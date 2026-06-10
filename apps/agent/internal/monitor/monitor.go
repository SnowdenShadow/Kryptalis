package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kryptalis/agent/internal/config"
)

// Version is stamped at build time via:
//
//	go build -ldflags "-X github.com/kryptalis/agent/internal/monitor.Version=x.y.z"
//
// Hard-coding it here guaranteed drift with the API's expected version.
var Version = "dev"

type SystemMetrics struct {
	CPUPercent  float64 `json:"cpuPercent"`
	MemoryUsed  uint64  `json:"memoryUsed"`
	MemoryTotal uint64  `json:"memoryTotal"`
	DiskUsed    uint64  `json:"diskUsed"`
	DiskTotal   uint64  `json:"diskTotal"`
}

type Monitor struct {
	cfg       *config.Config
	client    *http.Client
	startTime time.Time

	prevCPUTotal uint64
	prevCPUIdle  uint64
}

func New(cfg *config.Config) *Monitor {
	return &Monitor{
		cfg: cfg,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
		startTime: time.Now(),
	}
}

func (m *Monitor) Start(ctx context.Context) {
	interval := m.cfg.PollInterval
	if interval < 5*time.Second {
		interval = 30 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	m.sendHeartbeat(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.sendHeartbeat(ctx)
		}
	}
}

func (m *Monitor) collectMetrics() SystemMetrics {
	metrics := SystemMetrics{}

	if runtime.GOOS == "linux" {
		// memory via /proc/meminfo — read directly; shelling out to sh+awk
		// added a dependency on both binaries for two integers.
		if data, err := os.ReadFile("/proc/meminfo"); err == nil {
			var total, avail uint64
			for _, line := range strings.Split(string(data), "\n") {
				fields := strings.Fields(line)
				if len(fields) < 2 {
					continue
				}
				switch fields[0] {
				case "MemTotal:":
					total, _ = strconv.ParseUint(fields[1], 10, 64)
				case "MemAvailable:":
					avail, _ = strconv.ParseUint(fields[1], 10, 64)
				}
			}
			metrics.MemoryTotal = total * 1024
			if total > avail {
				metrics.MemoryUsed = (total - avail) * 1024
			}
		}

		// CPU via /proc/stat (delta-based)
		if data, err := os.ReadFile("/proc/stat"); err == nil {
			firstLine, _, _ := strings.Cut(string(data), "\n")
			parts := strings.Fields(firstLine)
			if len(parts) >= 5 && parts[0] == "cpu" {
				var total, idle uint64
				for i, v := range parts[1:] {
					n, _ := strconv.ParseUint(v, 10, 64)
					total += n
					if i == 3 {
						idle = n
					}
				}
				if m.prevCPUTotal > 0 && total > m.prevCPUTotal {
					dt := total - m.prevCPUTotal
					di := idle - m.prevCPUIdle
					if dt > 0 && dt >= di {
						metrics.CPUPercent = float64(dt-di) / float64(dt) * 100
					}
				}
				m.prevCPUTotal = total
				m.prevCPUIdle = idle
			}
		}

		// disk via statfs of /
		var fs syscall.Statfs_t
		if err := syscall.Statfs("/", &fs); err == nil {
			total := fs.Blocks * uint64(fs.Bsize)
			free := fs.Bavail * uint64(fs.Bsize)
			metrics.DiskTotal = total
			if total > free {
				metrics.DiskUsed = total - free
			}
		}
	}

	return metrics
}

func (m *Monitor) sendHeartbeat(ctx context.Context) {
	metrics := m.collectMetrics()
	uptime := time.Since(m.startTime).Seconds()

	body, _ := json.Marshal(map[string]interface{}{
		"serverId":     m.cfg.ServerID,
		"token":        m.cfg.AgentToken,
		"agentVersion": Version,
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"uptime":       uptime,
		"metrics":      metrics,
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/api/agent/heartbeat", m.cfg.APIUrl), bytes.NewReader(body))
	if err != nil {
		log.Printf("heartbeat error: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := m.client.Do(req)
	if err != nil {
		log.Printf("heartbeat error: %v", err)
		return
	}
	// Drain before close so the keep-alive connection is reused instead of
	// opening a fresh TCP/TLS handshake every heartbeat.
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
}
