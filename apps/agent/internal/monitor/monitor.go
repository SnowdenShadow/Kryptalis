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
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/dockcontrol/agent/internal/config"
)

// Version is stamped at build time via:
//
//	go build -ldflags "-X github.com/dockcontrol/agent/internal/monitor.Version=x.y.z"
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

// ContainerState is one dockcontrol-managed container's live docker state,
// shipped with every heartbeat so the API can mirror real RUNNING/STOPPED
// status for remote apps without per-request agent round-trips.
type ContainerState struct {
	Name  string `json:"name"`
	State string `json:"state"` // running | exited | restarting | ...
}

// ContainerStat is one running container's live resource usage, parsed from
// `docker stats --no-stream`. Bytes are absolute; cpuPercent is a whole-core
// percentage (100 = one full core). Shipped with the heartbeat so the API can
// persist per-container history without polling the agent per app.
type ContainerStat struct {
	Name        string  `json:"name"`
	CPUPercent  float64 `json:"cpuPercent"`
	MemoryUsed  uint64  `json:"memoryUsed"`
	MemoryLimit uint64  `json:"memoryLimit"`
	NetworkIn   uint64  `json:"networkIn"`
	NetworkOut  uint64  `json:"networkOut"`
	BlockRead   uint64  `json:"blockRead"`
	BlockWrite  uint64  `json:"blockWrite"`
}

// dockerStatsLine mirrors the `docker stats --format {{json .}}` object. All
// values are human-readable strings ("12.34%", "340MiB / 512MiB", "2.1MB / 8kB").
type dockerStatsLine struct {
	Name     string `json:"Name"`
	CPUPerc  string `json:"CPUPerc"`
	MemUsage string `json:"MemUsage"`
	NetIO    string `json:"NetIO"`
	BlockIO  string `json:"BlockIO"`
}

// parsePercent turns "12.34%" into 12.34. Bad input → 0.
func parsePercent(s string) float64 {
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "%"))
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

// parseSize turns a docker-formatted size ("340MiB", "2.1GB", "0B", "1.5kB")
// into bytes. Docker mixes IEC (MiB) and SI (MB) suffixes; we accept both and
// treat them by their real base (Ki=1024, K=1000). Bad input → 0.
func parseSize(s string) uint64 {
	s = strings.TrimSpace(s)
	if s == "" || s == "--" {
		return 0
	}
	// Longest suffixes first so "MiB" matches before "B".
	type unit struct {
		suffix string
		mult   float64
	}
	units := []unit{
		{"PiB", 1 << 50}, {"TiB", 1 << 40}, {"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10},
		{"PB", 1e15}, {"TB", 1e12}, {"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"KB", 1e3},
		{"B", 1},
	}
	for _, u := range units {
		if strings.HasSuffix(s, u.suffix) {
			num := strings.TrimSpace(strings.TrimSuffix(s, u.suffix))
			v, err := strconv.ParseFloat(num, 64)
			if err != nil {
				return 0
			}
			return uint64(v * u.mult)
		}
	}
	// No suffix — maybe a bare number of bytes.
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return uint64(v)
}

// parsePair splits a docker "A / B" field into its two sizes (used/limit,
// in/out, read/write). Missing halves → 0.
func parsePair(s string) (uint64, uint64) {
	a, b, ok := strings.Cut(s, "/")
	if !ok {
		return parseSize(s), 0
	}
	return parseSize(a), parseSize(b)
}

// ParseDockerStatsJSON parses the newline-delimited `docker stats --format
// {{json .}}` output into ContainerStat records. Exported + pure so both the
// heartbeat collector here and the poller's on-demand STATS task share one
// tested parser. When onlyManaged is true, only dockcontrol-* containers are
// kept (the heartbeat case); the on-demand task passes false and filters by
// the exact name it asked for. Unparseable lines are skipped.
func ParseDockerStatsJSON(raw string, onlyManaged bool) []ContainerStat {
	var stats []ContainerStat
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var d dockerStatsLine
		if err := json.Unmarshal([]byte(line), &d); err != nil {
			continue
		}
		// The API keys history by Application.containerName, all of which carry
		// the dockcontrol- prefix.
		if onlyManaged && !strings.HasPrefix(d.Name, "dockcontrol-") {
			continue
		}
		memUsed, memLimit := parsePair(d.MemUsage)
		netIn, netOut := parsePair(d.NetIO)
		blkRead, blkWrite := parsePair(d.BlockIO)
		stats = append(stats, ContainerStat{
			Name:        d.Name,
			CPUPercent:  parsePercent(d.CPUPerc),
			MemoryUsed:  memUsed,
			MemoryLimit: memLimit,
			NetworkIn:   netIn,
			NetworkOut:  netOut,
			BlockRead:   blkRead,
			BlockWrite:  blkWrite,
		})
	}
	return stats
}

// collectContainerStats runs a single `docker stats --no-stream` over the
// dockcontrol-managed containers and parses each line. Best-effort: docker
// missing/down is skipped rather than fatal.
func collectContainerStats(ctx context.Context) []ContainerStat {
	c := exec.CommandContext(ctx, "docker", "stats", "--no-stream",
		"--format", "{{json .}}")
	out, err := c.Output()
	if err != nil {
		return nil
	}
	return ParseDockerStatsJSON(string(out), true)
}

// collectContainers lists dockcontrol-managed containers (name prefix) with
// their current state. Best-effort: docker missing/down → empty list.
func collectContainers(ctx context.Context) []ContainerState {
	c := exec.CommandContext(ctx, "docker", "ps", "-a",
		"--filter", "name=dockcontrol-",
		"--format", "{{.Names}}\t{{.State}}")
	out, err := c.Output()
	if err != nil {
		return nil
	}
	var states []ContainerState
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		name, state, ok := strings.Cut(line, "\t")
		if !ok || name == "" {
			continue
		}
		states = append(states, ContainerState{Name: name, State: state})
	}
	return states
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
				// Both counters increment monotonically; idle < prev means a
				// reboot, a /proc/stat reset, or a virtualized /proc in a
				// container. uint64 subtraction would underflow to a huge di and
				// silently report 0% for the interval — so skip this tick and
				// re-baseline, same as the first-interval case (prevCPUTotal==0).
				if m.prevCPUTotal > 0 && total > m.prevCPUTotal && idle >= m.prevCPUIdle {
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

		// disk via statfs of / (linux-only syscall, see statfs_linux.go)
		metrics.DiskTotal, metrics.DiskUsed = diskUsage("/")
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
		// Live container states → the API mirrors real app status for this
		// server's apps (dashboard green/grey dot) without polling us.
		"containers": collectContainers(ctx),
		// Live per-container resource usage → the API persists it as
		// ContainerMetric history (CPU/mem/net/block IO per app).
		"containerStats": collectContainerStats(ctx),
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
