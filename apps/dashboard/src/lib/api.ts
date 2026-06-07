const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

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
 * The access token has a short TTL (15m); the refresh token lasts 7 days.
 * Without auto-refresh the user gets kicked back to /login every 15 minutes,
 * which is what was happening. Now: on any 401 we try /auth/refresh once with
 * the stored refresh token, swap in the new pair, and retry the original
 * request. Only if the refresh itself fails do we wipe storage and bounce to
 * /login.
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

  private getRefreshToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('refreshToken');
  }

  private clearTokensAndRedirect() {
    if (typeof window === 'undefined') return;
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    // Avoid bouncing if we're already on the login page.
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }

  /**
   * Returns a new access token (and rotates the refresh token in storage) on
   * success, or null if the refresh failed. Multi-call safe: a single
   * in-flight refresh is shared across all concurrent callers.
   */
  private async tryRefresh(): Promise<string | null> {
    if (this.refreshPromise) return this.refreshPromise;
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) return null;

    this.refreshPromise = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.accessToken) localStorage.setItem('accessToken', data.accessToken);
        if (data.refreshToken) localStorage.setItem('refreshToken', data.refreshToken);
        return data.accessToken ?? null;
      } catch {
        return null;
      } finally {
        // Release the lock on the next microtask so concurrent callers all see
        // the resolved value first.
        setTimeout(() => { this.refreshPromise = null; }, 0);
      }
    })();
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
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let res = await doFetch(this.getAccessToken());

    if (res.status === 401) {
      // /auth/refresh and /auth/login themselves shouldn't try to refresh —
      // their 401 is the real, unrecoverable kind.
      if (!endpoint.startsWith('/auth/refresh') && !endpoint.startsWith('/auth/login')) {
        const newToken = await this.tryRefresh();
        if (newToken) {
          res = await doFetch(newToken);
        }
      }
      if (res.status === 401) {
        this.clearTokensAndRedirect();
        throw new ApiError({ status: 401, message: 'Session expired — please log in again.', endpoint });
      }
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

    return res.json();
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
