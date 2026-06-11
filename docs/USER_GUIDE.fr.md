# Kryptalis — Guide utilisateur

Guide complet pour déployer apps, bases de données, domaines et microservices sur Kryptalis.

---

## Sommaire

1. [Modes de déploiement — Local vs Multi-serveur](#1-modes-de-déploiement)
2. [Projets](#2-projets)
3. [Applications](#3-applications)
4. [Bases de données](#4-bases-de-données)
5. [Domaines & DNS](#5-domaines--dns)
6. [Microservices — le réseau du projet](#6-microservices)
7. [Déplacer un projet entre serveurs](#7-déplacer-un-projet)
8. [Serveur mail](#8-serveur-mail)
9. [Dépannage](#9-dépannage)

---

## 1. Modes de déploiement

Kryptalis fonctionne dans l'un de deux modes, défini dans **Réglages → Infrastructure** :

| Mode | Ce qu'il fait | Quand l'utiliser |
|---|---|---|
| **Local** | Tout tourne sur ce VPS unique. La page `Serveurs` est masquée. | Projet solo, un seul VPS, setup le plus simple. |
| **Multi-serveur** | Ce VPS + d'autres VPS connectés via l'agent Kryptalis. Les apps peuvent être déployées sur n'importe quel serveur enregistré. | Plusieurs VPS, régions différentes, isolation de charges. |

### Changer de mode

- **Local → Multi** : Réglages → Infrastructure → clique "Multi-serveur" → confirme. Tu es redirigé vers `/dashboard/servers` pour ajouter ton premier VPS distant.
- **Multi → Local** : même chemin. Les apps déjà sur des serveurs distants continuent à tourner mais disparaissent du dashboard jusqu'au rebascule.

### Ajouter un serveur distant (mode Multi uniquement)

1. `/dashboard/servers` → "Ajouter un serveur"
2. Kryptalis génère une commande d'installation (one-liner avec token)
3. SSH dans le VPS distant, colle la commande
4. L'agent Kryptalis s'installe, se connecte, et le serveur passe à `ONLINE`
5. Tu peux maintenant y déployer des apps

---

## 2. Projets

Un **projet** est un groupe logique d'apps + bases de données qui :

- Appartiennent à un serveur (un projet vit sur un VPS)
- Partagent un réseau Docker — les apps du projet se parlent par leur nom
- Partagent le contrôle d'accès (membres, rôles)

### Créer un projet

`/dashboard/projects` → "Nouveau projet" → nom + (en mode Multi) serveur cible.

### Rôles

| Rôle | Permissions |
|---|---|
| OWNER | Tout, y compris transférer la propriété et supprimer le projet |
| ADMIN | Ajouter/retirer membres, déployer, migrer vers un autre serveur |
| DEVELOPER | Déployer, éditer des apps |
| VIEWER | Lecture seule |

---

## 3. Applications

### Créer une app

`/dashboard/applications` → "Nouvelle application". Choisis :

- **Framework** — Next.js / NestJS / Docker / Docker Compose / …
- **Source** — URL repo Git + branche, ou image Docker pré-construite
- **Port** — port d'écoute dans le container

### Internes du container

Kryptalis donne à chaque app :

- Un nom de container prédictible : `kryptalis-<slug>`
- Un nom d'hôte interne prédictible : identique au nom de container
- L'appartenance au réseau Docker partagé du projet

Les autres apps du même projet l'atteignent à `http://kryptalis-<slug>:<port>` — aucune URL publique requise.

### Cycle de vie

Boutons sur la page détail de l'app :

- **Démarrer / Arrêter / Redémarrer** — direct
- **Redéployer** — re-pull la branche git et rebuild
- **Supprimer** — démonte la stack, retire le container

---

## 4. Bases de données

`/dashboard/databases` → "Nouvelle base". Choisis le type :

- PostgreSQL
- MySQL / MariaDB
- MongoDB
- Redis / KeyDB / Dragonfly
- ClickHouse

Kryptalis crée un container `kryptalis-db-<slug>` sur le réseau du projet, avec username/password générés.

**Se connecter depuis une app du même projet :**
L'onglet Service Mesh te donne les chaînes de connexion prêtes. Pour PostgreSQL :

```
DATABASE_URL=postgres://<user>:<password>@kryptalis-db-<slug>:5432/<slug>
```

Colle-la dans les variables d'environnement de ton app — pas de firewall, pas de port public.

---

## 5. Domaines & DNS

### Ajouter un domaine

`/dashboard/domains` → "Ajouter un domaine". Tape le hostname complet (ex : `athexis.xyz` ou `api.athexis.xyz`).

Tu n'as pas besoin d'"acheter" le domaine via Kryptalis — tu dis juste à Kryptalis que tu le possèdes. Kryptalis :

- Le réserve dans sa base
- Configure Caddy pour le servir
- Émet un certificat SSL Let's Encrypt (une fois le DNS pointé correctement)

### Configurer le DNS chez ton registrar

Ouvre la card du domaine → bouton "DNS records & health" (icône info). Le dialog a deux onglets :

**Health & recommended** — état live + records exacts à ajouter.

**All records** — tous les records DNS détectés (A, AAAA, CNAME, MX, TXT, NS) + réconciliation expected vs actual.

#### Setup typique chez Namecheap / OVH / Cloudflare

**Important** : Tu gardes tes nameservers (Namecheap / Cloudflare / autre). Tu changes seulement les **records**, pas les nameservers.

Pour un domaine racine `athexis.xyz` :

| Host | Type | Valeur |
|---|---|---|
| `athexis.xyz` (ou `@`) | A | `<IP de ton VPS>` |

Pour un sous-domaine `api.athexis.xyz` :

| Host | Type | Valeur |
|---|---|---|
| `api` | CNAME | `athexis.xyz` |

Si tu as attaché un serveur mail (voir section 8) :

| Host | Type | Valeur |
|---|---|---|
| `athexis.xyz` | MX (priorité 10) | `mail.athexis.xyz` |
| `mail` | A | `<IP de ton VPS>` |
| `athexis.xyz` | TXT | `v=spf1 mx ~all` |
| (plus — voir onglet Email) | | |

Clique "Verify now" dans l'onglet Records pour vérifier la propagation. Jusqu'à 24h est normal.

### Hiérarchie sous-domaines

La page Domaines groupe visuellement les sous-domaines sous leur apex. Clique une card pour déployer ses sous-domaines. "Add subdomain" pré-remplit le parent (tu tapes juste `api`, Kryptalis ajoute `.athexis.xyz`).

---

## 6. Microservices

Microservices dans Kryptalis = plusieurs apps dans le même projet qui se parlent.

### Comment ça marche

Chaque projet possède un réseau Docker : `kryptalis_proj_<projectId>`.

Quand tu déploies une app dans un projet :

- **Mode Local** : l'API crée le réseau (si manquant) et y attache l'app.
- **Mode Multi-serveur (même serveur)** : l'agent Kryptalis crée le réseau et écrit un `docker-compose.override.yml` qui attache chaque service de la stack. Pas de config manuelle.

Les apps du même projet se résolvent par nom de container via le DNS interne Docker.

### Exemple : Next.js + API NestJS + PostgreSQL

Crée un projet "monapp", puis 3 services :

| Service | Type | Hostname interne |
|---|---|---|
| `frontend` | App Next.js, port 3000 | `kryptalis-frontend:3000` |
| `api` | App NestJS, port 4000 | `kryptalis-api:4000` |
| `db` | PostgreSQL | `kryptalis-db-db:5432` |

Dans l'onglet **Service Mesh**, copie :

```
# Dans les env vars de frontend :
API_URL=http://kryptalis-api:4000

# Dans les env vars de api :
DATABASE_URL=postgres://user:password@kryptalis-db-db:5432/db
```

Attache un domaine uniquement à `frontend`. `api` et `db` restent internes — aucune exposition publique.

### Limitations

- **Même projet uniquement** : le réseau est limité au projet. L'app A du projet X ne peut pas joindre l'app B du projet Y via DNS interne. Utilise l'URL publique HTTPS (via un domaine) à la place.
- **Même hôte Docker uniquement** : en mode Multi, chaque projet vit sur un serveur. Pour diviser un projet sur plusieurs VPS il faudrait un réseau overlay (Docker Swarm / Kubernetes) — pas supporté actuellement. Contournement : sépare en deux projets, expose les services internes en HTTPS via Caddy.

---

## 7. Déplacer un projet

En mode Multi, tu peux déplacer un projet (et toutes ses apps + bases) d'un serveur à un autre.

**Comment** : Page détail projet → card serveur → bouton flèche → choisir le serveur cible → confirmer.

**Ce qui se passe :**

1. Les apps et DBs sont démontées sur le serveur source (best-effort — les échecs ne bloquent pas). Les volumes source sont **conservés** sur l'ancien serveur pour récupération.
2. Le `serverId` du projet bascule vers la cible.
3. Les volumes Docker sont transférés vers la cible **de façon asynchrone** (export sur la source, import sur la cible).
4. Les apps et DBs se déploient sur la cible une fois les données des volumes arrivées, donc les containers démarrent sur les vraies données.
5. Caddy se régénère pour que les domaines suivent.

**Limitations :**

- **Downtime** : les apps sont indisponibles pendant le transfert des volumes et le redéploiement sur le nouveau serveur.
- **Le transfert de volumes est best-effort** : si la mise en place de l'export/import échoue, la migration retombe sur un déploiement immédiat avec des **volumes vides** (un avertissement est remonté). Les volumes source restent intacts sur l'ancien serveur dans tous les cas — fais une sauvegarde avant de migrer si les données sont critiques.
- La découverte des volumes suit la convention de nommage compose-project ; les stacks déclarant des volumes nommés différemment ne sont pas couvertes quand la source est un serveur distant.
- Le serveur cible doit être `ONLINE`.

---

## 8. Serveur mail

Serveur mail par domaine (Postfix + Dovecot en containers). `/dashboard/emails`.

Attache un serveur mail à un domaine → Kryptalis te dit les records MX / A / SPF / DKIM / DMARC / PTR exacts à ajouter. L'onglet "DNS health" montre ce qui manque.

DNS inverse (PTR) — seul ton fournisseur VPS peut le définir. La plupart des panels ont un champ "Reverse DNS" ; mets-le à `mail.<ton-apex>`.

---

## 9. Dépannage

### "Le SSL du domaine est bloqué sur PENDING"

- DNS pas encore propagé → attends, clique "Verify now" dans l'onglet Records.
- Le record A pointe vers la mauvaise IP → corrige chez ton registrar.
- Ports 80/443 pas ouverts sur le VPS → vérifie le firewall.

### "L'app est RUNNING mais l'URL est inaccessible"

- Domaine pas attaché → Applications → app → onglet Domaines → attacher.
- Caddy désynchronisé → page Domaines → bouton "Sync reverse proxy".
- Mauvais port → vérifie que le port container de l'app correspond à ce que Caddy attend.

### "J'ai déployé une app sur un serveur distant mais les services ne se voient pas"

- Ça nécessite l'agent à jour (avec support du réseau projet).
- Mets l'agent à jour : l'agent est un binaire autonome (pas un dépôt git). Relance le one-liner d'installation depuis **Serveurs → ton serveur → Commande d'installation** (`curl -fsSL '<api>/api/agent/install.sh?token=…' | sh`) — il télécharge le dernier binaire et redémarre le service.

### "Mes données sont sur l'ancien serveur après migration"

- Les volumes sont normalement transférés automatiquement (de façon asynchrone) pendant la migration. Si la mise en place du transfert a échoué, les apps ont été déployées avec des volumes vides — vérifie les avertissements de migration.
- Les volumes source sont préservés sur l'ancien serveur pour récupération ; la migration elle-même ne purge rien.
- Solution de repli : utilise la fonction Backups sur l'ancien serveur, restaure sur le nouveau.

### "J'ai basculé de Multi à Local, où sont passées mes apps ?"

- Elles tournent toujours sur les serveurs distants. Elles sont juste masquées dans le dashboard.
- Rebascule en Multi pour les revoir, ou migre-les vers le serveur local d'abord.
