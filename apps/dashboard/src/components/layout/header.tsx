'use client';

import { Bell, Search, User, LogOut } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
   *   1. POST /auth/logout with the current refreshToken so the server
   *      revokes the whole family — a stolen token elsewhere is now dead.
   *   2. Clear local storage + zustand auth state.
   *   3. Wipe the react-query cache so the next user on this browser
   *      doesn't see the previous user's data flash.
   *   4. Bounce to /login.
   *
   * The server call is fire-and-forget (catch the throw) — we don't block
   * the UI on a slow network when the user is leaving.
   */
  const handleLogout = async () => {
    const refreshToken =
      typeof window !== 'undefined' ? localStorage.getItem('refreshToken') : null;
    if (refreshToken) {
      try {
        await api.post('/auth/logout', { refreshToken });
      } catch {}
    }
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
      <div className="flex items-center gap-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={`${t('common.search')}... (Ctrl+K)`}
            className="w-64 pl-9"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="relative">
          <Bell size={20} />
          <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-destructive" />
        </Button>

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
