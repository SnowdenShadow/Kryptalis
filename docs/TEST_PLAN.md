# Plan de test runtime manuel — DockControl / Kryptalis

> **Pourquoi ce document.** La suite automatisée (700 tests API + 39 dashboard + Go)
> est **unitaire et mockée** : elle prouve la logique, pas le fonctionnement sur une
> vraie VPS avec Docker. Ce plan couvre ce que les tests ne peuvent pas : `install.sh`,
> `docker compose up`, déploiement réel, SSL Let's Encrypt, enrôlement d'un 2ᵉ serveur
> (agent Go), SFTP/backup distants. À exécuter par un humain sur de vraies machines.
>
> Repo nommé `Kryptalis-dev`, produit = **DockControl**, data dir sur disque = `.dockcontrol`.
> Toutes les routes API ont le préfixe `/api`. Port API par défaut **4000**, dashboard **3000**,
> Caddy **80/443**, SFTP local **2222**, SFTP agent distant **2522**.

## Légende
- ✅ = critère de réussite attendu. ❌ = signe d'échec à investiguer.
- Chaque étape cite la source code-exacte vérifiée (`fichier:ligne`).

---

# PARTIE A — MODE LOCAL (un seul serveur)

**Prérequis** : 1 VPS Ubuntu 22.04+ / Debian 12+, accès root, 2 Go RAM min (4 conseillé),
ports **80** et **443** ouverts publiquement, ports **3000** et **4000** atteignables au
premier boot, une IPv4 publique. Pour le test SSL : un nom de domaine dont tu contrôles le DNS.

## A1. Installation
1. En root sur la VPS :
   ```sh
   curl -fsSL https://raw.githubusercontent.com/SnowdenShadow/DockControl/main/install.sh | sudo sh
   ```
   (`install.sh:6`. Doit tourner en root — `install.sh:41`. Installe git/curl/openssl/Docker, exige le plugin `docker compose`.)
2. ✅ L'installeur génère `.env` (mode `600`) avec `JWT_SECRET`/`JWT_REFRESH_SECRET` (`openssl rand -hex 32`),
   `ENCRYPTION_KEY` (`rand -hex 16` → 32 hex), `POSTGRES_PASSWORD`, `PUBLIC_API_URL`, `PUBLIC_DASHBOARD_URL` (`install.sh:209-224`).
   - **Vérif** : `cat /opt/dockcontrol/.env` → les 4 secrets présents et non vides. `ls -l .env` → `-rw-------`.
3. ✅ `docker compose up -d --build` se lance (`install.sh:330`). Attendre la fin du build.
   - **Vérif** : `docker compose -f /opt/dockcontrol/docker-compose.yml ps` → conteneurs `dockcontrol-api`,
     `dockcontrol-dashboard`, `dockcontrol-postgres`, `dockcontrol-caddy` **Up/healthy**.
4. ✅ L'installeur attend `GET http://localhost:4000/api/settings/public` = 200/401 (`install.sh:364`).
   Il affiche les URLs finales Dashboard `http://<IP>:3000` et API `http://<IP>:4000/api` (`install.sh:395`).
5. **Health** : `curl -fsS http://localhost:4000/api/health` → `{"ok":true,"ts":...}` (`health.controller.ts:18`).
   - ❌ Si le conteneur API restart-loop : `docker logs dockcontrol-api` — souvent une var Joi requise manquante
     (`DATABASE_URL`, `JWT_SECRET`≥32, `JWT_REFRESH_SECRET`≥32, `ENCRYPTION_KEY`≥32 — `app.module.ts:42-51`)
     ou `POSTGRES_PASSWORD` absent (compose `:29`).

## A2. Premier compte (SUPERADMIN) + setup
1. Ouvrir `http://<IP>:3000` → redirige vers `/setup` tant que setup nécessaire.
2. **Vérif backend** : `curl http://<IP>:4000/api/auth/setup-status` → `{"needsSetup":true}`
   (`auth.controller.ts:81`, vrai seulement si 0 user ET pas de flag `bootstrapped`).
3. Créer le compte (page setup → `POST /api/auth/register`). **Le tout premier user est forcé `SUPERADMIN`**
   sans vérification email (`auth.service.ts:198,256`).
   - **Politique mot de passe** (`auth.service.ts:1211-1235`) : longueur **≥12 et ≤128**, **≥3 classes sur 4**
     {minuscule, MAJUSCULE, chiffre, symbole}. ✅ Un mdp de 8 → rejeté côté front ET back. ✅ ≥12 + 3 classes → accepté.
4. ✅ Après register, tokens émis, accès au dashboard.
5. ✅ Re-vérif : `GET /api/auth/setup-status` → `{"needsSetup":false}` (single-shot, flag `bootstrapped` posé — `auth.service.ts:215`).
6. **Sécurité (fix vérifié)** : le **token d'accès n'est PAS dans localStorage** (mémoire seule).
   - **Vérif** : DevTools → Application → Local Storage → l'entrée `dockcontrol-auth` ne contient que `user`,
     **jamais** `accessToken`. Après un **reload dur (F5)**, la session se rétablit sans flash login
     (refresh silencieux via cookie httpOnly — `sessionReady`, `layout.tsx`/`page.tsx`).

## A3. Déployer une app — marketplace (one-click)
1. Dashboard → Marketplace, ou `GET /api/marketplace` (`marketplace.controller.ts:16`).
2. Installer une app simple (ex. Redis/Postgres/Ghost) → `POST /api/marketplace/install` (`marketplace.controller.ts:29`).
3. ✅ **Sur disque** : un dossier apparaît sous `/opt/dockcontrol/.dockcontrol/apps/<slug>-<instanceId>`
   contenant `docker-compose.yml` (`marketplace.service.ts:441-446`).
4. ✅ Conteneur lancé : `docker ps` montre le conteneur de l'app.
5. **Test du fix « install custom » (CRITIQUE évasion host)** — via API avec un volume malicieux :
   ```sh
   curl -X POST http://<IP>:4000/api/marketplace/install-custom \
     -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
     -d '{"name":"evil","image":"alpine","projectId":"<pid>","volumes":["/:/host"]}'
   ```
   - ✅ **Doit renvoyer 400** (rejet : host bind-mount interdit — `install-custom.dto.ts` SafeVolumesConstraint).
   - ✅ Un volume nommé légitime `{"volumes":["media:/data"]}` → accepté.

## A4. Déployer une app — git custom
1. (Optionnel) Connecter un provider git : Dashboard → settings, ou `POST /api/git-providers`.
2. Créer l'app : `POST /api/applications` avec `gitUrl`, `gitBranch`, `gitProvider`, `projectId`
   (`applications.controller.ts`, `create-application.dto.ts`).
3. **Test du fix CRITIQUE (exfil token git)** : créer une app avec un provider GitHub mais
   `gitUrl=https://evil.example.com/x.git`.
   - ✅ **Doit renvoyer 400** « Git URL host does not match the selected provider »
     (`git-providers.service.ts` assertCloneHostAllowed). Le token n'est jamais envoyé à evil.example.com.
   - ✅ `gitUrl=https://github.com/<toi>/<repo>.git` avec provider GitHub → accepté.
4. Déclencher le déploiement (`POST /api/applications/:id/redeploy` ou `POST /api/deployments`).
5. ✅ Suivre le statut : `GET /api/applications/:id/deployments` puis `/:depId` (logs live — `applications.controller.ts:229`).
   Statut `DEPLOYING` → `RUNNING`.
6. ✅ `docker ps` → conteneur de l'app buildé depuis le repo.

## A5. Domaine + SSL (Let's Encrypt via Caddy)
1. Pointer un **enregistrement DNS A** `app.tondomaine.com` → IP de la VPS. Attendre la propagation.
2. Attacher le domaine : `POST /api/domains` `{domain, projectId, applicationId, autoSsl:true}` (`domains.controller.ts:23`).
3. ✅ La 1ʳᵉ requête HTTPS déclenche Caddy → émission Let's Encrypt (bloc `${host} { reverse_proxy ... }`
   sans directive `tls` → auto-HTTPS, `reverse-proxy.service.ts:564`).
   - **Vérif** : `curl -I https://app.tondomaine.com` → `200` avec cert valide (pas d'erreur TLS).
   - **Vérif DNS** : `GET /api/domains/:id/health` (`domains.controller.ts:68`).
   - ❌ Si échec : ports 80/443 fermés, ou DNS pas encore propagé (Caddy ne peut pas faire HTTP-01).
4. **Test du fix (injection Caddy via Server.host)** — pertinent surtout en MULTI (B), mais en LOCAL vérifier que
   `GET /api/domains` et l'attache d'un domaine au nom RFC-valide marchent ; un domaine mal formé est rejeté
   par `create-domain.dto.ts` (validation hostname RFC-1035).

## A6. Base de données + backup (cible LOCAL)
1. Créer une DB : `POST /api/databases` (`databases.controller.ts:15`).
2. ✅ `docker ps` → conteneur `dockcontrol-db-<name>`.
3. Créer un backup LOCAL : `POST /api/backups` `{name, serverId, target:"LOCAL", ...}` (`backups.controller.ts`,
   `create-backup.dto.ts:17`).
4. ✅ **Sur disque** : archive sous `/opt/dockcontrol/.dockcontrol/backups/<filename>.tar.gz` (`backups.service.ts:47,872`).
5. **Test du fix (clé backup trop courte ≠ silence)** :
   - Admin → System Config → poser `BACKUP_ENCRYPTION_KEY` à une valeur **< 32 caractères**.
   - Relancer un backup. ✅ **Le backup doit ÉCHOUER** avec un message explicite « configured but too short …
     Refusing to write an UNENCRYPTED backup » (`backups.service.ts:361-366`) — **PAS** un backup en clair silencieux.
   - Poser une clé **≥ 32 caractères** → ✅ backup réussit, archive chiffrée AES-256-GCM.
   - **Test du fix (decrypt-fail loud)** : si la clé est ensuite changée pour une autre (rendant un secret
     indéchiffrable), le backup doit échouer bruyamment, pas produire un dump en clair.
6. Restaurer : `POST /api/backups/:id/restore` (uniquement si statut `COMPLETED` — `backups.controller.ts:40`).
   ✅ Restauration sans erreur, données présentes.

## A7. Maintenance + RBAC (rapide)
1. Activer le mode maintenance (Admin). ✅ Un user non-admin reçoit `503` sur les écritures.
   - **Test du fix (MaintenanceGuard relit la DB)** : rétrograder un ADMIN→USER ; son token encore valide
     ne doit **plus** bypasser la maintenance (relecture rôle live en DB).
2. ✅ Un compte VIEWER ne peut pas lire les secrets d'une app (gate dotenv).

---

# PARTIE B — MODE MULTI (deux serveurs ou plus)

**Prérequis** : la PARTIE A validée sur le **serveur 1** (panneau de contrôle). Un **serveur 2**
Ubuntu/Debian avec accès root. Réseau : le serveur 2 doit pouvoir joindre **en sortie** l'API du
serveur 1 sur le **TCP 4000** (l'agent se connecte vers l'API ; l'API ne se connecte jamais à l'agent —
`config.go`, `poller.go`). Pour tester le SFTP distant : ouvrir **TCP 2522 en entrée** sur le serveur 2.

## B1. Activer le mode MULTI
1. Dashboard → Admin → onglet **Infrastructure** → basculer en MULTI
   (`PATCH /api/admin/settings/deployment_mode` `{value:"MULTI"}` — `admin.controller.ts:61`, `infrastructure-tab.tsx:60`).
2. **Vérif** : `getDeploymentMode()` renvoie `'MULTI'` (`admin.service.ts:149`).
   - ❌ Avant bascule : `POST /api/servers` renvoie 400 « Adding servers is disabled in LOCAL deployment mode »
     (`servers.controller.ts:73`). ✅ C'est le bon garde-fou.

## B2. Enrôler le serveur 2 (agent Go)
> ⚠️ **Pré-requis build** : l'endpoint `GET /api/agent/binary` sert un binaire compilé depuis
> `apps/agent/bin/dockcontrol-agent-linux-<arch>`. **Si l'image n'a pas été buildée avec l'agent
> (build.sh cross-compile amd64/arm64), l'endpoint renvoie 503** (`agent.controller.ts:29-47`).
> ✅ Vérifier d'abord : `curl -I http://<IP1>:4000/api/agent/binary?arch=amd64` → `200`. Si `503`,
> l'agent n'a pas été embarqué dans l'image — à corriger avant ce test (point connu : `apps/api/Dockerfile`
> doit produire le binaire dans le stage agent-builder).

1. Dashboard → Servers → Add server, ou `POST /api/servers` `{name, host}` (admin — `servers.service.ts:481`).
   ✅ Crée un serveur statut `PENDING_INSTALL`, renvoie `installToken` (64 hex) + `installCommand` :
   ```sh
   curl -fsSL http://<IP1>:4000/api/agent/install.sh?token=<token> | sudo sh
   ```
   (`servers.service.ts:499-503`. Token valable 24 h, stocké en sha256.)
2. **Sur le serveur 2**, exécuter cette commande en root. Le script (`agent.controller.ts:239-385`) :
   - exige root ; installe Docker si absent ;
   - télécharge le binaire `GET /api/agent/binary?arch=...` → `/opt/dockcontrol/dockcontrol-agent` ;
   - `POST /api/agent/register` `{installToken, host, hostname, os, arch, ...}` → reçoit `{serverId, token}`
     (token long-lived, l'install token 24 h est consommé single-use — `agent.service.ts:279-327`) ;
   - écrit `/opt/dockcontrol/agent.env` (mode 600) ;
   - installe l'unité systemd `dockcontrol-agent.service` (`systemctl enable --now`), sinon `nohup`.
3. ✅ **Vérif serveur 2** : `systemctl status dockcontrol-agent` → active (running).
   `cat /opt/dockcontrol/agent.env` → `DOCKCONTROL_API_URL`, `DOCKCONTROL_SERVER_ID`, `DOCKCONTROL_TOKEN`.
4. ✅ **Vérif dashboard** : le serveur 2 passe à **ONLINE** dans la liste (`servers/page.tsx:177`).
   - Liveness : chaque heartbeat/poll pose `lastSeenAt=now`+ONLINE (`agent.service.ts:348,401`).

## B3. Statut / heartbeat / offline
1. ✅ L'agent poll toutes les **5 s** (`POST /api/agent/poll`) et heartbeat (~30 s plancher) (`monitor.go:85`).
   - Dashboard → métriques serveur : `GET /api/monitoring/servers/:id/metrics`.
2. **Test du reaper** : arrêter l'agent (`systemctl stop dockcontrol-agent`).
   ✅ Après **~90 s sans signe** (seuil `OFFLINE_THRESHOLD_MS`, sweep 60 s — `servers.service.ts:23,104`),
   le serveur passe **OFFLINE** dans le dashboard, et les admins reçoivent une notif `serverOff` (une fois).
   - Worst-case détection ~2,5 min. Relancer l'agent → repasse ONLINE.

## B4. Déploiement distant (sur le serveur 2)
1. Créer un projet **placé sur le serveur 2** (ou une app avec `serverId` = serveur 2).
   La décision local/remote : `isLocalHost(host)` ; non-local → délégué à l'agent
   (`deployment-target.service.ts:20`, `application-deploy.service.ts:114`).
2. Déployer une app (marketplace ou git) sur ce projet.
   ✅ L'API enqueue une tâche `DEPLOY` (`agent.enqueueAndWait(server.id, 'DEPLOY', …)` — `application-deploy.service.ts:153`).
   L'agent la claim (CTE `FOR UPDATE SKIP LOCKED`, jusqu'à 10 tâches), build localement.
3. ✅ **Vérif SERVEUR 2** : `docker ps` → le conteneur de l'app tourne **sur le serveur 2**.
   Fichiers sous `/opt/dockcontrol/apps/<slug>` (`poller.go:271,449-637`).
4. ✅ **Vérif dashboard** : statut déploiement `RUNNING`, états conteneurs remontés par heartbeat
   (`agent.service.ts:440`). Logs : `GET /api/agent/tasks/:id` (payload masqué pour non-admin).

## B5. SFTP distant (agent, port 2522)
1. Créer un compte SFTP scoping une app du serveur 2 (Dashboard → SFTP).
   ✅ L'API pousse une tâche **SFTP_SYNC** (état désiré complet, idempotent — `sftp.service.ts:284`).
   L'agent applique via `Server.Sync` (`poller.go:874`, `sftpserver.go:87`).
2. Se connecter depuis ta machine : `sftp -P 2522 <username>@<IP2>` (port **2522**, pas 22 — `main.go:50`).
   - Auth bcrypt password et/ou clé publique SSH (`sftpserver.go:165-191`).
   - ✅ Le compte voit uniquement ses `roots` (chroot logique, ex. `app → /opt/dockcontrol/apps/<slug>`).
3. **Tests des fixes SFTP** :
   - ✅ Upload d'un fichier **plus court** par-dessus un plus long → contenu **tronqué correctement**
     (pas d'octets résiduels — fix O_TRUNC).
   - ✅ Tenter d'accéder hors du root via un symlink → **refusé** (containment réel par composant — fix anti-escape).
   - ✅ Un compte permission **ADMIN** peut **écrire** sur le serveur distant (fix parité ADMIN==WRITE — `sftpserver.go:387`).
   - ✅ Un compte **READ** ne peut pas écrire/renommer/supprimer.

## B6. Backup / restore distant
1. Backup d'une app du serveur 2 : `POST /api/backups` (le backup est délégué car host non-local —
   `backups.service.ts:1072`). L'agent exécute `BACKUP`, uploade l'archive via
   `POST /api/agent/transfers/:taskId/upload`.
2. ✅ L'archive arrive sur le **serveur 1** sous `.dockcontrol/backups/<backupId>.tar.gz` (handler de complétion).
3. Restaurer : `POST /api/backups/:id/restore` → tâche `RESTORE`, l'agent télécharge via `sourceTaskId`.
   ✅ Données restaurées sur le serveur 2.
   - **Test du fix (SHA fail-closed distant)** : si un backup distant n'a pas de checksum enregistré,
     la restauration doit **refuser** (« no recorded checksum ») au lieu d'accepter un objet non vérifié.

---

# PARTIE C — points connus à surveiller (non-bloquants mais à vérifier en réel)

Ces éléments sont corrects en logique/tests mais **n'ont jamais tourné en runtime** dans cette revue :

1. **Build de l'agent dans l'image** (B2 ⚠️) : confirmer que `GET /api/agent/binary` renvoie 200 et pas 503.
   C'est le prérequis n°1 du mode MULTI.
2. **Git self-hosted non supporté** : GitHub Enterprise / GitLab on-prem sont **rejetés** par la validation
   d'hôte (seuls github.com/gitlab.com/bitbucket.org sont acceptés). Si tu utilises un git self-hosted,
   c'est une limitation connue (nécessite une colonne `host` sur `GitProvider` + migration).
3. **CI durcie jamais exécutée ici** : les steps `docker compose config` / `docker build` / `shellcheck` /
   `gofmt` ajoutés à la CI n'ont pas tourné sur cette machine (Docker absent). À valider au 1ᵉʳ run CI réel.
4. **PAT git inline** : un token PAT one-shot peut viser n'importe quel hôte public (SSRF du propre token de
   l'utilisateur, pas exfil d'un token tiers) ; le DNS-rebinding n'est pas bloqué. Limitation documentée.
5. **SSL** : un domaine `*.local` reste en HTTP simple (pas de Let's Encrypt) — normal (`reverse-proxy.service.ts:547`).

---

## Critère global « full OK »
- **PARTIE A** complète sans ❌ → mode **LOCAL** validé runtime.
- **PARTIE B** complète sans ❌ → mode **MULTI** validé runtime.
- Tant que A et B n'ont pas tourné sur de vraies machines, le statut reste :
  **« logique + tests unitaires verts »**, ce qui n'équivaut pas à « validé en production ».
