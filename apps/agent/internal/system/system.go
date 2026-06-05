package system

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

type SystemInfo struct {
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	CPUCores  int    `json:"cpuCores"`
	Hostname  string `json:"hostname"`
}

func GetSystemInfo() SystemInfo {
	hostname, _ := exec.Command("hostname").Output()

	return SystemInfo{
		OS:       runtime.GOOS,
		Arch:     runtime.GOARCH,
		CPUCores: runtime.NumCPU(),
		Hostname: strings.TrimSpace(string(hostname)),
	}
}

func RunCommand(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("command %s failed: %w\noutput: %s", name, err, string(out))
	}
	return strings.TrimSpace(string(out)), nil
}
