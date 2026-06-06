# Kryptalis — User Guide

Complete guide to running apps, databases, domains, and microservices on Kryptalis.

---

## Table of contents

1. [Deployment modes — Local vs Multi-server](#1-deployment-modes)
2. [Projects](#2-projects)
3. [Applications](#3-applications)
4. [Databases](#4-databases)
5. [Domains & DNS](#5-domains--dns)
6. [Microservices — the project network](#6-microservices)
7. [Moving a project between servers](#7-moving-projects)
8. [Email server](#8-email-server)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Deployment modes

Kryptalis runs in one of two modes, set in **Settings → Infrastructure**:

| Mode | What it does | When to use |
|---|---|---|
| **Local** | Everything runs on this single VPS. The `Servers` page is hidden. | Solo project, one VPS, simplest setup. |
| **Multi-server** | This VPS + extra VPS connected via the Kryptalis agent. Apps can be deployed on any registered server. | Multiple VPS, different regions, isolating workloads. |

### Switching modes

- **Local → Multi**: Settings → Infrastructure → click "Multi-server" → confirm. You're redirected to `/dashboard/servers` to add your first remote VPS.
- **Multi → Local**: same path. Apps already running on remote servers keep running but disappear from the dashboard until you switch back.

### Adding a remote server (Multi mode only)

1. `/dashboard/servers` → "Add server"
2. Kryptalis generates an install command (one-liner with a token)
3. SSH into the remote VPS, paste the command
4. The Kryptalis agent installs itself, connects back, and the server flips to `ONLINE`
5. You can now deploy apps to it

---

## 2. Projects

A **project** is a logical group of apps + databases that:

- Belong to one server (a project lives on one VPS)
- Share a Docker network — apps inside the project can talk to each other by name
- Share access control (members, roles)

### Creating a project

`/dashboard/projects` → "New project" → name + (in Multi mode) target server.

### Roles

| Role | Can do |
|---|---|
| OWNER | Everything, including transferring ownership and deleting the project |
| ADMIN | Add/remove members, deploy, migrate to another server |
| DEVELOPER | Deploy, edit apps |
| VIEWER | Read-only |

---

## 3. Applications

### Creating an app

`/dashboard/applications` → "New application". Pick:

- **Framework** — Next.js / NestJS / Docker / Docker Compose / …
- **Source** — Git repo URL + branch, or pre-built Docker image
- **Port** — what the app listens on inside the container

### Container internals

Kryptalis gives every app:

- A predictable container name: `kryptalis-<slug>`
- A predictable internal hostname: same as the container name
- Membership in the project's shared Docker network

Other apps in the same project reach this app at `http://kryptalis-<slug>:<port>` — no public URL needed.

### Lifecycle

Buttons on the app detail page:

- **Start / Stop / Restart** — straightforward
- **Redeploy** — re-pull the git branch and rebuild
- **Delete** — tear down the stack, remove the container

---

## 4. Databases

`/dashboard/databases` → "New database". Pick type:

- PostgreSQL
- MySQL / MariaDB
- MongoDB
- Redis

Kryptalis creates a container `kryptalis-db-<slug>` on the project network, with a generated username/password.

**Connecting from an app in the same project:**
The Service Mesh tab gives you ready-made connection strings. For PostgreSQL it looks like:

```
DATABASE_URL=postgres://<user>:<password>@kryptalis-db-<slug>:5432/<slug>
```

Paste it as an environment variable in your app — no firewall, no public port.

---

## 5. Domains & DNS

### Adding a domain

`/dashboard/domains` → "Add domain". Type the full hostname (e.g. `athexis.xyz` or `api.athexis.xyz`).

You don't need to "buy" the domain through Kryptalis — you just tell Kryptalis you own it. Kryptalis then:

- Reserves it in its database
- Configures Caddy to serve it
- Issues a Let's Encrypt SSL certificate (once DNS points correctly)

### Configuring DNS at your registrar

Open the domain card → "DNS records & health" button (info icon). The dialog has two tabs:

**Health & recommended** — live status check + the exact records you need to add.

**All records** — every DNS record currently detected (A, AAAA, CNAME, MX, TXT, NS) + reconciliation showing expected vs actual.

#### Typical setup at Namecheap / OVH / Cloudflare

**Important**: You keep your nameservers (Namecheap / Cloudflare / whoever). You only change **records**, not nameservers.

For an apex domain `athexis.xyz`:

| Host | Type | Value |
|---|---|---|
| `athexis.xyz` (or `@`) | A | `<your VPS IP>` |

For a subdomain `api.athexis.xyz`:

| Host | Type | Value |
|---|---|---|
| `api` | CNAME | `athexis.xyz` |

If you've attached a mail server (see section 8):

| Host | Type | Value |
|---|---|---|
| `athexis.xyz` | MX (priority 10) | `mail.athexis.xyz` |
| `mail` | A | `<your VPS IP>` |
| `athexis.xyz` | TXT | `v=spf1 mx ~all` |
| (more — see Email tab) | | |

Click "Verify now" in the Records tab to check propagation. Up to 24h is normal.

### Subdomain hierarchy

The Domains page groups subdomains under their apex visually. Click a card to expand its subdomains. "Add subdomain" pre-fills the parent (you only type `api`, Kryptalis appends `.athexis.xyz`).

---

## 6. Microservices

Microservices in Kryptalis = multiple apps in the same project talking to each other.

### How it works

Every project owns a Docker network: `kryptalis_proj_<projectId>`.

When you deploy an app to a project:

- **Local mode**: the API creates the network (if missing) and attaches the app to it.
- **Multi-server mode (same server)**: the Kryptalis agent creates the network and writes a `docker-compose.override.yml` that attaches every service in the stack to it. No manual config needed.

Apps in the same project resolve each other by container name via Docker's internal DNS.

### Example: Next.js + NestJS API + PostgreSQL

Create a project "myapp", then 3 services:

| Service | Type | Internal hostname |
|---|---|---|
| `frontend` | Next.js app, port 3000 | `kryptalis-frontend:3000` |
| `api` | NestJS app, port 4000 | `kryptalis-api:4000` |
| `db` | PostgreSQL | `kryptalis-db-db:5432` |

In the **Service Mesh** tab, copy:

```
# In frontend's env vars:
API_URL=http://kryptalis-api:4000

# In api's env vars:
DATABASE_URL=postgres://user:password@kryptalis-db-db:5432/db
```

Attach a domain to `frontend` only. `api` and `db` stay internal — no public exposure.

### Limitations

- **Same project only**: the network is project-scoped. App A in project X can't reach app B in project Y via internal DNS. Use the public HTTPS URL (via a domain) instead.
- **Same Docker host only**: in Multi mode, each project lives on one server. To split a project across multiple VPS you'd need an overlay network (Docker Swarm / Kubernetes) — not currently supported. Workaround: split into two projects, expose internal services via HTTPS through Caddy.

---

## 7. Moving projects

In Multi mode, you can move a project (and all its apps + databases) from one server to another.

**How**: Project detail page → server card → arrow button → pick target server → confirm.

**What happens:**

1. Apps and DBs are torn down on the source server (best-effort — failures don't block).
2. The project's `serverId` flips to the target.
3. Apps and DBs are re-deployed on the target.
4. Caddy regenerates so domains follow.

**Limitations:**

- **Downtime**: apps are unavailable while they redeploy on the new server.
- **Data in volumes is not copied across hosts**. If you have data you need to keep (DBs, uploads), back it up before migrating, or use external storage / managed DBs.
- Target server must be `ONLINE`.

---

## 8. Email server

Per-domain mail server (Postfix + Dovecot in containers). `/dashboard/emails`.

Attach a mail server to a domain → Kryptalis tells you the exact MX / A / SPF / DKIM / DMARC / PTR records to set. Tab "DNS health" shows what's missing.

Reverse DNS (PTR) — only your VPS provider can set this. Most panels have a "Reverse DNS" field; set it to `mail.<your-apex>`.

---

## 9. Troubleshooting

### "Domain SSL is stuck on PENDING"

- DNS not propagated yet → wait, click "Verify now" in the Records tab.
- A record points to the wrong IP → fix at your registrar.
- Port 80/443 not open on the VPS → check firewall.

### "App is RUNNING but I can't reach the URL"

- Domain not attached → Applications → app → Domains tab → attach.
- Caddy out of sync → Domains page → "Sync reverse proxy" button.
- Wrong port → check the app's container port matches what Caddy expects.

### "I deployed an app on the remote server but services can't reach each other"

- This requires the agent to be at the latest version (with project network support).
- Update the agent: SSH into the remote VPS, `cd /opt/kryptalis/agent && git pull && systemctl restart kryptalis-agent` (or however your agent was installed).

### "My data is on the old server after migration"

- Volume migration across hosts is not automatic. Back up before migrating.
- For databases: use the Backups feature, restore on the new server.

### "I switched from Multi to Local, where did my apps go?"

- They're still running on the remote servers. They're just hidden from the dashboard.
- Switch back to Multi to see them again, or migrate them to the local server first.
