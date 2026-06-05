package proxy

import (
	"fmt"
	"log"
	"os"
)

type Manager struct{}

func New() *Manager {
	return &Manager{}
}

func (m *Manager) GenerateConfig(appName string, port int, domain string) error {
	config := fmt.Sprintf(`%s {
	reverse_proxy localhost:%d
}
`, domain, port)

	path := fmt.Sprintf("/opt/kryptalis/caddy/%s.conf", appName)
	if err := os.WriteFile(path, []byte(config), 0644); err != nil {
		return fmt.Errorf("failed to write proxy config: %w", err)
	}

	log.Printf("proxy config generated for %s -> :%d", domain, port)
	return nil
}

func (m *Manager) Reload() error {
	log.Println("reloading reverse proxy")
	return nil
}
