//go:build linux

package poller

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// fix-perms with an owner must chown the tree (the part that actually unblocks
// PrestaShop writes). Root-gated; uses syscall.Stat_t so it's Linux-only.
func TestRunFileFixPerms_ChownsWhenOwnerGiven(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("chown requires root")
	}
	root, appDir := setupAppDir(t, "app8")
	old := appsBaseDir
	appsBaseDir = root
	defer func() { appsBaseDir = old }()
	p := &Poller{}
	_, errStr := p.runFileFixPerms(Task{Payload: map[string]interface{}{
		"slug": "app8", "path": "", "dirMode": float64(0o775), "fileMode": float64(0o664),
		"owner": "33:33",
	}})
	if errStr != "" {
		t.Fatalf("fixperms+chown: %s", errStr)
	}
	fi, _ := os.Stat(filepath.Join(appDir, "var", "f.txt"))
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("no syscall.Stat_t")
	}
	if st.Uid != 33 || st.Gid != 33 {
		t.Fatalf("owner = %d:%d, want 33:33", st.Uid, st.Gid)
	}
}
