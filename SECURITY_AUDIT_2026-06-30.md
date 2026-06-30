# DockControl — Audit sécurité & logique (indépendant)

*Date : 2026-06-30 · Périmètre : monorepo complet (API NestJS, agent Go, dashboard Next.js, infra/ops). Chaque finding ci-dessous a été vérifié contre le code source réel, pas seulement déduit.*

> Contexte : un `ANALYSIS_REPORT.md` (2026-06-27) existait déjà. Ses 2 pires findings (injection de clé compose dans `install-custom`, IDOR sur `GET /agent/tasks/:id`) sont **déjà corrigés** dans le code actuel. Cet audit repart de zéro et ne liste que ce qui est **encore** vrai aujourd'hui.

Verdict global : **codebase étonnamment mature et bien défendue.** L'intention sécurité est de premier ordre (rotation de refresh-token avec révocation de famille, écran SSRF anti-rebinding, `execFile` argv partout, chiffrement at-rest AES-256-GCM, anti zip-slip/tar-slip, CSP avec nonce). Les failles restantes sont **concentrées, pas systémiques**. Une seule est critique et atteignable par le privilège le plus bas du système.

---

## Tableau de synthèse

| # | Sévérité | Domaine | Résumé | Qui peut l'exploiter |
|---|----------|---------|--------|----------------------|
| **C-1** | 🔴 CRITICAL | Deploy engine | Compose brut (`composeContent`/`composeOverride`/PATCH compose) non filtré → `privileged: true` + mount `/var/run/docker.sock` ou `/:/host` = root hôte | project **DEVELOPER** (rôle minimal) |
| **C-2** | 🔴 CRITICAL (fuite secret) | Agent Go | Le credential git (`http.extraheader: Authorization: Basic …`) est écrit verbatim dans les logs de tâche, stockés non-rédigés et lisibles par tout admin / lecture DB | tout déploiement de repo privé sur serveur distant |
| **H-1** | 🟠 HIGH | Deploy engine | `gitUrl` non validé sur le déploiement repo public **et** sur `PATCH /applications/:id` → SSRF (`http://169.254.169.254`) + lecture fichier local (`file://`) | project **DEVELOPER** |
| **H-2** | 🟠 HIGH | Auth/session | Les access tokens (15 min) ne sont **pas** révocables : logout / révocation de session / reset mot de passe ne tuent que le refresh token | vol de token / session compromise |
| **H-3** | 🟠 HIGH | Domains/Email | Aucune **vérification de propriété de domaine** → préemption cross-tenant, hijack de routage/cert, usurpation mail | tout **DEVELOPER** |
| **H-4** | 🟠 HIGH | Terminal | Le pont SSH API→agent désactive la vérification de host-key (TOFU sans pinning) | MITM sur le lien API↔agent |
| **M-1** | 🟡 MEDIUM | Backups | SSRF via l'`endpoint` S3 non filtré (aucun écran, contrairement aux webhooks) | project **ADMIN** |
| **M-2** | 🟡 MEDIUM | Marketplace | `install-app` ne valide pas les **clés** d'`envVars` → injection de lignes dans `.env` | project **DEVELOPER** |
| **M-3** | 🟡 MEDIUM | Auth | Lock anti-bruteforce en 2 écritures non-atomiques → contournable en parallèle | credential stuffing |
| **M-4** | 🟡 MEDIUM | Admin | `PATCH /admin/config` (bulk) écrit n'importe quelle clé sans allowlist | ADMIN compromis / CSRF |
| **M-5** | 🟡 MEDIUM | Crypto | Sel scrypt statique et partagé (`'dockcontrol-v1'`) sur tous les installs | précalcul cross-install sur clés faibles |
| **M-6** | 🟡 MEDIUM | Auth | Reset mot de passe admin contourne la politique de force (8 vs 12 car.) | ADMIN |
| **M-7** | 🟡 MEDIUM | Git providers | Écran SSRF du PAT one-shot plus faible (pas de re-resolution DNS, IPv6 incomplet) | utilisateur authentifié |
| **L-x** | 🔵 LOW | divers | énumération d'utilisateur (timing/messages), SameSite=Lax, tokens en mémoire non-TTL, binds 0.0.0.0 par défaut, CI sans `permissions:`, images non digest-pinned, backups world-readable | voir détail |

**Risque structurel inhérent (par design, pas un bug)** : l'API et l'agent ont le socket Docker = root hôte. Toute RCE applicative escalade en compromission hôte. L'auto-update est root-RCE depuis la branche suivie — **désactivé par défaut**, à garder ainsi et à signer.

---

## Détails & correctifs

### 🔴 C-1 — Évasion conteneur via compose brut non filtré
**Fichiers :** `applications.service.ts:235-244` (validation create — vérifie seulement `services:`), `application-deploy.service.ts:1507-1508` (`composeOverride` écrit verbatim), `:1756-1758` (`runComposeOnlyDeploy`), `application-ops.service.ts` (`writeComposeFile` pour `PATCH .../files/compose`).
**Preuve :** le repo **possède déjà** le bon garde — `project-transfer/dctproj-compose-guard.ts::checkImportedComposeSafety()` rejette `privileged`, `cap_add`, `devices`, `*:host`, `security_opt unconfined`, bind-mounts hôte (via `checkVolumeSafety`) et volumes `driver_opts` bind. Son propre commentaire dit : *« The normal create() compose check only verifies it parses + has a `services:` map; it does NOT reject bind-mounts or privileged primitives »*. Ce garde n'est **jamais** appelé par le module applications (vérifié par grep). `create()` exige seulement le rôle **DEVELOPER** (`assertProjectOwnership(userId, dto.projectId)` → défaut DEVELOPER).
**Exploit :** un DEVELOPER crée une app avec un compose contenant `privileged: true` + `volumes: ["/var/run/docker.sock:/var/run/docker.sock"]` (ou `/:/host`) sur une cible locale → root sur l'hôte de la plateforme, hors de toute frontière de tenant.
**Correctif :** appeler `checkImportedComposeSafety()` (déjà écrit et testé) sur **tout** compose fourni par l'utilisateur — dans `create()`, sur le chemin `composeOverride`, et dans `writeComposeFile` — et rejeter en 400 si la liste de problèmes est non vide. Coût : ~5 lignes + import. **C'est le correctif n°1.**

### 🔴 C-2 — Credential git fuité dans les logs de tâche stockés
**Fichiers :** `apps/agent/internal/poller/poller.go:500` (`fmt.Fprintf(logs, "> %s %s\n", prog, strings.Join(args, " "))`) avec `cloneArgs` contenant `-c http.extraheader=Authorization: Basic <token>` (`:521-522`) → renvoyé dans `result.logs` → `agent.service.ts:532-551` stocke `safeResult` **sans rédaction** (seulement un cap de taille) → `getTaskForUser` (`agent.service.ts:219`) renvoie le `result` complet à tout ADMIN/SUPERADMIN.
**Preuve :** le chemin local de l'API **rédige** déjà `http.extraheader` (`application-deploy.service.ts:57-62`) ; le chemin agent ne le fait pas → divergence réelle.
**Correctif :** côté agent, rédiger `http.extraheader=…` / `Authorization:` avant d'écrire dans `logs` (mêmes regex que l'API), **et** scrubber côté serveur dans `taskResult` avant persistance (défense en profondeur).

### 🟠 H-1 — `gitUrl` non validé (SSRF + lecture fichier local)
**Fichiers :** `applications.service.ts:221-232` (la validation `assertCloneHostAllowed` ne tourne **que** si `gitProviderId` ou `gitToken` est présent ; le cas repo public `gitUrl` seul passe sans contrôle), `update()` `:604-669` (accepte `gitUrl` via `data: {...dto}` — **aucune** validation), sink `application-deploy.service.ts:1418-1431` (`git clone <gitUrl>` ; aucun `GIT_ALLOW_PROTOCOL` défini).
**Exploit :** DEVELOPER pose `gitUrl=http://169.254.169.254/latest/meta-data/...` (SSRF aveugle via le probe smart-HTTP) ou `file:///etc/...` (clone d'un repo local sur l'hôte API, lisible via l'éditeur compose/Dockerfile).
**Correctif :** appeler `assertCloneHostAllowed(provider ?? null, gitUrl)` **inconditionnellement** dès qu'un `gitUrl` est posé (create **et** update), et passer `GIT_ALLOW_PROTOCOL=https` (ou `-c protocol.allow=never -c protocol.https.allow=always`) à chaque `git clone`/`fetch`.

### 🟠 H-2 — Access tokens non révocables
**Fichier :** `auth/strategies/jwt.strategy.ts:30-52` — `validate()` relit le user (status/role : très bien) mais ne vérifie jamais que `payload.sid` pointe vers une session ACTIVE. Les flux de révocation (`auth.service.ts` logout/revokeSession, `admin.service.ts` resetUserPassword) ne touchent que la table `session`.
**Impact :** après « se déconnecter partout », un reset admin, ou une révocation de session pair, un access token volé/en vol reste valide jusqu'à son expiration (15 min par défaut).
**Correctif :** dans `validate()`, si `payload.sid` présent, charger la session et rejeter si non-ACTIVE/expirée. `changePassword`/`resetPassword` révoquent déjà les sessions → ça boucle la boucle pour tous d'un coup.

### 🟠 H-3 — Pas de vérification de propriété de domaine
**Fichiers :** `domains.service.ts:31-110` (`create` — syntaxe seulement), sinks `reverse-proxy.service.ts:494-583` (bloc Caddy + ACME), `mail-server.service.ts:632` (deploy mail + DKIM/cert). Aucune logique de challenge TXT/`.well-known` dans le code.
**Impact :** `Domain.domain` est `@unique` → un tenant peut squatter `victim.com` et bloquer tous les autres ; si le DNS pointe un jour vers la plateforme, il obtient un cert LE valide et sert son app sous le nom de la victime ; il peut monter une stack mail brandée d'un domaine qu'il ne possède pas.
**Correctif :** étape de preuve de contrôle (TXT `dockcontrol-verify=<token>` ou jeton HTTP `.well-known`) vérifiée côté serveur ; gater `proxy.regenerate()` / `ssl.issue()` / `mailServer.deploy()` sur `domain.verifiedAt != null`.

### 🟠 H-4 — Pont SSH API→agent sans vérification de host-key
**Fichier :** `terminal.gateway.ts:242-251` (`conn.connect` sans `hostVerifier`/`hostHash` ; commentaire acceptant le TOFU). L'agent génère pourtant une host-key ed25519 persistante (`sftpserver.go:437-457`) → le pinning est faisable, juste jamais fait.
**Correctif :** persister la clé publique de l'agent au register/première connexion et passer un `hostVerifier` ; rejeter sur mismatch.

### 🟡 MEDIUM (résumé des correctifs)
- **M-1 (SSRF S3)** `backups.service.ts:560-574` + `setProjectStorage` : faire passer l'`endpoint` par le même écran SSRF que les webhooks (`notifications.service.ts:929` `validateWebhookUrl` + re-résolution DNS), à l'écriture **et** avant chaque déréférencement.
- **M-2 (env-key marketplace)** `marketplace/dto/install-app.dto.ts:55-58` : appliquer `checkEnvVarsSafety` (déjà exporté) sur `envVars`, et échapper la clé dans le sérialiseur `.env` (`marketplace.service.ts:1040-1043`).
- **M-3 (lock atomique)** `auth.service.ts:877-893` : un seul `UPDATE … SET failedLoginAttempts = failedLoginAttempts+1, lockedUntil = CASE WHEN …+1 >= 5 THEN now()+15m ELSE lockedUntil END`.
- **M-4 (allowlist config)** `admin.service.ts:60-88` `updateConfigBulk` : rejeter toute clé hors d'une allowlist explicite (calquer `SETTING_KEYS`).
- **M-5 (sel scrypt)** `encryption.service.ts:28,40` : sel aléatoire par-install, stocké et inclus dans l'enveloppe `v1.` ; au minimum documenter que `ENCRYPTION_KEY` doit être haute-entropie.
- **M-6 (politique mdp admin)** `admin.service.ts:356-357` : router le reset par `isStrongEnough` (12 car. + 3 classes), comme les autres chemins.
- **M-7 (SSRF PAT git)** `git-providers.service.ts:34-48` : réutiliser l'écran SSRF des notifications pour le chemin PAT one-shot.

### 🔵 LOW (à traiter en lot)
- Énumération d'utilisateur : `forgotPassword` (timing — envoi mail bloquant pour user valide) et messages de login distincts par état de compte → envoi mail fire-and-forget + message générique.
- Refresh cookie `SameSite=Lax` → envisager `Strict` (dashboard same-site) ou token CSRF double-submit sur `/auth/refresh|logout`.
- `project-transfer` : tokens de download `Math.random()` sans TTL + archives orphelines non purgées → `crypto.randomBytes` + sweeper.
- Backups archives sans mode `0600`, chiffrement opt-in → forcer `0600`/`0700`, envisager chiffrement par défaut.
- Infra : binds `0.0.0.0` par défaut (API/dashboard en HTTP clair) → défaut `127.0.0.1` ou warning post-install ; CI sans `permissions: contents: read` → l'ajouter ; actions/images non digest-pinned → pin `@sha256`, surtout `docker:cli`.
- DTO non typés sur `forgot/reset/verify` (`auth.controller.ts`) → introduire des DTO validés.
- Tokens reset/verify loggés si `NODE_ENV !== production` (et `NODE_ENV` défaut = development) → gater sur un flag `DEBUG_AUTH` explicite.

---

## Ce qui est déjà excellent (vérifié, ne pas casser)
- **Auth :** rotation refresh avec révocation de famille (CAS, anti-replay), bootstrap premier-user en transaction Serializable, JwtStrategy relit role/status à chaque requête, bcrypt cost 12, TOTP secret chiffré + window=1, backup codes hashés + consommés atomiquement, lockout par compte, throttling serré par route, `trust proxy 1`.
- **Crypto :** AES-256-GCM, IV 12o aléatoire par blob, tag vérifié, enveloppe versionnée, `ENCRYPTION_KEY ≥ 32` validé au boot ; `hash()` sha256 utilisé **uniquement** pour des tokens, jamais pour des mots de passe.
- **Agent/transport :** TLS imposé par défaut (`config.go` refuse `http://` vers un hôte non-loopback sauf override), **aucun** `InsecureSkipVerify`, tokens en header/body jamais en query (sauf fallback déprécié documenté), tokens stockés en sha256, taskResult authentifié + ownership-checké, install token single-use atomique, anti zip-slip/zip-bomb partout, jail SFTP avec garde anti-symlink réelle.
- **Deploy synthétisé :** tous les compose **générés** le sont via `yaml.dump` (objet → data, pas de templating string) ; custom-image durci de bout en bout (`SAFE_ENV_KEY`/`checkVolumeSafety` ré-appliqués dans le renderer) ; tout shell-out via `execFile` argv ; build-args restreints à un préfixe public.
- **Data-plane :** containment de chemin avec `realpath` après normalisation + `O_NOFOLLOW` + lstat-walk anti-TOCTOU ; `.dctproj`/backups en AES-256-GCM authentifié (decrypt-to-temp puis promote) ; caps de taille en streaming ; RBAC tracée jusqu'au sink sur chaque endpoint (pas d'IDOR trouvée).
- **Réseau/notifs :** écran SSRF webhook de très bonne qualité (private/metadata/`0.0.0.0`, IPv4 décimal/octal/hex, IPv6 mappé, re-résolution DNS au dispatch, `redirect: 'manual'`) ; Caddyfile anti-injection avec `caddy validate` + rollback ; webhook git HMAC sur raw body en compare constant-time ; auto-update OFF par défaut, pull-based, apply admin-only.
- **Dashboard :** access token **en mémoire seule** (jamais localStorage), refresh en cookie httpOnly ; **aucun** sink XSS (tout output en texte React/`<pre>`, xterm `term.write`) ; CSP réelle avec nonce + `strict-dynamic`, `connect-src` épinglé ; CORS credential-aware (wildcard strippé).

---

## Plan de correction (ordre recommandé)

**Sprint 0 — bloquant avant exposition à des tenants non-fiables**
1. **C-1** : brancher `checkImportedComposeSafety()` sur tous les chemins compose utilisateur (create / override / writeComposeFile). *(le garde existe déjà — c'est du câblage)*
2. **C-2** : rédiger `http.extraheader`/`Authorization` dans les logs de l'agent **et** scrubber côté `taskResult`.
3. **H-1** : `assertCloneHostAllowed` inconditionnel (create+update) + `GIT_ALLOW_PROTOCOL=https`.

**Sprint 1 — durcissement fort**
4. **H-2** : check de session ACTIVE dans `jwt.strategy.validate()`.
5. **H-3** : vérification de propriété de domaine (TXT/`.well-known`) avant proxy/cert/mail.
6. **H-4** : pinning host-key sur le pont SSH API→agent.
7. **M-1, M-2, M-4** : écran SSRF S3, validation env-key marketplace, allowlist `updateConfigBulk`.

**Sprint 2 — défense en profondeur**
8. **M-3, M-5, M-6, M-7** : lock atomique, sel scrypt par-install, politique mdp admin unifiée, écran SSRF PAT git.
9. Lot **LOW** : énumération user, SameSite, TTL transfer tokens, modes fichiers backup, binds loopback, CI `permissions`, digest-pinning, DTO auth.

**Sprint 3 — structurel / ops**
10. Signer les commits/tags et vérifier la signature dans `update.sh` avant `git reset --hard`.
11. Envisager un docker-socket-proxy filtrant devant le socket pour réduire le blast radius d'une RCE API.
12. Documenter explicitement la topologie supportée (single-instance, single-opérateur) — plusieurs protections (replay webhook in-memory, leader scheduler) dégradent en multi-réplica.

*Chaque correctif Sprint 0/1 devrait s'accompagner d'un test (la base a déjà ~0,42 de ratio spec/source — suivre cette discipline). La plupart des gardes nécessaires existent déjà ailleurs dans le code : l'essentiel du travail est de les **réutiliser** aux endroits manquants, pas de les réinventer.*

---

## ÉTAT DE REMÉDIATION (mis à jour 2026-06-30)

**Tous les sprints sont implémentés, testés et commités** sur la branche
`security/sprint0-compose-guard-git-creds`. Suite de tests : API 1197 ✅, agent Go
✅, dashboard tsc ✅.

| # | Sévérité | Statut | Commit |
|---|----------|--------|--------|
| C-1 | CRITICAL | ✅ Corrigé | `checkImportedComposeSafety` branché sur create/override/writeComposeFile (bypass interne consenti pour project-transfer) |
| C-2 | CRITICAL | ✅ Corrigé | Rédaction du credential git dans l'agent Go + scrub serveur dans `taskResult` |
| H-1 | HIGH | ✅ Corrigé | `assertCloneHostAllowed` inconditionnel (create+update+redeploy) + `GIT_ALLOW_PROTOCOL=https` |
| H-2 | HIGH | ✅ Corrigé | Révocation de session dans `jwt.strategy` (REVOKED/absent → rejet) |
| H-3 | HIGH | ✅ Corrigé | Vérification de propriété de domaine (TXT), gate `require_domain_verification` |
| H-4 | HIGH | ✅ Corrigé | Pinning host-key SSH API→agent (TOFU, colonne `Server.sshHostKey`) |
| M-1 | MEDIUM | ✅ Corrigé | Écran SSRF partagé sur l'endpoint S3 (write-time + chaque déréf) |
| M-2 | MEDIUM | ✅ Corrigé | `SafeEnvVarsConstraint` sur `InstallAppDto` + filtre clé `.env` |
| M-3 | MEDIUM | ✅ Corrigé | Lockout atomique (un seul `UPDATE … CASE`) |
| M-4 | MEDIUM | ✅ Corrigé | Allowlist `WRITABLE_KEYS` dans `validateKey` + `updateConfigBulk` |
| M-5 | MEDIUM | ✅ Corrigé | Sel scrypt par-install (v2), rétro-compatible v1 |
| M-6 | MEDIUM | ✅ Corrigé | `checkPasswordStrength` partagé sur le reset admin |
| M-7 | MEDIUM | ✅ Corrigé | Écran SSRF partagé + re-résolution DNS sur le chemin PAT git |
| LOW (lot) | LOW | ✅ Corrigé | tokens transfer (entropy+TTL+sweeper), modes backup 0600/0700, cookie SameSite=Strict, logs token gatés sur `DEBUG_AUTH_TOKENS`, DTO auth |
| Infra | — | ✅ Corrigé | CI `permissions: contents: read`, warning binds install.sh, `docker:27-cli` pinné, signature commit opt-in dans update.sh |

**Nouveaux modules partagés créés** : `common/compose/compose-safety.ts`,
`common/net/ssrf-guard.ts`, `auth/password-policy.ts`,
`domains/domain-verification.ts`. **Migrations** : `Server.sshHostKey`,
`Domain.verificationToken/verifiedAt`.

**Reste optionnel (non bloquant)** : énumération d'utilisateur par timing
(envoi mail fire-and-forget — atténué par le throttler), proxy filtrant devant
le docker.sock (réduction du blast radius), passage des binds à loopback *par
défaut* (gardé en warning pour ne pas casser le premier run).
