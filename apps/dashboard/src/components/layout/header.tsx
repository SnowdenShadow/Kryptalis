'use client';

import { User, LogOut } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useAuthStore, useSidebarStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const { collapsed } = useSidebarStore();
  const router = useRouter();
  const qc = useQueryClient();

  /**
   * Logout flow:
   *   1. POST /auth/logout — the httpOnly refresh cookie rides along
   *      automatically (the api client sends credentials:'include' on
   *      /auth/*), the server revokes the whole family and clears the
   *      cookie — a stolen token elsewhere is now dead.
   *   2. Clear local storage + zustand auth state.
   *   3. Wipe the react-query cache so the next user on this browser
   *      doesn't see the previous user's data flash.
   *   4. Bounce to /login.
   *
   * The server call is fire-and-forget (catch the throw) — we don't block
   * the UI on a slow network when the user is leaving.
   */
  const handleLogout = async () => {
    try {
      await api.post('/auth/logout', {});
    } catch {}
    logout();
    qc.clear();
    router.push('/login');
  };

  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60 transition-all duration-300',
        collapsed ? 'ml-16' : 'ml-64',
      )}
    >
      {/* Search (Ctrl+K) and the notification bell were decorative-only —
          no handler, no notification system. Removed rather than shipping
          dead UI; reintroduce alongside the real features. */}
      <div className="flex items-center gap-4" />

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5">
          <User size={16} className="text-muted-foreground" />
          <span className="text-sm">{user?.name || 'User'}</span>
        </div>

        <Button variant="ghost" size="icon" onClick={handleLogout} title={t('common.logout') || 'Log out'}>
          <LogOut size={18} />
        </Button>
      </div>
    </header>
  );
}
