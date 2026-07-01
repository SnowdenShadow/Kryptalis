package monitor

import (
	"testing"
	"time"

	"github.com/dockcontrol/agent/internal/config"
)

func TestNewDoesNotPanic(t *testing.T) {
	cfg := &config.Config{
		APIUrl:       "http://localhost:3000",
		AgentToken:   "tok",
		ServerID:     "srv-1",
		PollInterval: 5 * time.Second,
	}
	m := New(cfg)
	if m == nil {
		t.Fatal("New returned nil")
	}
	// collectMetrics must not panic on any OS; on non-linux it returns zeros.
	metrics := m.collectMetrics()
	_ = metrics
}

func TestParseSize(t *testing.T) {
	cases := map[string]uint64{
		"0B":       0,
		"512B":     512,
		"1kB":      1000,
		"1KiB":     1024,
		"340MiB":   340 * 1024 * 1024,
		"2.1GB":    2_100_000_000,
		"1.5GiB":   uint64(1.5 * (1 << 30)),
		"--":       0,
		"":         0,
		"garbage":  0,
		"100":      100, // bare bytes
	}
	for in, want := range cases {
		if got := parseSize(in); got != want {
			t.Errorf("parseSize(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParsePercent(t *testing.T) {
	if got := parsePercent("12.34%"); got != 12.34 {
		t.Errorf("parsePercent(12.34%%) = %v, want 12.34", got)
	}
	if got := parsePercent("0.00%"); got != 0 {
		t.Errorf("parsePercent(0.00%%) = %v, want 0", got)
	}
	if got := parsePercent("bad"); got != 0 {
		t.Errorf("parsePercent(bad) = %v, want 0", got)
	}
}

func TestParsePair(t *testing.T) {
	used, limit := parsePair("340MiB / 512MiB")
	if used != 340*1024*1024 || limit != 512*1024*1024 {
		t.Errorf("parsePair mem = %d/%d", used, limit)
	}
	in, out := parsePair("2.1MB / 800kB")
	if in != 2_100_000 || out != 800_000 {
		t.Errorf("parsePair net = %d/%d", in, out)
	}
}

func TestParseDockerStatsJSON(t *testing.T) {
	raw := `{"Name":"dockcontrol-shop","CPUPerc":"12.34%","MemUsage":"340MiB / 512MiB","NetIO":"2.1MB / 800kB","BlockIO":"15MB / 3MB"}
{"Name":"some-other-container","CPUPerc":"99%","MemUsage":"1GiB / 2GiB","NetIO":"0B / 0B","BlockIO":"0B / 0B"}
not-json-line
`
	// onlyManaged=true keeps just the dockcontrol-* row.
	managed := ParseDockerStatsJSON(raw, true)
	if len(managed) != 1 {
		t.Fatalf("expected 1 managed stat, got %d", len(managed))
	}
	s := managed[0]
	if s.Name != "dockcontrol-shop" || s.CPUPercent != 12.34 {
		t.Errorf("bad parse: %+v", s)
	}
	if s.MemoryUsed != 340*1024*1024 || s.MemoryLimit != 512*1024*1024 {
		t.Errorf("bad mem: %d/%d", s.MemoryUsed, s.MemoryLimit)
	}
	if s.BlockRead != 15_000_000 || s.BlockWrite != 3_000_000 {
		t.Errorf("bad block: %d/%d", s.BlockRead, s.BlockWrite)
	}
	// onlyManaged=false keeps both real rows (the not-json line is always skipped).
	all := ParseDockerStatsJSON(raw, false)
	if len(all) != 2 {
		t.Fatalf("expected 2 stats with onlyManaged=false, got %d", len(all))
	}
}
