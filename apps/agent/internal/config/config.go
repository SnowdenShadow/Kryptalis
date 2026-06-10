package config

import (
	"fmt"
	"os"
	"time"
)

type Config struct {
	APIUrl       string
	AgentToken   string
	ServerID     string
	PollInterval time.Duration
}

func Load() (*Config, error) {
	apiURL := getenv("KRYPTALIS_API_URL", "API_URL")
	if apiURL == "" {
		return nil, fmt.Errorf("KRYPTALIS_API_URL is required")
	}

	token := getenv("KRYPTALIS_TOKEN", "AGENT_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("KRYPTALIS_TOKEN is required")
	}

	serverID := getenv("KRYPTALIS_SERVER_ID", "SERVER_ID")
	if serverID == "" {
		return nil, fmt.Errorf("KRYPTALIS_SERVER_ID is required")
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
