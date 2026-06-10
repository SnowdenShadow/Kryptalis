//go:build !linux

package monitor

// diskUsage is a no-op on non-linux platforms; collectMetrics only reports
// disk usage on linux anyway.
func diskUsage(path string) (total, used uint64) {
	return 0, 0
}
