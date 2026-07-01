// ---------------------------------------------------------------------------
// Shared application formatting constants + helpers.
//
// Single source of truth for the status/framework/URL display logic that was
// previously copy-pasted across applications/page.tsx, applications/[id]/
// page.tsx, projects/[id]/page.tsx, admin/page.tsx and domains/page.tsx —
// the copies had already started to drift (different STATUS_COLOR keys,
// localhost hardcoded in one timeAgo, …).
// ---------------------------------------------------------------------------

export const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive'> = {
  RUNNING: 'success',
  STOPPED: 'secondary',
  BUILDING: 'warning',
  DEPLOYING: 'warning',
  ERROR: 'destructive',
  SUCCESS: 'success',
  FAILED: 'destructive',
  PENDING: 'warning',
  CANCELLED: 'secondary',
};

export const STATUS_COLOR: Record<string, string> = {
  RUNNING: 'bg-emerald-500',
  STOPPED: 'bg-zinc-400',
  BUILDING: 'bg-orange-500',
  DEPLOYING: 'bg-orange-500',
  ERROR: 'bg-red-500',
  FAILED: 'bg-red-500',
  PENDING: 'bg-orange-500',
};

export const FRAMEWORK_LABELS: Record<string, string> = {
  NEXTJS: 'Next.js',
  REACT: 'React',
  VUE: 'Vue',
  ANGULAR: 'Angular',
  NESTJS: 'NestJS',
  EXPRESS: 'Express',
  LARAVEL: 'Laravel',
  SYMFONY: 'Symfony',
  DJANGO: 'Django',
  FLASK: 'Flask',
  FASTAPI: 'FastAPI',
  STATIC: 'Static',
  DOCKER: 'Docker',
  DOCKER_COMPOSE: 'Compose',
  PHP_SITE: 'PHP / Apache',
};

export const HTTPS_PORTS = [443, 8443, 9443];

/**
 * Localized relative-time formatter factory. Pass the i18n `t` and the key
 * prefix the page's translations use ('apps' | 'admin' | 'domains' | …).
 * Keys expected: `<prefix>.timeJust|timeMin|timeHour|timeDay` (apps-style)
 * — pages with admin-style keys can pass a custom key map.
 */
export function makeTimeAgo(
  t: (k: string, v?: Record<string, string | number>) => string,
  keys: { just: string; min: string; hour: string; day: string; never?: string } = {
    just: 'apps.timeJust',
    min: 'apps.timeMin',
    hour: 'apps.timeHour',
    day: 'apps.timeDay',
  },
) {
  return (date: string | null) => {
    if (!date) return keys.never ? t(keys.never) : '—';
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return t(keys.just);
    if (s < 3600) return t(keys.min, { n: Math.floor(s / 60) });
    if (s < 86400) return t(keys.hour, { n: Math.floor(s / 3600) });
    return t(keys.day, { n: Math.floor(s / 86400) });
  };
}

/** http(s)://<current host>:<port> — protocol picked by well-known TLS ports. */
export function appUrl(port: number, hostname?: string) {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
  const proto = HTTPS_PORTS.includes(port) ? 'https' : 'http';
  return `${proto}://${host}:${port}`;
}

export interface PublicUrlApp {
  port?: number | null;
  hostPort?: number | null;
  customPort?: boolean;
  domains?: { domain: string; sslStatus: string }[];
  portBindings?: { port: number; domain: { domain: string; sslStatus: string } }[];
  /** Per-app server placement (a project has no server of its own). */
  server?: { host?: string | null } | null;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal', '::1'];

/** The hostname IP:port URLs should target: the app's own server when it's a
 *  remote machine, else the caller-provided fallback / current host. */
export function appServerHostname(app: PublicUrlApp, fallbackHostname?: string): string | undefined {
  const h = app.server?.host;
  if (h && !LOCAL_HOSTS.includes(h)) return h;
  return fallbackHostname;
}

/**
 * Every URL this app is reachable at:
 *   - clean-URL domains (app on :443)  → https://<domain>
 *   - port-pinned domain → http://<domain>:<port> (Caddy only binds 80/443;
 *     the container holds the custom port itself)
 *   - port bindings (app co-hosted on another domain) → http://<domain>:<port>
 *   - no domain at all → fallback to <current host>:<hostPort|port>
 */
export function publicUrls(app: PublicUrlApp, fallbackHostname?: string): string[] {
  const urls: string[] = [];
  for (const d of app.domains || []) {
    urls.push(app.customPort && app.port ? `http://${d.domain}:${app.port}` : `https://${d.domain}`);
  }
  for (const b of app.portBindings || []) {
    urls.push(`http://${b.domain.domain}:${b.port}`);
  }
  // IP:port fallback — target the app's OWN server (remote in MULTI mode),
  // not the host serving the dashboard.
  const ipHost = appServerHostname(app, fallbackHostname);
  if (urls.length === 0 && app.hostPort) {
    urls.push(appUrl(app.hostPort, ipHost));
  } else if (urls.length === 0 && app.port) {
    urls.push(appUrl(app.port, ipHost));
  }
  return urls;
}

/** First openable URL or null — list-view convenience over publicUrls(). */
export function publicAppUrl(app: PublicUrlApp, fallbackHostname?: string): string | null {
  return publicUrls(app, fallbackHostname)[0] ?? null;
}
