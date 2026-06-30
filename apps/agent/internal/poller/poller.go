package poller

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/dockcontrol/agent/internal/config"
	"github.com/dockcontrol/agent/internal/tasks"
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
	tasks  *tasks.Runner
	sem    chan struct{}
	wg     sync.WaitGroup
	// Embedded SFTP server — accounts pushed via SFTP_SYNC tasks. Nil
	// when the server failed to start (port busy); SFTP_SYNC then fails
	// loudly instead of silently dropping accounts.
	Sftp SftpSyncer
}

// SftpSyncer is implemented by sftpserver.Server. Interface (not the
// concrete type) so poller tests don't need the ssh/sftp dependencies.
type SftpSyncer interface {
	Sync(accounts []SftpAccountPayload) int
}

// SftpAccountPayload mirrors sftpserver.Account field-for-field.
type SftpAccountPayload struct {
	Username      string            `json:"username"`
	PasswordHash  string            `json:"passwordHash,omitempty"`
	PublicKeys    []string          `json:"publicKeys,omitempty"`
	Permission    string            `json:"permission"`
	Disabled      bool              `json:"disabled"`
	Roots         map[string]string `json:"roots"`
	AllowShell    bool              `json:"allowShell,omitempty"`
	ContainerName string            `json:"containerName,omitempty"`
}

const maxConcurrentTasks = 4

// Per-task-type deadlines. Without them a hung `docker compose pull`
// (network stall) permanently occupied a semaphore slot; four such tasks
// silently bricked the agent.
var taskTimeouts = map[string]time.Duration{
	"DEPLOY":        30 * time.Minute, // image builds can be slow
	"BUILD":         30 * time.Minute,
	"START":         5 * time.Minute,
	"RESTART":       5 * time.Minute,
	"STOP":          5 * time.Minute,
	"REMOVE":        5 * time.Minute,
	"LOGS":          1 * time.Minute,
	"SFTP_SYNC":     1 * time.Minute,
	"EXEC":          2 * time.Minute,
	"STATUS":        1 * time.Minute,
	"FILE_READ":     30 * time.Second,
	"FILE_WRITE":    30 * time.Second,
	"FILE_EXTRACT":  5 * time.Minute,  // unzip can touch many files
	"FILE_COMPRESS": 10 * time.Minute, // archive many files
	"FILE_CHMOD":    5 * time.Minute,  // recursive chmod can touch many files
	"FILE_CHOWN":    5 * time.Minute,
	"FILE_FIXPERMS": 5 * time.Minute,
	// Data-transfer tasks move whole volumes / database dumps over the
	// network — generous deadlines by design.
	"VOLUME_LIST":   1 * time.Minute,
	"VOLUME_EXPORT": 30 * time.Minute,
	"VOLUME_IMPORT": 30 * time.Minute,
	"BACKUP":        30 * time.Minute,
	"RESTORE":       30 * time.Minute,
}

const defaultTaskTimeout = 5 * time.Minute

func New(cfg *config.Config) *Poller {
	return &Poller{
		cfg: cfg,
		client: &http.Client{
			Timeout: 60 * time.Second,
		},
		tasks: tasks.NewRunner(tasks.NewClient(cfg.APIUrl, cfg.ServerID, cfg.AgentToken)),
		sem:   make(chan struct{}, maxConcurrentTasks),
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
	case "FILE_LIST":
		result, taskErr = p.runFileList(task)
	case "FILE_DELETE":
		result, taskErr = p.runFileDelete(task)
	case "FILE_EXTRACT":
		result, taskErr = p.runFileExtract(task)
	case "FILE_COMPRESS":
		result, taskErr = p.runFileCompress(task)
	case "FILE_CHMOD":
		result, taskErr = p.runFileChmod(task)
	case "FILE_CHOWN":
		result, taskErr = p.runFileChown(task)
	case "FILE_FIXPERMS":
		result, taskErr = p.runFileFixPerms(task)
	case "DISK_USAGE":
		result, taskErr = p.runDiskUsage(task)
	case "SFTP_SYNC":
		result, taskErr = p.runSftpSync(task)
	case "VOLUME_LIST":
		result, taskErr = p.tasks.VolumeList(tctx, task.Payload)
	case "VOLUME_EXPORT":
		result, taskErr = p.tasks.VolumeExport(tctx, task.ID, task.Payload)
	case "VOLUME_IMPORT":
		result, taskErr = p.tasks.VolumeImport(tctx, task.Payload)
	case "BACKUP":
		result, taskErr = p.tasks.Backup(tctx, task.ID, task.Payload)
	case "RESTORE":
		result, taskErr = p.tasks.Restore(tctx, task.Payload)
	case "SSL_ISSUE", "SSL_RENEW":
		// TLS termination for apps lives on the platform host's managed
		// reverse proxy (Caddy) — agent servers have no managed proxy to
		// issue or install certificates with. Report FAILED with an explicit
		// error: the previous `not_implemented` result reported COMPLETED,
		// which made the API/UI believe a certificate had been issued when
		// nothing happened.
		taskErr = fmt.Sprintf("%s requires the managed reverse proxy (Caddy), which is not available on agent servers — certificates are issued on the platform host", task.Type)
	// DNS_UPDATE and MONITOR are never emitted by the API (DNS is managed
	// API-side; metrics flow through heartbeats — internal/monitor). They
	// fall through to default and report FAILED instead of a fake COMPLETED.
	default:
		taskErr = fmt.Sprintf("unknown task type: %s", task.Type)
	}

	if tctx.Err() == context.DeadlineExceeded && taskErr == "" {
		taskErr = fmt.Sprintf("task timed out after %s", timeout)
	}

	p.reportResult(task.ID, result, taskErr)
}

// appsBaseDir is the root under which app dirs live. A package var (not a
// const) so tests can point it at a temp dir; production never changes it.
var appsBaseDir = "/opt/dockcontrol/apps"

func appDir(slug string) string {
	return filepath.Join(appsBaseDir, slug)
}

// isHexRef: 7-64 hex chars — a git commit SHA (abbreviated or full).
func isHexRef(s string) bool {
	if len(s) < 7 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return false
		}
	}
	return true
}

// writeProjectNetworkOverride drops a docker-compose.override.yml next to
// the user's compose file. Compose auto-merges it, so every service in the
// stack gets joined to the dockcontrol project network without us having to
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
	b.WriteString("# Auto-generated by DockControl agent. Do not edit.\n")
	b.WriteString("services:\n")
	for _, s := range services {
		fmt.Fprintf(&b, "  %s:\n    networks:\n      - dockcontrol_project\n", s)
	}
	b.WriteString("networks:\n  dockcontrol_project:\n    external: true\n    name: ")
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

// mergeRepoEnv reads the repo's committed env files (lowest → highest:
// .env.example, .env.local.example, .env.production, .env, .env.local) and
// merges the user-supplied envVars on top (user always wins). Mirrors the
// API's ApplicationEnvService.loadRepoEnvFiles priority so local and remote
// deploys bake the same values.
func mergeRepoEnv(dir string, userEnv map[string]interface{}) map[string]interface{} {
	out := map[string]interface{}{}
	for _, name := range []string{".env.example", ".env.local.example", ".env.production", ".env", ".env.local"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		for _, raw := range strings.Split(string(data), "\n") {
			line := strings.TrimSuffix(raw, "\r")
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			line = strings.TrimPrefix(line, "export ")
			eq := strings.Index(line, "=")
			if eq <= 0 {
				continue
			}
			key := strings.TrimSpace(line[:eq])
			if !isValidEnvKey(key) {
				continue
			}
			val := strings.TrimSpace(line[eq+1:])
			quoted := false
			if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
				val = val[1 : len(val)-1]
				quoted = true
			}
			if !quoted {
				if hash := strings.Index(val, " #"); hash != -1 {
					val = strings.TrimRight(val[:hash], " \t")
				}
			}
			out[key] = val
		}
	}
	for k, v := range userEnv {
		out[k] = v
	}
	return out
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

// redactGitArgs masks any git credential carried in an argv before it is echoed
// into the deploy log. The clone injects the token as a single argument of the
// form `http.extraheader=Authorization: Basic <b64>` (via `-c`), so we redact
// from `extraheader=` onward; we also blank a bare `Authorization:` header arg
// defensively. Everything else passes through untouched so the command stays
// readable in the logs.
func redactGitArgs(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		switch {
		case strings.Contains(a, "http.extraheader="):
			out[i] = a[:strings.Index(a, "http.extraheader=")] + "http.extraheader=<redacted>"
		case strings.HasPrefix(a, "extraheader="):
			out[i] = "extraheader=<redacted>"
		case strings.HasPrefix(strings.ToLower(a), "authorization:"):
			out[i] = "Authorization: <redacted>"
		default:
			out[i] = a
		}
	}
	return out
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
		// Pin git to https only (defense-in-depth behind the API's URL
		// validation): with GIT_ALLOW_PROTOCOL=https git refuses file://,
		// ext::, ssh://, git://, http://, … so a smuggled scheme can't read a
		// local repo or run an ext:: helper on the host. (H-1)
		if prog == "git" {
			c.Env = append(os.Environ(), "GIT_ALLOW_PROTOCOL=https")
		}
		// Redact before echoing the command: a private-repo clone carries the
		// git credential as `-c http.extraheader=Authorization: Basic <token>`.
		// These logs are returned in the task result and stored/shown to admins,
		// so the raw token must never reach the buffer. Mirrors the API-side
		// redactSecrets() (application-deploy.service.ts).
		fmt.Fprintf(logs, "> %s %s\n", prog, strings.Join(redactGitArgs(args), " "))
		return c.Run()
	}

	gitUrl, _ := task.Payload["gitUrl"].(string)

	// Rollback snapshot of the previous appDir — git path only. Mirrors the
	// API's local-deploy contract (application-deploy.service.ts): a git deploy
	// fully rewrites appDir from a fresh clone, so instead of destroying the
	// old dir (the previous `os.RemoveAll(dir)`, which left a failed clone/build
	// with NO way back), we move it aside with an atomic rename. The running
	// containers don't need their config dir — they keep serving while the new
	// version clones and builds next to them; the compose project name is the
	// dir basename, which stays `dir`, so the new `up` adopts/replaces the old
	// containers. On ANY failure (clone, build, up, or post-up healthcheck) we
	// swap the snapshot back and bring the previous stack up again, so a broken
	// push never leaves the app down.
	//
	// LIMITATION (same as the API): only the CONFIG (appDir: compose, source,
	// Dockerfile, .env) is snapshotted. Docker volumes/databases live outside
	// appDir and survive a redeploy untouched — they are not rolled back.
	//
	// Non-git deploys (compose/image/dockerfile/php) overwrite in place as
	// before and are NOT snapshotted: their appDir may hold user data (e.g. a
	// PHP site's bind-mounted public/) that must never be moved aside.
	prevDir := dir + ".prev"
	hasPrevSnapshot := false
	commitSha := ""
	commitMsg := ""

	// build runs the full deploy sequence. It returns an error string ("" on
	// success); the caller turns a non-empty result into a rollback (git path)
	// before reporting the task as FAILED.
	build := func() string {
		if gitUrl != "" {
			branch, _ := task.Payload["branch"].(string)
			if branch == "" {
				branch = "main"
			}
			// gitRef: deploy a SPECIFIC commit instead of the branch tip (manual
			// rollback). Needs a full clone — a shallow one only carries the tip.
			gitRef, _ := task.Payload["gitRef"].(string)
			// Snapshot the previous appDir aside instead of destroying it, so a
			// failed clone/build can be rolled back. Atomic rename (same FS),
			// costs no disk/time even with a huge node_modules.
			snapped, snapErr := snapshotAppDir(dir, prevDir)
			if snapErr != nil {
				// rename failed (cross-device, locked file) — degrade to the
				// historical wipe; rollback simply won't be available.
				fmt.Fprintf(logs, "> warn: could not snapshot previous deploy (%v); proceeding without rollback\n", snapErr)
				_ = os.RemoveAll(dir)
			}
			hasPrevSnapshot = snapped
			_ = os.MkdirAll(dir, 0755)
			cloneArgs := []string{"clone"}
			if gitRef == "" {
				cloneArgs = append(cloneArgs, "--depth", "1")
			}
			cloneArgs = append(cloneArgs, "--branch", branch)
			if header, ok := task.Payload["cloneHeader"].(string); ok && header != "" {
				cloneArgs = append([]string{"-c", "http.extraheader=" + header}, cloneArgs...)
			}
			cloneArgs = append(cloneArgs, gitUrl, dir)
			if err := runIn(".", "git", cloneArgs...); err != nil {
				return err.Error()
			}
			if gitRef != "" {
				// Detached checkout of the rollback target. Refuse garbage refs:
				// only full/abbreviated hex SHAs are accepted (no branch names —
				// the API already resolved the deployment's commitSha).
				if !isHexRef(gitRef) {
					return "invalid gitRef (expected a commit SHA): " + gitRef
				}
				if err := runIn(dir, "git", "checkout", "--detach", gitRef); err != nil {
					return "gitRef checkout failed: " + err.Error()
				}
			}
			// scrub any token persisted via extraheader
			_ = runIn(dir, "git", "remote", "set-url", "origin", gitUrl)
			_ = runIn(dir, "git", "config", "--unset", "http.extraheader")
		}

		if composeText, ok := task.Payload["compose"].(string); ok && composeText != "" {
			if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(composeText), 0644); err != nil {
				return err.Error()
			}
		}
		if composeOverride, ok := task.Payload["composeOverride"].(string); ok && composeOverride != "" {
			if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(composeOverride), 0644); err != nil {
				return err.Error()
			}
		}
		if dockerfileOverride, ok := task.Payload["dockerfileOverride"].(string); ok && dockerfileOverride != "" {
			if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfileOverride), 0644); err != nil {
				return "writing Dockerfile override: " + err.Error()
			}
		}

		// sideFiles: companion files some compose templates bind-mount (e.g.
		// PrestaShop's Apache proxy conf) and Dockerfile-only build contexts.
		// Written before compose up so the mount targets / build inputs exist.
		// Keys are paths relative to the app dir; traversal is rejected.
		if sideFiles, ok := task.Payload["sideFiles"].(map[string]interface{}); ok {
			for name, raw := range sideFiles {
				content, ok := raw.(string)
				if !ok {
					continue
				}
				safe := filepath.Clean(name)
				if safe == "." || strings.HasPrefix(safe, "..") || filepath.IsAbs(safe) {
					return "sideFiles path traversal rejected: " + name
				}
				full := filepath.Join(dir, safe)
				if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
					return "creating sideFiles dir: " + err.Error()
				}
				if err := os.WriteFile(full, []byte(content), 0644); err != nil {
					return "writing side file " + safe + ": " + err.Error()
				}
			}
		}

		// .env is ALWAYS written, even empty — marketplace templates declare
		// `env_file: - .env` and docker compose hard-fails on a missing file.
		{
			envVars, _ := task.Payload["envVars"].(map[string]interface{})
			if envVars == nil {
				envVars = map[string]interface{}{}
			}
			if gitUrl != "" {
				// Source build (git clone) — mirror the API's local-deploy logic:
				// merge the repo's .env* files (lowest priority) under the user's
				// envVars, then write the result to EVERY env file Next/Vite/CRA
				// read at build time. Writing only .env is not enough: Next.js
				// gives .env.production and .env.local committed in the repo
				// priority OVER .env, so user-set NEXT_PUBLIC_* values were
				// silently losing to stale repo values.
				merged := mergeRepoEnv(dir, envVars)
				for _, name := range []string{".env", ".env.local", ".env.production"} {
					if err := writeEnvFile(filepath.Join(dir, name), merged); err != nil {
						return "writing " + name + ": " + err.Error()
					}
				}
			} else if err := writeEnvFile(filepath.Join(dir, ".env"), envVars); err != nil {
				return "writing .env: " + err.Error()
			}
		}

		// Shared dockcontrol-apps bridge — every marketplace/compose template
		// declares it as `external: true`, so it must exist BEFORE compose up
		// or the deploy fails with "network dockcontrol-apps ... could not be
		// found". On the platform host the API creates it; on agent servers
		// we are the only one who can. Idempotent: inspect, then create.
		if err := exec.CommandContext(ctx, "docker", "network", "inspect", "dockcontrol-apps").Run(); err != nil {
			fmt.Fprintf(logs, "> docker network create dockcontrol-apps\n")
			_ = runIn(".", "docker", "network", "create", "dockcontrol-apps")
		}

		// Project network — apps in the same DockControl project share a docker
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
			return err.Error()
		}
		return ""
	}

	deployErr := build()

	// Post-up healthcheck — only when we hold a rollback snapshot (i.e. a git
	// REDEPLOY over a previous version). `compose up -d` exits 0 the instant
	// containers are created, so a crash-looping new build looks "deployed";
	// the healthcheck catches it and routes to rollback. We don't run it on a
	// first deploy (nothing to roll back to) or on non-git deploys (unchanged
	// behavior — a one-shot service that exits 0 must not be treated as failed).
	if deployErr == "" && hasPrevSnapshot {
		if !waitForComposeHealthy(ctx, dir, 30*time.Second) {
			deployErr = "healthcheck failed — new version did not reach a running state within 30s"
			fmt.Fprintf(logs, "> %s\n", deployErr)
		}
	}

	if deployErr != "" {
		if hasPrevSnapshot {
			// Swap the previous appDir back and bring the old stack up again.
			// Report the deploy as FAILED regardless (the requested version did
			// NOT deploy) — but the app keeps serving the previous version, and
			// the next heartbeat resyncs its RUNNING status from the live
			// containers.
			rolledBack := p.restorePrevDeploy(ctx, dir, prevDir, logs)
			return map[string]interface{}{
				"logs":       tail(logs.String(), 8000),
				"rolledBack": rolledBack,
			}, deployErr
		}
		return map[string]interface{}{"logs": tail(logs.String(), 8000)}, deployErr
	}

	// Deploy succeeded — the snapshot is no longer needed.
	if hasPrevSnapshot {
		_ = os.RemoveAll(prevDir)
	}
	return map[string]interface{}{
		"status":        "deployed",
		"logs":          tail(logs.String(), 8000),
		"commitSha":     commitSha,
		"commitMessage": commitMsg,
	}, ""
}

// snapshotAppDir moves an existing appDir aside to prevDir (atomic rename) so a
// failed deploy can be rolled back. Returns true when a snapshot was taken. A
// stale prevDir from an earlier crashed deploy is removed first. If the rename
// fails (cross-device, locked), the caller is told no snapshot exists and is
// expected to degrade to a plain wipe.
func snapshotAppDir(dir, prevDir string) (bool, error) {
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return false, nil // nothing to snapshot (first deploy)
	}
	_ = os.RemoveAll(prevDir)
	if err := os.Rename(dir, prevDir); err != nil {
		return false, err
	}
	return true, nil
}

// swapBackSnapshot restores a snapshot taken by snapshotAppDir: the (broken)
// current dir is removed and prevDir is renamed back into its place. Filesystem
// only — bringing the restored stack back up is the caller's job.
func swapBackSnapshot(dir, prevDir string) error {
	_ = os.RemoveAll(dir)
	return os.Rename(prevDir, dir)
}

// restorePrevDeploy rolls a failed git deploy back to the snapshot: it swaps the
// previous appDir back into place and brings the old compose stack up again.
// Returns true when the previous version is healthy again. Mirrors the rollback
// in the API's local deploy path (application-deploy.service.ts). The compose
// project name is the dir basename (unchanged across the swap), so `up`
// reconciles the containers back to the previous config.
func (p *Poller) restorePrevDeploy(ctx context.Context, dir, prevDir string, logs *bytes.Buffer) bool {
	fmt.Fprintf(logs, "> rollback: restoring previous deployment\n")
	// Restore the snapshot FIRST — otherwise `up` would just relaunch the
	// broken config the failed deploy wrote.
	if err := swapBackSnapshot(dir, prevDir); err != nil {
		fmt.Fprintf(logs, "> rollback: failed to restore previous app directory: %v\n", err)
		return false
	}
	c := exec.CommandContext(ctx, "docker", "compose", "up", "-d", "--remove-orphans")
	c.Dir = dir
	c.Stdout = logs
	c.Stderr = logs
	if err := c.Run(); err != nil {
		fmt.Fprintf(logs, "> rollback: previous stack failed to start: %v\n", err)
		return false
	}
	ok := waitForComposeHealthy(ctx, dir, 20*time.Second)
	if ok {
		fmt.Fprintf(logs, "> rollback successful — previous version is running\n")
	} else {
		fmt.Fprintf(logs, "> rollback healthcheck failed\n")
	}
	return ok
}

// composeState is the slice of `docker compose ps --format json` we care about
// for healthchecking.
type composeState struct {
	State  string `json:"State"`
	Health string `json:"Health"`
}

// parseComposeStates decodes `docker compose ps --format json` output, which is
// either NDJSON (one object per line, newer compose) or a single JSON array
// (older compose). Mirrors the API's waitForHealthy tolerance of both shapes.
func parseComposeStates(out string) []composeState {
	out = strings.TrimSpace(out)
	if out == "" {
		return nil
	}
	var states []composeState
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var s composeState
		if err := json.Unmarshal([]byte(line), &s); err == nil && (s.State != "" || s.Health != "") {
			states = append(states, s)
		}
	}
	if len(states) > 0 {
		return states
	}
	// Fallback: a single JSON array (or object) rather than NDJSON.
	var arr []composeState
	if err := json.Unmarshal([]byte(out), &arr); err == nil {
		return arr
	}
	return nil
}

// evalComposeHealth reduces a set of service states to (allUp, anyDead).
// allUp: every service is running and not starting/unhealthy → the stack is
// healthy. anyDead: at least one service exited/dead/oomkilled → fail fast, no
// point waiting for the rest. An empty set is neither (not yet observable).
func evalComposeHealth(states []composeState) (allUp bool, anyDead bool) {
	if len(states) == 0 {
		return false, false
	}
	allUp = true
	for _, s := range states {
		st := strings.ToLower(s.State)
		h := strings.ToLower(s.Health)
		if h == "starting" || h == "unhealthy" || st != "running" {
			allUp = false
		}
		if st == "exited" || st == "dead" || st == "oomkilled" {
			anyDead = true
		}
	}
	return allUp, anyDead
}

// waitForComposeHealthy polls `docker compose ps` until every service is running
// (and not unhealthy/starting) or the deadline passes. A service that
// exits/dies fails fast. Mirrors the API's waitForHealthy.
func waitForComposeHealthy(ctx context.Context, dir string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		c := exec.CommandContext(ctx, "docker", "compose", "ps", "--format", "json")
		c.Dir = dir
		if out, err := c.Output(); err == nil {
			allUp, anyDead := evalComposeHealth(parseComposeStates(string(out)))
			if allUp {
				return true
			}
			if anyDead {
				return false
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(2 * time.Second):
		}
	}
	return false
}

// resolveTaskDir picks the compose dir for lifecycle ops. New deploys use a
// per-instance slug (<name-slug>-<id12>); apps deployed before that
// convention live under the bare slug. `legacySlug` lets the API name both
// without knowing which one exists on THIS host's disk.
func resolveTaskDir(payload map[string]interface{}) (string, string) {
	slug, _ := payload["slug"].(string)
	if slug == "" {
		return "", "missing slug"
	}
	dir := appDir(slug)
	if _, err := os.Stat(dir); err != nil {
		if legacy, ok := payload["legacySlug"].(string); ok && legacy != "" {
			if legacyDir := appDir(legacy); func() bool { _, e := os.Stat(legacyDir); return e == nil }() {
				return legacyDir, ""
			}
		}
	}
	return dir, ""
}

func (p *Poller) runComposeCmd(ctx context.Context, task Task, action ...string) (map[string]interface{}, string) {
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" {
		return nil, errStr
	}
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
	dir, _ := resolveTaskDir(task.Payload)
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
		// `--` terminates docker's flag parsing so a containerName beginning
		// with `-` can never be reinterpreted as a CLI flag (matches the SFTP
		// shell path in sftpserver.go).
		c := exec.CommandContext(ctx, "docker", "rm", "-f", "--", cname)
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
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" {
		return nil, errStr
	}
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
		// `--` terminates docker's flag parsing so a containerName beginning
		// with `-` can never be reinterpreted as a docker flag.
		c := exec.CommandContext(ctx, "docker", "exec", "--", cname, shell, "-c", command)
		out, err := c.CombinedOutput()
		if err == nil {
			return map[string]interface{}{"output": string(out), "exitCode": 0}, ""
		}
		ec := 1
		if ee, ok := err.(*exec.ExitError); ok {
			ec = ee.ExitCode()
		} else {
			// Not an ExitError → docker itself couldn't run (daemon error,
			// context cancel, …). Surface it; trying other shells won't help.
			return map[string]interface{}{"output": string(out), "exitCode": 1}, ""
		}
		// `docker exec` reports 126 (found but not executable) / 127 (not found)
		// ONLY when it cannot start the shell binary itself — that's the real
		// "no shell" signal. Any OTHER exit code means the shell ran and the
		// USER'S command exited with it (e.g. `cat missing` → 1, which also
		// prints "No such file"): that is a legitimate result, NOT a missing
		// shell, so we must return it verbatim instead of string-matching the
		// command's own output (the previous bug).
		if ec == 126 || ec == 127 {
			continue // this shell path is absent — try the next candidate
		}
		return map[string]interface{}{"output": string(out), "exitCode": ec}, ""
	}
	return map[string]interface{}{
		"output":   "⚠️ Container has no shell (scratch/distroless).",
		"exitCode": -1,
	}, ""
}

func (p *Poller) runStatus(ctx context.Context, task Task) (map[string]interface{}, string) {
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" {
		return nil, errStr
	}
	c := exec.CommandContext(ctx, "docker", "compose", "ps", "--format", "json")
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		return map[string]interface{}{"output": string(out)}, err.Error()
	}
	return map[string]interface{}{"output": string(out)}, ""
}

// runFileList lists a directory inside the app dir (remote file manager).
// Returns name/size/mtime/isDir per entry. Path traversal rejected.
func (p *Poller) runFileList(task Task) (map[string]interface{}, string) {
	slug, _ := task.Payload["slug"].(string)
	rel, _ := task.Payload["path"].(string)
	if slug == "" {
		return nil, "missing slug"
	}
	if rel == "" {
		rel = "."
	}
	safe := filepath.Clean(rel)
	if strings.HasPrefix(safe, "..") || filepath.IsAbs(safe) {
		return nil, "path traversal rejected"
	}
	base, errStr := resolveTaskDir(task.Payload)
	if errStr != "" {
		return nil, errStr
	}
	dir := filepath.Join(base, safe)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]interface{}{"exists": false, "entries": []interface{}{}}, ""
		}
		return nil, err.Error()
	}
	out := make([]map[string]interface{}, 0, len(entries))
	for _, e := range entries {
		info, ierr := e.Info()
		var size int64
		var mtime string
		if ierr == nil {
			size = info.Size()
			mtime = info.ModTime().UTC().Format(time.RFC3339)
		}
		out = append(out, map[string]interface{}{
			"name":  e.Name(),
			"isDir": e.IsDir(),
			"size":  size,
			"mtime": mtime,
		})
	}
	return map[string]interface{}{"exists": true, "entries": out}, ""
}

// runFileDelete removes a file or directory INSIDE the app dir (remote file
// manager delete). Confined to the resolved app dir; traversal rejected;
// deleting the app dir itself ('.') is refused — that's REMOVE's job.
func (p *Poller) runFileDelete(task Task) (map[string]interface{}, string) {
	rel, _ := task.Payload["path"].(string)
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" || rel == "" {
		return nil, "missing slug or path"
	}
	safe := filepath.Clean(rel)
	if safe == "." || safe == "/" || strings.HasPrefix(safe, "..") || strings.Contains(safe, "..") || filepath.IsAbs(safe) {
		return nil, "path traversal rejected"
	}
	full := filepath.Join(dir, safe)
	if _, err := os.Lstat(full); err != nil {
		if os.IsNotExist(err) {
			return nil, "path not found"
		}
		return nil, err.Error()
	}
	if err := os.RemoveAll(full); err != nil {
		return nil, err.Error()
	}
	return map[string]interface{}{"deleted": true}, ""
}

const maxPermsEntries = 100000

// resolveFilePathArg validates the `path` payload field against the app dir,
// rejecting traversal/absolute/root — shared by chmod/chown.
func resolveFilePathArg(payload map[string]interface{}) (full string, errStr string) {
	rel, _ := payload["path"].(string)
	dir, e := resolveTaskDir(payload)
	if e != "" || rel == "" {
		return "", "missing slug or path"
	}
	safe := filepath.Clean(rel)
	if safe == "." || safe == "/" || strings.HasPrefix(safe, "..") || strings.Contains(safe, "..") || filepath.IsAbs(safe) {
		return "", "path traversal rejected"
	}
	full = filepath.Join(dir, safe)
	if _, err := os.Lstat(full); err != nil {
		if os.IsNotExist(err) {
			return "", "path not found"
		}
		return "", err.Error()
	}
	return full, ""
}

// runFileChmod chmods a path inside the app dir. Payload: { slug, path, mode
// (number 0-0o777), recursive }. Refuses setuid/setgid/sticky; never follows
// symlinks; recursion is bounded.
func (p *Poller) runFileChmod(task Task) (map[string]interface{}, string) {
	modeF, _ := task.Payload["mode"].(float64) // JSON numbers arrive as float64
	recursive, _ := task.Payload["recursive"].(bool)
	mode := os.FileMode(int(modeF))
	if int(modeF) < 0 || (int(modeF)&^0o777) != 0 {
		return nil, "mode must be within 0000-0777 (setuid/setgid/sticky not allowed)"
	}
	full, errStr := resolveFilePathArg(task.Payload)
	if errStr != "" {
		return nil, errStr
	}
	st, err := os.Lstat(full)
	if err != nil {
		return nil, err.Error()
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, "refusing to chmod a symlink"
	}
	if err := os.Chmod(full, mode); err != nil {
		return nil, err.Error()
	}
	count := 0
	if recursive && st.IsDir() {
		werr := filepath.WalkDir(full, func(p string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if p == full {
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil // never chmod through a symlink
			}
			count++
			if count > maxPermsEntries {
				return fmt.Errorf("too many entries for recursive chmod")
			}
			return os.Chmod(p, mode)
		})
		if werr != nil {
			return nil, werr.Error()
		}
	}
	return map[string]interface{}{"entries": count + 1}, ""
}

// runFileChown chowns a path inside the app dir. Payload: { slug, path, owner
// ("user[:group]" | "uid[:gid]"), recursive }. Resolves names via the agent's
// /etc/passwd; never follows symlinks (Lchown); recursion is bounded.
func (p *Poller) runFileChown(task Task) (map[string]interface{}, string) {
	owner, _ := task.Payload["owner"].(string)
	recursive, _ := task.Payload["recursive"].(bool)
	uid, gid, errStr := resolveOwner(owner)
	if errStr != "" {
		return nil, errStr
	}
	full, errStr := resolveFilePathArg(task.Payload)
	if errStr != "" {
		return nil, errStr
	}
	st, err := os.Lstat(full)
	if err != nil {
		return nil, err.Error()
	}
	if st.Mode()&os.ModeSymlink != 0 {
		return nil, "refusing to chown a symlink"
	}
	if err := os.Lchown(full, uid, gid); err != nil {
		return nil, err.Error()
	}
	count := 0
	if recursive && st.IsDir() {
		werr := filepath.WalkDir(full, func(p string, d os.DirEntry, e error) error {
			if e != nil {
				return e
			}
			if p == full {
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			count++
			if count > maxPermsEntries {
				return fmt.Errorf("too many entries for recursive chown")
			}
			return os.Lchown(p, uid, gid)
		})
		if werr != nil {
			return nil, werr.Error()
		}
	}
	return map[string]interface{}{"entries": count + 1}, ""
}

// runFileFixPerms applies the web-app preset recursively: dirs→dirMode,
// files→fileMode. Payload: { slug, path, dirMode, fileMode }. Skips symlinks;
// bounded. (chown, when requested, is a separate FILE_CHOWN task.)
func (p *Poller) runFileFixPerms(task Task) (map[string]interface{}, string) {
	dirF, _ := task.Payload["dirMode"].(float64)
	fileF, _ := task.Payload["fileMode"].(float64)
	dirMode := os.FileMode(int(dirF) & 0o777)
	fileMode := os.FileMode(int(fileF) & 0o777)
	// Unlike chmod/chown, fix-perms legitimately targets the whole app root, so
	// an empty path ("." / "") is allowed here — but traversal is still rejected.
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" {
		return nil, errStr
	}
	rel, _ := task.Payload["path"].(string)
	safe := filepath.Clean(rel)
	if safe == "" || safe == "." || safe == "/" {
		safe = "."
	} else if strings.Contains(safe, "..") || filepath.IsAbs(safe) {
		return nil, "path traversal rejected"
	}
	full := filepath.Join(dir, safe)
	if _, err := os.Lstat(full); err != nil {
		if os.IsNotExist(err) {
			return nil, "path not found"
		}
		return nil, err.Error()
	}
	// Optional owner: the web-server user (www-data) must OWN the writable tree,
	// not just be in its group — otherwise a "775" dir owned by root leaves
	// www-data as "other" (r-x) and PrestaShop/WordPress still can't write
	// var/cache. We chown in the SAME walk so it's one atomic pass.
	uid, gid := -1, -1
	if ownerStr, _ := task.Payload["owner"].(string); ownerStr != "" {
		u, g, oerr := resolveOwner(ownerStr)
		if oerr != "" {
			return nil, oerr
		}
		uid, gid = u, g
	}
	dirs, files := 0, 0
	chownFailed := false // chmod is authoritative; chown is best-effort (EPERM)
	werr := filepath.WalkDir(full, func(p string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.Type()&os.ModeSymlink != 0 {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil // never chmod through a symlink
		}
		// Never touch a managed file (.dockcontrol.env secrets / override) —
		// 664 would expose them. Parity with the API's fixWebPermsLocal.
		if managedFiles[strings.ToLower(d.Name())] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if dirs+files > maxPermsEntries {
			return fmt.Errorf("too many entries to fix")
		}
		var mode os.FileMode
		if d.IsDir() {
			dirs++
			mode = dirMode
		} else if d.Type().IsRegular() {
			files++
			mode = fileMode
		} else {
			return nil // skip sockets/devices/fifos
		}
		if cerr := os.Chmod(p, mode); cerr != nil {
			return cerr
		}
		if (uid >= 0 || gid >= 0) && !chownFailed {
			// Lchown so a symlink (already filtered above, but be safe) target
			// is never followed. If the agent lacks privilege (EPERM), record
			// it and stop trying — the chmod above still applied, so the user
			// gets the perms fix and a clear "chown skipped" signal rather than
			// a hard failure that loses everything.
			if cerr := os.Lchown(p, uid, gid); cerr != nil {
				if os.IsPermission(cerr) {
					chownFailed = true
				} else {
					return cerr
				}
			}
		}
		return nil
	})
	if werr != nil {
		return nil, werr.Error()
	}
	return map[string]interface{}{"dirs": dirs, "files": files, "chownFailed": chownFailed}, ""
}

// resolveOwner parses "user[:group]" or "uid[:gid]" to numeric ids. Names are
// resolved against the agent's account db. Strict: any lookup failure errors.
func resolveOwner(owner string) (uid, gid int, errStr string) {
	owner = strings.TrimSpace(owner)
	if owner == "" {
		return 0, 0, "owner is required"
	}
	parts := strings.SplitN(owner, ":", 2)
	u, err := resolveUID(parts[0])
	if err != "" {
		return 0, 0, err
	}
	// Default gid = -1 ("leave the group unchanged", honored by os.Lchown),
	// NOT the uid — matches `chown <user>` CLI semantics. We only set a group
	// when one is given OR the user's primary gid is resolvable by name.
	g := -1
	if len(parts) == 2 && parts[1] != "" {
		gg, gerr := resolveGID(parts[1])
		if gerr != "" {
			return 0, 0, gerr
		}
		g = gg
	} else {
		// no group given: use the user's primary gid when resolvable by name.
		if usr, e := user.Lookup(parts[0]); e == nil {
			if pg, e2 := strconv.Atoi(usr.Gid); e2 == nil {
				g = pg
			}
		}
	}
	return u, g, ""
}

func resolveUID(s string) (int, string) {
	if n, err := strconv.Atoi(s); err == nil {
		return n, ""
	}
	usr, err := user.Lookup(s)
	if err != nil {
		return 0, "unknown user: " + s
	}
	n, _ := strconv.Atoi(usr.Uid)
	return n, ""
}

func resolveGID(s string) (int, string) {
	if n, err := strconv.Atoi(s); err == nil {
		return n, ""
	}
	grp, err := user.LookupGroup(s)
	if err != nil {
		return 0, "unknown group: " + s
	}
	n, _ := strconv.Atoi(grp.Gid)
	return n, ""
}

// runSftpSync replaces the embedded SFTP server's full account set with
// the payload's `accounts` array (API = source of truth, idempotent).
func (p *Poller) runSftpSync(task Task) (map[string]interface{}, string) {
	if p.Sftp == nil {
		return nil, "embedded SFTP server is not running on this agent (port busy at startup?)"
	}
	raw, ok := task.Payload["accounts"]
	if !ok {
		return nil, "missing accounts"
	}
	// Round-trip through JSON: the payload arrives as []interface{} of
	// map[string]interface{} — re-marshal is simpler and safer than
	// hand-walking the nesting.
	blob, err := json.Marshal(raw)
	if err != nil {
		return nil, "invalid accounts payload: " + err.Error()
	}
	var accounts []SftpAccountPayload
	if err := json.Unmarshal(blob, &accounts); err != nil {
		return nil, "invalid accounts payload: " + err.Error()
	}
	n := p.Sftp.Sync(accounts)
	return map[string]interface{}{"synced": n}, ""
}

// runDiskUsage reports the byte size of one or more app dirs — feeds the
// project storage quota for apps placed on this server.
func (p *Poller) runDiskUsage(task Task) (map[string]interface{}, string) {
	slugsRaw, _ := task.Payload["slugs"].([]interface{})
	usage := map[string]interface{}{}
	var total int64
	for _, raw := range slugsRaw {
		slug, ok := raw.(string)
		if !ok || slug == "" {
			continue
		}
		dir := appDir(slug)
		var size int64
		_ = filepath.Walk(dir, func(_ string, info os.FileInfo, err error) error {
			if err != nil {
				return nil // unreadable entries don't kill the walk
			}
			if info.Mode().IsRegular() {
				size += info.Size()
			}
			return nil
		})
		usage[slug] = size
		total += size
	}
	return map[string]interface{}{"perSlug": usage, "totalBytes": total}, ""
}

func (p *Poller) runFileRead(task Task) (map[string]interface{}, string) {
	name, _ := task.Payload["file"].(string)
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" || name == "" {
		return nil, "missing slug or file"
	}
	safe := filepath.Clean(name)
	if strings.HasPrefix(safe, "..") || strings.Contains(safe, "..") || filepath.IsAbs(safe) {
		return nil, "path traversal rejected"
	}
	full := filepath.Join(dir, safe)
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
	name, _ := task.Payload["file"].(string)
	content, _ := task.Payload["content"].(string)
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" || name == "" {
		return nil, "missing slug or file"
	}
	safe := filepath.Clean(name)
	if strings.HasPrefix(safe, "..") || strings.Contains(safe, "..") || filepath.IsAbs(safe) {
		return nil, "path traversal rejected"
	}
	// encoding=base64 → binary upload (remote file-manager upload path).
	data := []byte(content)
	if enc, _ := task.Payload["encoding"].(string); enc == "base64" {
		decoded, err := base64.StdEncoding.DecodeString(content)
		if err != nil {
			return nil, "invalid base64 content: " + err.Error()
		}
		data = decoded
	}
	full := filepath.Join(dir, safe)
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		return nil, err.Error()
	}
	if err := os.WriteFile(full, data, 0644); err != nil {
		return nil, err.Error()
	}
	return map[string]interface{}{"written": len(data)}, ""
}

// maxExtractBytes caps the total UNCOMPRESSED output of a single FILE_EXTRACT
// (zip-bomb defence). 2 GiB matches the API-side ceiling.
const maxExtractBytes int64 = 2 * 1024 * 1024 * 1024

// managedFiles must stay in sync with the API's MANAGED_FILES (files.service.ts)
// — a zip entry must never overwrite a DockControl-managed file. Compared
// case-insensitively against every path component.
var managedFiles = map[string]bool{
	".dockcontrol.env":            true,
	"docker-compose.override.yml": true,
}

// touchesManaged reports whether any component of a cleaned relative path is a
// managed filename (case-insensitive).
func touchesManaged(rel string) bool {
	for _, c := range strings.Split(filepath.ToSlash(rel), "/") {
		if managedFiles[strings.ToLower(c)] {
			return true
		}
	}
	return false
}

// archiveFormat detects the archive kind from a filename (mirrors the API's
// detectArchiveFormat). Returns "" for an unsupported name.
func archiveFormat(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.HasSuffix(n, ".zip"):
		return "zip"
	case strings.HasSuffix(n, ".tar.gz"), strings.HasSuffix(n, ".tgz"):
		return "tar.gz"
	case strings.HasSuffix(n, ".tar"):
		return "tar"
	case strings.HasSuffix(n, ".gz"):
		return "gz"
	default:
		return ""
	}
}

// runFileExtract extracts an archive IN PLACE inside the app dir. Payload:
//
//	{ slug|legacySlug, file: "<relpath>", dest: "<reldir>", format: "zip|tar.gz|tar|gz", deleteAfter: bool }
//
// Security mirrors untarGz (backup restore): every entry is filepath.Clean'd
// and rejected if it escapes the destination (zip-slip); non-regular entries
// (symlinks/devices) are skipped; the total uncompressed size is capped.
func (p *Poller) runFileExtract(task Task) (map[string]interface{}, string) {
	name, _ := task.Payload["file"].(string)
	dest, _ := task.Payload["dest"].(string)
	format, _ := task.Payload["format"].(string)
	deleteAfter, _ := task.Payload["deleteAfter"].(bool)
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" || name == "" {
		return nil, "missing slug or file"
	}
	if format == "" {
		format = archiveFormat(name)
	}
	if format == "" {
		return nil, "unsupported archive format"
	}

	safeZip := filepath.Clean(name)
	if strings.HasPrefix(safeZip, "..") || strings.Contains(safeZip, "..") || filepath.IsAbs(safeZip) {
		return nil, "path traversal rejected"
	}
	zipPath := filepath.Join(dir, safeZip)

	// Destination dir (parent of the archive by default; or an explicit reldir).
	destClean := filepath.Clean(dest)
	if dest == "" || destClean == "." {
		destClean = filepath.Dir(safeZip)
	}
	if strings.HasPrefix(destClean, "..") || strings.Contains(destClean, "..") || filepath.IsAbs(destClean) {
		return nil, "destination traversal rejected"
	}
	destAbs := filepath.Join(dir, destClean)

	written, errStr := extractArchiveInto(zipPath, destAbs, format)
	if errStr != "" {
		return nil, errStr
	}
	if deleteAfter {
		_ = os.Remove(zipPath)
	}
	return map[string]interface{}{"files": written, "deletedArchive": deleteAfter}, ""
}

// extractZipInto unzips zipPath into destAbs (both absolute), enforcing
// zip-slip (no entry may escape destAbs), skipping non-regular entries
// (symlinks/devices), and capping total uncompressed output at maxExtractBytes.
// Returns the number of files written, or a non-empty error string.
func extractZipInto(zipPath, destAbs string) (int, string) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, "archive not found"
		}
		return 0, "not a valid .zip: " + err.Error()
	}
	defer zr.Close()

	var total int64
	written := 0
	for _, f := range zr.File {
		entryName := filepath.Clean(filepath.FromSlash(f.Name))
		if entryName == "." {
			continue
		}
		// zip-slip: the resolved target must stay under destAbs.
		target := filepath.Join(destAbs, entryName)
		if target != destAbs && !strings.HasPrefix(target, destAbs+string(os.PathSeparator)) {
			return 0, fmt.Sprintf("entry %q escapes the destination", f.Name)
		}
		// Never let an archive overwrite a DockControl-managed file.
		if touchesManaged(entryName) {
			return 0, fmt.Sprintf("entry %q targets a managed file", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0755); err != nil {
				return 0, err.Error()
			}
			continue
		}
		// Skip symlinks / devices / anything not a regular file.
		if !f.FileInfo().Mode().IsRegular() {
			continue
		}
		// Budget remaining BEFORE this file (header sizes can lie, so we cap the
		// actual copy below — never trust UncompressedSize64 alone).
		remaining := maxExtractBytes - total
		if remaining <= 0 {
			return 0, fmt.Sprintf("archive decompresses beyond %d bytes (possible zip bomb)", maxExtractBytes)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return 0, err.Error()
		}
		rc, err := f.Open()
		if err != nil {
			return 0, err.Error()
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
		if err != nil {
			rc.Close()
			return 0, err.Error()
		}
		// Copy at most `remaining`+1 bytes: if we actually read more than the
		// budget, the archive lied about its size — reject as a zip bomb.
		n, copyErr := io.Copy(out, io.LimitReader(rc, remaining+1))
		rc.Close()
		closeErr := out.Close()
		if copyErr != nil {
			return 0, copyErr.Error()
		}
		if closeErr != nil {
			return 0, closeErr.Error()
		}
		if n > remaining {
			_ = os.Remove(target)
			return 0, fmt.Sprintf("archive decompresses beyond %d bytes (possible zip bomb)", maxExtractBytes)
		}
		total += n
		written++
	}
	return written, ""
}

// maxCompressBytes caps the total bytes the agent reads when building an
// archive. The archive is base64'd into the task-result JSON, which the API
// receives through express.json({ limit: '10mb' }) — base64 adds ~33% plus
// JSON overhead, so the COMPRESSED archive must stay well under 10 MiB or the
// result POST is rejected and the task hangs. We cap the RAW input read at
// 6 MiB; even with poor compression the archive + base64 stays under the API
// body limit. Larger remote selections should use SFTP, not this path.
const maxCompressBytes int64 = 6 * 1024 * 1024

// runFileCompress builds a .zip or .tar.gz of the selected paths and returns it
// base64 in the result. Payload: { slug|legacySlug, paths: []string, format }.
func (p *Poller) runFileCompress(task Task) (map[string]interface{}, string) {
	format, _ := task.Payload["format"].(string)
	rawPaths, _ := task.Payload["paths"].([]interface{})
	dir, errStr := resolveTaskDir(task.Payload)
	if errStr != "" {
		return nil, errStr
	}
	if format != "zip" && format != "tar.gz" {
		return nil, "unsupported compression format"
	}
	if len(rawPaths) == 0 {
		return nil, "no paths selected"
	}

	// Collect (archiveRelPath, absPath) for every regular file under the
	// selection, validating each against traversal.
	type entry struct{ rel, abs string }
	var files []entry
	var total int64
	var walk func(rel string) string
	walk = func(rel string) string {
		clean := filepath.Clean(rel)
		if strings.HasPrefix(clean, "..") || strings.Contains(clean, "..") || filepath.IsAbs(clean) {
			return "path traversal rejected"
		}
		abs := filepath.Join(dir, clean)
		fi, err := os.Lstat(abs)
		if err != nil {
			return "not found: " + rel
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return "refusing to compress a symlink: " + rel
		}
		if fi.IsDir() {
			ents, err := os.ReadDir(abs)
			if err != nil {
				return err.Error()
			}
			for _, e := range ents {
				if errStr := walk(filepath.ToSlash(filepath.Join(clean, e.Name()))); errStr != "" {
					return errStr
				}
			}
			return ""
		}
		if !fi.Mode().IsRegular() {
			return "" // skip devices/fifo
		}
		total += fi.Size()
		if total > maxCompressBytes {
			return fmt.Sprintf("selection exceeds %d bytes (use SFTP for large transfers)", maxCompressBytes)
		}
		files = append(files, entry{rel: filepath.ToSlash(clean), abs: abs})
		return ""
	}
	for _, rp := range rawPaths {
		s, _ := rp.(string)
		if s == "" {
			continue
		}
		if errStr := walk(s); errStr != "" {
			return nil, errStr
		}
	}
	if len(files) == 0 {
		return nil, "selection is empty"
	}

	var buf bytes.Buffer
	if format == "zip" {
		zw := zip.NewWriter(&buf)
		for _, f := range files {
			w, err := zw.Create(f.rel)
			if err != nil {
				return nil, err.Error()
			}
			src, err := os.Open(f.abs)
			if err != nil {
				return nil, err.Error()
			}
			_, copyErr := io.Copy(w, src)
			src.Close()
			if copyErr != nil {
				return nil, copyErr.Error()
			}
		}
		if err := zw.Close(); err != nil {
			return nil, err.Error()
		}
	} else { // tar.gz
		gw := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gw)
		for _, f := range files {
			fi, err := os.Stat(f.abs)
			if err != nil {
				return nil, err.Error()
			}
			hdr := &tar.Header{Name: f.rel, Mode: 0644, Size: fi.Size(), Typeflag: tar.TypeReg}
			if err := tw.WriteHeader(hdr); err != nil {
				return nil, err.Error()
			}
			src, err := os.Open(f.abs)
			if err != nil {
				return nil, err.Error()
			}
			_, copyErr := io.Copy(tw, src)
			src.Close()
			if copyErr != nil {
				return nil, copyErr.Error()
			}
		}
		if err := tw.Close(); err != nil {
			return nil, err.Error()
		}
		if err := gw.Close(); err != nil {
			return nil, err.Error()
		}
	}

	// Defence-in-depth: the archive rides the task-result JSON through the API's
	// 10 MiB body limit. Refuse if the produced archive is too big to fit
	// (rather than have the API silently reject the result POST and hang the
	// caller until timeout). 7 MiB raw → ~9.4 MiB base64, still under 10 MiB.
	if int64(buf.Len()) > 7*1024*1024 {
		return nil, "archive too large to return over the agent channel — use SFTP for large selections"
	}

	return map[string]interface{}{
		"archive": base64.StdEncoding.EncodeToString(buf.Bytes()),
		"files":   len(files),
	}, ""
}

// extractArchiveInto dispatches to the right extractor by format. All share the
// same zip-slip / managed-file / zip-bomb guards (writeArchiveEntry).
func extractArchiveInto(archivePath, destAbs, format string) (int, string) {
	switch format {
	case "zip":
		return extractZipInto(archivePath, destAbs)
	case "tar":
		f, err := os.Open(archivePath)
		if err != nil {
			if os.IsNotExist(err) {
				return 0, "archive not found"
			}
			return 0, err.Error()
		}
		defer f.Close()
		return extractTarStream(f, destAbs)
	case "tar.gz":
		f, err := os.Open(archivePath)
		if err != nil {
			if os.IsNotExist(err) {
				return 0, "archive not found"
			}
			return 0, err.Error()
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return 0, "not a valid gzip stream: " + err.Error()
		}
		defer gz.Close()
		return extractTarStream(gz, destAbs)
	case "gz":
		return extractGzInto(archivePath, destAbs)
	default:
		return 0, "unsupported archive format"
	}
}

// writeArchiveEntry validates one entry's relative name against zip-slip and
// the managed-file guard, then copies up to the remaining byte budget into
// destAbs. Returns bytes written (-1 on a skipped/dir entry) or an error string.
func writeArchiveEntry(destAbs, entryName string, mode os.FileMode, src io.Reader, remaining int64) (int64, string) {
	clean := filepath.Clean(filepath.FromSlash(entryName))
	if clean == "." {
		return -1, ""
	}
	target := filepath.Join(destAbs, clean)
	if target != destAbs && !strings.HasPrefix(target, destAbs+string(os.PathSeparator)) {
		return 0, fmt.Sprintf("entry %q escapes the destination", entryName)
	}
	if touchesManaged(clean) {
		return 0, fmt.Sprintf("entry %q targets a managed file", entryName)
	}
	if remaining <= 0 {
		return 0, fmt.Sprintf("archive decompresses beyond %d bytes (possible zip bomb)", maxExtractBytes)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return 0, err.Error()
	}
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return 0, err.Error()
	}
	n, copyErr := io.Copy(out, io.LimitReader(src, remaining+1))
	closeErr := out.Close()
	if copyErr != nil {
		return 0, copyErr.Error()
	}
	if closeErr != nil {
		return 0, closeErr.Error()
	}
	if n > remaining {
		_ = os.Remove(target)
		return 0, fmt.Sprintf("archive decompresses beyond %d bytes (possible zip bomb)", maxExtractBytes)
	}
	return n, ""
}

// extractTarStream extracts a (possibly gunzipped) tar stream into destAbs,
// only writing regular files; symlinks/devices/dirs are skipped or mkdir'd.
func extractTarStream(r io.Reader, destAbs string) (int, string) {
	tr := tar.NewReader(r)
	var total int64
	written := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return 0, "corrupt tar: " + err.Error()
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			clean := filepath.Clean(filepath.FromSlash(hdr.Name))
			target := filepath.Join(destAbs, clean)
			if target != destAbs && !strings.HasPrefix(target, destAbs+string(os.PathSeparator)) {
				return 0, fmt.Sprintf("entry %q escapes the destination", hdr.Name)
			}
			_ = os.MkdirAll(target, 0755)
		case tar.TypeReg:
			n, errStr := writeArchiveEntry(destAbs, hdr.Name, 0644, tr, maxExtractBytes-total)
			if errStr != "" {
				return 0, errStr
			}
			if n >= 0 {
				total += n
				written++
			}
		default:
			// symlink / hardlink / char / block / fifo — never created.
		}
	}
	return written, ""
}

// extractGzInto inflates a single-file .gz into destAbs, naming the output by
// stripping the trailing ".gz" from the archive's basename.
func extractGzInto(gzPath, destAbs string) (int, string) {
	f, err := os.Open(gzPath)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, "archive not found"
		}
		return 0, err.Error()
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return 0, "not a valid gzip stream: " + err.Error()
	}
	defer gz.Close()
	base := filepath.Base(gzPath)
	out := strings.TrimSuffix(base, filepath.Ext(base)) // drop ".gz"
	if out == "" {
		out = "extracted"
	}
	n, errStr := writeArchiveEntry(destAbs, out, 0644, gz, maxExtractBytes)
	if errStr != "" {
		return 0, errStr
	}
	if n < 0 {
		return 0, ""
	}
	return 1, ""
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
			log.Printf("task %s report rejected (%d): %s", taskID, resp.StatusCode, string(buf))
			// Permanent 4xx (bad token, unknown task, malformed) — retrying
			// won't help. Transient 4xx (408/409/425/429) and all 5xx are
			// worth retrying with the existing backoff.
			switch resp.StatusCode {
			case 408, 409, 425, 429:
				// transient — fall through to retry
			default:
				if resp.StatusCode < 500 {
					return
				}
			}
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
			continue
		}
		return
	}
	log.Printf("failed to report task %s after retries: %v", taskID, lastErr)
}
