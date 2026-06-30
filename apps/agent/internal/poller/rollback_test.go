package poller

import (
	"os"
	"path/filepath"
	"testing"
)

// snapshotAppDir + swapBackSnapshot are the filesystem half of the remote
// deploy rollback (the API local path does the same with rename/rename-back).
// They must be: (1) a no-op on first deploy (no dir yet), (2) an atomic move
// aside that leaves the original path empty, and (3) reversible — swapping back
// restores the exact previous contents over whatever the failed deploy wrote.

func TestSnapshotAppDir_FirstDeployNoOp(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	prev := dir + ".prev"

	// Nothing at dir yet (first deploy).
	snapped, err := snapshotAppDir(dir, prev)
	if err != nil {
		t.Fatalf("snapshotAppDir on missing dir: unexpected err %v", err)
	}
	if snapped {
		t.Fatal("snapshotAppDir reported a snapshot when there was nothing to snapshot")
	}
	if _, err := os.Stat(prev); !os.IsNotExist(err) {
		t.Fatalf("prevDir should not exist after a no-op snapshot, stat err = %v", err)
	}
}

func TestSnapshotAppDir_MovesAside(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	prev := dir + ".prev"
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "compose.yml")
	if err := os.WriteFile(marker, []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}

	snapped, err := snapshotAppDir(dir, prev)
	if err != nil {
		t.Fatalf("snapshotAppDir: %v", err)
	}
	if !snapped {
		t.Fatal("snapshotAppDir should report a snapshot when dir exists")
	}
	// Original path is now gone; previous content lives under prev.
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("dir should be moved away, stat err = %v", err)
	}
	got, err := os.ReadFile(filepath.Join(prev, "compose.yml"))
	if err != nil {
		t.Fatalf("reading snapshot: %v", err)
	}
	if string(got) != "v1" {
		t.Fatalf("snapshot content = %q, want v1", got)
	}
}

func TestSnapshotAppDir_OverwritesStalePrev(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	prev := dir + ".prev"
	// A stale .prev left by an earlier crashed deploy.
	if err := os.MkdirAll(prev, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prev, "stale"), []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	// The current dir we are about to snapshot.
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fresh"), []byte("new"), 0644); err != nil {
		t.Fatal(err)
	}

	snapped, err := snapshotAppDir(dir, prev)
	if err != nil || !snapped {
		t.Fatalf("snapshotAppDir: snapped=%v err=%v", snapped, err)
	}
	// The stale file must be gone — prev now holds only the just-snapshotted dir.
	if _, err := os.Stat(filepath.Join(prev, "stale")); !os.IsNotExist(err) {
		t.Fatalf("stale prev content should have been overwritten, stat err = %v", err)
	}
	if _, err := os.Stat(filepath.Join(prev, "fresh")); err != nil {
		t.Fatalf("snapshot should contain the fresh file: %v", err)
	}
}

func TestSwapBackSnapshot_RestoresPrevious(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	prev := dir + ".prev"

	// Previous (good) version snapshotted aside.
	if err := os.MkdirAll(prev, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prev, "version"), []byte("good"), 0644); err != nil {
		t.Fatal(err)
	}
	// Broken new deploy wrote into dir.
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "version"), []byte("broken"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := swapBackSnapshot(dir, prev); err != nil {
		t.Fatalf("swapBackSnapshot: %v", err)
	}
	// dir now holds the previous good content; prev is consumed.
	got, err := os.ReadFile(filepath.Join(dir, "version"))
	if err != nil {
		t.Fatalf("reading restored dir: %v", err)
	}
	if string(got) != "good" {
		t.Fatalf("restored content = %q, want good", got)
	}
	if _, err := os.Stat(prev); !os.IsNotExist(err) {
		t.Fatalf("prev should be consumed by the swap, stat err = %v", err)
	}
}

// Round trip: snapshot then swap back must return the exact original tree even
// after the "failed deploy" replaced dir with different content.
func TestSnapshotThenSwapBack_RoundTrip(t *testing.T) {
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	prev := dir + ".prev"
	if err := os.MkdirAll(filepath.Join(dir, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "src", "main.go"), []byte("package main"), 0644); err != nil {
		t.Fatal(err)
	}

	snapped, err := snapshotAppDir(dir, prev)
	if err != nil || !snapped {
		t.Fatalf("snapshot: snapped=%v err=%v", snapped, err)
	}
	// Simulate the failed deploy writing a fresh (broken) tree.
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "broken"), []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := swapBackSnapshot(dir, prev); err != nil {
		t.Fatalf("swap back: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "broken")); !os.IsNotExist(err) {
		t.Fatalf("broken deploy artifact should be gone after rollback, stat err = %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dir, "src", "main.go"))
	if err != nil {
		t.Fatalf("original file missing after rollback: %v", err)
	}
	if string(got) != "package main" {
		t.Fatalf("restored content = %q, want 'package main'", got)
	}
}

func TestParseComposeStates(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int
	}{
		{"empty", "", 0},
		{"whitespace only", "   \n  \n", 0},
		{"ndjson two services", `{"State":"running","Health":""}` + "\n" + `{"State":"running","Health":"healthy"}`, 2},
		{"json array", `[{"State":"running","Health":""},{"State":"exited","Health":""}]`, 2},
		{"garbage line skipped", "not json\n" + `{"State":"running"}`, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := parseComposeStates(c.in)
			if len(got) != c.want {
				t.Errorf("parseComposeStates(%q) = %d states, want %d", c.in, len(got), c.want)
			}
		})
	}
}

func TestEvalComposeHealth(t *testing.T) {
	cases := []struct {
		name      string
		states    []composeState
		wantAllUp bool
		wantDead  bool
	}{
		{"empty is neither", nil, false, false},
		{"all running no health", []composeState{{State: "running"}, {State: "running"}}, true, false},
		{"all running healthy", []composeState{{State: "running", Health: "healthy"}}, true, false},
		{"one starting not up", []composeState{{State: "running", Health: "starting"}}, false, false},
		{"one unhealthy not up", []composeState{{State: "running", Health: "unhealthy"}}, false, false},
		{"exited is dead", []composeState{{State: "running"}, {State: "exited"}}, false, true},
		{"oomkilled is dead", []composeState{{State: "oomkilled"}}, false, true},
		{"created not running", []composeState{{State: "created"}}, false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			allUp, dead := evalComposeHealth(c.states)
			if allUp != c.wantAllUp || dead != c.wantDead {
				t.Errorf("evalComposeHealth(%+v) = (allUp=%v, dead=%v), want (allUp=%v, dead=%v)",
					c.states, allUp, dead, c.wantAllUp, c.wantDead)
			}
		})
	}
}
