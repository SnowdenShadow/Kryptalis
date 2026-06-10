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
	"sync"
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
	wg     sync.WaitGroup
}

const maxConcurrentTasks = 4

// Per-task-type deadlines. Without them a hung `docker compose pull`
// (network stall) permanently occupied a semaphore slot; four such tasks
// silently bricked the agent.
var taskTimeouts = map[string]time.Duration{
	"DEPLOY":     30 * time.Minute, // image builds can be slow
	"BUILD":      30 * time.Minute,
	"START":      5 * time.Minute,
	"RESTART":    5 * time.Minute,
	"STOP":       5 * time.Minute,
	"REMOVE":     5 * time.Minute,
	"LOGS":       1 * time.Minute,
	"EXEC":       2 * time.Minute,
	"STATUS":     1 * time.Minute,
	"FILE_READ":  30 * time.Second,
	"FILE_WRITE": 30 * time.Second,
}

const defaultTaskTimeout = 5 * time.Minute

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
	// Exponential backoff with cap when the API is unreachable — a fixed
	// interval hammers a recovering API from every agent at once.
	interval := p.cfg.PollInterval
	maxBackoff := 2 * time.Minute
	current := interval

	timer := time.NewTimer(current)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			tasks, err := p.poll(ctx)
			if err != nil {
				log.Printf("poll error: %v", err)
				current *= 2
				if current > maxBackoff {
					current = maxBackoff
				}
			} else {
				current = interval
				for _, task := range tasks {
					select {
					case p.sem <- struct{}{}:
					case <-ctx.Done():
						return
					}
					p.wg.Add(1)
					go func(t Task) {
						defer p.wg.Done()
						defer func() { <-p.sem }()
						p.handleTask(ctx, t)
					}(task)
				}
			}
			timer.Reset(current)
		}
	}
}

// Wait blocks until all in-flight tasks have finished and reported their
// results. Called on shutdown so SIGTERM doesn't kill a deployment halfway
// and leave the API row stuck PENDING.
func (p *Poller) Wait(timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		log.Printf("shutdown: %s grace period elapsed with tasks still running", timeout)
	}
}

func (p *Poller) poll(ctx context.Context) ([]Task, error) {
	body, _ := json.Marshal(map[string]string{
		"serverId": p.cfg.ServerID,
		"token":    p.cfg.AgentToken,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/api/agent/poll", p.cfg.APIUrl), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := p.client.Do(req)
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
func (p *Poller) handleTask(ctx context.Context, task Task) {
	log.Printf("▶ task %s (%s)", task.ID, task.Type)

	timeout, ok := taskTimeouts[task.Type]
	if !ok {
		timeout = defaultTaskTimeout
	}
	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

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
		result, taskErr = p.runDeploy(tctx, task)
	case "START":
		result, taskErr = p.runComposeCmd(tctx, task, "up", "-d")
	case "RESTART":
		result, taskErr = p.runComposeCmd(tctx, task, "restart")
	case "STOP":
		result, taskErr = p.runComposeCmd(tctx, task, "stop")
	case "REMOVE":
		result, taskErr = p.runRemove(tctx, task)
	case "LOGS":
		result, taskErr = p.runLogs(tctx, task)
	case "EXEC":
		result, taskErr = p.runExec(tctx, task)
	case "STATUS":
		result, taskErr = p.runStatus(tctx, task)
	case "FILE_READ":
		result, taskErr = p.runFileRead(task)
	case "FILE_WRITE":
		result, taskErr = p.runFileWrite(task)
	case "BACKUP", "SSL_ISSUE", "SSL_RENEW", "DNS_UPDATE", "MONITOR":
		result = map[string]interface{}{"status": "not_implemented"}
	default:
		taskErr = fmt.Sprintf("unknown task type: %s", task.Type)
	}

	if tctx.Err() == context.DeadlineExceeded && taskErr == "" {
		taskErr = fmt.Sprintf("task timed out after %s", timeout)
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
	// Skip comments and compose extension fields (x-*) — both match the
	// "two-space indent ending in ':'" shape but are not services.
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
				if name == "" || strings.HasPrefix(name, "#") || strings.HasPrefix(name, "x-") {
					continue
				}
				services = append(services, name)
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

// writeEnvFile renders KEY=VALUE lines, escaping values so a value
// containing a newline can't inject extra variables, and quoting anything
// that isn't a plain token. Keys that aren't valid env identifiers are
// rejected outright.
func writeEnvFile(path string, envVars map[string]interface{}) error {
	var b strings.Builder
	for k, v := range envVars {
		if !isValidEnvKey(k) {
			return fmt.Errorf("invalid env var name: %q", k)
		}
		val := fmt.Sprintf("%v", v)
		if strings.ContainsAny(val, "\n\r\"'\\$` #") {
			val = strconv_QuoteCompat(val)
		}
		fmt.Fprintf(&b, "%s=%s\n", k, val)
	}
	return os.WriteFile(path, []byte(b.String()), 0600)
}

// strconv_QuoteCompat double-quotes a value for .env consumption, escaping
// backslashes, double quotes, dollars and newlines (docker compose reads
// double-quoted values with standard escapes).
func strconv_QuoteCompat(s string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		`"`, `\"`,
		"$", `$$`, // compose interpolation escape
		"\n", `\n`,
		"\r", ``,
	)
	return `"` + r.Replace(s) + `"`
}

func isValidEnvKey(k string) bool {
	if k == "" {
		return false
	}
	for i := 0; i < len(k); i++ {
		c := k[i]
		ok := c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (i > 0 && c >= '0' && c <= '9')
		if !ok {
			return false
		}
	}
	return true
}

// runDeploy: clones the repo (if gitUrl given) and brings the compose stack up.
// Falls back to writing a pre-rendered compose when the API supplies one.
func (p *Poller) runDeploy(ctx context.Context, task Task) (map[string]interface{}, string) {
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
		c := exec.CommandContext(ctx, prog, args...)
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
		if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfileOverride), 0644); err != nil {
			return map[string]interface{}{"logs": logs.String()}, "writing Dockerfile override: " + err.Error()
		}
	}

	if envVars, ok := task.Payload["envVars"].(map[string]interface{}); ok && len(envVars) > 0 {
		if err := writeEnvFile(filepath.Join(dir, ".env"), envVars); err != nil {
			return map[string]interface{}{"logs": logs.String()}, "writing .env: " + err.Error()
		}
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
		if err := exec.CommandContext(ctx, "docker", "network", "inspect", projectNet).Run(); err != nil {
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
	if shaOut, err := exec.CommandContext(ctx, "git", "-C", dir, "rev-parse", "HEAD").Output(); err == nil {
		commitSha = strings.TrimSpace(string(shaOut))
	}
	if msgOut, err := exec.CommandContext(ctx, "git", "-C", dir, "log", "-1", "--pretty=%B").Output(); err == nil {
		commitMsg = strings.TrimSpace(string(msgOut))
	}

	if err := runIn(dir, "docker", "compose", "pull"); err != nil {
		// Non-fatal (image may be built locally) but worth surfacing in logs.
		fmt.Fprintf(logs, "> warn: compose pull failed: %v\n", err)
	}
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

func (p *Poller) runComposeCmd(ctx context.Context, task Task, action ...string) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	dir := appDir(slug)
	logs := bytes.Buffer{}
	args := append([]string{"compose"}, action...)
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Dir = dir
	cmd.Stdout = &logs
	cmd.Stderr = &logs
	if err := cmd.Run(); err != nil {
		return map[string]interface{}{"logs": logs.String()}, err.Error()
	}
	return map[string]interface{}{"status": "ok", "logs": tail(logs.String(), 2000)}, ""
}

func (p *Poller) runRemove(ctx context.Context, task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	// `purgeVolumes` defaults to FALSE for safety — `docker compose down -v`
	// nukes named volumes (databases, uploads). The previous behaviour was
	// to always pass -v on user-initiated app delete AND on project
	// migration, the latter being a silent data-loss bug. The API now
	// passes purgeVolumes:true ONLY when the user explicitly opts into a
	// destructive delete; migrations pass false so data survives until
	// VOLUME_EXPORT/IMPORT lands.
	purgeVolumes := false
	if v, ok := task.Payload["purgeVolumes"].(bool); ok {
		purgeVolumes = v
	}
	dir := appDir(slug)
	logs := bytes.Buffer{}
	// Collect errors instead of swallowing them: reporting "removed" while
	// `compose down` failed left the API state diverged from reality
	// (running containers the dashboard no longer shows).
	var errs []string
	if _, err := os.Stat(dir); err == nil {
		args := []string{"compose", "down", "--remove-orphans"}
		if purgeVolumes {
			args = []string{"compose", "down", "-v", "--remove-orphans"}
		}
		c := exec.CommandContext(ctx, "docker", args...)
		c.Dir = dir
		c.Stdout = &logs
		c.Stderr = &logs
		if err := c.Run(); err != nil {
			errs = append(errs, "compose down: "+err.Error())
		}
	}
	if cname, ok := task.Payload["containerName"].(string); ok && cname != "" {
		c := exec.CommandContext(ctx, "docker", "rm", "-f", cname)
		c.Stdout = &logs
		c.Stderr = &logs
		// `docker rm -f` on an already-gone container exits non-zero; that's
		// fine — only record the error when compose down ALSO failed.
		if err := c.Run(); err != nil && len(errs) > 0 {
			errs = append(errs, "docker rm: "+err.Error())
		}
	}
	// Only wipe the on-disk app dir when we're also purging volumes.
	// Otherwise leave it so a later restore can recover state.
	if purgeVolumes && len(errs) == 0 {
		if err := os.RemoveAll(dir); err != nil {
			errs = append(errs, "removing app dir: "+err.Error())
		}
	}
	if len(errs) > 0 {
		return map[string]interface{}{"logs": tail(logs.String(), 2000)}, strings.Join(errs, "; ")
	}
	return map[string]interface{}{
		"status":        "removed",
		"purgedVolumes": purgeVolumes,
		"logs":          tail(logs.String(), 2000),
	}, ""
}

func (p *Poller) runLogs(ctx context.Context, task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	dir := appDir(slug)
	lines := 100
	if n, ok := task.Payload["lines"].(float64); ok && n > 0 {
		lines = int(n)
	}
	c := exec.CommandContext(ctx, "docker", "compose", "logs", "--tail", fmt.Sprintf("%d", lines), "--no-color")
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"logs": string(out)}, err.Error()
	}
	return map[string]interface{}{"logs": string(out)}, ""
}

func (p *Poller) runExec(ctx context.Context, task Task) (map[string]interface{}, string) {
	cname, _ := task.Payload["containerName"].(string)
	command, _ := task.Payload["command"].(string)
	if cname == "" || command == "" {
		return nil, "missing containerName or command"
	}
	shells := []string{"/bin/sh", "/bin/bash", "sh", "bash"}
	for _, shell := range shells {
		c := exec.CommandContext(ctx, "docker", "exec", cname, shell, "-c", command)
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

func (p *Poller) runStatus(ctx context.Context, task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	dir := appDir(slug)
	c := exec.CommandContext(ctx, "docker", "compose", "ps", "--format", "json")
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

	// Backend requires serverId + token in the body to bind the result
	// to this agent's identity (same shape as /api/agent/tasks). Without
	// them every POST was rejected and deployments stayed forever PENDING.
	body, _ := json.Marshal(map[string]interface{}{
		"serverId": p.cfg.ServerID,
		"token":    p.cfg.AgentToken,
		"status":   status,
		"result":   result,
		"error":    taskErr,
	})

	// Retry with backoff — a transient network blip here used to lose the
	// result permanently, leaving the task PENDING until the staleness
	// sweeper failed it.
	delays := []time.Duration{0, 5 * time.Second, 15 * time.Second}
	var lastErr error
	for _, d := range delays {
		if d > 0 {
			time.Sleep(d)
		}
		resp, err := p.client.Post(
			fmt.Sprintf("%s/api/agent/tasks/%s/result", p.cfg.APIUrl, taskID),
			"application/json",
			bytes.NewReader(body),
		)
		if err != nil {
			lastErr = err
			continue
		}
		// Drain so the keep-alive connection is reusable.
		buf, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode >= 400 {
			// 4xx = rejected (bad token, unknown task) — retrying won't help.
			log.Printf("task %s report rejected (%d): %s", taskID, resp.StatusCode, string(buf))
			if resp.StatusCode < 500 {
				return
			}
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
			continue
		}
		return
	}
	log.Printf("failed to report task %s after retries: %v", taskID, lastErr)
}
