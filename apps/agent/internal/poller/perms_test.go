package poller

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func setupAppDir(t *testing.T, slug string) (root, appDir string) {
	t.Helper()
	root = t.TempDir()
	appDir = filepath.Join(root, slug)
	if err := os.MkdirAll(filepath.Join(appDir, "var", "cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "var", "f.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	return root, appDir
}

func TestRunFileChmod_AppliesMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod bits are not meaningful on Windows")
	}
	root, appDir := setupAppDir(t, "app1")
	old := appsBaseDir
	appsBaseDir = root
	defer func() { appsBaseDir = old }()

	p := &Poller{}
	_, errStr := p.runFileChmod(Task{Payload: map[string]interface{}{
		"slug": "app1", "path": "var", "mode": float64(0o775), "recursive": true,
	}})
	if errStr != "" {
		t.Fatalf("chmod: %s", errStr)
	}
	fi, _ := os.Stat(filepath.Join(appDir, "var", "f.txt"))
	if fi.Mode().Perm() != 0o775 {
		t.Fatalf("recursive chmod didn't apply: %o", fi.Mode().Perm())
	}
}

func TestRunFileChmod_RejectsSetuid(t *testing.T) {
	root, _ := setupAppDir(t, "app2")
	old := appsBaseDir
	appsBaseDir = root
	defer func() { appsBaseDir = old }()
	p := &Poller{}
	_, errStr := p.runFileChmod(Task{Payload: map[string]interface{}{
		"slug": "app2", "path": "var", "mode": float64(0o4755),
	}})
	if errStr == "" || !strings.Contains(errStr, "setuid") {
		t.Fatalf("expected setuid rejection, got %q", errStr)
	}
}

func TestRunFileChmod_TraversalRejected(t *testing.T) {
	root, _ := setupAppDir(t, "app3")
	old := appsBaseDir
	appsBaseDir = root
	defer func() { appsBaseDir = old }()
	p := &Poller{}
	_, errStr := p.runFileChmod(Task{Payload: map[string]interface{}{
		"slug": "app3", "path": "../../etc", "mode": float64(0o777),
	}})
	if errStr == "" || !strings.Contains(errStr, "traversal") {
		t.Fatalf("expected traversal rejection, got %q", errStr)
	}
}

func TestRunFileChown_Numeric(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() != 0 {
		t.Skip("chown requires root and a POSIX fs")
	}
	root, appDir := setupAppDir(t, "app4")
	old := appsBaseDir
	appsBaseDir = root
	defer func() { appsBaseDir = old }()
	p := &Poller{}
	_, errStr := p.runFileChown(Task{Payload: map[string]interface{}{
		"slug": "app4", "path": "var", "owner": "33:33", "recursive": true,
	}})
	if errStr != "" {
		t.Fatalf("chown: %s", errStr)
	}
	_ = appDir
}

func TestResolveOwner_ParsesForms(t *testing.T) {
	if u, g, e := resolveOwner("1000:1000"); e != "" || u != 1000 || g != 1000 {
		t.Fatalf("numeric: %d %d %q", u, g, e)
	}
	if _, _, e := resolveOwner("definitely-not-a-real-user-xyz"); e == "" {
		t.Fatal("expected unknown-user error")
	}
	if _, _, e := resolveOwner(""); e == "" {
		t.Fatal("expected empty-owner error")
	}
}

func TestRunFileChown_RejectsTraversal(t *testing.T) {
	root, _ := setupAppDir(t, "app5")
	old := appsBaseDir
	appsBaseDir = root
	defer func() { appsBaseDir = old }()
	p := &Poller{}
	_, errStr := p.runFileChown(Task{Payload: map[string]interface{}{
		"slug": "app5", "path": "../escape", "owner": "1000",
	}})
	if errStr == "" || !strings.Contains(errStr, "traversal") {
		t.Fatalf("expected traversal rejection, got %q", errStr)
	}
}

func TestRunFileFixPerms_AppliesAndSkipsManaged(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod bits are not meaningful on Windows")
	}
	root, appDir := setupAppDir(t, "app6")
	// A secret file at the app root, hardened to 0600.
	if err := os.WriteFile(filepath.Join(appDir, ".dockcontrol.env"), []byte("S=1"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := appsBaseDir
	appsBaseDir = root
	defer func() { appsBaseDir = old }()

	p := &Poller{}
	// Empty path = whole app root (fix-perms allows the root, unlike chmod).
	res, errStr := p.runFileFixPerms(Task{Payload: map[string]interface{}{
		"slug": "app6", "path": "", "dirMode": float64(0o775), "fileMode": float64(0o664),
	}})
	if errStr != "" {
		t.Fatalf("fixperms: %s", errStr)
	}
	// a regular file → 0664
	if fi, _ := os.Stat(filepath.Join(appDir, "var", "f.txt")); fi.Mode().Perm() != 0o664 {
		t.Fatalf("file mode = %o, want 664", fi.Mode().Perm())
	}
	// a directory → 0775
	if fi, _ := os.Stat(filepath.Join(appDir, "var")); fi.Mode().Perm() != 0o775 {
		t.Fatalf("dir mode = %o, want 775", fi.Mode().Perm())
	}
	// the managed secret stays 0600 — NEVER downgraded
	if fi, _ := os.Stat(filepath.Join(appDir, ".dockcontrol.env")); fi.Mode().Perm() != 0o600 {
		t.Fatalf("SECRET LEAK: .dockcontrol.env = %o, want 600", fi.Mode().Perm())
	}
	if res["files"].(int) < 1 || res["dirs"].(int) < 1 {
		t.Fatalf("unexpected counts: %+v", res)
	}
}

func TestRunFileFixPerms_TraversalRejected(t *testing.T) {
	root, _ := setupAppDir(t, "app7")
	old := appsBaseDir
	appsBaseDir = root
	defer func() { appsBaseDir = old }()
	p := &Poller{}
	_, errStr := p.runFileFixPerms(Task{Payload: map[string]interface{}{
		"slug": "app7", "path": "../../etc", "dirMode": float64(0o775), "fileMode": float64(0o664),
	}})
	if errStr == "" || !strings.Contains(errStr, "traversal") {
		t.Fatalf("expected traversal rejection, got %q", errStr)
	}
}
