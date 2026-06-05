package monitor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kryptalis/agent/internal/config"
)

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

	m.sendHeartbeat()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.sendHeartbeat()
		}
	}
}

func (m *Monitor) collectMetrics() SystemMetrics {
	metrics := SystemMetrics{}

	if runtime.GOOS == "linux" {
		// memory via /proc/meminfo
		out, err := exec.Command("sh", "-c", "awk '/MemTotal/ {t=$2} /MemAvailable/ {a=$2} END {print t,a}' /proc/meminfo").Output()
		if err == nil {
			parts := strings.Fields(strings.TrimSpace(string(out)))
			if len(parts) == 2 {
				total, _ := strconv.ParseUint(parts[0], 10, 64)
				avail, _ := strconv.ParseUint(parts[1], 10, 64)
				metrics.MemoryTotal = total * 1024
				if total > avail {
					metrics.MemoryUsed = (total - avail) * 1024
				}
			}
		}

		// CPU via /proc/stat (delta-based)
		out, err = exec.Command("sh", "-c", "head -n1 /proc/stat").Output()
		if err == nil {
			parts := strings.Fields(strings.TrimSpace(string(out)))
			if len(parts) >= 5 {
				var total, idle uint64
				for i, v := range parts[1:] {
					n, _ := strconv.ParseUint(v, 10, 64)
					total += n
					if i == 3 {
						idle = n
					}
				}
				if m.prevCPUTotal > 0 {
					dt := total - m.prevCPUTotal
					di := idle - m.prevCPUIdle
					if dt > 0 {
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

func (m *Monitor) sendHeartbeat() {
	metrics := m.collectMetrics()
	uptime := time.Since(m.startTime).Seconds()

	body, _ := json.Marshal(map[string]interface{}{
		"serverId":     m.cfg.ServerID,
		"token":        m.cfg.AgentToken,
		"agentVersion": "0.1.0",
		"os":           runtime.GOOS,
		"arch":         runtime.GOARCH,
		"uptime":       uptime,
		"metrics":      metrics,
	})

	resp, err := m.client.Post(
		fmt.Sprintf("%s/api/agent/heartbeat", m.cfg.APIUrl),
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		log.Printf("heartbeat error: %v", err)
		return
	}
	defer resp.Body.Close()
}
