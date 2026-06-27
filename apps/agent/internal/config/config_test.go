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
		"DOCKCONTROL_ALLOW_INSECURE", "ALLOW_INSECURE",
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
	// Loopback over http is allowed (dev / same-host), so the fallback-name
	// check uses a loopback URL rather than a remote one.
	t.Setenv("API_URL", "http://127.0.0.1:4000")
	t.Setenv("AGENT_TOKEN", "tok2")
	t.Setenv("SERVER_ID", "srv-2")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.APIUrl != "http://127.0.0.1:4000" || cfg.AgentToken != "tok2" || cfg.ServerID != "srv-2" {
		t.Errorf("fallback names not honored: %+v", cfg)
	}
}

func TestLoadRejectsPlaintextRemoteHTTP(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOCKCONTROL_API_URL", "http://api.example.com:4000")
	t.Setenv("DOCKCONTROL_TOKEN", "tok")
	t.Setenv("DOCKCONTROL_SERVER_ID", "srv-1")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for plaintext http:// to a remote host")
	}
}

func TestLoadAllowsHTTPS(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOCKCONTROL_API_URL", "https://api.example.com")
	t.Setenv("DOCKCONTROL_TOKEN", "tok")
	t.Setenv("DOCKCONTROL_SERVER_ID", "srv-1")
	if _, err := Load(); err != nil {
		t.Fatalf("https should be accepted: %v", err)
	}
}

func TestLoadAllowsLoopbackHTTP(t *testing.T) {
	clearEnv(t)
	for _, u := range []string{"http://localhost:4000", "http://127.0.0.1:4000", "http://[::1]:4000"} {
		t.Setenv("DOCKCONTROL_API_URL", u)
		t.Setenv("DOCKCONTROL_TOKEN", "tok")
		t.Setenv("DOCKCONTROL_SERVER_ID", "srv-1")
		if _, err := Load(); err != nil {
			t.Fatalf("loopback %q should be accepted: %v", u, err)
		}
	}
}

func TestLoadInsecureOptInAllowsRemoteHTTP(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOCKCONTROL_API_URL", "http://api.example.com:4000")
	t.Setenv("DOCKCONTROL_TOKEN", "tok")
	t.Setenv("DOCKCONTROL_SERVER_ID", "srv-1")
	t.Setenv("DOCKCONTROL_ALLOW_INSECURE", "1")
	if _, err := Load(); err != nil {
		t.Fatalf("explicit insecure opt-in should permit remote http: %v", err)
	}
}

func TestLoadRejectsNonHTTPScheme(t *testing.T) {
	clearEnv(t)
	t.Setenv("DOCKCONTROL_API_URL", "ftp://api.example.com")
	t.Setenv("DOCKCONTROL_TOKEN", "tok")
	t.Setenv("DOCKCONTROL_SERVER_ID", "srv-1")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for non-http(s) scheme")
	}
}
