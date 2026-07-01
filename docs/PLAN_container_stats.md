# Plan — Consommation des apps / containers (live + historique)

## Objectif
Voir la conso réelle par app/container : **CPU %, RAM (utilisée/limite), réseau I/O, bloc I/O**, en **live** ET en **historique** (graphes 24h/7j/30j), pour les apps **locales ET distantes** (mode MULTI), affiché **sur la page de chaque app** ET dans une **vue globale sur Monitoring**.

L'archi existante s'y prête déjà très bien : le heartbeat de l'agent ships déjà les *états* des containers ; on ajoute leurs *stats*. Le modèle `ServerMetric` sert de patron pour l'historique.

---

## Couche 1 — Collecte (source des données)

### Agent Go — `apps/agent/internal/monitor/monitor.go`
- Nouvelle fn `collectContainerStats(ctx)` : un seul `docker stats --no-stream --format {{json .}}` (filtré `name=dockcontrol-`).
- Parse par container : `CPUPerc`, `MemUsage` (used/limit), `NetIO`, `BlockIO`, `Name`.
- Ajout au payload heartbeat sous `containerStats: [...]` (à côté de `containers`).
- Best-effort : docker down → liste vide, jamais d'erreur qui casse le heartbeat.

### Local (API box) — nouveau helper partagé
- `docker stats --no-stream --format {{json .}}` exécuté par l'API pour les containers locaux.
- Réutilisé par le endpoint live ET par un petit collecteur périodique local (voir couche 3).

### Agent — nouveau task `STATS` (`poller.go`)
- Pour le **live à la demande** sur une app distante précise (comme `LOGS`/`STATUS`).
- Payload `{ containerName }` → renvoie les stats live de ce container.
- (L'historique distant, lui, passe par le heartbeat — pas de polling par app.)

---

## Couche 2 — Stockage historique (API + Prisma)

### Nouveau modèle `ContainerMetric` (mirror de `ServerMetric`)
```prisma
model ContainerMetric {
  id             String   @id @default(cuid())
  serverId       String
  applicationId  String?              // null si container non rattaché à une app
  containerName  String
  cpuPercent     Float
  memoryUsed     BigInt
  memoryLimit    BigInt
  networkIn      BigInt
  networkOut     BigInt
  blockRead      BigInt
  blockWrite     BigInt
  timestamp      DateTime @default(now())

  server      Server       @relation(fields: [serverId], references: [id], onDelete: Cascade)
  application Application?  @relation(fields: [applicationId], references: [id], onDelete: Cascade)

  @@index([applicationId, timestamp])
  @@index([serverId, timestamp])
  @@map("container_metrics")
}
```
+ relations inverses sur `Server` et `Application`, + migration SQL `add_container_metrics`.

### Heartbeat handler — `agent.service.ts`
- Étendre le DTO `AgentHeartbeatDto` avec `containerStats?: HeartbeatContainerStatsDto[]`.
- Sur réception : mapper chaque stat → `ContainerMetric.create`, en résolvant `applicationId` via `containerName` (déjà persisté sur `Application.containerName`).
- Rétention : réutiliser le patron de `DeploymentsService.pruneOldDeployments` (cron 6h) — purge > N jours + cap par container. Nouveau `container_metrics_retention_days` (défaut 7j, plus court que serveur car volume élevé).

### Local : collecteur périodique
- Dans un service API (ou étendre le monitoring) : toutes les ~30s, `docker stats` local → `ContainerMetric.create` pour les apps locales. Gardé par `SchedulerLeaderService.shouldRun()` (pas de doublon multi-réplica), comme l'éval des alertes.

---

## Couche 3 — API (endpoints)

Dans le module **monitoring** (là où vivent déjà métriques + RBAC serveur) :

1. `GET /monitoring/applications/:appId/stats/live`
   - RBAC : `assertProjectAccess(VIEWER)` sur le projet de l'app.
   - Local → `docker stats` du/des container(s) de l'app. Distant → task `STATS`.
   - Renvoie le live (peut couvrir plusieurs containers : app multi-service, PHP nginx+fpm).

2. `GET /monitoring/applications/:appId/stats?period=24h|7d|30d`
   - Historique depuis `ContainerMetric`, downsamplé (réutilise la logique `downsample()` déjà écrite dans `monitoring.service.ts`).

3. `GET /monitoring/containers/overview`
   - Vue globale : dernière stat par container accessible au caller (scopé via `accessibleServerIds` déjà existant). Triable côté front par CPU/RAM.

---

## Couche 4 — Dashboard (UI)

### Page détail app — `applications/[id]/page.tsx`
- Nouvel onglet **« Ressources »** :
  - Cartes live (CPU %, RAM used/limit + barre, Net I/O, Block I/O), auto-refresh 3–5s via `refetchInterval`.
  - Graphes historiques (24h/7j/30j) — réutiliser le composant de graphe du monitoring serveur s'il existe, sinon un sparkline simple.
- Gated par le rôle (VIEWER voit les stats en lecture).

### Page Monitoring — `monitoring/page.tsx`
- Nouvelle section **« Consommation des applications »** : tableau de toutes les apps accessibles (nom, projet, serveur, CPU, RAM, statut), triable, ligne cliquable → page app.

### i18n
- Clés EN + FR (parité obligatoire — le test `translations.spec.ts` la vérifie).

---

## Couche 5 — Tests & vérif
- **Agent** : test Go du parseur `docker stats --format {{json .}}` (lignes malformées ignorées).
- **API** : specs monitoring pour le mapping heartbeat→ContainerMetric, le scoping RBAC des nouveaux endpoints, le downsample réutilisé.
- `tsc --noEmit` (API + dashboard), suite Vitest complète, `go build ./...`.

---

## Ordre de livraison (incrémental, chaque étape testable)
1. **Prisma** : modèle `ContainerMetric` + migration + relations.
2. **Agent** : `collectContainerStats` + `containerStats` dans le heartbeat + task `STATS`.
3. **API** : DTO étendu + persistance heartbeat + rétention + collecteur local + 3 endpoints + specs.
4. **Dashboard** : onglet Ressources (page app) + section globale (Monitoring) + i18n.
5. **Vérif finale** : type-check + tests + build agent.

## Notes / risques
- `docker stats --no-stream` prend ~1–2s (échantillonne 2 lectures). OK pour un tick 30s ou un appel live, à ne PAS mettre dans une boucle serrée.
- Volume de données : 1 ligne / container / 30s. La rétention courte (7j) + le cap par container évitent l'explosion de la table.
- Le live distant via task agent a une latence (aller-retour long-poll) — on affichera un léger spinner, acceptable.
