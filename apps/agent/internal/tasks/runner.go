package tasks

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Runner executes the data-transfer task types. It is stateless apart from
// the transfer client, so a single instance is shared by all poller goroutines.
type Runner struct {
	client *Client
}

func NewRunner(client *Client) *Runner {
	return &Runner{client: client}
}

// ── payloads ─────────────────────────────────────────────────────────

type volumeExportPayload struct {
	Volumes []string `json:"volumes"`
}

type volumeImportPayload struct {
	Volumes      []string `json:"volumes"`
	SourceTaskID string   `json:"sourceTaskId"`
}

type volumeListPayload struct {
	Prefixes []string `json:"prefixes"`
}

type backupPayload struct {
	Databases  []DatabaseSpec `json:"databases"`
	Volumes    []string       `json:"volumes"`
	UploadName string         `json:"uploadName"`
}

type restorePayload struct {
	DownloadName string         `json:"downloadName"`
	SourceTaskID string         `json:"sourceTaskId"`
	Databases    []DatabaseSpec `json:"databases"`
	Volumes      []string       `json:"volumes"`
}

// decodePayload round-trips the poller's generic map through JSON into a
// typed struct — keeps parsing rules (field names, types) in one place.
func decodePayload(payload map[string]interface{}, dst interface{}) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("invalid payload: %v", err)
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("invalid payload: %v", err)
	}
	return nil
}

// manifest mirrors the API's BackupManifest shape (backups.service.ts) so an
// agent-produced archive is replayable by either side.
type manifest struct {
	Version   int             `json:"version"`
	Databases []manifestEntry `json:"databases"`
	Volumes   []string        `json:"volumes"`
}

type manifestEntry struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Container string `json:"container"`
	File      string `json:"file"`
	DumpAll   bool   `json:"dumpAll"`
}

// ── docker plumbing ──────────────────────────────────────────────────

// runDocker runs `docker argv...` and returns combined stderr on failure.
// stdout/stdin wiring is the caller's business via the cmd hooks.
func dockerCmd(ctx context.Context, argv []string) (*exec.Cmd, *bytes.Buffer) {
	cmd := exec.CommandContext(ctx, "docker", argv...)
	stderr := &bytes.Buffer{}
	cmd.Stderr = stderr
	return cmd, stderr
}

func dockerErr(argv []string, err error, stderr *bytes.Buffer) error {
	return fmt.Errorf("docker %s: %v: %s",
		strings.Join(redactArgv(argv), " "), err, tail(stderr.String(), 1000))
}

// runDockerToWriter runs docker with stdout streamed into w.
func runDockerToWriter(ctx context.Context, argv []string, w io.Writer) error {
	cmd, stderr := dockerCmd(ctx, argv)
	cmd.Stdout = w
	if err := cmd.Run(); err != nil {
		return dockerErr(argv, err, stderr)
	}
	return nil
}

// runDockerWithStdin runs docker with r streamed into stdin.
func runDockerWithStdin(ctx context.Context, argv []string, r io.Reader) error {
	cmd, stderr := dockerCmd(ctx, argv)
	cmd.Stdin = r
	if err := cmd.Run(); err != nil {
		return dockerErr(argv, err, stderr)
	}
	return nil
}

// runDockerQuiet runs docker discarding stdout (e.g. redis-cli SAVE,
// docker volume create).
func runDockerQuiet(ctx context.Context, argv []string) error {
	return runDockerToWriter(ctx, argv, io.Discard)
}

// runDockerCapture runs docker and returns its stdout as a string (for
// read-only listing commands like `docker volume ls`).
func runDockerCapture(ctx context.Context, argv []string) (string, error) {
	var out bytes.Buffer
	if err := runDockerToWriter(ctx, argv, &out); err != nil {
		return "", err
	}
	return out.String(), nil
}

func tail(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return "..." + s[len(s)-max:]
}

// ── VOLUME_EXPORT ────────────────────────────────────────────────────

// VolumeExport streams each volume as <volume>.tar.gz to the API's transfer
// endpoint under the task's own id. No temp file: docker's stdout is piped
// straight into the HTTP request body.
func (r *Runner) VolumeExport(ctx context.Context, taskID string, payload map[string]interface{}) (map[string]interface{}, string) {
	var p volumeExportPayload
	if err := decodePayload(payload, &p); err != nil {
		return nil, err.Error()
	}
	if len(p.Volumes) == 0 {
		return nil, "missing volumes"
	}
	for _, vol := range p.Volumes {
		if !validDockerName(vol) {
			return nil, fmt.Sprintf("invalid volume name %q", vol)
		}
	}
	for _, vol := range p.Volumes {
		log.Printf("volume export: %s → %s.tar.gz", vol, vol)
		if err := r.exportVolume(ctx, taskID, vol); err != nil {
			return nil, fmt.Sprintf("exporting volume %q: %v", vol, err)
		}
	}
	return map[string]interface{}{"volumes": len(p.Volumes)}, ""
}

func (r *Runner) exportVolume(ctx context.Context, taskID, vol string) error {
	// Pipe docker stdout → HTTP body. If either side fails, cancel the other
	// via CloseWithError so neither goroutine leaks.
	pr, pw := io.Pipe()
	dockerDone := make(chan error, 1)
	go func() {
		err := runDockerToWriter(ctx, volumeExportArgv(vol), pw)
		pw.CloseWithError(err)
		dockerDone <- err
	}()
	upErr := r.client.Upload(ctx, taskID, vol+".tar.gz", pr)
	// Unblock the docker goroutine if the upload died first.
	pr.CloseWithError(upErr)
	dockErr := <-dockerDone
	if dockErr != nil {
		return dockErr
	}
	return upErr
}

// ── VOLUME_IMPORT ────────────────────────────────────────────────────

// VolumeImport downloads each <volume>.tar.gz (uploaded by the export task
// sourceTaskId), creates the volume and unpacks the stream into it.
func (r *Runner) VolumeImport(ctx context.Context, payload map[string]interface{}) (map[string]interface{}, string) {
	var p volumeImportPayload
	if err := decodePayload(payload, &p); err != nil {
		return nil, err.Error()
	}
	if len(p.Volumes) == 0 {
		return nil, "missing volumes"
	}
	if p.SourceTaskID == "" {
		return nil, "missing sourceTaskId"
	}
	for _, vol := range p.Volumes {
		if !validDockerName(vol) {
			return nil, fmt.Sprintf("invalid volume name %q", vol)
		}
	}
	for _, vol := range p.Volumes {
		log.Printf("volume import: %s.tar.gz → %s", vol, vol)
		if err := r.importVolume(ctx, p.SourceTaskID, vol); err != nil {
			return nil, fmt.Sprintf("importing volume %q: %v", vol, err)
		}
	}
	return map[string]interface{}{"volumes": len(p.Volumes)}, ""
}

func (r *Runner) importVolume(ctx context.Context, sourceTaskID, vol string) error {
	body, err := r.client.Download(ctx, sourceTaskID, vol+".tar.gz")
	if err != nil {
		return err
	}
	defer body.Close()
	// Idempotent — `docker volume create` succeeds when the volume exists.
	if err := runDockerQuiet(ctx, []string{"volume", "create", vol}); err != nil {
		return err
	}
	return runDockerWithStdin(ctx, volumeImportArgv(vol), body)
}

// ── VOLUME_LIST ──────────────────────────────────────────────────────

// VolumeList enumerates the docker volumes on this host and returns only
// those whose name starts with one of the requested prefixes. Read-only:
// it never creates, removes or mutates anything. Lets the API discover a
// stack's REAL volume names instead of guessing them for remote migration.
func (r *Runner) VolumeList(ctx context.Context, payload map[string]interface{}) (map[string]interface{}, string) {
	var p volumeListPayload
	if err := decodePayload(payload, &p); err != nil {
		return nil, err.Error()
	}
	out, err := runDockerCapture(ctx, volumeListArgv())
	if err != nil {
		return nil, err.Error()
	}
	names := []string{}
	for _, line := range strings.Split(out, "\n") {
		if name := strings.TrimSpace(line); name != "" {
			names = append(names, name)
		}
	}
	matched := filterByPrefix(names, p.Prefixes)
	return map[string]interface{}{"volumes": matched}, ""
}

// ── BACKUP ───────────────────────────────────────────────────────────

// Backup dumps the requested databases and volumes into a temp staging dir,
// writes manifest.json, packs everything into one tar.gz and uploads it as
// uploadName under the task's own id. Result: {"sizeBytes": N}.
func (r *Runner) Backup(ctx context.Context, taskID string, payload map[string]interface{}) (map[string]interface{}, string) {
	var p backupPayload
	if err := decodePayload(payload, &p); err != nil {
		return nil, err.Error()
	}
	if p.UploadName == "" {
		p.UploadName = "backup.tar.gz"
	}
	for _, vol := range p.Volumes {
		if !validDockerName(vol) {
			return nil, fmt.Sprintf("invalid volume name %q", vol)
		}
	}

	staging, err := os.MkdirTemp(os.TempDir(), "dockcontrol-backup-")
	if err != nil {
		return nil, "creating staging dir: " + err.Error()
	}
	defer os.RemoveAll(staging)

	m := manifest{Version: 1, Databases: []manifestEntry{}, Volumes: []string{}}

	// Database dumps via docker exec, streamed to staging files.
	if len(p.Databases) > 0 {
		dbDir := filepath.Join(staging, "databases")
		if err := os.MkdirAll(dbDir, 0700); err != nil {
			return nil, err.Error()
		}
		for _, db := range p.Databases {
			file, err := dumpFileName(db)
			if err != nil {
				return nil, err.Error()
			}
			log.Printf("backup: dumping database %s (%s, container %s)", db.Name, db.Type, db.Container)
			if err := dumpDatabaseToFile(ctx, db, filepath.Join(dbDir, file)); err != nil {
				return nil, fmt.Sprintf("dumping database %q: %v", db.Name, err)
			}
			m.Databases = append(m.Databases, manifestEntry{
				ID:        db.ID,
				Name:      db.Name,
				Type:      db.Type,
				Container: db.Container,
				File:      "databases/" + file,
				DumpAll:   db.DumpAll,
			})
		}
	}

	// Volume tars via busybox, streamed to staging files.
	if len(p.Volumes) > 0 {
		volDir := filepath.Join(staging, "volumes")
		if err := os.MkdirAll(volDir, 0700); err != nil {
			return nil, err.Error()
		}
		for _, vol := range p.Volumes {
			log.Printf("backup: dumping volume %s", vol)
			if err := dumpToFile(ctx, volumeExportArgv(vol), filepath.Join(volDir, vol+".tar.gz")); err != nil {
				return nil, fmt.Sprintf("dumping volume %q: %v", vol, err)
			}
			m.Volumes = append(m.Volumes, vol)
		}
	}

	manifestJSON, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, "encoding manifest: " + err.Error()
	}
	if err := os.WriteFile(filepath.Join(staging, "manifest.json"), manifestJSON, 0600); err != nil {
		return nil, "writing manifest: " + err.Error()
	}

	// Pack staging → tar.gz (native Go — no host tar dependency), then
	// upload. A temp archive file (not a pipe) so sizeBytes is exact and the
	// upload gets a complete archive even if packing fails midway.
	archive, err := os.CreateTemp(os.TempDir(), "dockcontrol-backup-*.tar.gz")
	if err != nil {
		return nil, "creating archive temp: " + err.Error()
	}
	archivePath := archive.Name()
	defer os.Remove(archivePath)

	if err := tarGzDir(staging, archive); err != nil {
		archive.Close()
		return nil, "packing archive: " + err.Error()
	}
	if err := archive.Close(); err != nil {
		return nil, "closing archive: " + err.Error()
	}
	info, err := os.Stat(archivePath)
	if err != nil {
		return nil, err.Error()
	}

	f, err := os.Open(archivePath)
	if err != nil {
		return nil, err.Error()
	}
	defer f.Close()
	log.Printf("backup: uploading %s (%d bytes)", p.UploadName, info.Size())
	if err := r.client.Upload(ctx, taskID, p.UploadName, f); err != nil {
		return nil, "uploading archive: " + err.Error()
	}

	return map[string]interface{}{"sizeBytes": info.Size()}, ""
}

// dumpDatabaseToFile runs the per-type pre-commands then streams the dump
// command's stdout into outPath.
func dumpDatabaseToFile(ctx context.Context, db DatabaseSpec, outPath string) error {
	pre, dump, err := dumpPlan(db)
	if err != nil {
		return err
	}
	for _, argv := range pre {
		if err := runDockerQuiet(ctx, argv); err != nil {
			return err
		}
	}
	return dumpToFile(ctx, dump, outPath)
}

// dumpToFile streams a docker command's stdout into a file.
func dumpToFile(ctx context.Context, argv []string, outPath string) error {
	out, err := os.OpenFile(outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	if err := runDockerToWriter(ctx, argv, out); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ── RESTORE ──────────────────────────────────────────────────────────

// Restore downloads the archive (uploaded by the backup task sourceTaskId),
// extracts it into a temp dir, then replays database dumps and volume tars.
// Any failed step fails the whole task with a step-precise error.
func (r *Runner) Restore(ctx context.Context, payload map[string]interface{}) (map[string]interface{}, string) {
	var p restorePayload
	if err := decodePayload(payload, &p); err != nil {
		return nil, err.Error()
	}
	if p.DownloadName == "" {
		p.DownloadName = "backup.tar.gz"
	}
	if p.SourceTaskID == "" {
		return nil, "missing sourceTaskId"
	}
	for _, vol := range p.Volumes {
		if !validDockerName(vol) {
			return nil, fmt.Sprintf("invalid volume name %q", vol)
		}
	}

	extractDir, err := os.MkdirTemp(os.TempDir(), "dockcontrol-restore-")
	if err != nil {
		return nil, "creating extract dir: " + err.Error()
	}
	defer os.RemoveAll(extractDir)

	log.Printf("restore: downloading %s", p.DownloadName)
	body, err := r.client.Download(ctx, p.SourceTaskID, p.DownloadName)
	if err != nil {
		return nil, "downloading archive: " + err.Error()
	}
	err = untarGz(body, extractDir)
	body.Close()
	if err != nil {
		return nil, "extracting archive: " + err.Error()
	}

	databasesRestored := 0
	for _, db := range p.Databases {
		file, err := dumpFileName(db)
		if err != nil {
			return nil, err.Error()
		}
		dumpFile := filepath.Join(extractDir, "databases", file)
		if _, err := os.Stat(dumpFile); err != nil {
			return nil, fmt.Sprintf("restore failed at database %q: dump file %s missing from archive", db.Name, "databases/"+file)
		}
		log.Printf("restore: database %s (%s, container %s)", db.Name, db.Type, db.Container)
		if err := restoreDatabase(ctx, db, dumpFile); err != nil {
			return nil, fmt.Sprintf("restore failed at database %q: %v", db.Name, err)
		}
		databasesRestored++
	}

	volumesRestored := 0
	for _, vol := range p.Volumes {
		tarFile := filepath.Join(extractDir, "volumes", vol+".tar.gz")
		if _, err := os.Stat(tarFile); err != nil {
			return nil, fmt.Sprintf("restore failed at volume %q: tar volumes/%s.tar.gz missing from archive", vol, vol)
		}
		log.Printf("restore: volume %s", vol)
		if err := restoreVolume(ctx, vol, tarFile); err != nil {
			return nil, fmt.Sprintf("restore failed at volume %q (after %d database(s) restored): %v", vol, databasesRestored, err)
		}
		volumesRestored++
	}

	return map[string]interface{}{
		"databasesRestored": databasesRestored,
		"volumesRestored":   volumesRestored,
	}, ""
}

func restoreDatabase(ctx context.Context, db DatabaseSpec, dumpFile string) error {
	steps, err := restorePlan(db, dumpFile)
	if err != nil {
		return err
	}
	for _, step := range steps {
		if step.stdinFile != "" {
			f, err := os.Open(step.stdinFile)
			if err != nil {
				return err
			}
			err = runDockerWithStdin(ctx, step.argv, f)
			f.Close()
			if err != nil {
				return err
			}
			continue
		}
		if err := runDockerQuiet(ctx, step.argv); err != nil {
			return err
		}
	}
	return nil
}

func restoreVolume(ctx context.Context, vol, tarFile string) error {
	if err := runDockerQuiet(ctx, []string{"volume", "create", vol}); err != nil {
		return err
	}
	f, err := os.Open(tarFile)
	if err != nil {
		return err
	}
	defer f.Close()
	return runDockerWithStdin(ctx, volumeImportArgv(vol), f)
}

// ── archive helpers (native Go tar.gz) ───────────────────────────────

// tarGzDir packs the contents of dir (paths relative to dir) into w as a
// gzip'd tar — equivalent to `tar -czf - -C dir .` minus the leading "./".
func tarGzDir(dir string, w io.Writer) error {
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)

	err := filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		name := filepath.ToSlash(rel)
		hdr, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		hdr.Name = name
		if info.IsDir() {
			hdr.Name += "/"
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return gz.Close()
}

// untarGz extracts a gzip'd tar stream into dir, rejecting entries that
// would escape it (zip-slip) and skipping non-file/dir entry types.
func untarGz(r io.Reader, dir string) error {
	gz, err := gzip.NewReader(r)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	cleanDir := filepath.Clean(dir)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := filepath.Clean(filepath.FromSlash(hdr.Name))
		if name == "." {
			continue
		}
		target := filepath.Join(cleanDir, name)
		if target != cleanDir && !strings.HasPrefix(target, cleanDir+string(os.PathSeparator)) {
			return fmt.Errorf("archive entry %q escapes extraction dir", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		default:
			// Symlinks/devices have no business in a dockcontrol backup —
			// skip rather than create escape hatches.
		}
	}
}
