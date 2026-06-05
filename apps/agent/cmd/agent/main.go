package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/kryptalis/agent/internal/config"
	"github.com/kryptalis/agent/internal/monitor"
	"github.com/kryptalis/agent/internal/poller"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	p := poller.New(cfg)
	go p.Start(ctx)

	m := monitor.New(cfg)
	go m.Start(ctx)

	log.Printf("Kryptalis Agent started (server=%s)", cfg.ServerID)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	log.Println("Shutting down...")
	cancel()
}
