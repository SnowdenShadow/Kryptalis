package poller

import (
	"strings"
	"testing"
)

func TestRedactGitArgs_MasksCloneCredential(t *testing.T) {
	// The exact shape runDeploy builds for a private-repo clone.
	args := []string{
		"-c",
		"http.extraheader=Authorization: Basic dXNlcjpzM2NyZXQtdG9rZW4=",
		"clone",
		"--depth", "1",
		"--branch", "main",
		"https://github.com/me/repo.git",
		"/opt/dockcontrol/apps/repo",
	}
	out := redactGitArgs(args)
	joined := strings.Join(out, " ")

	if strings.Contains(joined, "dXNlcjpzM2NyZXQtdG9rZW4=") {
		t.Fatalf("token leaked through redaction: %q", joined)
	}
	if strings.Contains(joined, "Basic ") {
		t.Fatalf("credential not masked: %q", joined)
	}
	if !strings.Contains(joined, "http.extraheader=<redacted>") {
		t.Fatalf("expected redacted marker, got: %q", joined)
	}
	// Non-secret args must survive untouched so the log stays useful.
	if !strings.Contains(joined, "clone") || !strings.Contains(joined, "github.com/me/repo.git") {
		t.Fatalf("redaction clobbered benign args: %q", joined)
	}
}

func TestRedactGitArgs_MasksBareAuthorizationHeader(t *testing.T) {
	out := redactGitArgs([]string{"Authorization: Bearer abc.def.ghi"})
	if strings.Contains(strings.Join(out, " "), "abc.def.ghi") {
		t.Fatalf("bearer token leaked: %v", out)
	}
}

func TestRedactGitArgs_LeavesCleanArgvUntouched(t *testing.T) {
	in := []string{"clone", "--depth", "1", "https://github.com/me/public.git", "/dst"}
	out := redactGitArgs(in)
	if strings.Join(in, " ") != strings.Join(out, " ") {
		t.Fatalf("credential-free argv was modified: %v -> %v", in, out)
	}
}
