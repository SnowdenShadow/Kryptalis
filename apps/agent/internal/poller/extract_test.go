package poller

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// makeTar builds a tar (optionally gzipped) with the given entries, returning
// its temp-file path. ext controls the filename suffix (.tar / .tar.gz).
func makeTar(t *testing.T, files map[string]string, gzipped bool, ext string) string {
	t.Helper()
	var buf bytes.Buffer
	var tw *tar.Writer
	var gw *gzip.Writer
	if gzipped {
		gw = gzip.NewWriter(&buf)
		tw = tar.NewWriter(gw)
	} else {
		tw = tar.NewWriter(&buf)
	}
	for name, content := range files {
		hdr := &tar.Header{Name: name, Mode: 0644, Size: int64(len(content)), Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("tar header %q: %v", name, err)
		}
		if _, err := tw.Write([]byte(content)); err != nil {
			t.Fatalf("tar write %q: %v", name, err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatalf("tar close: %v", err)
	}
	if gzipped {
		if err := gw.Close(); err != nil {
			t.Fatalf("gzip close: %v", err)
		}
	}
	p := filepath.Join(t.TempDir(), "archive"+ext)
	if err := os.WriteFile(p, buf.Bytes(), 0644); err != nil {
		t.Fatalf("write tar: %v", err)
	}
	return p
}

// makeZip builds an in-memory .zip with the given name→content entries and
// writes it to a temp file, returning its path.
func makeZip(t *testing.T, files map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %q: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %q: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	p := filepath.Join(t.TempDir(), "archive.zip")
	if err := os.WriteFile(p, buf.Bytes(), 0644); err != nil {
		t.Fatalf("write zip: %v", err)
	}
	return p
}

func TestExtractZipInto_HappyPath(t *testing.T) {
	zipPath := makeZip(t, map[string]string{
		"index.php":       "<?php echo 1;",
		"config/app.php":  "return [];",
		"assets/logo.txt": "logo",
	})
	dest := t.TempDir()

	n, errStr := extractZipInto(zipPath, dest)
	if errStr != "" {
		t.Fatalf("unexpected error: %s", errStr)
	}
	if n != 3 {
		t.Fatalf("files = %d, want 3", n)
	}
	got, err := os.ReadFile(filepath.Join(dest, "config", "app.php"))
	if err != nil || string(got) != "return [];" {
		t.Fatalf("nested file not extracted correctly: %v / %q", err, string(got))
	}
}

func TestExtractZipInto_ZipSlipRejected(t *testing.T) {
	zipPath := makeZip(t, map[string]string{
		"ok.txt":        "fine",
		"../escape.txt": "pwned",
	})
	dest := t.TempDir()

	_, errStr := extractZipInto(zipPath, dest)
	if errStr == "" || !strings.Contains(errStr, "escapes") {
		t.Fatalf("expected zip-slip rejection, got %q", errStr)
	}
	// The escaping file must NOT have been written next to dest.
	if _, err := os.Stat(filepath.Join(filepath.Dir(dest), "escape.txt")); err == nil {
		t.Fatal("escape.txt was written outside the destination!")
	}
}

func TestExtractZipInto_ManagedFileRejected(t *testing.T) {
	for _, bad := range []string{".dockcontrol.env", "sub/docker-compose.override.yml", "DOCKER-COMPOSE.OVERRIDE.YML"} {
		zipPath := makeZip(t, map[string]string{"ok.txt": "fine", bad: "evil"})
		_, errStr := extractZipInto(zipPath, t.TempDir())
		if errStr == "" || !strings.Contains(errStr, "managed") {
			t.Fatalf("entry %q: expected managed-file rejection, got %q", bad, errStr)
		}
	}
}

func TestExtractZipInto_NotAZip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "nope.zip")
	if err := os.WriteFile(p, []byte("definitely not a zip"), 0644); err != nil {
		t.Fatal(err)
	}
	_, errStr := extractZipInto(p, t.TempDir())
	if errStr == "" {
		t.Fatal("expected error for non-zip input")
	}
}

func TestExtractZipInto_MissingArchive(t *testing.T) {
	_, errStr := extractZipInto(filepath.Join(t.TempDir(), "ghost.zip"), t.TempDir())
	if errStr != "archive not found" {
		t.Fatalf("error = %q, want 'archive not found'", errStr)
	}
}

func TestExtractZipInto_CreatesNestedDirs(t *testing.T) {
	zipPath := makeZip(t, map[string]string{"a/b/c/deep.txt": "x"})
	dest := t.TempDir()
	if _, errStr := extractZipInto(zipPath, dest); errStr != "" {
		t.Fatalf("error: %s", errStr)
	}
	if _, err := os.Stat(filepath.Join(dest, "a", "b", "c", "deep.txt")); err != nil {
		t.Fatalf("nested dirs not created: %v", err)
	}
}

// ─── tar / tar.gz / gz via extractArchiveInto ──────────────────────────

func TestExtractArchive_TarGz_HappyPath(t *testing.T) {
	p := makeTar(t, map[string]string{"index.php": "<?php", "sub/dir/f.txt": "hi"}, true, ".tar.gz")
	dest := t.TempDir()
	n, errStr := extractArchiveInto(p, dest, "tar.gz")
	if errStr != "" {
		t.Fatalf("unexpected error: %s", errStr)
	}
	if n != 2 {
		t.Fatalf("files = %d, want 2", n)
	}
	got, err := os.ReadFile(filepath.Join(dest, "sub", "dir", "f.txt"))
	if err != nil || string(got) != "hi" {
		t.Fatalf("nested file wrong: %v / %q", err, string(got))
	}
}

func TestExtractArchive_Tar_HappyPath(t *testing.T) {
	p := makeTar(t, map[string]string{"a.txt": "one"}, false, ".tar")
	dest := t.TempDir()
	n, errStr := extractArchiveInto(p, dest, "tar")
	if errStr != "" || n != 1 {
		t.Fatalf("tar extract: n=%d err=%q", n, errStr)
	}
}

func TestExtractArchive_TarZipSlipRejected(t *testing.T) {
	p := makeTar(t, map[string]string{"../escape.txt": "pwned"}, true, ".tar.gz")
	dest := t.TempDir()
	_, errStr := extractArchiveInto(p, dest, "tar.gz")
	if errStr == "" || !strings.Contains(errStr, "escapes") {
		t.Fatalf("expected zip-slip rejection, got %q", errStr)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dest), "escape.txt")); err == nil {
		t.Fatal("escape.txt written outside destination!")
	}
}

func TestExtractArchive_TarManagedRejected(t *testing.T) {
	p := makeTar(t, map[string]string{".dockcontrol.env": "evil"}, true, ".tar.gz")
	_, errStr := extractArchiveInto(p, t.TempDir(), "tar.gz")
	if errStr == "" || !strings.Contains(errStr, "managed") {
		t.Fatalf("expected managed-file rejection, got %q", errStr)
	}
}

func TestExtractArchive_Gz_SingleFile(t *testing.T) {
	// Build dump.sql.gz → should extract to dump.sql.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	gw.Write([]byte("SELECT 1;"))
	gw.Close()
	p := filepath.Join(t.TempDir(), "dump.sql.gz")
	os.WriteFile(p, buf.Bytes(), 0644)
	dest := t.TempDir()
	n, errStr := extractArchiveInto(p, dest, "gz")
	if errStr != "" || n != 1 {
		t.Fatalf("gz extract: n=%d err=%q", n, errStr)
	}
	got, err := os.ReadFile(filepath.Join(dest, "dump.sql"))
	if err != nil || string(got) != "SELECT 1;" {
		t.Fatalf("gz output wrong: %v / %q", err, string(got))
	}
}

func TestExtractArchive_UnsupportedFormat(t *testing.T) {
	if _, errStr := extractArchiveInto("x", "y", "rar"); errStr == "" {
		t.Fatal("expected error for unsupported format")
	}
}

func TestArchiveFormat_Detection(t *testing.T) {
	cases := map[string]string{
		"a.zip": "zip", "b.tar.gz": "tar.gz", "c.tgz": "tar.gz",
		"d.tar": "tar", "e.sql.gz": "gz", "f.txt": "",
	}
	for name, want := range cases {
		if got := archiveFormat(name); got != want {
			t.Errorf("archiveFormat(%q) = %q, want %q", name, got, want)
		}
	}
}

// ─── FILE_COMPRESS ─────────────────────────────────────────────────────

// compressRoundTrip builds an app dir with files, runs runFileCompress, then
// extracts the produced archive and checks the contents survive.
func TestRunFileCompress_ZipRoundTrip(t *testing.T) {
	appsRoot := t.TempDir()
	slug := "myapp"
	appDir := filepath.Join(appsRoot, slug)
	_ = os.MkdirAll(filepath.Join(appDir, "config"), 0755)
	os.WriteFile(filepath.Join(appDir, "index.php"), []byte("<?php"), 0644)
	os.WriteFile(filepath.Join(appDir, "config", "app.php"), []byte("return [];"), 0644)

	// resolveTaskDir derives /opt/dockcontrol/apps/<slug>; override base by
	// using an explicit "dir" payload is not supported, so we test the inner
	// compress logic by calling the handler with a fake apps root via dirEnv.
	// Simpler: point the slug dir through the same resolveTaskDir contract by
	// temporarily symlinking is overkill — instead assert on the archive bytes
	// produced when we feed the real appDir through a tiny shim.
	p := &Poller{}
	task := Task{Payload: map[string]interface{}{
		"slug":   slug,
		"format": "zip",
		"paths":  []interface{}{"index.php", "config"},
	}}
	// Redirect resolveTaskDir to our temp apps root for this test.
	oldFn := appsBaseDir
	appsBaseDir = appsRoot
	defer func() { appsBaseDir = oldFn }()

	res, errStr := p.runFileCompress(task)
	if errStr != "" {
		t.Fatalf("runFileCompress: %s", errStr)
	}
	if res["files"].(int) != 2 {
		t.Fatalf("files = %v, want 2", res["files"])
	}
	b64, _ := res["archive"].(string)
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(raw) == 0 {
		t.Fatalf("bad base64 archive: %v", err)
	}
	// Re-open the produced zip and verify entries.
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatalf("produced zip invalid: %v", err)
	}
	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if !names["index.php"] || !names["config/app.php"] {
		t.Fatalf("zip missing entries: %v", names)
	}
}

func TestRunFileCompress_RejectsSymlink(t *testing.T) {
	appsRoot := t.TempDir()
	slug := "app2"
	appDir := filepath.Join(appsRoot, slug)
	_ = os.MkdirAll(appDir, 0755)
	os.WriteFile(filepath.Join(appDir, "real.txt"), []byte("x"), 0644)
	// symlink pointing anywhere — compress must refuse it.
	if err := os.Symlink("/etc/passwd", filepath.Join(appDir, "link")); err != nil {
		t.Skip("symlink not supported on this platform")
	}
	oldFn := appsBaseDir
	appsBaseDir = appsRoot
	defer func() { appsBaseDir = oldFn }()

	p := &Poller{}
	_, errStr := p.runFileCompress(Task{Payload: map[string]interface{}{
		"slug": slug, "format": "tar.gz", "paths": []interface{}{"link"},
	}})
	if errStr == "" || !strings.Contains(errStr, "symlink") {
		t.Fatalf("expected symlink rejection, got %q", errStr)
	}
}
