'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { useSidebarStore, useAuthStore } from '@/lib/store';
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
    // After zustand's persist has had a chance to rehydrate from localStorage
    // (synchronously by next tick) decide whether to render or bounce.
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated && !accessToken) {
      router.replace('/login');
    }
  }, [hydrated, accessToken, router]);

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
