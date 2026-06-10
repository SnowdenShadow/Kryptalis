package poller

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSanitize(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"normal name", "myapp", "myapp"},
		{"uppercase and spaces", "My Cool App", "my-cool-app"},
		{"special characters", "app@2024!v2", "app-2024-v2"},
		{"leading/trailing specials trimmed", "--hello--", "hello"},
		{"consecutive specials collapse", "a___b", "a-b"},
		{"truncated to 48", strings.Repeat("a", 60), strings.Repeat("a", 48)},
		{"truncation trims trailing dash", strings.Repeat("ab-", 16) + "xyz", strings.TrimRight((strings.Repeat("ab-", 16) + "xyz")[:48], "-")},
		{"empty becomes app", "", "app"},
		{"only specials becomes app", "!!!", "app"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := sanitize(c.in)
			if got != c.want {
				t.Errorf("sanitize(%q) = %q, want %q", c.in, got, c.want)
			}
			if len(got) > 48 {
				t.Errorf("sanitize(%q) length %d > 48", c.in, len(got))
			}
		})
	}
}

func TestIsValidEnvKey(t *testing.T) {
	valid := []string{"FOO", "_BAR", "a1", "FOO_BAR_2", "_"}
	for _, k := range valid {
		if !isValidEnvKey(k) {
			t.Errorf("isValidEnvKey(%q) = false, want true", k)
		}
	}
	invalid := []string{"1A", "a b", "", "a-b", "FOO=", "a.b", "é"}
	for _, k := range invalid {
		if isValidEnvKey(k) {
			t.Errorf("isValidEnvKey(%q) = true, want false", k)
		}
	}
}

func TestStrconvQuoteCompat(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"a\nb", `"a\nb"`},
		{`say "hi"`, `"say \"hi\""`},
		{"$HOME", `"$$HOME"`},
		{`back\slash`, `"back\\slash"`},
		{"cr\rstripped", `"crstripped"`},
		{"a\nb\"c$d\\e", `"a\nb\"c$$d\\e"`},
	}
	for _, c := range cases {
		got := strconv_QuoteCompat(c.in)
		if got != c.want {
			t.Errorf("strconv_QuoteCompat(%q) = %s, want %s", c.in, got, c.want)
		}
		if strings.Contains(got, "\n") {
			t.Errorf("strconv_QuoteCompat(%q) contains a raw newline: %q", c.in, got)
		}
	}
}

func TestWriteEnvFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")

	env := map[string]interface{}{
		"FOO":    "bar",
		"PORT":   3000,
		"MULTI":  "line1\nline2",
		"QUOTED": `va"lue`,
	}
	if err := writeEnvFile(path, env); err != nil {
		t.Fatalf("writeEnvFile: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	content := string(data)
	lines := strings.Split(strings.TrimRight(content, "\n"), "\n")

	// One physical line per variable — a \n in a value must NOT inject a line.
	if len(lines) != len(env) {
		t.Fatalf("expected %d lines, got %d:\n%s", len(env), len(lines), content)
	}

	got := map[string]string{}
	for _, line := range lines {
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("line not in KEY=VALUE format: %q", line)
		}
		if !isValidEnvKey(k) {
			t.Errorf("written key %q is not a valid env key", k)
		}
		got[k] = v
	}

	if got["FOO"] != "bar" {
		t.Errorf("FOO = %q, want %q", got["FOO"], "bar")
	}
	if got["PORT"] != "3000" {
		t.Errorf("PORT = %q, want %q", got["PORT"], "3000")
	}
	if got["MULTI"] != `"line1\nline2"` {
		t.Errorf("MULTI = %q, want quoted escaped value %q", got["MULTI"], `"line1\nline2"`)
	}
	if got["QUOTED"] != `"va\"lue"` {
		t.Errorf("QUOTED = %q, want %q", got["QUOTED"], `"va\"lue"`)
	}

	// Invalid key must be rejected (injection vector).
	bad := map[string]interface{}{"BAD KEY": "x"}
	if err := writeEnvFile(filepath.Join(dir, ".env2"), bad); err == nil {
		t.Error("writeEnvFile with invalid key: expected error, got nil")
	}
}

func TestWriteProjectNetworkOverride(t *testing.T) {
	dir := t.TempDir()
	compose := `version: "3"
services:
  web:
    image: nginx
  # foo:
  x-common:
    restart: always
  db:
    image: postgres
networks:
  default: {}
`
	if err := os.WriteFile(filepath.Join(dir, "docker-compose.yml"), []byte(compose), 0644); err != nil {
		t.Fatal(err)
	}

	if err := writeProjectNetworkOverride(dir, "kryptalis_proj_123"); err != nil {
		t.Fatalf("writeProjectNetworkOverride: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, "docker-compose.override.yml"))
	if err != nil {
		t.Fatalf("override not written: %v", err)
	}
	out := string(data)

	if !strings.Contains(out, "  web:") {
		t.Errorf("override missing service web:\n%s", out)
	}
	if !strings.Contains(out, "  db:") {
		t.Errorf("override missing service db:\n%s", out)
	}
	if strings.Contains(out, "foo") {
		t.Errorf("override must not contain commented service '# foo':\n%s", out)
	}
	if strings.Contains(out, "x-common") {
		t.Errorf("override must not contain extension field x-common:\n%s", out)
	}
	if !strings.Contains(out, "name: kryptalis_proj_123") {
		t.Errorf("override missing external network name:\n%s", out)
	}
	if !strings.Contains(out, "external: true") {
		t.Errorf("override network must be external:\n%s", out)
	}
}

func TestWriteProjectNetworkOverrideNoCompose(t *testing.T) {
	dir := t.TempDir()
	if err := writeProjectNetworkOverride(dir, "net"); err != nil {
		t.Fatalf("expected nil when no compose file, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "docker-compose.override.yml")); !os.IsNotExist(err) {
		t.Error("override file must not be created when no compose file exists")
	}
}

func TestTail(t *testing.T) {
	if got := tail("short", 100); got != "short" {
		t.Errorf("tail short = %q, want unchanged", got)
	}
	if got := tail("abcdefghij", 5); got != "...fghij" {
		t.Errorf("tail long = %q, want %q", got, "...fghij")
	}
	// exactly at limit: unchanged
	if got := tail("abcde", 5); got != "abcde" {
		t.Errorf("tail exact = %q, want unchanged", got)
	}
}
