# DockControl — Engineering Analysis Report

*Prepared by: Lead Reviewer · Date: 2026-06-27*
*Scope: full monorepo — NestJS API (~51k LOC), Next.js dashboard (~27k LOC), Go agent (~4k LOC), Prisma schema (30 models), install/ops tooling. All findings below were independently verified against source.*

---

## 1. Executive Summary

DockControl is a self-hosted Platform-as-a-Service: it takes a user-supplied source (Git repo, Docker image, Compose, Dockerfile, or PHP site), builds and runs it as containers, fronts it with a managed Caddy reverse proxy + automatic Let's Encrypt TLS, and manages the full lifecycle across a local Docker daemon and remote hosts driven by a Go agent. It includes one-click marketplace stacks, managed databases, encrypted backups, per-domain mail hosting, SFTP, monitoring, and a bilingual operator dashboard.

**Overall maturity verdict: strong engineering, with a small number of sharp security edges that must be addressed before exposing this to untrusted tenants.**

This is a notably mature codebase for a self-hosted PaaS. The security *intent* is first-class and unusually well-documented — refresh-token family revocation (RFC 6819), SSRF screening, no-shell `execFile` argv everywhere, encryption-at-rest envelopes, blue-green canary deploys with rollback, and disciplined input validation at the HTTP boundary. Test investment is well above genre norm (~15k lines of vitest, ~0.42 spec-to-source ratio) and deliberately targets the risky surfaces. The architecture is a clean, intentionally-decomposed 27-module NestJS graph with documented cross-module dependencies.

The headline risks are concentrated, not systemic:

| # | Severity | Risk | One-line |
|---|----------|------|----------|
| 1 | **CRITICAL** | Compose-injection via env-var **key** in marketplace `install-custom` | A project-DEVELOPER can deploy a `privileged` container with `/` bind-mounted → full host root compromise. |
| 2 | **HIGH** | Agent runs over plain HTTP by default, no response authentication | MITM on a fresh install → forged DEPLOY/EXEC tasks (root RCE) + cleartext git tokens/DB passwords. |
| 3 | **HIGH** | Unattended auto-update with host docker socket, no commit signature | Anyone who can push to the tracked branch gets fleet-wide root RCE within ~60s. |
| 4 | **MEDIUM** | Cross-tenant IDOR on agent task status endpoint | Any authenticated user who learns a task id can read another tenant's EXEC output/errors. |
| 5 | **MEDIUM** | Webhook SSRF screen bypassed by HTTP redirects / DNS rebinding | Admin-gated, blind POST SSRF into internal services / cloud metadata. |
| 6 | **MEDIUM** | Agent token sent as URL query param + plaintext HTTP | Root-equivalent token leaks into proxy/access logs. |

The unifying theme of the worst findings is the **host trust boundary**: the API and agent both have root-equivalent control of the host docker daemon by design, so any input-validation gap or transport weakness escalates directly to host compromise. The platform is architected for a **single-instance, single-operator** topology; several controls (webhook replay protection, scheduler leader election, per-app deploy serialization) silently degrade in any multi-replica or genuinely multi-tenant deployment.

**Recommendation:** Fix finding #1 immediately (it is reachable by the lowest meaningful privilege in the system). Harden the agent transport (#2) and auto-update integrity (#3) before any production exposure. The remaining items are real but bounded.

---

## 2. Architecture Overview

DockControl is a monorepo with four deployables and a shared types package.

### API (NestJS, ~51k LOC) — 27 modules

The control plane. Cleanly decomposed; every cross-module import in a `*.module.ts` carries a comment justifying the dependency, `@Global` is reserved for genuinely cross-cutting providers (Crypto, Notifications, ReverseProxy, System, DeploymentTarget), and `forwardRef` is confined to the single real cycle (Domains ↔ Email).

- **Auth / RBAC core** — registration with first-user bootstrap, email verification, TOTP 2FA, JWT access + rotating refresh sessions with family revocation, two-tier RBAC (global `Role` via `RolesGuard`; per-project `ProjectRole` via `common/rbac/project-access.ts`). Platform admins act as project `OWNER` everywhere.
- **Applications / deployments / build pipeline** — the PaaS engine. Turns sources into containers, manages lifecycle, attaches Caddy domains and per-project networks, auto-redeploys on git push via signed webhooks. Split into 5 collaborating services (facade + Deploy/Ops/Network/Env).
- **Marketplace / domains / SSL / reverse-proxy** — one-click stacks, domain binding, and a single managed Caddy that terminates TLS and auto-issues certs (Caddy issues certs; the SSL module is a thin RBAC/diagnostics layer over it).
- **Data plane** — databases, file browsing/editing, encrypted backups (local + S3), project migration and encrypted `.dctproj` export/import, glued by one AES-256-GCM `EncryptionService`.
- **Infra control-plane** — agent register/poll/heartbeat protocol, server metrics + threshold alerts, notifications (email + SSRF-screened webhooks + in-app feed), SFTP, mail stacks, cron, raw Docker introspection, orphan reaper, `SystemSetting` store, admin/RBAC administration, git-poll self-update.

### Go agent (~4k LOC)

On-host worker installed on remote (and the platform's own) servers. Polls the API, executes Docker lifecycle/file ops locally, streams backup/volume archives, sends heartbeats, and runs an embedded SFTP-only SSH server. Clean package layering (`config`/`monitor`/`poller`/`sftpserver`/`tasks`) with a single flat task-dispatch switch — markedly cleaner structure than the API's deploy side.

### Dashboard (Next.js 15, ~27k LOC)

App-Router SPA (all pages `'use client'`), a thin presentation layer over the API. All backend access funnels through one shared `apps/dashboard/src/lib/api.ts` client. **All authorization in the dashboard is cosmetic** — route protection is a `useEffect` redirect and role gating hides nav. This is correct *only if* the API enforces `@Roles` on every endpoint; the API guards are the real trust boundary.

### Data model (Prisma, ~30 models)

One PostgreSQL schema, baseline migration + 16 incremental SQL migrations. No ORM middleware, soft-delete, or seed layer — referential integrity is pushed into Postgres FKs with deliberate, mostly-correct cascade/`SetNull`/`RESTRICT` choices.

### Install / ops layer

A single `curl | sudo sh` installer provisions an Ubuntu/Debian VPS and brings up a 5-service Compose stack (postgres, caddy, api, dashboard, sftp). The **API container mounts `/var/run/docker.sock` and runs as root** — this is the foundational trust assumption that makes the security findings below matter.

---

## 3. Security Findings

Grouped by severity. Each finding has been verified against source; file:line references are exact.

### 🔴 CRITICAL

#### C-1 — Docker-compose injection via unescaped env-var KEY (marketplace install-custom)

- **Location:** `apps/api/src/modules/marketplace/templates.ts:1054` (renderer); reachable via `apps/api/src/modules/marketplace/marketplace.service.ts` `installCustom` (742–856) and `install-custom.dto.ts:133-136`.
- **Who can trigger:** any user with **project-DEVELOPER** role on any project — the lowest meaningful privilege in the system.
- **Root cause:** `renderCustomComposeTemplate` emits each env entry as `      ${k}: ${JSON.stringify(String(v))}`. The **value** is escaped via `JSON.stringify`, but the **key** is interpolated completely raw. An env key containing a newline + indentation injects sibling YAML keys at service level.
- **Why nothing catches it:** `envVars` is only `@IsObject()` in the DTO; class-validator does not constrain dynamic `Record` keys, and the global `ValidationPipe` (`whitelist`/`forbidNonWhitelisted`) only filters top-level DTO properties, not nested object keys. `installCustom` validates the image regex, runs `checkVolumeSafety` on the volumes field, and blocks reserved ports — but performs **no validation of env keys**. `encryptEnvVars` only encrypts values.
- **Impact:** A key such as

  ```
  X: 0
      privileged: true
      cap_add:
        - SYS_ADMIN
      volumes:
        - /:/host
      ignore
  ```

  produces structurally valid YAML adding `privileged: true`, `cap_add: [SYS_ADMIN]`, and a `/:/host` bind-mount as siblings of the app service. `runDockerCompose` then runs `docker compose up -d` against the **host** docker daemon (the API container mounts `/var/run/docker.sock`, `docker-compose.yml:169`). This is **full root-equivalent host compromise** — every tenant's data, the `.env` secrets, and the docker socket — and it bypasses `checkVolumeSafety`, the image regex, and the `RESERVED_HOST_PORTS` guard entirely.
- **Corroborating signal:** `marketplace.service.spec.ts:960-974` already tests rejection of this exact newline→compose-key injection *via the volumes channel* — the team's own threat model treats it as a host escape, yet left the env-key channel unguarded. There is no test for env-key injection.
- **Note:** the sibling `.env` writer (`marketplace.service.ts:1006-1008`) escapes newlines, so the `.env` channel is safe; the compose `environment:` block is the sole injection point.
- **Fix:**
  1. Validate every env-var key against a strict allowlist (`/^[A-Za-z_][A-Za-z0-9_]*$/`) in `installCustom()`, and re-validate in `renderCustomComposeTemplate` as defense-in-depth (mirroring the volume re-check pattern the code already uses).
  2. **Better:** build the compose as a JS object and serialize with `yaml.dump`, exactly as every `application-deploy.service.ts` path already does (`:417`). This single change eliminates the entire class of injection.

---

### 🟠 HIGH

#### H-1 — Agent has no response authentication and runs over plain HTTP by default

- **Location:** `apps/agent/internal/config/config.go:16-51` (no scheme validation); clients at `poller.go:93` and `tasks/transfer.go:37` use stdlib defaults with no TLS pinning; no HMAC/signature anywhere in `apps/agent/internal`.
- **Default transport is plaintext:** server default is `http://localhost:4000` (`agent.controller.ts:88`); `install.sh:182` sets `http://<public-ip>:4000`; `renderInstallScript` bakes that http URL into `DOCKCONTROL_API_URL` and even performs agent-token-issuing registration over it. `docker-compose.yml` publishes the API on `0.0.0.0:4000` directly; Caddy (80/443) fronts only dashboard/app domains, not the `:4000` agent channel.
- **Impact:** On a default install (no domain yet), a network MITM between agent and API can (a) inject forged DEPLOY/EXEC tasks — `runExec` (`poller.go:759`) runs `docker exec <c> sh -c <command>`, and `runDeploy` executes attacker-controlled compose/Dockerfile, both root-equivalent via the docker socket — and (b) read git clone tokens (`poller.go:495-497`) and **plaintext DB passwords** decrypted server-side immediately before delivery (`agent.service.ts:229-240`, returned at `poll()`). The agent performs **zero** authentication of API responses beyond (optional) TLS, so even with HTTPS a forged-cert MITM or typosquatted endpoint yields root RCE.
- **Mitigating context:** exploitation is MITM-gated; an operator who sets `PUBLIC_API_URL` to `https://`, fronts `:4000` with TLS, and sets `API_BIND=127.0.0.1` eliminates the exposure. But the *default, documented* install is genuinely vulnerable.
- **Fix:**
  1. Enforce `https://` in `config.Load()` (reject http except for an explicit localhost/dev opt-in).
  2. Default `PUBLIC_API_URL` guidance to https and bind `:4000` to loopback by default.
  3. **Sign task payloads** (HMAC over the payload with the shared agent token) or pin the API cert, so a compromised/MITM'd transport cannot drive host operations even if TLS is bypassed.

#### H-2 — Unattended auto-update: `git reset --hard` + rebuild with host docker socket, no commit signature

- **Location:** `apps/api/src/modules/system/system-updates.service.ts:328-500`; `update.sh` (does `git fetch`, `git reset --hard origin/$BRANCH`, `docker compose build`, `up -d --wait`).
- **Mechanism:** `poll()` fetches the latest SHA from `api.github.com` over anonymous HTTPS on a **60s `setInterval`** (started in `onModuleInit`, **not** gated by the controller's `@Roles` guard — that only protects the manual endpoints). When the remote SHA differs, `runUpdate()` spawns `docker run --rm -d -v ${installDir}:${installDir} -v /var/run/docker.sock:/var/run/docker.sock docker:cli sh -c 'sh update.sh'`. Because the API container itself bind-mounts the host docker socket, this reaches the **host** docker daemon.
- **Integrity controls:** none. A grep for `verify-commit`/`verify-tag`/`gpg`/`cosign`/`signature` across `update.sh` and the system module returns nothing. It tracks a **mutable branch tip** (`origin/main`), not a signed/pinned release tag, and applies fully unattended.
- **Impact:** Anyone who can push to (or compromise) the tracked GitHub branch — leaked maintainer/CI credential, malicious merge-capable contributor, GitHub account compromise — gets **arbitrary code execution as root on every DockControl install within ~60s**. A single repo compromise is fleet-wide root RCE. (Held at HIGH rather than CRITICAL only because it requires upstream control, not a direct single-host network exploit.)
- **Secondary:** the privileged updater container also runs `apk add git` over the network (`update.sh:37`) — another unverified dependency fetch in the privileged path.
- **Fix:**
  1. Verify a GPG/sigstore signature on the commit, or pin to signed release tags, before `reset`.
  2. Default auto-apply **off**: check-only with a manual apply button and SHA/diff surfaced for review; gate unattended apply behind explicit operator opt-in.
  3. Consider scoping the updater container's docker access rather than mounting the full host socket.

---

### 🟡 MEDIUM

#### M-1 — Cross-tenant IDOR: agent task status endpoint leaks result/error to any authenticated user

- **Location:** `apps/api/src/modules/agent/agent.service.ts:183`; controller `agent.controller.ts:228-233`.
- **Mechanism:** `GET /api/agent/tasks/:id` is gated **only** by `@UseGuards(AuthGuard('jwt'))` — no `RolesGuard`, no ownership check — and calls `getTaskForUser(id, role)` with no `userId`, so ownership cannot be checked. For any non-admin role it returns `{id,type,status,error,result,...}`; only `payload` is dropped. A grep for `assertProjectAccess|projectId` across the agent module returns zero matches.
- **Impact:** A `USER`/`VIEWER` who learns or guesses another tenant's task id can read the captured `result` and `error` of that tenant's deploys, container EXEC runs, and file/DB ops — `result` carries `docker exec` stdout/stderr (`application-ops.service.ts:549`), which can include secrets echoed by commands, env dumps, or file contents. Read-only; no modification path.
- **Why severity is held at MEDIUM:** `AgentTask.id` is `@default(cuid())` (`schema.prisma:933`) — non-sequential, non-enumerable — so exploitation requires learning/guessing a valid id (via logs, referrals, a leaked id). Note that even the `RolesGuard` used elsewhere would *not* fully fix this: it enforces coarse platform role, not per-project ownership.
- **Fix:** Resolve the task's `serverId` → project and call `assertProjectAccess` in `getTaskForUser`; at minimum, do not return `result`/`error` to a caller with no membership on the owning project (restrict them to ADMIN/SUPERADMIN like `payload` already is).

#### M-2 — Notification webhook SSRF screen bypassed by HTTP redirects (and DNS rebinding)

- **Location:** `apps/api/src/modules/notifications/notifications.service.ts:1025`.
- **Mechanism:** `fetch(url, {method:'POST',...})` is called with **no `redirect` option**. Node ≥20's undici defaults to `redirect:'follow'` (up to 20 hops), and nothing in the repo overrides it. `validateWebhookUrl` (928–985) is a pure URL-string/literal screen that does **not** DNS-resolve and never re-screens a redirect `Location`. A public host the attacker controls can `302` to `http://169.254.169.254/...` or `http://127.0.0.1/...`, which the API host then POSTs to. DNS rebinding is an independent, code-acknowledged bypass of the same string-only screen.
- **Impact:** Blind, POST-only SSRF into the docker network / cloud metadata endpoint (`169.254.169.254`). The code reads only `res.ok`/`res.status`, never the body, so there is no metadata-credential exfiltration via read-back — impact is internal POST requests and metadata probing/timing.
- **Privilege gate (important):** creating an alert rule with a webhook is `@Roles('ADMIN','SUPERADMIN')` — this is a **privilege-to-SSRF pivot**, not any-authenticated-user SSRF. The validator's own comment frames the threat as "an admin (or a compromised one)," so admin-gating is by design and the control is meant to constrain admins too; the bypass defeats the intended control.
- **Fix:** Pass `redirect:'manual'` and treat any 3xx as a hard failure (or re-run `validateWebhookUrl` on each `Location`). For full coverage, resolve the hostname, screen the A/AAAA records, and pin the connection to that IP to close the DNS-rebinding window.

#### M-3 / M-4 — Agent token sent as URL query parameter on transfer endpoints (over plaintext HTTP)

- **Location:** `apps/agent/internal/tasks/transfer.go:41-48` (`transferURL` sets `?...&token=<token>`); API reads `@Query('token')` at `agent.controller.ts:143` and `:205`.
- **Mechanism:** The long-lived, root-equivalent agent token rides in the URL query string for both upload and download (VOLUME_EXPORT/IMPORT, BACKUP, RESTORE). This is an outlier: `poll`, `heartbeat`, and `reportResult` all carry the token in the JSON **body** (`poller.go:161`, `:1023`; `monitor.go:166`) — the codebase deliberately moved auth into the body as a hardening step, and the transfer path regressed that.
- **Impact:** Query-string secrets routinely land in reverse-proxy / load-balancer / APM access logs (the full request line is logged). A log-reader recovers the token → root-equivalent control of every host that token authorizes. Combined with the accepted plain-http scheme (H-1), an on-path attacker sniffs it directly.
- **Scope correction:** these are server-to-server calls with no browser, so the "browser/referrer history" leak vector does **not** apply; the real vectors are intermediary access logs and cleartext transport. Note also: this repo's generated Caddyfile emits no `log` directive and the API has no request-logging middleware, so *by default* nothing here logs the query — the exposure materializes the moment an operator enables proxy access logging or ships logs to an aggregator.
- **Fix:** Move `serverId`/`token` into an `Authorization` / `X-Agent-Token` header on the transfer client (matching poll/heartbeat) and stop accepting `@Query('token')` for transfers. Enforce `https://` in `config.Load()`. (Related, separate: the `install.sh?token=` install-token query param at `agent.controller.ts:79/242`.)

---

### 🟢 LOW

#### L-1 — CORS special-cases literal `'*'` together with `credentials:true`

- **Location:** `apps/api/src/main.ts:123` (special-cases `allowlist.includes('*')` → `cb(null, true)`) and `:128` (`credentials:true`).
- **Mechanism:** `CORS_ORIGINS=*` is not rejected (`app.module.ts:61` is `Joi.string().allow('')`); the code path turns it into the dangerous **reflect-Origin + credentials** combination rather than the browser-safe bare `*`.
- **Impact:** An operator misconfiguration silently becomes a credential-exposing any-origin policy. **Not a default-config vuln** — the out-of-the-box allowlist never contains `*`, and the refresh token is httpOnly so it cannot be exfiltrated cross-origin. Exploitation requires the operator to actively set `CORS_ORIGINS=*`.
- **Fix:** Refuse to honor `'*'` when `credentials:true` (ignore it, or require an explicit `ALLOW_INSECURE_CORS` flag with a loud warning), or validate `CORS_ORIGINS` at boot.

#### L-2 — Agent token transmitted in URL on transfers (credential-hygiene)

Same root issue as M-3/M-4, captured separately as a CWE-598 defense-in-depth note; see fix above. Worth doing for consistency with the codebase's own hardening of poll/heartbeat.

---

### Also checked — *not* exploitable

These were investigated and found to be non-issues; noting them so they aren't re-raised:

- **`assertDbAccess` fail-open on dangling `applicationId`** (`databases.service.ts:269`) — the dead-code `if (app)` with no `else` is real, but the dangling-row precondition is structurally impossible: a Postgres FK with `ON DELETE SET NULL` (`0_init/migration.sql:735`) guarantees `applicationId` is either NULL or live. Harmless; align with `files.service.ts` for consistency only.
- **Env-key injection into the `.env` file** (`marketplace.service.ts:1006`) — newline in a key does inject a line, but a DEVELOPER can already supply any well-formed key by design, so it grants nothing new. (The *compose* env-key path, C-1, is the real bug.)
- **Webhook SSRF via non-dotted IPv4 encodings** — WHATWG `URL` normalizes decimal/hex/octal hosts to dotted-quad before the regex runs; `http://2130706433/` becomes `127.0.0.1` and is blocked (and is tested, `webhook-ssrf.spec.ts:35-36`).
- **Access/refresh JWT interchangeability if secrets equal** — refresh verification also requires `sha256(token)` to match a stored session hash; only the *refresh* token's hash is ever stored, and differing expirations make the bytes differ regardless. Not reachable.
- **`ENCRYPTION_KEY` 128-bit entropy** — installer uses `openssl rand -hex 16`; 128 random bits is uncrackable. Documentation/label nit only ("AES-256-GCM" overstates effective keying), not a vuln.
- **`EncryptionService.decrypt()` legacy-plaintext passthrough** — every security consequence is fail-*closed* (wrong HMAC → verification fails; bad TOTP → returns false; corrupted credentials → downstream rejects). Intentional backward-compat.
- **Content-Disposition filename quote** — the quote/backslash/`;` stripping happens one layer earlier in the service (`files.service.ts:1321`, `docker-fs.ts:314`, `databases.service.ts:883`), tested at `files.service.spec.ts:740`. The controller regex is a redundant second pass.
- **Inline-typed auth bodies bypass ValidationPipe** (`auth.controller.ts:181/189/197`) — real DTO-consistency nit, but password strength is enforced in `AuthService.isStrongEnough` and emails are normalized + parameterized + throttled. Cosmetic.
- **Agent `register()` writes `host` verbatim → flip to LOCAL** — install-token minting is `@Roles('ADMIN','SUPERADMIN')` only; the recipient is the operator who already controls the control plane. Worth validating `host`/rejecting `LOCAL_HOSTS` as defense-in-depth (a *leaked* admin token could be replayed), but not the multi-tenant escape originally claimed.
- **`curl | sudo sh` installer** — standard for the genre; HTTPS, no `-k`. Externally-rooted trust assumption, not a reachable bug.
- **EXEC runs arbitrary `sh -c` inside containers** — properly RBAC-gated (`assertProjectAccess` ≥ DEVELOPER, scoped to the caller's own app's container). Intended PaaS capability, by design.

---

### Standing architectural security notes (by design, worth stating)

- **The API and agent are root-equivalent on the host** (docker socket, arbitrary `docker exec`/`run -v`). Any RCE/SSRF/path-traversal in the API is a host takeover. This is the genre's reality, but it raises the stakes on every input-validation finding above.
- **All dashboard authorization is client-side/cosmetic.** Correct *only if* the API enforces `@Roles` on every endpoint. Any endpoint missing a server-side guard is fully exploitable regardless of hidden nav — and M-1 is exactly such a gap.
- **DEVELOPER is a low bar for arbitrary container execution.** The compose/Dockerfile editors, EXEC, and marketplace installs all give a project-DEVELOPER broad command execution on the host docker daemon by design. Confirm DEVELOPER grants are reserved for trusted collaborators.
- **Portainer / curated templates can mount `/var/run/docker.sock`** (`checkVolumeSafety` blocks it for custom installs but curated templates are exempt) — installing Portainer = host-level Docker control.
- **SSL private keys at rest in cleartext:** `SSLCertificate.certificate`/`privateKey` are plain `String` with no encryption marker (`schema.prisma`), unlike every other secret field. The `ssl_certificates` table is currently never populated, but if it ever is, this is a cleartext-private-key-at-rest exposure. `MailServer.dkimPrivateKey` similarly lacks an `Enc` suffix (comment says "encrypted at rest in V4," implying plaintext today). Verify before that table goes live.
- **MongoDB password on argv:** `db-dump.util.ts` `dumpPlan`/`restorePlan` pass `--password <pass>` on the `docker exec` argv for mongodump/mongorestore (visible via `ps` during the dump window) — the only off-argv hole among the engines; acknowledged/deferred in-code.
- **Whole-server backups are unencrypted by default:** `BACKUP_ENCRYPTION_KEY` is opt-in, so a LOCAL whole-server dump holds every tenant's DB data on disk with only sha256 integrity (no confidentiality) unless the operator sets the key.
- **DB credentials visible to project VIEWERs:** `findAll`/`connectionInfo` return the decrypted password to any project VIEWER — documented as intentional (dashboard shows it); confirm this RBAC contract is desired.

---

## 4. Code Quality & Architecture Assessment

Each dimension below was rated on a four-point scale (**excellent / good / fair / needs work**). All five rated **good** overall, with specific high-priority issues called out.

### 4.1 Architecture, module boundaries, coupling, reuse — **Good**

Clean, intentional 27-module decomposition with documented dependencies and restrained use of `@Global`/`forwardRef`. Excellent shared-helper extraction where done (`common/paths.ts`, `applications.helpers.ts`, `common/rbac/project-access.ts`, `db-dump.util.ts`). The applications domain is well-split into 5 cohesive services.

The recurring weakness is **duplication born of a missing data-access boundary**:

- **[HIGH] Five near-parallel deploy methods** (`application-deploy.service.ts`, 1992 lines): `runDeploy`/`runDockerImageDeploy`/`runComposeOnlyDeploy`/`runDockerfileOnlyDeploy`/`runPhpSiteDeploy` each re-implement the same lifecycle (status→DEPLOYING, network-ensure, appDir teardown, success finalization, near-identical catch). There are 5 copies of the catch handler and 10+ copies of `proxy.regenerate().catch(()=>{})` (lines 188, 216, 438, 466, 649, 679, 875, 927, 1199, 1227, 1355, 1856, 1924). A change to the failure contract must be made in 5+ places. A `withDeploymentLifecycle(...)` template-method wrapper would collapse this — the team already proved it knows this pattern in `applications.helpers.ts`.
- **[HIGH] DB compose templates duplicated across two modules and already drifted:** `databases.service.ts` `DB_CONFIGS` (module-private) vs `projects.service.ts` `renderDbCompose()` (793–820). The MariaDB template uses `MYSQL_*` keys in one and `MARIADB_*` in the other — a **real correctness divergence**: a managed MariaDB rebuilt via the projects path initializes with different env vars. The projects copy also builds YAML by raw string interpolation of the decrypted password (`${pass}`), reintroducing the compose-injection vector the helpers exist to prevent. Export `DB_CONFIGS` and have projects consume it.
- **[HIGH] No data-access boundary:** services use `PrismaClient` directly. `application` is written by agent, applications (4 services), marketplace, *and* projects modules; read directly by 20 service files. `marketplace.service.ts` independently does `application.create()` and drives the status lifecycle — a parallel ~500-line re-implementation of the deploy pipeline rather than dispatching through `ApplicationsService`. This is the root cause behind both the DB-template and marketplace duplication, and it makes invariants (status transitions, soft-delete, audit) impossible to enforce in one place.
- **[MEDIUM]** Stream-to-file exec plumbing (`runCommandToFile`/`runCommandWithInputFile`) duplicated byte-for-byte across `backups.service.ts` (701/731), `projects.service.ts` (38/64), and `project-transfer.service.ts`. Belongs in `db-dump.util.ts`.
- **[MEDIUM]** God-services/methods: `ProjectsService` injects 10 collaborators (1237 lines); `ApplicationsService.create()` ~417 lines; `moveServer()` ~317 lines; `marketplace install()` ~500 lines.
- **[MEDIUM]** Dashboard has no feature/data-hook layer: 151 `useMutation` + 196 `useQuery` inlined across 24 page files, each re-declaring query keys and invalidation. Pages are 960–1166 lines. Extracting per-resource hooks (`useApplications`, …) would remove most duplication.
- **[LOW]** `DeploymentTargetService` refactor half-finished (its own header says "migration of the three callers is deferred"); LOCAL/REMOTE logic split between the seam and ad-hoc `resolveRemoteServer()` checks.
- **[LOW]** Dead `handleWebhook()` in `git.service.ts` forges a Deployment row attributed to `prisma.user.findFirst()` (typically superadmin) with no verification — unrouted but a re-wiring footgun; delete it.
- **[LOW]** Stale `'VOLUME_LIST' as any` cast (`applications.service.ts:855`) — `VOLUME_LIST` is now a real `TaskType` enum member; the cast and its comment are stale.

### 4.2 Error handling, atomicity, idempotency, race conditions — **Good**

Genuinely strong foundations: `FOR UPDATE SKIP LOCKED` CTE task-claiming is correct and exclusive; result reporting is idempotent (`alreadyFinalized` guard) and server-scoped; agent `reportResult` distinguishes permanent vs transient errors; the **local** git deploy has real config rollback via `.prev` snapshot + blue-green canary; per-task-type timeouts and SIGTERM drain prevent hung deployments.

The gaps cluster around **the local-vs-remote asymmetry** and **best-effort concurrency guards**:

- **[MEDIUM] `failStaleTasks` lost-update race** (`agent.service.ts:126-145`): the sweep does `findMany(status IN QUEUED/RUNNING)` then a separate `updateMany` keyed **only** on `id`, with no status predicate. An agent legitimately reporting COMPLETED in that window gets clobbered back to FAILED, re-running `handleTaskTermination` as FAILED (which **drops the `onComplete` chain** — e.g. a cross-server VOLUME_IMPORT/RESTORE never enqueues). `taskResult()` got the idempotency guard right; this path is the gap. **One-line fix:** add `status: { in: ['QUEUED','RUNNING'] }` to the `updateMany` where-clause.
- **[MEDIUM] Remote git deploy has no `.prev` snapshot and no rollback** (`poller.go:452-640`): the agent does `os.RemoveAll(dir)` **before** cloning, with no snapshot and no canary. A failed clone/build/`up` leaves the stack down with the previous config gone. The API just flips to ERROR (`application-deploy.service.ts:1368-1386`). Remote-hosted apps have a materially worse failure mode than local ones for the identical operation.
- **[MEDIUM] No per-app serialization on the agent** (`poller.go:61,127-136`): the agent runs up to 4 tasks concurrently with no per-app/per-dir lock, and `assertNoInflightDeployment` is best-effort with a documented TOCTOU window (no DB unique index / advisory lock). Two near-simultaneous redeploys (webhook + manual, or two webhooks) can both enqueue and race on the same appDir — `os.RemoveAll`/clone vs build/`up`. Real fix: a partial unique index on `(applicationId, status IN inflight)` or a per-app advisory lock.
- **[LOW]** Local image/compose redeploys destroy the appDir with no rollback (only the git path snapshots `.prev`) — the rollback safety net was added to `runDeploy()` but not back-ported (same 5-method duplication problem surfacing as divergent failure contracts).
- **[LOW]** Webhook auto-redeploy propagates the inflight `ConflictException` (409) to the git provider (`webhooks.controller.ts:180`, no try/catch) → recorded as a failed delivery → retried. A push during an active deploy should be a benign skip.
- **[LOW]** Marketplace port allocation is a TOCTOU race that only probes *running* containers (`marketplace.service.ts:697-730`) and assumes-free on probe error.
- **[LOW]** `onComplete` chaining failures are logged-and-dropped with no retry → a partial cross-server move is left half-done with staged data (`agent.service.ts:567-631`).
- **[LOW]** The highest-consequence queue properties — `alreadyFinalized` idempotency, the stale-sweep race, `SKIP LOCKED` exclusivity — have **no tests** despite excellent coverage of the secret-handling paths.

### 4.3 Type safety & DTO/input validation — **Good**

Input validation at the HTTP boundary is genuinely strong: the global `ValidationPipe` (`main.ts:133`) runs `whitelist + forbidNonWhitelisted + transform`; all 45 DTO files carry decorators; `create-application.dto.ts` uses security-aware `Matches()` regexes and `MaxLength` caps, and the `declare restoreVolumes?` trick shows staff-level toolchain understanding. The two highest-value strict flags (`strictNullChecks`, `noImplicitAny`) are on in the API tsconfig.

The weaknesses are about **contract enforcement vs documentation**:

- **[HIGH] `@dockcontrol/types` is a one-directional hand-maintained mirror the API never consumes:** zero API source files import it; no API controller declares an explicit return type, so nothing links the real response to `ApplicationResponse`. The only binding is a `/** Mirrors ... */` comment. API and shared types can silently diverge with no compile error — the "shared types" are documentation, not a guarantee.
- **[HIGH] Gratuitous/stale `as any` in security-critical session code** (`auth.service.ts`): `'REVOKED' as any` (662,664,670,680,682), `'ACTIVE'/'PENDING' as any` (583,628,370) — unnecessary, since bare literals compile fine (line 701 proves it). The cast strictly removes typo protection: `'REVOEKD' as any` would compile and silently fail to revoke. `(dto as any).totpCode/.backupCode` (485,495) also defeats rename-safety in the 2FA gate.
- **[MEDIUM]** Nested/`Record` payloads validated only at `@IsObject()` depth — `@ValidateNested` is used exactly once in the whole API (`agent-heartbeat.dto.ts:54`). `envVars`/`phpIni`/`portMapping` and the heartbeat metrics object are unvalidated interiors; `Record<string,string>` is a runtime lie. Mitigated for env by `String(v)` coercion at render time, but the contract is shallower than the types claim.
- **[MEDIUM]** Prisma include/select results repeatedly cast to `any` to reach relation/partial-select fields (`databases.service.ts` has 14, incl. double-unsafe `(db as any).autoImported as boolean`; `files.service.ts` similar). Thread `Prisma.DatabaseGetPayload<...>` instead.
- **[MEDIUM]** API↔agent task contract is fully untyped on both sides (`enqueueAndWait(payload: any)`; Go `Payload map[string]interface{}`, 69 uses). The stale `'VOLUME_LIST' as any` cast now *contradicts* the schema, and the `packages/types` mirror still omits it — three-way drift.
- **[LOW]** API tsconfig runs `strict:false` (cherry-picks flags); notably `useUnknownInCatchVariables` is off, so every `catch (e)` is `any`. The dashboard and types package use full strict — the strictest config is applied to everything *except* the most security-sensitive code.
- **[LOW]** Dashboard redefines ~96 contract types locally (whole modules — email, files, cron, sftp, ssl — have no shared types), leaking as casts like `(app as any).slugName`.

### 4.4 Test coverage — **Good**

Strong, deliberate investment (~15k lines vitest, 878 cases across 44 spec files, ~0.42 ratio). The **hardest security invariants are tested well**: refresh-token family revocation end-to-end with real crypto/JWT and mocked Prisma (`auth-flow.spec.ts` — replay→family revoke, stolen-token detection, lost-CAS race, resetPassword revoking all sessions); the deploy pipeline's failure contract at the argv level (`application-deploy.service.spec.ts`, 1369 lines — canary crash → FAILED + old container never removed); the webhook trust boundary; and the genuinely host-dangerous Go surfaces (zip-slip, symlink-escape, dump/restore argv redaction).

The gap is the **HTTP authorization boundary** — the real trust boundary — and integration testing:

- **[HIGH]** `RolesGuard` (`common/guards/roles.guard.ts`) and the live-DB `JwtStrategy` have **zero tests**. The "ban/demotion takes effect immediately" security property is completely unverified; only 1 of 28 controllers and 1 of 3 guards have specs.
- **[HIGH]** `admin.service.ts` (446 lines) — privilege-escalation and last-superadmin guards (`assertCanGrantRole`, "cannot change your own role", "never delete the last superadmin") — is **completely untested**. A regression here is privilege escalation or platform lockout.
- **[MEDIUM]** Destructive infra services untested: `docker.service.ts` (protected-container fail-closed), `reaper.service.ts` ("never remove anything we can't tie back to the DB"), `monitoring.service.ts` `evaluateAlerts()` (threshold boundary).
- **[MEDIUM]** No integration/contract tests anywhere — every API spec mocks Prisma with `vi.fn()` (526 occurrences; no testcontainers/pg-mem), so the actual SQL, `$transaction` atomicity, FK cascade semantics, and the broken nullable `@@unique([applicationId,serviceName])` dedup are never executed against Postgres. The Playwright e2e layer mocks the *entire* API, so the dashboard↔API contract is never validated either.
- **[LOW]** No coverage threshold/reporting configured; 18+ services have zero spec import.
- **[LOW]** The TOCTOU/concurrency hazards the mapping flags rest on comments, not regression tests.

### 4.5 Performance, observability, operability — **Good**

Install/update/migration operability is **excellent and scar-tissue-informed**: `docker-start.sh` baselines `0_init` only on the exact P3005 signature; `update.sh` emulates pipefail in POSIX sh, builds before `up`, and uses `--wait --wait-timeout 300`; `SystemUpdatesService` uses ETag-cached polling, fail-closed verdicts, and a sticky `lastFailedSha`. Background jobs are uniformly bounded and self-pruning. `docker.service.ts` is a model observability boundary (full argv + truncated stderr under a correlation id, generic client error). The Go poller caps concurrency at 4 with per-task timeouts and backoff.

The gaps are **N+1 process forks**, **observability outside that one file**, and **single-instance assumptions**:

- **[HIGH] `findAll` spawns one `docker compose ps` per local app on every 5s poll** (`applications.service.ts:558` → `application-ops.service.ts:619`): the dashboard polls `GET /applications` every 5s (`page.tsx:248`), so with N local apps the single-process control plane forks N concurrent docker processes every 5s, indefinitely, × open tabs. Collapse to one `docker ps` + match-by-container-name (as the heartbeat path already does).
- **[MEDIUM] No structured logging or request/trace correlation** anywhere except `docker.service.ts`. No pino/winston, no requestId. For a PaaS that shells out to docker and runs many schedulers, there's no way to correlate an HTTP request → the background job → the docker/agent invocation that failed.
- **[MEDIUM] `GlobalExceptionFilter` and `TransformInterceptor` are defined but never registered** (zero `APP_FILTER`/`useGlobalFilters` registrations). The filter is dead code and wouldn't log anyway (no `Logger` call). Unhandled 500s fall through to Nest's default handler with no route/user/request context — no central 5xx capture for alerting.
- **[MEDIUM] Quota check on the file-write path** (`files.service.ts:1537`) combines a synchronous up-to-100k-file `readdirSync`/`lstatSync` walk (blocks the event loop) with `enqueueAndWait`'s 500ms DB-poll loop (up to 20s) on the first write after each 60s TTL expiry.
- **[LOW]** Liveness healthcheck (`health.controller.ts`) returns `{ok:true}` unconditionally — never touches Prisma; a wedged-DB API still returns 200. Add a `SELECT 1` readiness probe.
- **[LOW]** Per-process `setInterval` schedulers (cron, alert eval, metric collection, offline sweep, backup, notification cleanup, deployment prune) with **no leader election** → double-fire in any multi-replica deployment. Single-instance is intended but undocumented-at-deploy-time. The `NODE_ENV==='test'` guard is also applied inconsistently across them.

---

## 5. What's Done Well

This codebase has real strengths that deserve to be preserved through any refactor:

- **Defense-in-depth in auth is exemplary and well-documented.** Refresh-token family revocation (RFC 6819), CAS rotation, account lockout shared across password/TOTP/credential-change flows, login timing parity, 2FA re-verification gating password reset and 2FA disable, and a live-DB JWT strategy so bans/demotions take effect immediately. These are the crown jewels and they are both implemented and tested correctly.
- **No-shell discipline is consistent across the host-dangerous surface.** API, agent, SFTP, and reaper all use `execFile`/`execFileAsync` with argv arrays, `--` separators, and regex allowlists (`CONTAINER_ID_RE`, `USERNAME_RE`, `VOLUME_NAME_RE`); DB passwords go via `0600 --env-file` (off `ps`/argv); the Go agent redacts argv in logs. The one critical injection (C-1) is precisely where the team *broke* this discipline by hand-interpolating YAML instead of using `yaml.dump`.
- **The SSRF screen is genuinely careful** (`validateWebhookUrl`) — blocks loopback/private/link-local IPv4 including `169.254.169.254`, default-denies IPv6, extracts embedded IPv4 from mapped/NAT64 forms, applied at both write and dispatch. The residual gap (redirects/rebinding, M-2) is the only hole in an otherwise thorough control.
- **The deploy pipeline is operationally mature** (locally): blue-green `canaryBoot` catches startup crashes before swapping, `.prev` enables real config rollback, redeploy builds while the old version still serves, streamed (never memory-buffered) volume tar import/export, stale-canary reaper on boot.
- **Layered Caddyfile-injection defense** (DTO regex → render-time re-validation → char-allowlist before any `docker exec`), serialized `regenerate()` with debounce + validate-and-rollback so a bad render can't take every hosted domain offline.
- **The data plane's security posture is strong and well-documented:** sha256 integrity gate refusing tampered restores, GCM-tag-verified-before-promote decrypt, zip-bomb/zip-slip/symlink-reject on `.dctproj` import, recompute-don't-trust of the imported-compose host-access flag, separate `BACKUP_ENCRYPTION_KEY` siloing.
- **The Prisma schema is exceptionally well-documented for security intent** — token-hashing rationale, RFC-6819 family detection, deliberate cascade/`SetNull`/`RESTRICT` choices (apps survive server deletion via `SetNull`; audit attribution preserved via `RESTRICT` on `triggeredBy`/`createdBy`). The security model is auditable from the schema alone.
- **The Go agent is clean and well-tested on its dangerous paths** — strict `validDockerName` allowlist blocking leading-dash flag smuggling, two-layer SFTP containment (`lexContained` + `checkRealContained` walking each component with `Lstat`), per-task-type timeouts, panic recovery reported as FAILED.
- **The dashboard auth client is unusually careful** — memory-only access token, httpOnly path-scoped refresh cookie, single-flight refresh with the race-condition fix documented, per-request nonce CSP with `strict-dynamic`, exactly one (developer-controlled, nonce'd) `dangerouslySetInnerHTML`.
- **Ops tooling reflects real incident scars** — P3005-only baselining, pipefail emulation, build-before-up rollback, LE rate-limit cert preservation, `--wait` so a crash-looping API reports a real failure.

---

## 6. Prioritized Recommendations

Ordered by risk-reduction per unit of effort. Items 1–3 should land before any exposure to untrusted tenants or the public internet.

### Now (security — do before exposure)

1. **Fix C-1 (compose env-key injection).** Validate every env key against `/^[A-Za-z_][A-Za-z0-9_]*$/` in `installCustom()`, and — the durable fix — replace the hand-interpolated YAML in `renderCustomComposeTemplate` with `yaml.dump` of a JS object, matching every `application-deploy` path. Add a regression test mirroring the existing volume-channel injection test. *(Reachable by project-DEVELOPER; full host compromise.)*
2. **Harden the agent transport (H-1).** Enforce `https://` in `config.Load()` (localhost/dev opt-out only); bind `:4000` to loopback by default in the shipped compose; default `PUBLIC_API_URL` to https in installer guidance. Then add **task-payload signing** (HMAC with the shared agent token) so a MITM cannot drive host ops even past TLS.
3. **Gate and verify auto-update (H-2).** Default unattended auto-apply to **off** (check-only + manual apply with SHA/diff surfaced); when enabled, require signed-commit/signed-tag verification or pin to signed release tags before `git reset --hard`.
4. **Close the agent-task IDOR (M-1).** Scope `getTaskForUser` to the caller — resolve `serverId` → project and `assertProjectAccess`, or restrict `result`/`error` to ADMIN/SUPERADMIN.
5. **Fix webhook SSRF redirect/rebinding (M-2).** `redirect:'manual'`, hard-fail 3xx (or re-screen `Location`); resolve + pin the connection IP to close DNS rebinding.
6. **Move the agent transfer token off the URL (M-3/M-4/L-2).** Use an `Authorization`/`X-Agent-Token` header on `transfer.go`, matching poll/heartbeat; stop reading `@Query('token')`.

### Soon (correctness & hardening)

7. **`failStaleTasks` one-line fix:** add `status: { in: ['QUEUED','RUNNING'] }` to the `updateMany` where-clause (M-2 in §4.2) — eliminates a lost-update that silently drops cross-server `onComplete` chains.
8. **Reject `CORS_ORIGINS=*` with credentials (L-1)** — ignore it or require an explicit insecure flag with a loud warning.
9. **Add `.prev` snapshot + serialization to remote/agent deploys** (`poller.go`) and a DB **partial unique index on `(applicationId, status IN inflight)`** (or per-app advisory lock) to close the redeploy TOCTOU. Back-port `.prev` rollback to the local image/compose paths.
10. **Test the authorization boundary:** specs for `RolesGuard`, `JwtStrategy` (live-DB ban-takes-effect), and `admin.service.ts` (role-grant ceiling, last-superadmin, self-modification guards). Add tests for `taskResult` idempotency and the stale-sweep race.
11. **Verify the cleartext-at-rest secret fields before they go live:** encrypt `SSLCertificate.privateKey`/`certificate` and `MailServer.dkimPrivateKey`; resolve the MongoDB password-on-argv (M) hole.

### Eventually (architecture & operability)

12. **Introduce a thin Application repository/aggregate layer** so status transitions, soft-delete, and audit can be enforced in one place — this is the root cause behind the marketplace and DB-template duplication. Then collapse the five deploy methods into a `withDeploymentLifecycle(...)` template-method and finish the `DeploymentTargetService` migration.
13. **De-duplicate the DB compose templates** (export `DB_CONFIGS`) — this is a live correctness bug (MariaDB env-key drift), not just a smell — and the stream-to-file exec plumbing into `db-dump.util.ts`.
14. **Collapse the `findAll` N+1** — one `docker ps` + match-by-container-name instead of one `docker compose ps` per local app per 5s poll. Consider raising the dashboard `refetchInterval` or moving to event-driven status.
15. **Wire observability:** register `GlobalExceptionFilter` and add structured logging (pino) with a request/correlation id threaded through to the docker/agent layer; add a readiness probe doing `SELECT 1`.
16. **Make `@dockcontrol/types` compiler-enforced:** declare explicit controller return types bound to the shared response interfaces so the client/server contract is checked, not just documented. Remove the gratuitous `as any` casts in `auth.service.ts` and the stale `'VOLUME_LIST' as any`.
17. **Document the single-instance topology constraint** at deploy time, and add a leader-election guard (or an explicit "scheduler instance" flag) before any multi-replica deployment — today the per-process `setInterval` schedulers and in-memory webhook replay map silently break under HA.
18. **Dashboard:** extract per-resource hooks (`useApplications`, …) to drain duplication out of the 1000+-line monolithic pages and make them testable; add the missing shared types for email/files/cron/sftp/ssl.

---

*End of report.*