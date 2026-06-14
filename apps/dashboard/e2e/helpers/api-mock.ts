import type { Page, Route, Request } from '@playwright/test';

/**
 * Backend-less e2e: every request the dashboard fires at the API origin
 * (NEXT_PUBLIC_API_URL, fixed to http://localhost:4000 in playwright.config)
 * is intercepted with page.route() and answered from a handler table.
 *
 * ── Auth approach (documented decision) ─────────────────────────────────
 * Two options were considered:
 *   1. Drive the real login UI for every test.
 *   2. Seed localStorage with what the app actually persists.
 * We use (2) for everything except the login tests themselves (which DO
 * exercise the real form + mocked POST /api/auth/login). Seeding is the
 * most robust because route protection is fully client-side:
 *   - `(dashboard)/layout.tsx` gates on `useAuthStore().accessToken`,
 *     rehydrated by zustand/persist from the `dockcontrol-auth` localStorage
 *     key (shape: `{ state: { user, accessToken }, version: 1 }` — version
 *     must be 1 or the store's migrate() runs).
 *   - `src/lib/api.ts` reads the raw `accessToken` localStorage key for the
 *     Authorization header.
 * The token is an opaque string to the frontend (never decoded client-side),
 * so any non-empty value works. The httpOnly refresh cookie is irrelevant
 * here: with all routes mocked, nothing ever returns 401 unless a test
 * wants it to.
 */

export const API_ORIGIN = 'http://localhost:4000';

export type Role = 'USER' | 'ADMIN' | 'SUPERADMIN';

export interface MockUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export function makeUser(role: Role = 'USER'): MockUser {
  return {
    id: `e2e-${role.toLowerCase()}-id`,
    name: role === 'USER' ? 'Eva User' : 'Ada Admin',
    email: `${role.toLowerCase()}@e2e.test`,
    role,
  };
}

export interface MockHandler {
  /** HTTP method, default GET. */
  method?: string;
  /** Matched against the pathname with the `/api` prefix stripped (e.g. `/auth/login`). */
  path: string | RegExp;
  status?: number;
  /** JSON body, or a function receiving the route (for request assertions / dynamic bodies). */
  body?: unknown | ((route: Route, request: Request) => unknown | Promise<unknown>);
}

/**
 * Baseline handlers so background queries fired by the layout/sidebar/header
 * (onboarding, projects, badges, notifications, public settings) never 404
 * or — worse — 401 (which would trigger the refresh→logout pipeline).
 */
function defaultHandlers(user: MockUser): MockHandler[] {
  return [
    { path: '/settings/public', body: { deployment_mode: 'LOCAL' } },
    { path: '/auth/me', body: user },
    { path: '/auth/me/onboarding', body: { completed: true } },
    { path: '/auth/setup-status', body: { needsSetup: false } },
    { path: '/projects', body: [] },
    { path: '/applications', body: [] },
    { path: '/servers', body: [] },
    { path: '/servers/mine', body: [] },
    { path: '/servers/local', body: {} },
    { path: '/servers/local-public', body: { id: 'srv-local', name: 'local', status: 'ONLINE' } },
    { path: '/notifications/unread-count', body: { count: 0 } },
    { path: '/notifications', body: [] },
    { path: '/users/me/notification-preferences', body: { prefs: {} } },
    { path: '/domains', body: [] },
    { path: '/deployments', body: [] },
  ];
}

/**
 * CORS headers for every fulfilled response. The app runs on :3100 and the
 * (mocked) API origin is :4000, so the browser still applies CORS checks to
 * route.fulfill() responses — including a preflight for the JSON
 * Content-Type + Authorization header. Origin is echoed (not `*`) because
 * /auth/* requests use credentials:'include'.
 */
function corsHeaders(request: Request): Record<string, string> {
  return {
    'access-control-allow-origin': request.headers()['origin'] ?? 'http://localhost:3100',
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  };
}

/**
 * Install the API interception layer. `handlers` take priority over the
 * defaults (first match wins, custom handlers checked first).
 * Unmatched requests get an empty 200 `[]` — safe for both list and object
 * consumers, and never kicks off the 401-refresh-logout path.
 */
export async function mockApi(page: Page, handlers: MockHandler[] = [], user: MockUser = makeUser('USER')): Promise<void> {
  const all = [...handlers, ...defaultHandlers(user)];
  await page.route(`${API_ORIGIN}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api/, '') || '/';
    const method = request.method();

    if (method === 'OPTIONS') {
      // CORS preflight
      await route.fulfill({ status: 204, headers: corsHeaders(request) });
      return;
    }

    const handler = all.find(
      (h) =>
        (h.method ?? 'GET').toUpperCase() === method &&
        (typeof h.path === 'string' ? h.path === path : h.path.test(path)),
    );

    if (handler) {
      const body =
        typeof handler.body === 'function'
          ? await (handler.body as (r: Route, req: Request) => unknown)(route, request)
          : handler.body;
      await route.fulfill({
        status: handler.status ?? 200,
        contentType: 'application/json',
        headers: corsHeaders(request),
        body: JSON.stringify(body ?? {}),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: corsHeaders(request),
      body: '[]',
    });
  });
}

/**
 * Seed the exact persisted auth state the app reads on boot (must be called
 * BEFORE the first page.goto so the init script runs ahead of hydration).
 */
export async function seedAuth(page: Page, user: MockUser): Promise<void> {
  await page.addInitScript(
    ({ u }) => {
      const token = 'e2e-access-token';
      localStorage.setItem('accessToken', token);
      localStorage.setItem(
        'dockcontrol-auth',
        JSON.stringify({ state: { user: u, accessToken: token }, version: 1 }),
      );
    },
    { u: user },
  );
}

/**
 * Full "already logged in" setup: API mocks + persisted auth state.
 * Returns the user so tests can assert on its fields.
 */
export async function loginAs(
  page: Page,
  opts: { role?: Role; handlers?: MockHandler[] } = {},
): Promise<MockUser> {
  const user = makeUser(opts.role ?? 'USER');
  await mockApi(page, opts.handlers ?? [], user);
  await seedAuth(page, user);
  return user;
}
