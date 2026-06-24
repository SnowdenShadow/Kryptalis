# Dashboard

DockControl is built around a modern, fast and intuitive user interface.

The goal is to make infrastructure management accessible to everyone.

---

## Modern Interface

Built with:

* Next.js 15
* React 19
* TypeScript
* Tailwind CSS
* shadcn/ui

Features:

* Dark Mode
* Responsive Design
* Real-time Updates (polling)

---

## Overview Dashboard

A global view of your infrastructure.

Monitor:

* Servers
* Applications
* Domains
* Databases
* Emails
* Containers
* Resources

From a single screen.

---

## Projects

Each project centralizes:

* Applications
* Domains
* SSL Certificates
* Environment Variables
* Databases
* File Storage
* Monitoring
* Backups

---

## Real-Time Monitoring

Live metrics:

* CPU Usage
* Memory Usage
* Disk Usage
* Network Activity
* Container Statistics

Without page refresh.

---

## Deployment Interface

Deploy applications visually.

Features:

* Git Repository Connection
* Branch Selection
* Environment Variables
* Build Configuration
* Deployment History
* Automatic rollback on failed deploys (API-side)

---

## PHP / Apache Hosting

Classic shared-hosting for PHP sites — no Docker knowledge required.

Features:

* Pick the PHP version per site (7.4 / 8.0 / 8.1 / 8.2 / 8.3) — change it anytime, the image rebuilds automatically.
* Serves both static `.html` and executable `.php` (Apache + mod_php).
* Bundled extensions: `pdo_mysql`, `mysqli`, `pdo_pgsql` + `gd`, `zip`, `intl`, `opcache`, `bcmath` — WordPress, Laravel, Symfony, PrestaShop run out of the box.
* Upload your files over **SFTP** into the site's `public/` folder — served live, no rebuild.
* **Attach a managed database** from the site card: its connection details are injected as `DB_HOST` / `DB_PORT` / `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD` / `DATABASE_URL` env vars (read them with `getenv()`), and survive redeploys.
* Attach a domain for automatic HTTPS (Let's Encrypt via Caddy). The first request to a new domain may briefly fail while the certificate is issued, then works.
* Full lifecycle (logs, deployment history, terminal, start / stop / restart) via the site's **Details** page.

---

## Cron Jobs

Schedule a command to run periodically inside an application or PHP site.

Features:

* **Simple schedule builder** (every N minutes / hourly / daily / weekly / monthly) with dropdowns — or an **Advanced** raw 5-field cron expression for power users. A plain-language preview always shows what will happen.
* Commands run as `sh -c` inside the app's container (works for Docker apps and PHP sites alike).
* **Test now** button runs the job immediately and shows the captured output + exit code.
* Edit, enable/disable, and delete jobs from the list.
* The scheduler runs inside the API (one process, minute granularity). A run missed while the platform is down is skipped rather than replayed.

---

## File Manager

Integrated web file explorer.

Features:

* Upload Files
* Download Files
* Edit Files
* Create Directories
* Rename / Delete

No FTP client required.

---

## Email Management

Manage email infrastructure directly from the dashboard.

Features:

* Mailboxes
* Aliases
* Forwarding
* Quotas
* DNS Validation

---

## Database Management

Visual database administration.

Features:

* Create Databases
* Manage Users
* Backups
* Restores
* Metrics

---

## Multi-Language

Supported languages:

* English
* Français

Additional languages can be added through the translation system.

---

## Multi-Tenant Ready

Built for:

* Individuals
* Agencies
* Hosting Providers
* SaaS Platforms

Manage multiple customers from a single interface.

---

## RBAC

Role-based access control.

Roles:

* Global roles: SUPERADMIN / ADMIN / USER / VIEWER
* Per-project roles: OWNER / ADMIN / DEVELOPER / VIEWER

Fine-grained permissions for every resource.

---

## Notifications

Receive notifications for:

* Deployments
* SSL Expiration
* Server Issues
* Backup Failures
* Monitoring Alerts

Channels:

* Email
* Discord
* Slack
* Webhooks
