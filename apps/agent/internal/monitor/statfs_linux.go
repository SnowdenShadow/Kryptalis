//go:build linux

package monitor

import "syscall"

// diskUsage returns total and used bytes for the filesystem containing path.
// Linux-only: syscall.Statfs does not exist on other platforms.
func diskUsage(path string) (total, used uint64) {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return 0, 0
	}
	total = fs.Blocks * uint64(fs.Bsize)
	free := fs.Bavail * uint64(fs.Bsize)
	if total > free {
		used = total - free
	}
	return total, used
}
