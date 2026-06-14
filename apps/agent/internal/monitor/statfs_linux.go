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
	bsize := uint64(fs.Bsize)
	total = fs.Blocks * bsize
	// Used = all blocks minus ALL free blocks (Bfree includes the
	// root-reserved ~5%). Using Bavail here would count the reserved
	// blocks as used and over-report by that reserve.
	if fs.Blocks >= fs.Bfree {
		used = (fs.Blocks - fs.Bfree) * bsize
	}
	return total, used
}
