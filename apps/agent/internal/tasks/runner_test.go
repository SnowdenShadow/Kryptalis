package tasks

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDecodePayloadVolumeExport(t *testing.T) {
	var p volumeExportPayload
	err := decodePayload(map[string]interface{}{
		"volumes": []interface{}{"a", "b"},
	}, &p)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Volumes) != 2 || p.Volumes[0] != "a" || p.Volumes[1] != "b" {
		t.Errorf("volumes = %v", p.Volumes)
	}
}

func TestDecodePayloadVolumeImport(t *testing.T) {
	var p volumeImportPayload
	err := decodePayload(map[string]interface{}{
		"volumes":      []interface{}{"v"},
		"sourceTaskId": "task-42",
	}, &p)
	if err != nil {
		t.Fatal(err)
	}
	if p.SourceTaskID != "task-42" {
		t.Errorf("sourceTaskId = %q", p.SourceTaskID)
	}
}

func TestDecodePayloadVolumeList(t *testing.T) {
	var p volumeListPayload
	err := decodePayload(map[string]interface{}{
		"prefixes": []interface{}{"app1_", "app2_"},
	}, &p)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Prefixes) != 2 || p.Prefixes[0] != "app1_" || p.Prefixes[1] != "app2_" {
		t.Errorf("prefixes = %v", p.Prefixes)
	}
}

func TestDecodePayloadBackup(t *testing.T) {
	var p backupPayload
	err := decodePayload(map[string]interface{}{
		"databases": []interface{}{
			map[string]interface{}{
				"id": "d1", "type": "POSTGRESQL", "container": "pg",
				"username": "u", "password": "p", "name": "db", "dumpAll": true,
			},
		},
		"volumes":    []interface{}{"vol1"},
		"uploadName": "backup.tar.gz",
	}, &p)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Databases) != 1 {
		t.Fatalf("databases = %+v", p.Databases)
	}
	db := p.Databases[0]
	if db.ID != "d1" || db.Type != "POSTGRESQL" || db.Container != "pg" ||
		db.Username != "u" || db.Password != "p" || db.Name != "db" || !db.DumpAll {
		t.Errorf("database = %+v", db)
	}
	if p.UploadName != "backup.tar.gz" {
		t.Errorf("uploadName = %q", p.UploadName)
	}
}

func TestDecodePayloadRestore(t *testing.T) {
	var p restorePayload
	err := decodePayload(map[string]interface{}{
		"downloadName": "backup.tar.gz",
		"sourceTaskId": "src-1",
		"databases":    []interface{}{map[string]interface{}{"id": "d", "type": "REDIS", "container": "c"}},
		"volumes":      []interface{}{"v"},
	}, &p)
	if err != nil {
		t.Fatal(err)
	}
	if p.DownloadName != "backup.tar.gz" || p.SourceTaskID != "src-1" ||
		len(p.Databases) != 1 || len(p.Volumes) != 1 {
		t.Errorf("payload = %+v", p)
	}
}

func TestVolumeExportRejectsBadVolume(t *testing.T) {
	r := NewRunner(NewClient("http://x", "s", "t"))
	_, errStr := r.VolumeExport(context.Background(), "task1", map[string]interface{}{
		"volumes": []interface{}{"ok", "bad name"},
	})
	if errStr == "" || !strings.Contains(errStr, "invalid volume name") {
		t.Errorf("expected invalid volume error, got %q", errStr)
	}
}

func TestVolumeImportRequiresSourceTaskID(t *testing.T) {
	r := NewRunner(NewClient("http://x", "s", "t"))
	_, errStr := r.VolumeImport(context.Background(), map[string]interface{}{
		"volumes": []interface{}{"v"},
	})
	if errStr != "missing sourceTaskId" {
		t.Errorf("error = %q, want missing sourceTaskId", errStr)
	}
}

func TestRestoreRequiresSourceTaskID(t *testing.T) {
	r := NewRunner(NewClient("http://x", "s", "t"))
	_, errStr := r.Restore(context.Background(), map[string]interface{}{
		"downloadName": "b.tar.gz",
	})
	if errStr != "missing sourceTaskId" {
		t.Errorf("error = %q, want missing sourceTaskId", errStr)
	}
}

func TestTransferURLs(t *testing.T) {
	var gotPath, gotQuery string
	var gotBody []byte
	var gotContentType, gotServerID, gotToken string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotPath = req.URL.Path
		gotQuery = req.URL.RawQuery
		gotContentType = req.Header.Get("Content-Type")
		gotServerID = req.Header.Get("X-Server-Id")
		gotToken = req.Header.Get("X-Agent-Token")
		gotBody, _ = io.ReadAll(req.Body)
		if req.Method == http.MethodPost {
			w.WriteHeader(http.StatusCreated)
			return
		}
		_, _ = w.Write([]byte("file-bytes"))
	}))
	defer srv.Close()

	c := NewClient(srv.URL, "srv-1", "tok&en")

	// Upload
	if err := c.Upload(context.Background(), "task-9", "vol1.tar.gz", bytes.NewReader([]byte("payload"))); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/agent/transfers/task-9/upload" {
		t.Errorf("upload path = %q", gotPath)
	}
	if gotContentType != "application/octet-stream" {
		t.Errorf("upload content-type = %q", gotContentType)
	}
	if string(gotBody) != "payload" {
		t.Errorf("upload body = %q", gotBody)
	}
	// name still rides the query, but the credentials must be HEADERS, never
	// the query string (which leaks into proxy/access logs).
	if !strings.Contains(gotQuery, "name=vol1.tar.gz") {
		t.Errorf("upload query %q missing name", gotQuery)
	}
	for _, leaked := range []string{"serverId", "token"} {
		if strings.Contains(gotQuery, leaked) {
			t.Errorf("upload query %q must NOT contain credential %q", gotQuery, leaked)
		}
	}
	if gotServerID != "srv-1" {
		t.Errorf("X-Server-Id header = %q, want srv-1", gotServerID)
	}
	if gotToken != "tok&en" {
		t.Errorf("X-Agent-Token header = %q, want tok&en", gotToken)
	}

	// Download
	body, err := c.Download(context.Background(), "task-9", "vol1.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(body)
	body.Close()
	if string(data) != "file-bytes" {
		t.Errorf("download body = %q", data)
	}
	if gotPath != "/api/agent/transfers/task-9/download" {
		t.Errorf("download path = %q", gotPath)
	}
}

func TestUploadErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "bad token", http.StatusUnauthorized)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "s", "t")
	err := c.Upload(context.Background(), "t1", "f", strings.NewReader("x"))
	if err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("expected 401 error, got %v", err)
	}
	if _, err := c.Download(context.Background(), "t1", "f"); err == nil {
		t.Error("expected download error on 401")
	}
}

func TestTarGzRoundTrip(t *testing.T) {
	src := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "databases"), 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"manifest.json":    `{"version":1}`,
		"databases/d1.sql": "SELECT 1;",
		"databases/d2.rdb": "binary\x00data",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(src, filepath.FromSlash(name)), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}

	var buf bytes.Buffer
	if err := tarGzDir(src, &buf); err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	if err := untarGz(&buf, dst); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		data, err := os.ReadFile(filepath.Join(dst, filepath.FromSlash(name)))
		if err != nil {
			t.Errorf("missing %s after round trip: %v", name, err)
			continue
		}
		if string(data) != content {
			t.Errorf("%s = %q, want %q", name, data, content)
		}
	}
}

func TestUntarGzRejectsTraversal(t *testing.T) {
	// Hand-craft an archive containing ../escape.
	var buf bytes.Buffer
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "ok.txt"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := tarGzDir(src, &buf); err != nil {
		t.Fatal(err)
	}
	evil := buildEvilArchive(t)
	dst := t.TempDir()
	if err := untarGz(bytes.NewReader(evil), dst); err == nil {
		t.Error("expected zip-slip rejection")
	}
}

func TestUntarGzRoundTripsUnderCap(t *testing.T) {
	// The zip-bomb cap must not break legitimate restores: a normal archive
	// (well under maxRestoreBytes) round-trips its files intact.
	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("hello"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(src, "sub"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "sub", "b.bin"), []byte{0, 1, 2, 3, 255}, 0600); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := tarGzDir(src, &buf); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	if err := untarGz(bytes.NewReader(buf.Bytes()), dst); err != nil {
		t.Fatalf("untarGz of a normal archive failed: %v", err)
	}
	got, err := os.ReadFile(filepath.Join(dst, "a.txt"))
	if err != nil || string(got) != "hello" {
		t.Errorf("a.txt = %q (err %v), want \"hello\"", got, err)
	}
	gotBin, err := os.ReadFile(filepath.Join(dst, "sub", "b.bin"))
	if err != nil || !bytes.Equal(gotBin, []byte{0, 1, 2, 3, 255}) {
		t.Errorf("sub/b.bin = %v (err %v), want binary intact", gotBin, err)
	}
}

func TestManifestShape(t *testing.T) {
	m := manifest{
		Version: 1,
		Databases: []manifestEntry{{
			ID: "d1", Name: "db", Type: "POSTGRESQL", Container: "pg",
			File: "databases/d1.sql", DumpAll: true,
		}},
		Volumes: []string{"vol1"},
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]interface{}
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	if generic["version"] != float64(1) {
		t.Errorf("version = %v", generic["version"])
	}
	dbs := generic["databases"].([]interface{})
	entry := dbs[0].(map[string]interface{})
	for _, key := range []string{"id", "name", "type", "container", "file", "dumpAll"} {
		if _, ok := entry[key]; !ok {
			t.Errorf("manifest database entry missing key %q: %v", key, entry)
		}
	}
	if vols := generic["volumes"].([]interface{}); len(vols) != 1 || vols[0] != "vol1" {
		t.Errorf("volumes = %v", generic["volumes"])
	}
}

// buildEvilArchive crafts a tar.gz with a path-traversal member.
func buildEvilArchive(t *testing.T) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	hdr := &tar.Header{Name: "../escape.txt", Mode: 0600, Size: 4, Typeflag: tar.TypeReg}
	if err := tw.WriteHeader(hdr); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("evil")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
