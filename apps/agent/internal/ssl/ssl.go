package ssl

import (
	"log"
)

type Manager struct{}

func New() *Manager {
	return &Manager{}
}

func (m *Manager) Issue(domain string) error {
	log.Printf("issuing SSL certificate for %s", domain)
	return nil
}

func (m *Manager) Renew(domain string) error {
	log.Printf("renewing SSL certificate for %s", domain)
	return nil
}
