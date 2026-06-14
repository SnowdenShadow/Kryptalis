// Package sftpserver embeds an SFTP-only SSH server in the agent so
// operators can reach the files of apps deployed on THIS remote server —
// the platform host's SFTP container only serves its own local paths.
//
// Design notes:
//
//   - Accounts are pushed by the API as an SFTP_SYNC task (full desired
//     state, not deltas — idempotent, self-healing) and persisted to
//     accounts.json next to the agent so a restart doesn't drop them.
//   - Auth: bcrypt password hashes and/or SSH public keys, both supplied
//     by the API. Plaintext never reaches the agent.
//   - Authorization: every account is scoped to a list of root dirs
//     (the app dirs / docker volume _data dirs it may see). The handler
//     resolves+validates every path against those roots — a logical
//     chroot. READ accounts get the write/rename/remove handlers
//     refused outright.
//   - The SSH layer rejects every channel type except "session" and
//     every subsystem except "sftp": no shell, no exec, no TCP
//     forwarding. Equivalent posture to the platform's /bin/false +
//     internal-sftp setup.
package sftpserver

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/ssh"
)

// Account mirrors the payload the API sends in SFTP_SYNC.
type Account struct {
	Username     string   `json:"username"`
	PasswordHash string   `json:"passwordHash,omitempty"` // bcrypt
	PublicKeys   []string `json:"publicKeys,omitempty"`   // authorized_keys lines
	Permission   string   `json:"permission"`             // READ | WRITE | ADMIN (ADMIN == WRITE)
	Disabled     bool     `json:"disabled"`
	// Root dirs this account may access, keyed by the display dir name
	// shown at the top level (e.g. "app" or "<slug>-<id12>").
	Roots map[string]string `json:"roots"`
}

type Server struct {
	mu       sync.RWMutex
	accounts map[string]Account

	stateDir string
	addr     string
	hostKey  ssh.Signer
	listener net.Listener
}

// New prepares (but does not start) the server. stateDir holds the host
// key + persisted accounts; addr is the listen address (":2522").
func New(stateDir, addr string) (*Server, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("sftp state dir: %w", err)
	}
	key, err := loadOrCreateHostKey(filepath.Join(stateDir, "ssh_host_ed25519_key"))
	if err != nil {
		return nil, err
	}
	s := &Server{
		accounts: map[string]Account{},
		stateDir: stateDir,
		addr:     addr,
		hostKey:  key,
	}
	s.loadAccounts()
	return s, nil
}

// Sync replaces the full account set (API is the source of truth) and
// persists it. Returns the number of active accounts.
func (s *Server) Sync(accounts []Account) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.accounts = map[string]Account{}
	for _, a := range accounts {
		if a.Username == "" {
			continue
		}
		s.accounts[a.Username] = a
	}
	s.persistAccountsLocked()
	return len(s.accounts)
}

func (s *Server) persistAccountsLocked() {
	blob, err := json.MarshalIndent(mapValues(s.accounts), "", "  ")
	if err != nil {
		return
	}
	path := filepath.Join(s.stateDir, "accounts.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o600); err == nil {
		_ = os.Rename(tmp, path)
	}
}

func (s *Server) loadAccounts() {
	blob, err := os.ReadFile(filepath.Join(s.stateDir, "accounts.json"))
	if err != nil {
		return
	}
	var list []Account
	if json.Unmarshal(blob, &list) != nil {
		return
	}
	for _, a := range list {
		if a.Username != "" {
			s.accounts[a.Username] = a
		}
	}
}

func mapValues(m map[string]Account) []Account {
	out := make([]Account, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

// Serve blocks accepting connections until the listener is closed.
func (s *Server) Serve() error {
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return fmt.Errorf("sftp listen %s: %w", s.addr, err)
	}
	s.listener = ln
	log.Printf("sftp: listening on %s", s.addr)
	for {
		conn, err := ln.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			continue
		}
		go s.handleConn(conn)
	}
}

func (s *Server) Close() {
	if s.listener != nil {
		_ = s.listener.Close()
	}
}

func (s *Server) sshConfig() *ssh.ServerConfig {
	cfg := &ssh.ServerConfig{
		PasswordCallback: func(meta ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			acc, ok := s.lookup(meta.User())
			if !ok || acc.Disabled || acc.PasswordHash == "" {
				return nil, fmt.Errorf("auth failed")
			}
			if bcrypt.CompareHashAndPassword([]byte(acc.PasswordHash), password) != nil {
				return nil, fmt.Errorf("auth failed")
			}
			return nil, nil
		},
		PublicKeyCallback: func(meta ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			acc, ok := s.lookup(meta.User())
			if !ok || acc.Disabled {
				return nil, fmt.Errorf("auth failed")
			}
			marshaled := string(ssh.MarshalAuthorizedKey(key))
			for _, line := range acc.PublicKeys {
				parsed, _, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
				if err != nil {
					continue
				}
				if string(ssh.MarshalAuthorizedKey(parsed)) == marshaled {
					return nil, nil
				}
			}
			return nil, fmt.Errorf("auth failed")
		},
	}
	cfg.AddHostKey(s.hostKey)
	return cfg
}

func (s *Server) lookup(username string) (Account, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	a, ok := s.accounts[username]
	return a, ok
}

func (s *Server) handleConn(raw net.Conn) {
	defer raw.Close()
	sshConn, chans, reqs, err := ssh.NewServerConn(raw, s.sshConfig())
	if err != nil {
		return
	}
	defer sshConn.Close()
	go ssh.DiscardRequests(reqs)

	acc, ok := s.lookup(sshConn.User())
	if !ok || acc.Disabled {
		return
	}

	for newChan := range chans {
		if newChan.ChannelType() != "session" {
			_ = newChan.Reject(ssh.Prohibited, "only sftp sessions are allowed")
			continue
		}
		channel, requests, err := newChan.Accept()
		if err != nil {
			continue
		}
		go func(ch ssh.Channel, in <-chan *ssh.Request) {
			defer ch.Close()
			sftpRequested := false
			for req := range in {
				// Accept ONLY the sftp subsystem; refuse shell/exec/pty.
				if req.Type == "subsystem" && len(req.Payload) > 4 && string(req.Payload[4:]) == "sftp" {
					sftpRequested = true
					_ = req.Reply(true, nil)
					break
				}
				_ = req.Reply(false, nil)
			}
			if !sftpRequested {
				return
			}
			handlers := newScopedHandlers(acc)
			server := sftp.NewRequestServer(ch, handlers)
			_ = server.Serve()
			_ = server.Close()
		}(channel, requests)
	}
}

func loadOrCreateHostKey(path string) (ssh.Signer, error) {
	if blob, err := os.ReadFile(path); err == nil {
		signer, err := ssh.ParsePrivateKey(blob)
		if err == nil {
			return signer, nil
		}
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	pemBlock, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		return nil, err
	}
	blob := pem.EncodeToMemory(pemBlock)
	if err := os.WriteFile(path, blob, 0o600); err != nil {
		return nil, err
	}
	return ssh.ParsePrivateKey(blob)
}

// ── scoped filesystem handlers ──────────────────────────────────────

// scopedHandlers implements sftp.Handlers with a virtual layout:
//
//	/                  → synthetic dir listing the account's root names
//	/<rootName>/...    → mapped onto the configured real path
//
// Every real path is Cleaned and verified to stay under its root —
// symlinks are NOT followed for containment (Lstat-based walk), same
// posture as the platform file manager.
type scopedHandlers struct {
	acc Account
}

func newScopedHandlers(acc Account) sftp.Handlers {
	h := &scopedHandlers{acc: acc}
	return sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h}
}

var errDenied = errors.New("permission denied")
var errNotFound = errors.New("file does not exist")

// resolve maps a virtual SFTP path to a real path, enforcing containment.
func (h *scopedHandlers) resolve(vpath string) (string, error) {
	clean := filepath.ToSlash(filepath.Clean("/" + strings.TrimPrefix(vpath, "/")))
	if clean == "/" {
		return "", errDenied // root is virtual-only — callers handle it
	}
	parts := strings.SplitN(strings.TrimPrefix(clean, "/"), "/", 2)
	rootName := parts[0]
	rootPath, ok := h.acc.Roots[rootName]
	if !ok {
		return "", errNotFound
	}
	real := rootPath
	if len(parts) == 2 && parts[1] != "" {
		real = filepath.Join(rootPath, filepath.FromSlash(parts[1]))
	}
	// Containment (lexical): the joined path must stay under the root.
	if !lexContained(rootPath, real) {
		return "", errDenied
	}
	// Containment (real): a symlink planted under the root could point
	// outside it, and os.Open/OpenFile/Rename/Remove all dereference
	// symlinks. Re-check the FULLY RESOLVED real path against the
	// resolved root before handing the path to any os.* call.
	if err := checkRealContained(rootPath, real); err != nil {
		return "", err
	}
	return real, nil
}

// lexContained reports whether real lexically stays under root.
func lexContained(root, real string) bool {
	rel, err := filepath.Rel(root, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return false
	}
	return true
}

// checkRealContained verifies the target real path cannot escape root through
// a symlink. It walks every path component from the root downward and rejects
// if ANY existing component is a symlink — os.Open/OpenFile/Rename/Remove and
// MkdirAll all dereference symlinks, so a symlink anywhere along the path
// (including an intermediate ancestor a create would MkdirAll through) is an
// escape vector. A not-yet-existing tail (upload/rename target, or dirs MkdirAll
// will create) is fine: components that don't exist can't be symlinks, and once
// no existing component is a symlink the lexical containment already proven by
// resolve() holds for the real path too.
//
// This deliberately uses Lstat (never follows) rather than EvalSymlinks: a
// not-fully-resolvable path used to fall through to a lexical-only pass, which
// let a symlinked ancestor of a not-yet-existing parent slip past.
func checkRealContained(root, real string) error {
	// The root itself must be real (resolve once); a symlinked root dir would
	// otherwise make every contained path look like an escape.
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		// Root must exist; if it can't be resolved, refuse rather than guess.
		return errDenied
	}
	rel, err := filepath.Rel(realRoot, real)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		// `real` was built under the (possibly symlinked) root; recompute it
		// against the resolved root so the per-component walk starts clean.
		rel, err = filepath.Rel(root, real)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return errDenied
		}
	}
	// Walk component by component from realRoot; Lstat each and reject symlinks.
	cur := realRoot
	for _, seg := range strings.Split(filepath.ToSlash(rel), "/") {
		if seg == "" || seg == "." {
			continue
		}
		if seg == ".." {
			return errDenied
		}
		cur = filepath.Join(cur, seg)
		info, err := os.Lstat(cur)
		if err != nil {
			// This component (and therefore everything below it) doesn't exist
			// yet. Nothing left to dereference — the remaining tail will be
			// created as real dirs/files under a verified-symlink-free prefix.
			return nil
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errDenied
		}
	}
	return nil
}

func (h *scopedHandlers) canWrite() bool {
	// Platform contract: ADMIN is write-capable (schema: ADMIN == WRITE).
	// Treating only "WRITE" as writable left remote ADMIN accounts read-only.
	return !h.acc.Disabled &&
		(strings.EqualFold(h.acc.Permission, "WRITE") || strings.EqualFold(h.acc.Permission, "ADMIN"))
}

func (h *scopedHandlers) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	real, err := h.resolve(r.Filepath)
	if err != nil {
		return nil, err
	}
	return os.Open(real)
}

func (h *scopedHandlers) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	if !h.canWrite() {
		return nil, errDenied
	}
	real, err := h.resolve(r.Filepath)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(real), 0o755); err != nil {
		return nil, err
	}
	// pkg/sftp streams the body via WriteAt at increasing offsets. With a
	// plain O_WRONLY|O_CREATE, overwriting a file with shorter content
	// leaves the original tail bytes in place → corruption. Standard SFTP
	// write-open semantics truncate on open unless the client asked to
	// append, so add O_TRUNC for the non-append case. A non-zero starting
	// offset / explicit append leaves existing content intact for partial
	// writes.
	flags := os.O_WRONLY | os.O_CREATE
	pf := r.Pflags()
	if !pf.Append {
		// Non-append open → truncate so a shorter overwrite can't leave the
		// previous file's tail behind. (Append must NOT add O_APPEND: pkg/sftp
		// writes via WriteAt, which is incompatible with O_APPEND on most
		// platforms — the offset already places the bytes correctly.)
		flags |= os.O_TRUNC
	}
	return os.OpenFile(real, flags, 0o644)
}

func (h *scopedHandlers) Filecmd(r *sftp.Request) error {
	if !h.canWrite() {
		return errDenied
	}
	real, err := h.resolve(r.Filepath)
	if err != nil {
		return err
	}
	switch r.Method {
	case "Setstat":
		// Accept silently — clients send chmod/utimes after upload; the
		// platform file model doesn't track per-file modes.
		return nil
	case "Rename":
		target, err := h.resolve(r.Target)
		if err != nil {
			return err
		}
		return os.Rename(real, target)
	case "Rmdir":
		return os.Remove(real)
	case "Remove":
		return os.Remove(real)
	case "Mkdir":
		return os.MkdirAll(real, 0o755)
	case "Symlink":
		// Symlinks could escape the containment walk — refuse.
		return errDenied
	default:
		return errDenied
	}
}

type listerat []os.FileInfo

func (l listerat) ListAt(f []os.FileInfo, off int64) (int, error) {
	if off >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(f, l[off:])
	if n < len(f) {
		return n, io.EOF
	}
	return n, nil
}

func (h *scopedHandlers) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	clean := filepath.ToSlash(filepath.Clean("/" + strings.TrimPrefix(r.Filepath, "/")))
	switch r.Method {
	case "List":
		if clean == "/" {
			infos := make([]os.FileInfo, 0, len(h.acc.Roots))
			for name := range h.acc.Roots {
				st, err := os.Stat(h.acc.Roots[name])
				if err != nil {
					continue
				}
				infos = append(infos, renamedInfo{FileInfo: st, name: name})
			}
			return listerat(infos), nil
		}
		real, err := h.resolve(clean)
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(real)
		if err != nil {
			return nil, err
		}
		infos := make([]os.FileInfo, 0, len(entries))
		for _, e := range entries {
			info, err := e.Info()
			if err == nil {
				infos = append(infos, info)
			}
		}
		return listerat(infos), nil
	case "Stat", "Lstat":
		if clean == "/" {
			return listerat([]os.FileInfo{renamedInfo{FileInfo: dirStatSelf(), name: "/"}}), nil
		}
		real, err := h.resolve(clean)
		if err != nil {
			return nil, err
		}
		st, err := os.Lstat(real)
		if err != nil {
			return nil, err
		}
		return listerat([]os.FileInfo{st}), nil
	default:
		return nil, errDenied
	}
}

// renamedInfo overrides the display name of an os.FileInfo (top-level
// roots show their virtual dir name, not the real basename).
type renamedInfo struct {
	os.FileInfo
	name string
}

func (r renamedInfo) Name() string { return r.name }

func dirStatSelf() os.FileInfo {
	st, err := os.Stat(".")
	if err == nil {
		return st
	}
	return nil
}
