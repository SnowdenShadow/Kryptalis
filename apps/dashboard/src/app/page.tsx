'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';

/**
 * Landing page — fans out to the right starting screen for the current
 * install state.
 *
 *   needsSetup = true → /register?setup=1  (fresh install, no users yet)
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
  const isAuthed = useAuthStore((s) => !!s.accessToken);

  useEffect(() => {
    if (isAuthed) {
      router.replace('/dashboard');
      return;
    }
    api
      .get<{ needsSetup: boolean }>('/auth/setup-status')
      .then((r) => {
        router.replace(r.needsSetup ? '/register?setup=1' : '/login');
      })
      .catch(() => {
        // API unreachable — fall back to /login. Operator's setup script
        // would have surfaced the API failure elsewhere; we don't want to
        // get stuck on a blank page if it's just a transient blip.
        router.replace('/login');
      });
  }, [isAuthed, router]);

  return null;
}
