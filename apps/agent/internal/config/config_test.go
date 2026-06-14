package config

import (
	"testing"
	"time"
)

// clearEnv blanks every variable Load() reads so ambient environment can't
// leak into a test. getenv treats "" as unset.
func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"DOCKCONTROL_API_URL", "API_URL",
		"DOCKCONTROL_TOKEN", "AGENT_TOKEN",
		"DOCKCONTROL_SERVER_ID", "SERVER_ID",
		"POLL_INTERVAL",
	} {
		t.Setenv(k, "")
	}
}

func setRequired(t *testing.T) {
	t.Helper()
	t.Setenv("DOCKCONTROL_API_URL", "http://localhost:3000")
	t.Setenv("DOCKCONTROL_TOKEN", "tok")
	t.Setenv("DOCKCONTROL_SERVER_ID", "srv-1")
}

func TestLoadMissingAPIURL(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOCKCONTROL_TOKEN", "tok")
	t.Setenv("DOCKCONTROL_SERVER_ID", "srv-1")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when DOCKCONTROL_API_URL is missing")
	}
}

func TestLoadMissingToken(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOCKCONTROL_API_URL", "http://localhost:3000")
	t.Setenv("DOCKCONTROL_SERVER_ID", "srv-1")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when DOCKCONTROL_TOKEN is missing")
	}
}

func TestLoadMissingServerID(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOCKCONTROL_API_URL", "http://localhost:3000")
	t.Setenv("DOCKCONTROL_TOKEN", "tok")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when DOCKCONTROL_SERVER_ID is missing")
	}
}

func TestLoadInvalidPollInterval(t *testing.T) {
	clearEnv(t)
	setRequired(t)
	t.Setenv("POLL_INTERVAL", "abc")
	if _, err := Load(); err == nil {
		t.Fatal(`expected error for POLL_INTERVAL "abc"`)
	}
}

func TestLoadZeroPollInterval(t *testing.T) {
	clearEnv(t)
	setRequired(t)
	t.Setenv("POLL_INTERVAL", "0s")
	if _, err := Load(); err == nil {
		t.Fatal(`expected error for POLL_INTERVAL "0s" (must be >= 1s)`)
	}
}

func TestLoadValidPollInterval(t *testing.T) {
	clearEnv(t)
	setRequired(t)
	t.Setenv("POLL_INTERVAL", "10s")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PollInterval != 10*time.Second {
		t.Errorf("PollInterval = %v, want 10s", cfg.PollInterval)
	}
}

func TestLoadDefaultPollInterval(t *testing.T) {
	clearEnv(t)
	setRequired(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PollInterval != 5*time.Second {
		t.Errorf("PollInterval = %v, want default 5s", cfg.PollInterval)
	}
	if cfg.APIUrl != "http://localhost:3000" || cfg.AgentToken != "tok" || cfg.ServerID != "srv-1" {
		t.Errorf("unexpected config: %+v", cfg)
	}
}

func TestLoadFallbackEnvNames(t *testing.T) {
	clearEnv(t)
	t.Setenv("API_URL", "http://api")
	t.Setenv("AGENT_TOKEN", "tok2")
	t.Setenv("SERVER_ID", "srv-2")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.APIUrl != "http://api" || cfg.AgentToken != "tok2" || cfg.ServerID != "srv-2" {
		t.Errorf("fallback names not honored: %+v", cfg)
	}
}
