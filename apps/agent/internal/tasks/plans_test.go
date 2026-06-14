package tasks

import (
	"reflect"
	"strings"
	"testing"
)

func TestValidDockerName(t *testing.T) {
	valid := []string{"vol1", "myapp_data", "a.b-c", "A1", strings.Repeat("a", 255)}
	for _, s := range valid {
		if !validDockerName(s) {
			t.Errorf("validDockerName(%q) = false, want true", s)
		}
	}
	invalid := []string{
		"", "-leadingdash", "_leading", ".leading",
		"has space", "slash/inside", "back\\slash", "dot/../dot",
		"semi;colon", "$inject", strings.Repeat("a", 256),
	}
	for _, s := range invalid {
		if validDockerName(s) {
			t.Errorf("validDockerName(%q) = true, want false", s)
		}
	}
}

func TestDumpFileName(t *testing.T) {
	cases := []struct {
		db   DatabaseSpec
		want string
	}{
		{DatabaseSpec{ID: "id1", Type: "POSTGRESQL"}, "id1.sql"},
		{DatabaseSpec{ID: "id2", Type: "MYSQL"}, "id2.sql"},
		{DatabaseSpec{ID: "id3", Type: "MARIADB"}, "id3.sql"},
		{DatabaseSpec{ID: "id4", Type: "MONGODB"}, "id4.archive"},
		{DatabaseSpec{ID: "id5", Type: "REDIS"}, "id5.rdb"},
		{DatabaseSpec{ID: "id6", Type: "KEYDB"}, "id6.rdb"},
		{DatabaseSpec{ID: "id7", Type: "DRAGONFLY"}, "id7.rdb"},
	}
	for _, c := range cases {
		got, err := dumpFileName(c.db)
		if err != nil {
			t.Errorf("dumpFileName(%s): %v", c.db.Type, err)
			continue
		}
		if got != c.want {
			t.Errorf("dumpFileName(%s) = %q, want %q", c.db.Type, got, c.want)
		}
	}
	if _, err := dumpFileName(DatabaseSpec{ID: "x", Type: "CLICKHOUSE"}); err == nil {
		t.Error("dumpFileName(CLICKHOUSE): expected error for unsupported type")
	}
	if _, err := dumpFileName(DatabaseSpec{ID: "../evil", Type: "POSTGRESQL"}); err == nil {
		t.Error("dumpFileName with traversal id: expected error")
	}
}

func TestDumpPlanPostgres(t *testing.T) {
	db := DatabaseSpec{ID: "i", Type: "POSTGRESQL", Container: "pg", Username: "admin", Password: "secret", Name: "mydb"}

	pre, dump, err := dumpPlan(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(pre) != 0 {
		t.Errorf("postgres pre = %v, want none", pre)
	}
	want := []string{"exec", "pg", "pg_dump", "-U", "admin", "--clean", "--if-exists", "-d", "mydb"}
	if !reflect.DeepEqual(dump, want) {
		t.Errorf("pg_dump argv = %v, want %v", dump, want)
	}

	db.DumpAll = true
	_, dump, err = dumpPlan(db)
	if err != nil {
		t.Fatal(err)
	}
	want = []string{"exec", "pg", "pg_dumpall", "-U", "admin", "--clean", "--if-exists"}
	if !reflect.DeepEqual(dump, want) {
		t.Errorf("pg_dumpall argv = %v, want %v", dump, want)
	}
	// pg auth is trust/peer inside the container — password must not leak anywhere.
	for _, a := range dump {
		if strings.Contains(a, "secret") {
			t.Errorf("postgres dump argv leaks password: %v", dump)
		}
	}
}

func TestDumpPlanMySQL(t *testing.T) {
	for _, typ := range []string{"MYSQL", "MARIADB"} {
		db := DatabaseSpec{ID: "i", Type: typ, Container: "my", Username: "root", Password: "p@ss", Name: "shop"}
		_, dump, err := dumpPlan(db)
		if err != nil {
			t.Fatal(err)
		}
		want := []string{"exec", "-e", "MYSQL_PWD=p@ss", "my", "mysqldump", "-u", "root", "--databases", "shop"}
		if !reflect.DeepEqual(dump, want) {
			t.Errorf("%s dump argv = %v, want %v", typ, dump, want)
		}

		db.DumpAll = true
		_, dump, _ = dumpPlan(db)
		want = []string{"exec", "-e", "MYSQL_PWD=p@ss", "my", "mysqldump", "-u", "root", "--all-databases"}
		if !reflect.DeepEqual(dump, want) {
			t.Errorf("%s dumpAll argv = %v, want %v", typ, dump, want)
		}
		// Password only ever via -e env assignment, never as a bare flag value.
		assertPasswordOnlyViaEnv(t, dump, "p@ss")
	}
}

func TestDumpPlanMongo(t *testing.T) {
	db := DatabaseSpec{ID: "i", Type: "MONGODB", Container: "mg", Username: "root", Password: "pw", Name: "appdb"}
	pre, dump, err := dumpPlan(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(pre) != 0 {
		t.Errorf("mongo pre = %v, want none", pre)
	}
	assertPasswordOnlyViaEnv(t, dump, "pw")
	joined := strings.Join(dump, " ")
	for _, frag := range []string{"mongodump", "--archive", "--authenticationDatabase admin", `--db "$MONGO_DB"`} {
		if !strings.Contains(joined, frag) {
			t.Errorf("mongo dump argv missing %q: %v", frag, dump)
		}
	}
	if !contains(dump, "MONGO_DB=appdb") {
		t.Errorf("mongo dump argv missing MONGO_DB env: %v", dump)
	}

	db.DumpAll = true
	_, dump, _ = dumpPlan(db)
	if strings.Contains(strings.Join(dump, " "), "--db") {
		t.Errorf("mongo dumpAll argv must not pass --db: %v", dump)
	}
}

func TestDumpPlanRedis(t *testing.T) {
	for _, typ := range []string{"REDIS", "KEYDB", "DRAGONFLY"} {
		db := DatabaseSpec{ID: "i", Type: typ, Container: "rd", Password: "authpw"}
		pre, dump, err := dumpPlan(db)
		if err != nil {
			t.Fatal(err)
		}
		if len(pre) != 1 {
			t.Fatalf("%s: expected 1 pre command (SAVE), got %v", typ, pre)
		}
		wantSave := []string{"exec", "-e", "REDISCLI_AUTH=authpw", "rd", "redis-cli", "SAVE"}
		if !reflect.DeepEqual(pre[0], wantSave) {
			t.Errorf("%s SAVE argv = %v, want %v", typ, pre[0], wantSave)
		}
		wantDump := []string{"exec", "rd", "cat", "/data/dump.rdb"}
		if !reflect.DeepEqual(dump, wantDump) {
			t.Errorf("%s dump argv = %v, want %v", typ, dump, wantDump)
		}

		// No password → no -e at all.
		db.Password = ""
		pre, _, _ = dumpPlan(db)
		wantSave = []string{"exec", "rd", "redis-cli", "SAVE"}
		if !reflect.DeepEqual(pre[0], wantSave) {
			t.Errorf("%s SAVE (no auth) argv = %v, want %v", typ, pre[0], wantSave)
		}
	}
}

func TestDumpPlanRejectsBadNames(t *testing.T) {
	bad := []DatabaseSpec{
		{ID: "ok", Type: "POSTGRESQL", Container: "evil; rm -rf /"},
		{ID: "../traverse", Type: "MYSQL", Container: "ok"},
		{ID: "ok", Type: "REDIS", Container: "--privileged"},
	}
	for _, db := range bad {
		if _, _, err := dumpPlan(db); err == nil {
			t.Errorf("dumpPlan(%+v): expected error", db)
		}
	}
}

func TestRestorePlanPostgres(t *testing.T) {
	db := DatabaseSpec{ID: "i", Type: "POSTGRESQL", Container: "pg", Username: "admin", Name: "mydb"}
	steps, err := restorePlan(db, "/tmp/i.sql")
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 1 || steps[0].stdinFile != "/tmp/i.sql" {
		t.Fatalf("postgres restore steps = %+v", steps)
	}
	want := []string{"exec", "-i", "pg", "psql", "-U", "admin", "-d", "mydb"}
	if !reflect.DeepEqual(steps[0].argv, want) {
		t.Errorf("psql argv = %v, want %v", steps[0].argv, want)
	}

	db.DumpAll = true
	steps, _ = restorePlan(db, "/tmp/i.sql")
	want = []string{"exec", "-i", "pg", "psql", "-U", "admin", "-d", "postgres"}
	if !reflect.DeepEqual(steps[0].argv, want) {
		t.Errorf("psql dumpAll argv = %v, want %v (must target postgres)", steps[0].argv, want)
	}
}

func TestRestorePlanMySQL(t *testing.T) {
	db := DatabaseSpec{ID: "i", Type: "MYSQL", Container: "my", Username: "root", Password: "pw"}
	steps, err := restorePlan(db, "/tmp/i.sql")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"exec", "-i", "-e", "MYSQL_PWD=pw", "my", "mysql", "-u", "root"}
	if !reflect.DeepEqual(steps[0].argv, want) {
		t.Errorf("mysql argv = %v, want %v", steps[0].argv, want)
	}
	assertPasswordOnlyViaEnv(t, steps[0].argv, "pw")
}

func TestRestorePlanMongo(t *testing.T) {
	db := DatabaseSpec{ID: "i", Type: "MONGODB", Container: "mg", Username: "root", Password: "pw"}
	steps, err := restorePlan(db, "/tmp/i.archive")
	if err != nil {
		t.Fatal(err)
	}
	if steps[0].stdinFile != "/tmp/i.archive" {
		t.Errorf("mongo restore must stream archive via stdin, got %+v", steps[0])
	}
	joined := strings.Join(steps[0].argv, " ")
	for _, frag := range []string{"mongorestore", "--archive", "--drop"} {
		if !strings.Contains(joined, frag) {
			t.Errorf("mongo restore argv missing %q: %v", frag, steps[0].argv)
		}
	}
	assertPasswordOnlyViaEnv(t, steps[0].argv, "pw")
}

func TestRestorePlanRedis(t *testing.T) {
	for _, typ := range []string{"REDIS", "KEYDB", "DRAGONFLY"} {
		db := DatabaseSpec{ID: "i", Type: typ, Container: "rd"}
		steps, err := restorePlan(db, "/tmp/i.rdb")
		if err != nil {
			t.Fatal(err)
		}
		if len(steps) != 2 {
			t.Fatalf("%s restore: expected 2 steps (cp, restart), got %+v", typ, steps)
		}
		wantCp := []string{"cp", "/tmp/i.rdb", "rd:/data/dump.rdb"}
		if !reflect.DeepEqual(steps[0].argv, wantCp) {
			t.Errorf("%s cp argv = %v, want %v", typ, steps[0].argv, wantCp)
		}
		wantRestart := []string{"restart", "rd"}
		if !reflect.DeepEqual(steps[1].argv, wantRestart) {
			t.Errorf("%s restart argv = %v, want %v", typ, steps[1].argv, wantRestart)
		}
	}
}

func TestRestorePlanUnknownType(t *testing.T) {
	if _, err := restorePlan(DatabaseSpec{ID: "i", Type: "CLICKHOUSE", Container: "c"}, "f"); err == nil {
		t.Error("expected error for unsupported restore type")
	}
}

func TestVolumeArgvs(t *testing.T) {
	wantExp := []string{"run", "--rm", "-v", "myvol:/data:ro", "busybox", "tar", "-czf", "-", "-C", "/data", "."}
	if got := volumeExportArgv("myvol"); !reflect.DeepEqual(got, wantExp) {
		t.Errorf("volumeExportArgv = %v, want %v", got, wantExp)
	}
	wantImp := []string{"run", "--rm", "-i", "-v", "myvol:/data", "busybox", "tar", "-xzf", "-", "-C", "/data"}
	if got := volumeImportArgv("myvol"); !reflect.DeepEqual(got, wantImp) {
		t.Errorf("volumeImportArgv = %v, want %v", got, wantImp)
	}
	wantList := []string{"volume", "ls", "--format", "{{.Name}}"}
	if got := volumeListArgv(); !reflect.DeepEqual(got, wantList) {
		t.Errorf("volumeListArgv = %v, want %v", got, wantList)
	}
}

func TestFilterByPrefix(t *testing.T) {
	names := []string{"myapp_db", "myapp_uploads", "other_data", "myappX", "unrelated"}

	// Single prefix — only exact-prefix matches, not substring.
	got := filterByPrefix(names, []string{"myapp_"})
	want := []string{"myapp_db", "myapp_uploads"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("single prefix = %v, want %v", got, want)
	}

	// Multiple prefixes — union, each name kept at most once.
	got = filterByPrefix(names, []string{"myapp_", "other_"})
	want = []string{"myapp_db", "myapp_uploads", "other_data"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("multi prefix = %v, want %v", got, want)
	}

	// No prefix matches → empty (non-nil) slice.
	got = filterByPrefix(names, []string{"nope_"})
	if len(got) != 0 {
		t.Errorf("no match = %v, want empty", got)
	}

	// Empty prefixes → all names returned unchanged.
	got = filterByPrefix(names, nil)
	if !reflect.DeepEqual(got, names) {
		t.Errorf("empty prefixes = %v, want all %v", got, names)
	}
}

func TestRedactArgv(t *testing.T) {
	in := []string{"exec", "-e", "MYSQL_PWD=hunter2", "-e", "FOO=bar", "c", "mysqldump"}
	got := redactArgv(in)
	joined := strings.Join(got, " ")
	if strings.Contains(joined, "hunter2") || strings.Contains(joined, "bar") {
		t.Errorf("redactArgv leaked secret: %v", got)
	}
	if !contains(got, "MYSQL_PWD=***") {
		t.Errorf("redactArgv = %v, want masked MYSQL_PWD", got)
	}
	// Input must be untouched.
	if !contains(in, "MYSQL_PWD=hunter2") {
		t.Error("redactArgv mutated its input")
	}
}

// assertPasswordOnlyViaEnv fails if the password appears anywhere except as
// the value of a `-e KEY=password` pair.
func assertPasswordOnlyViaEnv(t *testing.T, argv []string, password string) {
	t.Helper()
	for i, a := range argv {
		if !strings.Contains(a, password) {
			continue
		}
		isEnv := i > 0 && argv[i-1] == "-e" && strings.Contains(a, "="+password)
		if !isEnv {
			t.Errorf("password %q appears outside -e env at argv[%d]: %v", password, i, argv)
		}
	}
}

func contains(ss []string, want string) bool {
	for _, s := range ss {
		if s == want {
			return true
		}
	}
	return false
}
