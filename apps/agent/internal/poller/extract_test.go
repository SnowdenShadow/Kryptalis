package poller

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
