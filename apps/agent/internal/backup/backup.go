package backup

import (
	"log"
)

type Manager struct{}

func New() *Manager {
	return &Manager{}
}

func (m *Manager) Create(name string, targets []string) error {
	log.Printf("creating backup: %s (targets=%v)", name, targets)
	return nil
}

func (m *Manager) Restore(backupID string) error {
	log.Printf("restoring backup: %s", backupID)
	return nil
}
