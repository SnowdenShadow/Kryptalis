package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dockcontrol/agent/internal/config"
	"github.com/dockcontrol/agent/internal/monitor"
	"github.com/dockcontrol/agent/internal/poller"
	"github.com/dockcontrol/agent/internal/sftpserver"
)

// sftpAdapter bridges poller.SftpSyncer (payload structs) to the
// sftpserver implementation without coupling the two packages.
type sftpAdapter struct{ srv *sftpserver.Server }

func (a sftpAdapter) Sync(accounts []poller.SftpAccountPayload) int {
	converted := make([]sftpserver.Account, 0, len(accounts))
	for _, acc := range accounts {
		converted = append(converted, sftpserver.Account{
			Username:      acc.Username,
			PasswordHash:  acc.PasswordHash,
			PublicKeys:    acc.PublicKeys,
			Permission:    acc.Permission,
			Disabled:      acc.Disabled,
			Roots:         acc.Roots,
			AllowShell:    acc.AllowShell,
			ContainerName: acc.ContainerName,
		})
	}
	return a.srv.Sync(converted)
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p := poller.New(cfg)

	// Embedded SFTP server — serves THIS host's app files to accounts the
	// API pushes via SFTP_SYNC. Failure to start (port busy) is non-fatal:
	// deploys still work; SFTP_SYNC tasks fail with a clear error.
	sftpAddr := os.Getenv("DOCKCONTROL_SFTP_ADDR")
	if sftpAddr == "" {
		sftpAddr = ":2522"
	}
	if srv, err := sftpserver.New("/opt/dockcontrol/sftp-state", sftpAddr); err != nil {
		log.Printf("sftp: disabled (%v)", err)
	} else {
		p.Sftp = sftpAdapter{srv: srv}
		go func() {
			if err := srv.Serve(); err != nil {
				log.Printf("sftp: server stopped: %v", err)
			}
		}()
		defer srv.Close()
	}

	go p.Start(ctx)

	m := monitor.New(cfg)
	go m.Start(ctx)

	log.Printf("DockControl Agent started (server=%s)", cfg.ServerID)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down — waiting for in-flight tasks (up to 60s)...")
	cancel()
	// Drain: an immediate exit killed running deployments mid-way and left
	// their AgentTask rows stuck PENDING on the API side. Task contexts are
	// cancelled by cancel() above, so the wait is bounded.
	p.Wait(60 * time.Second)
	log.Println("Shutdown complete")
}
