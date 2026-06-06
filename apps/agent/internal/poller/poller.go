package poller

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kryptalis/agent/internal/config"
)

type Task struct {
	ID      string                 `json:"id"`
	Type    string                 `json:"type"`
	Payload map[string]interface{} `json:"payload"`
}

type PollResponse struct {
	Tasks []Task `json:"tasks"`
}

type Poller struct {
	cfg    *config.Config
	client *http.Client
	sem    chan struct{}
}

const maxConcurrentTasks = 4

func New(cfg *config.Config) *Poller {
	return &Poller{
		cfg: cfg,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
		sem: make(chan struct{}, maxConcurrentTasks),
	}
}

func (p *Poller) Start(ctx context.Context) {
	ticker := time.NewTicker(p.cfg.PollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			tasks, err := p.poll()
			if err != nil {
				log.Printf("poll error: %v", err)
				continue
			}
			for _, task := range tasks {
				p.sem <- struct{}{}
				go func(t Task) {
					defer func() { <-p.sem }()
					p.handleTask(t)
				}(task)
			}
		}
	}
}

func (p *Poller) poll() ([]Task, error) {
	body, _ := json.Marshal(map[string]string{
		"serverId": p.cfg.ServerID,
		"token":    p.cfg.AgentToken,
	})

	resp, err := p.client.Post(
		fmt.Sprintf("%s/api/agent/poll", p.cfg.APIUrl),
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("poll %d: %s", resp.StatusCode, string(data))
	}
	var result PollResponse
	if err := json.Unmarshal(data, &result); err != nil {
		return nil, err
	}
	return result.Tasks, nil
}

// handleTask runs whatever the API queued for us. The payload is forwarded
// from ApplicationsService etc. and contains the docker-compose stack (or
// commands) we should apply locally on this server.
func (p *Poller) handleTask(task Task) {
	log.Printf("▶ task %s (%s)", task.ID, task.Type)

	var result map[string]interface{}
	var taskErr string

	defer func() {
		if r := recover(); r != nil {
			taskErr = fmt.Sprintf("panic: %v", r)
			p.reportResult(task.ID, result, taskErr)
		}
	}()

	switch task.Type {
	case "DEPLOY", "BUILD":
		result, taskErr = p.runDeploy(task)
	case "START":
		result, taskErr = p.runComposeCmd(task, "up", "-d")
	case "RESTART":
		result, taskErr = p.runComposeCmd(task, "restart")
	case "STOP":
		result, taskErr = p.runComposeCmd(task, "stop")
	case "REMOVE":
		result, taskErr = p.runRemove(task)
	case "LOGS":
		result, taskErr = p.runLogs(task)
	case "EXEC":
		result, taskErr = p.runExec(task)
	case "STATUS":
		result, taskErr = p.runStatus(task)
	case "FILE_READ":
		result, taskErr = p.runFileRead(task)
	case "FILE_WRITE":
		result, taskErr = p.runFileWrite(task)
	case "BACKUP", "SSL_ISSUE", "SSL_RENEW", "DNS_UPDATE", "MONITOR":
		result = map[string]interface{}{"status": "not_implemented"}
	default:
		taskErr = fmt.Sprintf("unknown task type: %s", task.Type)
	}

	p.reportResult(task.ID, result, taskErr)
}

func appDir(slug string) string {
	return filepath.Join("/opt/kryptalis/apps", slug)
}

// writeProjectNetworkOverride drops a docker-compose.override.yml next to
// the user's compose file. Compose auto-merges it, so every service in the
// stack gets joined to the kryptalis project network without us having to
// parse the user's YAML. Service list is discovered by reading
// docker-compose.yml — if there's no compose, nothing to override.
func writeProjectNetworkOverride(dir, networkName string) error {
	composePath := ""
	for _, candidate := range []string{"docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"} {
		p := filepath.Join(dir, candidate)
		if _, err := os.Stat(p); err == nil {
			composePath = p
			break
		}
	}
	if composePath == "" {
		return nil // nothing to override
	}
	data, err := os.ReadFile(composePath)
	if err != nil {
		return err
	}
	// Cheap service discovery: collect top-level keys under "services:". We
	// only care about direct children of the services map, not nested keys.
	services := []string{}
	inServices := false
	for _, line := range strings.Split(string(data), "\n") {
		trim := strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(trim, "services:") {
			inServices = true
			continue
		}
		if inServices {
			// New top-level block (no indent + non-empty) ends the services map.
			if len(trim) > 0 && trim[0] != ' ' && trim[0] != '\t' && trim[0] != '#' {
				inServices = false
				continue
			}
			// A service name is "  <name>:" with exactly 2 spaces of indent.
			if strings.HasPrefix(trim, "  ") && !strings.HasPrefix(trim, "   ") &&
				strings.HasSuffix(strings.TrimSpace(trim), ":") {
				name := strings.TrimSuffix(strings.TrimSpace(trim), ":")
				if name != "" {
					services = append(services, name)
				}
			}
		}
	}
	if len(services) == 0 {
		return nil
	}
	var b strings.Builder
	b.WriteString("# Auto-generated by Kryptalis agent. Do not edit.\n")
	b.WriteString("services:\n")
	for _, s := range services {
		fmt.Fprintf(&b, "  %s:\n    networks:\n      - kryptalis_project\n", s)
	}
	b.WriteString("networks:\n  kryptalis_project:\n    external: true\n    name: ")
	b.WriteString(networkName)
	b.WriteString("\n")
	return os.WriteFile(filepath.Join(dir, "docker-compose.override.yml"), []byte(b.String()), 0644)
}

// runDeploy: clones the repo (if gitUrl given) and brings the compose stack up.
// Falls back to writing a pre-rendered compose when the API supplies one.
func (p *Poller) runDeploy(task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		if name, ok := task.Payload["appName"].(string); ok {
			slug = sanitize(name)
		}
	}
	if slug == "" {
		return nil, "missing slug"
	}

	dir := appDir(slug)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, err.Error()
	}

	logs := &bytes.Buffer{}
	runIn := func(cwd, prog string, args ...string) error {
		c := exec.Command(prog, args...)
		c.Dir = cwd
		c.Stdout = logs
		c.Stderr = logs
		fmt.Fprintf(logs, "> %s %s\n", prog, strings.Join(args, " "))
		return c.Run()
	}

	gitUrl, _ := task.Payload["gitUrl"].(string)
	if gitUrl != "" {
		branch, _ := task.Payload["branch"].(string)
		if branch == "" {
			branch = "main"
		}
		// fresh clone — wipe any previous content
		_ = os.RemoveAll(dir)
		_ = os.MkdirAll(dir, 0755)
		cloneArgs := []string{"clone", "--depth", "1", "--branch", branch}
		if header, ok := task.Payload["cloneHeader"].(string); ok && header != "" {
			cloneArgs = append([]string{"-c", "http.extraheader=" + header}, cloneArgs...)
		}
		cloneArgs = append(cloneArgs, gitUrl, dir)
		if err := runIn(".", "git", cloneArgs...); err != nil {
			return map[string]interface{}{"logs": logs.String()}, err.Error()
		}
		// scrub any token persisted via extraheader
		_ = runIn(dir, "git", "remote", "set-url", "origin", gitUrl)
		_ = runIn(dir, "git", "config", "--unset", "http.extraheader")
	}

	if composeText, ok := task.Payload["compose"].(string); ok && composeText != "" {
		if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(composeText), 0644); err != nil {
			return nil, err.Error()
		}
	}
	if composeOverride, ok := task.Payload["composeOverride"].(string); ok && composeOverride != "" {
		if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(composeOverride), 0644); err != nil {
			return nil, err.Error()
		}
	}
	if dockerfileOverride, ok := task.Payload["dockerfileOverride"].(string); ok && dockerfileOverride != "" {
		_ = os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfileOverride), 0644)
	}

	if envVars, ok := task.Payload["envVars"].(map[string]interface{}); ok && len(envVars) > 0 {
		var b strings.Builder
		for k, v := range envVars {
			fmt.Fprintf(&b, "%s=%v\n", k, v)
		}
		_ = os.WriteFile(filepath.Join(dir, ".env"), []byte(b.String()), 0600)
	}

	// Project network — apps in the same Kryptalis project share a docker
	// network so they can reach each other by container name.
	//
	// We do two things:
	//   1. create the network if it doesn't exist (idempotent, `inspect` then
	//      `create`). Errors here are non-fatal — if the user's compose file
	//      doesn't reference the network at all, network creation just isn't
	//      needed.
	//   2. write a docker-compose.override.yml that wires every service in the
	//      stack onto that shared external network. Docker Compose merges this
	//      override on top of docker-compose.yml automatically. This is far
	//      simpler (and more robust) than parsing the user's YAML in Go — it
	//      composes cleanly with whatever they already have.
	if projectNet, ok := task.Payload["projectNetwork"].(string); ok && projectNet != "" {
		if err := exec.Command("docker", "network", "inspect", projectNet).Run(); err != nil {
			fmt.Fprintf(logs, "> docker network create %s\n", projectNet)
			_ = runIn(".", "docker", "network", "create", projectNet)
		}
		if err := writeProjectNetworkOverride(dir, projectNet); err != nil {
			fmt.Fprintf(logs, "> warn: could not write compose override: %v\n", err)
		}
	}

	// capture commit (best-effort)
	commitSha := ""
	commitMsg := ""
	if shaOut, err := exec.Command("git", "-C", dir, "rev-parse", "HEAD").Output(); err == nil {
		commitSha = strings.TrimSpace(string(shaOut))
	}
	if msgOut, err := exec.Command("git", "-C", dir, "log", "-1", "--pretty=%B").Output(); err == nil {
		commitMsg = strings.TrimSpace(string(msgOut))
	}

	_ = runIn(dir, "docker", "compose", "pull")
	if err := runIn(dir, "docker", "compose", "up", "-d", "--build", "--remove-orphans"); err != nil {
		return map[string]interface{}{"logs": tail(logs.String(), 8000)}, err.Error()
	}
	return map[string]interface{}{
		"status":        "deployed",
		"logs":          tail(logs.String(), 8000),
		"commitSha":     commitSha,
		"commitMessage": commitMsg,
	}, ""
}

func (p *Poller) runComposeCmd(task Task, action ...string) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	dir := appDir(slug)
	logs := bytes.Buffer{}
	args := append([]string{"compose"}, action...)
	cmd := exec.Command("docker", args...)
	cmd.Dir = dir
	cmd.Stdout = &logs
	cmd.Stderr = &logs
	if err := cmd.Run(); err != nil {
		return map[string]interface{}{"logs": logs.String()}, err.Error()
	}
	return map[string]interface{}{"status": "ok", "logs": tail(logs.String(), 2000)}, ""
}

func (p *Poller) runRemove(task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	dir := appDir(slug)
	logs := bytes.Buffer{}
	if _, err := os.Stat(dir); err == nil {
		c := exec.Command("docker", "compose", "down", "-v", "--remove-orphans")
		c.Dir = dir
		c.Stdout = &logs
		c.Stderr = &logs
		_ = c.Run()
	}
	if cname, ok := task.Payload["containerName"].(string); ok && cname != "" {
		c := exec.Command("docker", "rm", "-f", cname)
		c.Stdout = &logs
		c.Stderr = &logs
		_ = c.Run()
	}
	_ = os.RemoveAll(dir)
	return map[string]interface{}{"status": "removed", "logs": tail(logs.String(), 2000)}, ""
}

func (p *Poller) runLogs(task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	dir := appDir(slug)
	lines := 100
	if n, ok := task.Payload["lines"].(float64); ok && n > 0 {
		lines = int(n)
	}
	c := exec.Command("docker", "compose", "logs", "--tail", fmt.Sprintf("%d", lines), "--no-color")
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"logs": string(out)}, err.Error()
	}
	return map[string]interface{}{"logs": string(out)}, ""
}

func (p *Poller) runExec(task Task) (map[string]interface{}, string) {
	cname, _ := task.Payload["containerName"].(string)
	command, _ := task.Payload["command"].(string)
	if cname == "" || command == "" {
		return nil, "missing containerName or command"
	}
	shells := []string{"/bin/sh", "/bin/bash", "sh", "bash"}
	for _, shell := range shells {
		c := exec.Command("docker", "exec", cname, shell, "-c", command)
		out, err := c.CombinedOutput()
		if err == nil {
			return map[string]interface{}{"output": string(out), "exitCode": 0}, ""
		}
		txt := strings.ToLower(string(out) + " " + err.Error())
		if strings.Contains(txt, "not found") || strings.Contains(txt, "no such file") || strings.Contains(txt, "executable file") {
			continue
		}
		ec := 1
		if ee, ok := err.(*exec.ExitError); ok {
			ec = ee.ExitCode()
		}
		return map[string]interface{}{"output": string(out), "exitCode": ec}, ""
	}
	return map[string]interface{}{
		"output":   "⚠️ Container has no shell (scratch/distroless).",
		"exitCode": -1,
	}, ""
}

func (p *Poller) runStatus(task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	dir := appDir(slug)
	c := exec.Command("docker", "compose", "ps", "--format", "json")
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"output": string(out)}, err.Error()
	}
	return map[string]interface{}{"output": string(out)}, ""
}

func (p *Poller) runFileRead(task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	name, _ := task.Payload["file"].(string)
	if slug == "" || name == "" {
		return nil, "missing slug or file"
	}
	safe := filepath.Clean(name)
	if strings.HasPrefix(safe, "..") || strings.Contains(safe, "..") {
		return nil, "path traversal rejected"
	}
	full := filepath.Join(appDir(slug), safe)
	data, err := os.ReadFile(full)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{"exists": false, "content": ""}, ""
		}
		return nil, err.Error()
	}
	return map[string]interface{}{"exists": true, "content": string(data)}, ""
}

func (p *Poller) runFileWrite(task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	name, _ := task.Payload["file"].(string)
	content, _ := task.Payload["content"].(string)
	if slug == "" || name == "" {
		return nil, "missing slug or file"
	}
	safe := filepath.Clean(name)
	if strings.HasPrefix(safe, "..") || strings.Contains(safe, "..") {
		return nil, "path traversal rejected"
	}
	full := filepath.Join(appDir(slug), safe)
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		return nil, err.Error()
	}
	if err := os.WriteFile(full, []byte(content), 0644); err != nil {
		return nil, err.Error()
	}
	return map[string]interface{}{"written": len(content)}, ""
}

// sanitize must stay byte-for-byte equivalent to apps/api/.../applications.service.ts:slugify.
func sanitize(name string) string {
	lower := strings.ToLower(name)
	var b strings.Builder
	prev := byte(0)
	for i := 0; i < len(lower); i++ {
		r := lower[i]
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteByte(r)
			prev = r
		default:
			if prev != '-' && b.Len() > 0 {
				b.WriteByte('-')
				prev = '-'
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if len(out) > 48 {
		out = strings.Trim(out[:48], "-")
	}
	if out == "" {
		return "app"
	}
	return out
}

func tail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return "..." + s[len(s)-max:]
}

func (p *Poller) reportResult(taskID string, result map[string]interface{}, taskErr string) {
	status := "COMPLETED"
	if taskErr != "" {
		status = "FAILED"
	}

	body, _ := json.Marshal(map[string]interface{}{
		"status": status,
		"result": result,
		"error":  taskErr,
	})

	resp, err := p.client.Post(
		fmt.Sprintf("%s/api/agent/tasks/%s/result", p.cfg.APIUrl, taskID),
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		log.Printf("failed to report task %s: %v", taskID, err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		buf, _ := io.ReadAll(resp.Body)
		log.Printf("task %s report rejected (%d): %s", taskID, resp.StatusCode, string(buf))
	}
}
