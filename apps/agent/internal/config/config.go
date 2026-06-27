package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"
	"time"
)

type Config struct {
	APIUrl       string
	AgentToken   string
	ServerID     string
	PollInterval time.Duration
}

func Load() (*Config, error) {
	apiURL := getenv("DOCKCONTROL_API_URL", "API_URL")
	if apiURL == "" {
		return nil, fmt.Errorf("DOCKCONTROL_API_URL is required")
	}
	// Transport hardening: the agent token is root-equivalent (the API hands
	// back decrypted DB passwords and git tokens, and forged DEPLOY/EXEC tasks
	// run as root via the docker socket). Plain HTTP to a remote host lets a
	// network MITM read those secrets and inject tasks, so we refuse it unless
	// the operator explicitly opts in (DOCKCONTROL_ALLOW_INSECURE) or the
	// target is loopback (the dev / same-host case).
	if err := validateAPIURL(apiURL); err != nil {
		return nil, err
	}

	token := getenv("DOCKCONTROL_TOKEN", "AGENT_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("DOCKCONTROL_TOKEN is required")
	}

	serverID := getenv("DOCKCONTROL_SERVER_ID", "SERVER_ID")
	if serverID == "" {
		return nil, fmt.Errorf("DOCKCONTROL_SERVER_ID is required")
	}

	interval := 5 * time.Second
	if v := os.Getenv("POLL_INTERVAL"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return nil, fmt.Errorf("invalid POLL_INTERVAL %q: %w", v, err)
		}
		// A zero/negative interval makes time.NewTicker panic at startup.
		if d < time.Second {
			return nil, fmt.Errorf("POLL_INTERVAL must be >= 1s, got %q", v)
		}
		interval = d
	}

	return &Config{
		APIUrl:       apiURL,
		AgentToken:   token,
		ServerID:     serverID,
		PollInterval: interval,
	}, nil
}

func getenv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

// truthy reports whether an env value looks affirmative.
func truthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// isLoopbackHost reports whether host (no port) resolves to a loopback target.
// A bare "localhost" counts; literal IPs are checked against the loopback range.
func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// validateAPIURL enforces a safe transport for the API endpoint. https is
// always allowed; http is allowed only to a loopback host or when the operator
// sets DOCKCONTROL_ALLOW_INSECURE. Any other scheme (or a malformed URL) is
// rejected so the agent cannot be pointed at, e.g., a file:// or ws:// target.
func validateAPIURL(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid DOCKCONTROL_API_URL %q: %w", raw, err)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if isLoopbackHost(u.Hostname()) {
			return nil
		}
		if truthy(getenv("DOCKCONTROL_ALLOW_INSECURE", "ALLOW_INSECURE")) {
			return nil
		}
		return fmt.Errorf(
			"refusing plaintext http:// to non-loopback host %q: the agent token and "+
				"server-issued secrets would be exposed to a network MITM. Use https:// "+
				"or set DOCKCONTROL_ALLOW_INSECURE=1 to override (not recommended)",
			u.Host,
		)
	default:
		return fmt.Errorf("DOCKCONTROL_API_URL must be http(s):// (got scheme %q)", u.Scheme)
	}
}
