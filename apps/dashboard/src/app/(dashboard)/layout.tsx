'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { useSidebarStore, useAuthStore } from '@/lib/store';
import { api, sessionReady } from '@/lib/api';
import { useProjects } from '@/lib/hooks';
import { cn } from '@/lib/utils';

/**
 * Client-side guard for /dashboard/*.
 *
 * The middleware can't read localStorage (it runs at the edge), and the
 * tokens are stored client-side only. So we gate the layout: until
 * zustand's persist middleware has rehydrated and confirmed a token,
 * render a tiny spinner. If no token after rehydration → redirect to
 * /login. This stops "see the dashboard shell while logged out" — which
 * was the actual bug — without flashing the login page for legitimate
 * sessions.
 *
 * The 401 path in api.ts is still there as a backstop for expired or
 * revoked tokens; this layer just prevents the cold-boot leak.
 *
 * The access token is now memory-only (never localStorage), so on a hard
 * reload we must `await sessionReady` — a silent refresh via the httpOnly
 * cookie — BEFORE deciding to bounce, otherwise a valid session flashes the
 * login page while the in-memory token is still empty.
 */
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { collapsed } = useSidebarStore();
  const router = useRouter();
  const accessToken = useAuthStore((s) => s.accessToken);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    // Wait for the cold-boot silent refresh (sessionReady) to settle before
    // deciding to render or bounce — the access token lives in memory only,
    // so a hard reload starts with accessToken===null even for a valid
    // session until the httpOnly-cookie refresh repopulates it.
    let active = true;
    void sessionReady.finally(() => {
      if (active) setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (hydrated && !accessToken) {
      router.replace('/login');
    }
  }, [hydrated, accessToken, router]);

  // First-run onboarding lives at /setup (full-screen, pre-dashboard) —
  // the old in-dashboard wizard popup is gone. A SUPERADMIN who created
  // the account but bailed out of /setup mid-flow (closed the tab, typed
  // /dashboard by hand) is sent back there. The zero-projects condition
  // keeps pre-existing installs out: an admin who configured everything
  // before this flow existed (flag never flipped) must not be bounced
  // into setup on a working install.
  const user = useAuthStore((s) => s.user);
  const onboardingEnabled = hydrated && !!accessToken && user?.role === 'SUPERADMIN';
  const { data: onboarding } = useQuery<{ completed: boolean }>({
    queryKey: ['onboarding'],
    queryFn: () => api.get('/auth/me/onboarding'),
    enabled: onboardingEnabled,
    staleTime: 60_000,
  });
  const { data: projects } = useProjects<unknown[]>({
    enabled: onboardingEnabled && onboarding?.completed === false,
    staleTime: 60_000,
  });
  useEffect(() => {
    if (onboarding?.completed === false && Array.isArray(projects) && projects.length === 0) {
      router.replace('/setup');
    }
  }, [onboarding, projects, router]);

  if (!hydrated || !accessToken) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <Header />
      <main
        className={cn(
          'min-h-[calc(100vh-4rem)] p-6 transition-all duration-300',
          collapsed ? 'ml-16' : 'ml-64',
        )}
      >
        {children}
      </main>
    </div>
  );
}
