package tasks

import (
	"fmt"
	"strings"
)

// DatabaseSpec is the per-database shape carried by BACKUP / RESTORE payloads.
type DatabaseSpec struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Container string `json:"container"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	Name      string `json:"name"`
	DumpAll   bool   `json:"dumpAll"`
}

// validDockerName matches docker's own constraint for volume / container
// names: [a-zA-Z0-9][a-zA-Z0-9_.-]*. Also blocks anything that could be
// parsed as a flag (leading '-') or smuggle path separators into filenames.
func validDockerName(s string) bool {
	if s == "" || len(s) > 255 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'):
		case i > 0 && (c == '_' || c == '.' || c == '-'):
		default:
			return false
		}
	}
	return true
}

// validDBIdent matches the identifier charset for a DB username / database
// name passed as a DISCRETE argv element to pg_dump/psql/mysqldump/mongodump
// (-U <user>, -d <name>, --databases <name>). exec() already prevents shell
// injection, but a value beginning with '-' could be reparsed as a CLI flag by
// the target tool (e.g. a name of "--all-databases"). Enforce non-empty, no
// leading '-', and a conservative allowlist (alphanumerics, underscore, dash,
// dot, dollar — covers Postgres/MySQL/Mongo identifiers) with no whitespace or
// control characters.
func validDBIdent(s string) bool {
	if s == "" || len(s) > 255 || s[0] == '-' {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'):
		case c == '_' || c == '.' || c == '-' || c == '$':
		default:
			return false
		}
	}
	return true
}

func validateDBSpec(db DatabaseSpec) error {
	if !validDockerName(db.ID) {
		return fmt.Errorf("database entry has invalid id %q", db.ID)
	}
	if !validDockerName(db.Container) {
		return fmt.Errorf("database %q has invalid container name %q", db.ID, db.Container)
	}
	// Username / Name reach the dump/restore tools as discrete argv elements
	// only for the SQL/Mongo engines. Redis-family auth is password-only (via
	// REDISCLI_AUTH env) and uses neither, so don't require them there.
	switch db.Type {
	case "POSTGRESQL", "MYSQL", "MARIADB", "MONGODB":
		// Username is passed on every SQL/Mongo dump+restore (-U/-u/--username),
		// so it must always be a valid identifier (no leading '-' flag smuggle).
		if !validDBIdent(db.Username) {
			return fmt.Errorf("database %q has invalid username %q", db.ID, db.Username)
		}
		// Name is only an argv element on SOME paths (e.g. MySQL/Mongo restore
		// don't use it — they replay USE statements / a full archive). Validate
		// its CHARSET whenever present to block flag injection, but don't force
		// presence, or we'd reject those legitimately name-less restore plans.
		if db.Name != "" && !validDBIdent(db.Name) {
			return fmt.Errorf("database %q has invalid name %q", db.ID, db.Name)
		}
	}
	return nil
}

// dumpFileName is the deterministic archive-relative basename for a database
// dump. Must stay in sync with the API's manifest convention
// (<id>.sql / <id>.archive / <id>.rdb under databases/).
func dumpFileName(db DatabaseSpec) (string, error) {
	if !validDockerName(db.ID) {
		return "", fmt.Errorf("database entry has invalid id %q", db.ID)
	}
	switch db.Type {
	case "POSTGRESQL", "MYSQL", "MARIADB":
		return db.ID + ".sql", nil
	case "MONGODB":
		return db.ID + ".archive", nil
	case "REDIS", "KEYDB", "DRAGONFLY":
		return db.ID + ".rdb", nil
	default:
		return "", fmt.Errorf("no dump strategy for database type %q", db.Type)
	}
}

// dumpPlan returns the docker argvs for dumping one database:
//   - pre: commands to run before the dump (e.g. redis-cli SAVE), output ignored
//   - dump: the command whose stdout IS the dump body
//
// Passwords never appear as direct command arguments — only as `-e KEY=value`
// env assignments (MYSQL_PWD, REDISCLI_AUTH, MONGO_PASSWORD), expanded inside
// the container for mongo via `sh -c` so the host docker argv stays clean.
func dumpPlan(db DatabaseSpec) (pre [][]string, dump []string, err error) {
	if err := validateDBSpec(db); err != nil {
		return nil, nil, err
	}
	switch db.Type {
	case "POSTGRESQL":
		if db.DumpAll {
			dump = []string{"exec", db.Container, "pg_dumpall", "-U", db.Username, "--clean", "--if-exists"}
		} else {
			dump = []string{"exec", db.Container, "pg_dump", "-U", db.Username, "--clean", "--if-exists", "-d", db.Name}
		}
	case "MYSQL", "MARIADB":
		dump = []string{"exec", "-e", "MYSQL_PWD=" + db.Password, db.Container, "mysqldump", "-u", db.Username}
		if db.DumpAll {
			dump = append(dump, "--all-databases")
		} else {
			dump = append(dump, "--databases", db.Name)
		}
	case "MONGODB":
		script := `exec mongodump --archive --quiet --username "$MONGO_USERNAME" --password "$MONGO_PASSWORD" --authenticationDatabase admin`
		dump = []string{"exec",
			"-e", "MONGO_USERNAME=" + db.Username,
			"-e", "MONGO_PASSWORD=" + db.Password,
		}
		if !db.DumpAll {
			script += ` --db "$MONGO_DB"`
			dump = append(dump, "-e", "MONGO_DB="+db.Name)
		}
		dump = append(dump, db.Container, "sh", "-c", script)
	case "REDIS", "KEYDB", "DRAGONFLY":
		save := []string{"exec"}
		if db.Password != "" {
			// REDISCLI_AUTH instead of -a so the password never shows up in
			// any process list (same reason mysqldump gets MYSQL_PWD).
			save = append(save, "-e", "REDISCLI_AUTH="+db.Password)
		}
		save = append(save, db.Container, "redis-cli", "SAVE")
		pre = [][]string{save}
		dump = []string{"exec", db.Container, "cat", "/data/dump.rdb"}
	default:
		return nil, nil, fmt.Errorf("no dump strategy for database type %q", db.Type)
	}
	return pre, dump, nil
}

// restoreStep is one docker invocation of a restore plan. When stdinFile is
// set, the file is streamed into the command's stdin.
type restoreStep struct {
	argv      []string
	stdinFile string
}

// restorePlan returns the ordered docker invocations that replay the dump at
// dumpFile into the live container.
func restorePlan(db DatabaseSpec, dumpFile string) ([]restoreStep, error) {
	if err := validateDBSpec(db); err != nil {
		return nil, err
	}
	switch db.Type {
	case "POSTGRESQL":
		// dumpAll dumps (pg_dumpall) carry their own \connect statements —
		// feed them to the admin database; single-db dumps target db.Name.
		target := db.Name
		if db.DumpAll {
			target = "postgres"
		}
		return []restoreStep{{
			argv:      []string{"exec", "-i", db.Container, "psql", "-U", db.Username, "-d", target},
			stdinFile: dumpFile,
		}}, nil
	case "MYSQL", "MARIADB":
		return []restoreStep{{
			argv:      []string{"exec", "-i", "-e", "MYSQL_PWD=" + db.Password, db.Container, "mysql", "-u", db.Username},
			stdinFile: dumpFile,
		}}, nil
	case "MONGODB":
		script := `exec mongorestore --archive --drop --username "$MONGO_USERNAME" --password "$MONGO_PASSWORD" --authenticationDatabase admin`
		return []restoreStep{{
			argv: []string{"exec", "-i",
				"-e", "MONGO_USERNAME=" + db.Username,
				"-e", "MONGO_PASSWORD=" + db.Password,
				db.Container, "sh", "-c", script},
			stdinFile: dumpFile,
		}}, nil
	case "REDIS", "KEYDB", "DRAGONFLY":
		// Drop the RDB in place, then restart so the server loads it.
		return []restoreStep{
			{argv: []string{"cp", dumpFile, db.Container + ":/data/dump.rdb"}},
			{argv: []string{"restart", db.Container}},
		}, nil
	default:
		return nil, fmt.Errorf("no restore strategy for database type %q", db.Type)
	}
}

// volumeExportArgv streams a gzip'd tar of the volume's contents to stdout.
func volumeExportArgv(volume string) []string {
	return []string{"run", "--rm", "-v", volume + ":/data:ro", "busybox", "tar", "-czf", "-", "-C", "/data", "."}
}

// volumeImportArgv unpacks a gzip'd tar from stdin into the volume.
func volumeImportArgv(volume string) []string {
	return []string{"run", "--rm", "-i", "-v", volume + ":/data", "busybox", "tar", "-xzf", "-", "-C", "/data"}
}

// volumeListArgv lists every docker volume name, one per line. Filtering by
// prefix is done in Go (filterByPrefix) — `docker volume ls --filter name=`
// is a substring match, not a prefix match, so it can't be trusted here.
func volumeListArgv() []string {
	return []string{"volume", "ls", "--format", "{{.Name}}"}
}

// filterByPrefix returns the names whose value starts with ANY of the given
// prefixes. An empty prefixes slice returns all names unchanged. Pure (no
// docker) so the prefix-matching contract is unit-testable on its own.
func filterByPrefix(names, prefixes []string) []string {
	if len(prefixes) == 0 {
		return names
	}
	matched := []string{}
	for _, name := range names {
		for _, prefix := range prefixes {
			if strings.HasPrefix(name, prefix) {
				matched = append(matched, name)
				break
			}
		}
	}
	return matched
}

// redactArgv masks the value of every `-e KEY=VALUE` pair so error messages
// and logs never leak MYSQL_PWD / REDISCLI_AUTH / MONGO_PASSWORD.
func redactArgv(argv []string) []string {
	out := make([]string, len(argv))
	for i, a := range argv {
		if i > 0 && argv[i-1] == "-e" {
			if k, _, ok := strings.Cut(a, "="); ok {
				out[i] = k + "=***"
				continue
			}
		}
		out[i] = a
	}
	return out
}
