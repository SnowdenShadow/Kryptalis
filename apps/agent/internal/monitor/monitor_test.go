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
