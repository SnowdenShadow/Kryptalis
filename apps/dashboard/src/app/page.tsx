'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api, sessionReady } from '@/lib/api';
import { useAuthStore } from '@/lib/store';

/**
 * Landing page — fans out to the right starting screen for the current
 * install state.
 *
 *   needsSetup = true → /setup  (fresh install — full-screen setup flow)
 *   logged in        → /dashboard
 *   default          → /login
 *
 * Runs on the client so we can read auth from the Zustand store without
 * needing SSR session plumbing. The Next.js middleware already covers the
 * "auth required" cases for deeper routes; this is just the entry-point
 * router.
 */
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    // Wait for the cold-boot silent refresh first: the access token is
    // memory-only now, so reading the store synchronously would mis-route a
    // valid session to /login. sessionReady resolves true if the httpOnly
    // cookie restored a session.
    void sessionReady.then((restored) => {
      if (!active) return;
      if (restored || useAuthStore.getState().accessToken) {
        router.replace('/dashboard');
        return;
      }
      api
        .get<{ needsSetup: boolean }>('/auth/setup-status')
        .then((r) => {
          if (active) router.replace(r.needsSetup ? '/setup' : '/login');
        })
        .catch(() => {
          // API unreachable — fall back to /login. Operator's setup script
          // would have surfaced the API failure elsewhere; we don't want to
          // get stuck on a blank page if it's just a transient blip.
          if (active) router.replace('/login');
        });
    });
    return () => {
      active = false;
    };
  }, [router]);

  return null;
}
