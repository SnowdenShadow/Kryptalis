import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// api.ts (and the store it imports) touch window/localStorage at module-init
// and request time. We run in a plain node environment and install minimal
// stubs BEFORE the module under test is imported (hence the dynamic import
// below — a static `import './api'` would hoist past the stubs).
// ---------------------------------------------------------------------------

function createLocalStorageStub() {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
}

const localStorageStub = createLocalStorageStub();
const locationStub = { pathname: '/dashboard', href: '' };

vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub, location: locationStub });

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { api, ApiError } = await import('./api');
const { useAuthStore } = await import('./store');

afterAll(() => {
  vi.unstubAllGlobals();
});

/** Minimal Response-shaped stub (only what ApiClient reads). */
function jsonRes(status: number, body?: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('Unexpected end of JSON input');
      return body;
    },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

function authHeader(init?: { headers?: Record<string, string> }) {
  return init?.headers?.Authorization ?? null;
}

beforeEach(() => {
  fetchMock.mockReset();
  localStorageStub.clear();
  locationStub.pathname = '/dashboard';
  locationStub.href = '';
  useAuthStore.setState({ user: null, accessToken: null });
});

describe('ApiClient request()', () => {
  it('returns parsed JSON on success and sends the in-memory access token', async () => {
    // Access token lives in the zustand store (memory), never localStorage.
    useAuthStore.setState({ accessToken: 'tok-1' });
    fetchMock.mockResolvedValueOnce(jsonRes(200, { hello: 'world' }));

    const data = await api.get<{ hello: string }>('/things');

    expect(data).toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:4000/api/things');
    expect(authHeader(init)).toBe('Bearer tok-1');
  });

  it('returns undefined for 204 No Content', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(204));
    await expect(api.delete('/things/1')).resolves.toBeUndefined();
  });

  it('normalizes NestJS ValidationPipe array messages into fields + summary', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(400, { message: ['port must be an integer', 'domain must match'] }),
    );

    const err = await api.post('/things', {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as InstanceType<typeof ApiError>;
    expect(apiErr.status).toBe(400);
    expect(apiErr.fields).toEqual(['port must be an integer', 'domain must match']);
    expect(apiErr.message).toBe('port must be an integer • domain must match');
    expect(apiErr.endpoint).toBe('/things');
  });

  it('does NOT attempt a refresh for /auth/login 401 and surfaces the backend message', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(401, { message: 'Two-factor code required' }));

    const err = await api.post('/auth/login', { email: 'a@b.c' }).catch((e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh call
    expect((err as Error).message).toBe('Two-factor code required');
    expect(locationStub.href).toBe(''); // no redirect
  });
});

describe('ApiClient transparent refresh', () => {
  it('on 401: refreshes, stores the new token, and retries the original request', async () => {
    useAuthStore.setState({ accessToken: 'stale' });
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.endsWith('/api/auth/refresh')) return jsonRes(200, { accessToken: 'fresh' });
      return authHeader(init) === 'Bearer fresh'
        ? jsonRes(200, { ok: true })
        : jsonRes(401, { message: 'Unauthorized' });
    });

    const data = await api.get<{ ok: boolean }>('/things');

    expect(data).toEqual({ ok: true });
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => u.endsWith('/api/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
    // cookie-first: body must be empty, credentials included
    expect(refreshCalls[0][1].body).toBe('{}');
    expect(refreshCalls[0][1].credentials).toBe('include');
    // new token lives in the in-memory store ONLY — never localStorage, so an
    // XSS can't scrape a valid bearer from disk.
    expect(useAuthStore.getState().accessToken).toBe('fresh');
    expect(localStorageStub.getItem('accessToken')).toBeNull();
  });

  it('two concurrent 401s share a single in-flight refresh', async () => {
    let resolveRefresh!: () => void;
    const refreshGate = new Promise<void>((r) => {
      resolveRefresh = r;
    });
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.endsWith('/api/auth/refresh')) {
        refreshCalls++;
        await refreshGate;
        return jsonRes(200, { accessToken: 'fresh' });
      }
      return authHeader(init) === 'Bearer fresh'
        ? jsonRes(200, { ok: true })
        : jsonRes(401, { message: 'Unauthorized' });
    });

    const both = Promise.all([api.get('/a'), api.get('/b')]);
    // let both 401s land and reach tryRefresh before the refresh settles
    await new Promise((r) => setTimeout(r, 0));
    resolveRefresh();

    await expect(both).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCalls).toBe(1);
  });

  it('failed refresh: logs out, redirects to /login, throws ApiError(401)', async () => {
    useAuthStore.setState({ accessToken: 'stale', user: { id: '1', name: 'n', email: 'e', role: 'USER' } });
    const logoutSpy = vi.spyOn(useAuthStore.getState(), 'logout');
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/api/auth/refresh') ? jsonRes(401, {}) : jsonRes(401, { message: 'Unauthorized' }),
    );

    const err = await api.get('/things').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).status).toBe(401);
    expect(logoutSpy).toHaveBeenCalledTimes(1);
    expect(locationStub.href).toBe('/login');
    // logout clears the in-memory token (and the legacy localStorage key).
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(localStorageStub.getItem('accessToken')).toBeNull();
  });

  it('does not redirect again when already on /login', async () => {
    locationStub.pathname = '/login';
    fetchMock.mockImplementation(async () => jsonRes(401, {}));

    await api.get('/things').catch(() => undefined);

    expect(locationStub.href).toBe('');
  });

  it('a 401 arriving AFTER a settled (failed) refresh starts a fresh refresh attempt', async () => {
    // Regression for the setTimeout→.finally fix: the lock must be released
    // synchronously on settlement so a later 401 never reuses a stale failed
    // promise.
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/api/auth/refresh')) {
        refreshCalls++;
        return jsonRes(401, {});
      }
      return jsonRes(401, { message: 'Unauthorized' });
    });

    await api.get('/first').catch(() => undefined);
    await api.get('/second').catch(() => undefined);

    expect(refreshCalls).toBe(2);
  });
});

describe('ApiClient rawFetch()', () => {
  it('shares the refresh pipeline and returns the raw Response on success', async () => {
    fetchMock.mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
      if (url.endsWith('/api/auth/refresh')) return jsonRes(200, { accessToken: 'fresh' });
      return authHeader(init) === 'Bearer fresh'
        ? jsonRes(200, { blob: true })
        : jsonRes(401, {});
    });

    const res = await api.rawFetch('/files/download');
    expect(res.status).toBe(200);
    const refreshCalls = fetchMock.mock.calls.filter(([u]) => u.endsWith('/api/auth/refresh'));
    expect(refreshCalls).toHaveLength(1);
  });
});

describe('ApiClient restoreSession() (cold-boot recovery)', () => {
  it('repopulates the in-memory token from the refresh cookie and returns true', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/api/auth/refresh') ? jsonRes(200, { accessToken: 'restored' }) : jsonRes(401, {}),
    );

    await expect(api.restoreSession()).resolves.toBe(true);
    expect(useAuthStore.getState().accessToken).toBe('restored');
    expect(localStorageStub.getItem('accessToken')).toBeNull(); // never persisted
  });

  it('returns false and leaves the user logged out when no session can be restored', async () => {
    fetchMock.mockImplementation(async () => jsonRes(401, {}));

    await expect(api.restoreSession()).resolves.toBe(false);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });
});
