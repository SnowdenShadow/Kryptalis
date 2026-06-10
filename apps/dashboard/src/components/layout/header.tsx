'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { User, LogOut, Bell } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { useAuthStore, useSidebarStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { makeTimeAgo } from '@/lib/app-format';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * Header bell backed by the in-app notification feed (GET /notifications).
 * Badge polls /notifications/unread-count every 30 s; the list itself is
 * only fetched while the popover is open. No new dependency — the popover
 * is a plain absolutely-positioned Card with outside-click/Escape closing.
 */
function NotificationBell() {
  const { t } = useTranslation();
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const timeAgo = useMemo(
    () =>
      makeTimeAgo(t, {
        just: 'notif.timeJust',
        min: 'notif.timeMin',
        hour: 'notif.timeHour',
        day: 'notif.timeDay',
      }),
    [t],
  );

  const { data: unread } = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: () => api.get<{ count: number }>('/notifications/unread-count'),
    refetchInterval: 30_000,
  });

  const { data: items } = useQuery({
    queryKey: ['notifications', 'list'],
    queryFn: () => api.get<NotificationItem[]>('/notifications?take=20'),
    enabled: open,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: invalidate,
  });

  // Close on outside click / Escape — standard popover hygiene.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const count = unread?.count ?? 0;

  const handleItemClick = (n: NotificationItem) => {
    if (!n.readAt) markRead.mutate(n.id);
    if (n.link) {
      setOpen(false);
      router.push(n.link);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        onClick={() => setOpen((o) => !o)}
        title={t('notif.title') || 'Notifications'}
        aria-label={t('notif.open') || 'Open notifications'}
      >
        <Bell size={18} />
        {count > 0 && (
          <Badge
            variant="destructive"
            className="absolute -right-0.5 -top-0.5 h-4 min-w-4 justify-center px-1 text-[10px] leading-none"
          >
            {count > 99 ? '99+' : count}
          </Badge>
        )}
      </Button>

      {open && (
        <Card className="absolute right-0 top-full z-50 mt-2 w-96 overflow-hidden p-0 shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold">{t('notif.title')}</span>
            {count > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
              >
                {t('notif.markAllRead')}
              </Button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {!items || items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                {t('notif.empty')}
              </p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => handleItemClick(n)}
                  className={cn(
                    'flex w-full items-start gap-3 border-b border-border px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent',
                    !n.readAt && 'bg-accent/40',
                  )}
                >
                  <span
                    className={cn(
                      'mt-1.5 h-2 w-2 shrink-0 rounded-full',
                      n.readAt ? 'bg-transparent' : 'bg-primary',
                    )}
                    aria-label={n.readAt ? undefined : t('notif.unread')}
                  />
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-sm', !n.readAt && 'font-medium')}>
                      {n.title}
                    </span>
                    {n.body && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {n.body}
                      </span>
                    )}
                    <span className="block text-xs text-muted-foreground/70">
                      {timeAgo(n.createdAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

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
      {/* Search (Ctrl+K) was decorative-only — removed rather than shipping
          dead UI; reintroduce alongside the real feature. */}
      <div className="flex items-center gap-4" />

      <div className="flex items-center gap-2">
        <NotificationBell />

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
