import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface AuthState {
  user: User | null;
  accessToken: string | null;
  setAuth: (user: User, accessToken: string) => void;
  logout: () => void;
  isAuthenticated: () => boolean;
}

// Soft migration: the refresh token used to live in localStorage (and in
// the persisted zustand snapshot below). It now travels exclusively in the
// httpOnly `kryptalis_rt` cookie, so wipe any residue left by older builds
// — an XSS can no longer harvest a long-lived credential here. We capture
// the value before deleting so a legacy session (logged in before this
// deploy, hence no cookie yet) can do ONE body-based refresh, after which
// the server sets the cookie and the migration is complete.
let legacyRefreshToken: string | null = null;
if (typeof window !== 'undefined') {
  try {
    legacyRefreshToken = localStorage.getItem('refreshToken');
    localStorage.removeItem('refreshToken');
  } catch {}
}

/** One-shot accessor for the pre-cookie refresh token (legacy sessions). */
export function consumeLegacyRefreshToken(): string | null {
  const t = legacyRefreshToken;
  legacyRefreshToken = null;
  return t;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      accessToken: null,
      setAuth: (user, accessToken) => {
        localStorage.setItem('accessToken', accessToken);
        set({ user, accessToken });
      },
      logout: () => {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken'); // legacy key, belt + suspenders
        set({ user: null, accessToken: null });
      },
      isAuthenticated: () => !!get().accessToken,
    }),
    {
      name: 'kryptalis-auth',
      // v1 drops the persisted refreshToken (now httpOnly-cookie only).
      // The migrate fn strips the stale key from any v0 snapshot.
      version: 1,
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        delete state.refreshToken;
        return state as unknown as AuthState;
      },
    },
  ),
);

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
}

export const useSidebarStore = create<SidebarState>()((set) => ({
  collapsed: false,
  toggle: () => set((s) => ({ collapsed: !s.collapsed })),
}));
