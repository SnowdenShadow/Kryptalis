import { useAuthStore, consumeLegacyRefreshToken } from './store';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * Structured error every page can branch on. Replaces the old `new Error(msg)`
 * pipeline that discarded HTTP status + NestJS ValidationPipe field arrays.
 *
 * `status` is the HTTP status code (4xx = user-actionable, 5xx = server bug),
 * `fields` is the array form Nest emits for class-validator failures
 * (e.g. `['port must be an integer', 'domain must match ...']`),
 * `endpoint` is the path that errored (handy for debugging).
 *
 * The default `message` is the best one-line summary we could synthesize
 * (fields joined with ' • ', or the raw `message` field, or the HTTP text).
 * `toString()` returns that summary too, so legacy `toast.error(err.message)`
 * sites keep working.
 */
export class ApiError extends Error {
  status: number;
  fields: string[];
  endpoint: string;
  raw: unknown;
  constructor(opts: { status: number; message: string; fields?: string[]; endpoint: string; raw?: unknown }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.fields = opts.fields ?? [];
    this.endpoint = opts.endpoint;
    this.raw = opts.raw;
  }
}

/**
 * API client with transparent JWT refresh.
 *
 * The access token has a short TTL (15m); the refresh token lasts 7 days and
 * lives in the httpOnly `kryptalis_rt` cookie (path-scoped to /api/auth).
 * Without auto-refresh the user gets kicked back to /login every 15 minutes,
 * which is what was happening. Now: on any 401 we POST /auth/refresh with
 * credentials:'include' (the cookie does the authenticating), swap in the new
 * access token, and retry the original request. Only if the refresh itself
 * fails do we wipe storage and bounce to /login.
 *
 * Concurrent requests landing during a refresh share the same in-flight promise
 * so we never fire two refreshes in parallel.
 */
class ApiClient {
  private baseUrl: string;
  private refreshPromise: Promise<string | null> | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  private getAccessToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('accessToken');
  }

  private clearTokensAndRedirect() {
    if (typeof window === 'undefined') return;
    // logout() clears BOTH localStorage tokens and the persisted zustand
    // state ('kryptalis-auth'). Clearing only localStorage left zustand
    // believing the user was still logged in → /login ↔ /dashboard
    // redirect loop after session expiry.
    useAuthStore.getState().logout();
    // Avoid bouncing if we're already on the login page.
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }

  /**
   * Returns a new access token on success, or null if the refresh failed.
   * Cookie-first: the httpOnly `kryptalis_rt` cookie rides along via
   * credentials:'include' and the body stays empty. If that fails AND a
   * pre-cookie localStorage refresh token still exists (legacy session),
   * we retry once with the body — the server then sets the cookie and the
   * migration completes. The rotated refresh token returned in the JSON
   * body is deliberately NOT persisted anywhere readable by JS.
   * Multi-call safe: a single in-flight refresh is shared across all
   * concurrent callers.
   */
  private async tryRefresh(): Promise<string | null> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const attempt = async (body: Record<string, string>) => {
          const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) return null;
          return res.json();
        };

        let data = await attempt({});
        if (!data) {
          const legacy = consumeLegacyRefreshToken();
          if (legacy) data = await attempt({ refreshToken: legacy });
        }
        if (!data?.accessToken) return null;

        localStorage.setItem('accessToken', data.accessToken);
        // Keep the zustand copy in sync — it persists its own snapshot
        // ('kryptalis-auth') and would otherwise hold a revoked token.
        useAuthStore.setState({ accessToken: data.accessToken });
        return data.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      // Lock lifetime = promise lifetime: callers landing while a refresh is
      // in flight share it; callers landing after it settled start a fresh
      // attempt. The old setTimeout(…, 0) release left a macrotask window
      // after settlement where a new 401 was handed the STALE settled
      // promise — after a failed refresh that meant a spurious logout even
      // though a fresh attempt (e.g. legacy-token path) might have
      // succeeded. Callers keep their own reference, so clearing the field
      // synchronously never hides the result from anyone already waiting.
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, headers = {} } = options;

    const doFetch = (token: string | null) => fetch(`${this.baseUrl}/api${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      // /api/auth/* carries the httpOnly refresh cookie (login/refresh set
      // it, logout clears it) — everything else stays cookie-less.
      ...(endpoint.startsWith('/auth') ? { credentials: 'include' as const } : {}),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let res = await doFetch(this.getAccessToken());

    if (res.status === 401) {
      // /auth/refresh and /auth/login themselves shouldn't try to refresh —
      // their 401 is the real, unrecoverable kind. For login specifically
      // a 401 carries an actionable message ('Two-factor code required',
      // 'Invalid credentials', …) which the page needs verbatim — don't
      // overwrite it with a 'Session expired' redirect.
      const isAuthEntry =
        endpoint.startsWith('/auth/refresh') ||
        endpoint.startsWith('/auth/login') ||
        endpoint.startsWith('/auth/register');

      if (!isAuthEntry) {
        const newToken = await this.tryRefresh();
        if (newToken) {
          res = await doFetch(newToken);
        }
        if (res.status === 401) {
          this.clearTokensAndRedirect();
          throw new ApiError({ status: 401, message: 'Session expired — please log in again.', endpoint });
        }
      }
      // For /auth/* entry points, fall through to the generic !res.ok
      // handler below so the backend's actual error message reaches the
      // caller.
    }

    if (!res.ok) {
      const error: any = await res.json().catch(() => ({}));
      // NestJS ValidationPipe emits `message` as a string[] for field errors.
      // Normalize: keep the array on `fields`, and join into a readable summary.
      let fields: string[] = [];
      let summary: string;
      if (Array.isArray(error?.message)) {
        fields = error.message;
        summary = fields.join(' • ');
      } else if (typeof error?.message === 'string' && error.message) {
        summary = error.message;
      } else if (typeof error?.error === 'string' && error.error) {
        summary = error.error;
      } else {
        summary = res.status >= 500
          ? `Server error (${res.status}) — try again in a moment.`
          : `Request failed (${res.status}).`;
      }
      throw new ApiError({ status: res.status, message: summary, fields, endpoint, raw: error });
    }

    // 204 No Content / empty body (typical DELETE) — res.json() would throw
    // "Unexpected end of JSON input".
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Raw fetch sharing the same auth/refresh pipeline, for endpoints that
   * are not JSON (file upload streams, blob downloads). Callers get the
   * Response object back; non-2xx still throws ApiError after one refresh
   * attempt, so upload/download no longer break 15 minutes into a session.
   */
  async rawFetch(endpoint: string, init: RequestInit = {}): Promise<Response> {
    const doFetch = (token: string | null) =>
      fetch(`${this.baseUrl}/api${endpoint}`, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

    let res = await doFetch(this.getAccessToken());
    if (res.status === 401) {
      const newToken = await this.tryRefresh();
      if (newToken) res = await doFetch(newToken);
      if (res.status === 401) {
        this.clearTokensAndRedirect();
        throw new ApiError({ status: 401, message: 'Session expired — please log in again.', endpoint });
      }
    }
    return res;
  }

  get<T>(endpoint: string) {
    return this.request<T>(endpoint);
  }

  post<T>(endpoint: string, body?: unknown) {
    return this.request<T>(endpoint, { method: 'POST', body });
  }

  patch<T>(endpoint: string, body?: unknown) {
    return this.request<T>(endpoint, { method: 'PATCH', body });
  }

  delete<T>(endpoint: string, body?: unknown) {
    return this.request<T>(endpoint, { method: 'DELETE', body });
  }
}

export const api = new ApiClient(API_URL);
