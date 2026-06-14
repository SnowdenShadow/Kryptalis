package sftpserver

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/pkg/sftp"
)

// newHandlers builds a WRITE-capable scopedHandlers rooted at a single dir.
func newHandlers(t *testing.T, root string) *scopedHandlers {
	t.Helper()
	return &scopedHandlers{acc: Account{
		Username:   "u",
		Permission: "WRITE",
		Roots:      map[string]string{"app": root},
	}}
}

// writeReq fakes the minimal sftp.Request the handlers read.
func writeReq(vpath string, flags uint32) *sftp.Request {
	return &sftp.Request{Method: "Put", Filepath: vpath, Flags: flags}
}

// sshFxfWrite|sshFxfCreat with NO append — the common upload/overwrite case.
// pkg/sftp does not export these constants; mirror the on-wire values.
const (
	flagWrite  = 0x00000002
	flagAppend = 0x00000004
	flagCreat  = 0x00000008
	flagTrunc  = 0x00000010
)

// TestFilewrite_TruncatesOnOverwrite is the regression test for the stale-tail
// corruption bug: overwriting a longer file with shorter content must not leave
// the old tail behind.
func TestFilewrite_TruncatesOnOverwrite(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "f.txt")
	if err := os.WriteFile(target, []byte("AAAAAAAAAAAAAAAAAAAA"), 0o644); err != nil {
		t.Fatal(err)
	}

	h := newHandlers(t, root)
	w, err := h.Filewrite(writeReq("/app/f.txt", flagWrite|flagCreat))
	if err != nil {
		t.Fatalf("Filewrite: %v", err)
	}
	if _, err := w.WriteAt([]byte("BBB"), 0); err != nil {
		t.Fatalf("WriteAt: %v", err)
	}
	if c, ok := w.(interface{ Close() error }); ok {
		_ = c.Close()
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "BBB" {
		t.Fatalf("stale tail not truncated: got %q want %q", string(got), "BBB")
	}
}

// TestFilewrite_PartialOffsetWrite ensures a non-zero starting offset still
// lands the bytes correctly (truncate-on-open does not break offset writes).
func TestFilewrite_PartialOffsetWrite(t *testing.T) {
	root := t.TempDir()
	h := newHandlers(t, root)
	w, err := h.Filewrite(writeReq("/app/g.txt", flagWrite|flagCreat))
	if err != nil {
		t.Fatalf("Filewrite: %v", err)
	}
	if _, err := w.WriteAt([]byte("XYZ"), 3); err != nil {
		t.Fatalf("WriteAt: %v", err)
	}
	if c, ok := w.(interface{ Close() error }); ok {
		_ = c.Close()
	}
	got, _ := os.ReadFile(filepath.Join(root, "g.txt"))
	// First 3 bytes are the implicit hole (NUL), then XYZ.
	if len(got) != 6 || string(got[3:]) != "XYZ" {
		t.Fatalf("offset write wrong: got %q (len %d)", string(got), len(got))
	}
}

// TestResolve_SymlinkEscapeDenied is the regression test for the chroot escape:
// a symlink planted inside the root that points outside it must be rejected.
func TestResolve_SymlinkEscapeDenied(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation typically requires privilege on Windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret")
	if err := os.WriteFile(secret, []byte("top"), 0o600); err != nil {
		t.Fatal(err)
	}
	// /app/escape -> <outside>
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	h := newHandlers(t, root)
	if _, err := h.resolve("/app/escape/secret"); !errors.Is(err, errDenied) {
		t.Fatalf("symlink escape not denied: err=%v", err)
	}
	// Reading through the symlink must also be refused.
	if _, err := h.Fileread(&sftp.Request{Method: "Get", Filepath: "/app/escape/secret"}); !errors.Is(err, errDenied) {
		t.Fatalf("Fileread through symlink not denied: err=%v", err)
	}
}

// TestResolve_InRootOK confirms a legitimate path inside the root resolves.
func TestResolve_InRootOK(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "ok.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	h := newHandlers(t, root)
	got, err := h.resolve("/app/ok.txt")
	if err != nil {
		t.Fatalf("resolve in-root failed: %v", err)
	}
	if filepath.Base(got) != "ok.txt" {
		t.Fatalf("unexpected resolved path: %s", got)
	}
}

// TestResolve_LexicalTraversalDenied keeps the existing ".." guard honest.
func TestResolve_LexicalTraversalDenied(t *testing.T) {
	root := t.TempDir()
	h := newHandlers(t, root)
	if _, err := h.resolve("/app/../../etc/passwd"); err == nil {
		t.Fatalf("lexical traversal should be denied")
	}
}

// TestResolve_NewFileInRootOK ensures a not-yet-existing create/upload target
// inside the root is allowed (parent-realpath path of checkRealContained).
func TestResolve_NewFileInRootOK(t *testing.T) {
	root := t.TempDir()
	h := newHandlers(t, root)
	if _, err := h.resolve("/app/brand-new.txt"); err != nil {
		t.Fatalf("new file in root should resolve: %v", err)
	}
}
