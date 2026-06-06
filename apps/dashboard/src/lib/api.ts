const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

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
        throw new Error('Unauthorized');
      }
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: 'Request failed' }));
      throw new Error(error.message || 'Request failed');
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
