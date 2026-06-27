'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Server,
  FolderKanban,
  Rocket,
  Globe,
  Container,
  Database,
  Activity,
  Archive,
  Store,
  Mail,
  FolderOpen,
  KeyRound,
  Settings,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  Clock,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { useSidebarStore, useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { api } from '@/lib/api';
import { useApplications, usePublicSettings } from '@/lib/hooks';

type NavBadge = 'applications' | 'servers';

const navigation: Array<{
  key: string;
  href: string;
  icon: typeof LayoutDashboard;
  multiOnly?: boolean;
  adminOnly?: boolean;
  badge?: NavBadge;
}> = [
  { key: 'nav.overview', href: '/dashboard', icon: LayoutDashboard },
  { key: 'nav.server', href: '/dashboard/servers', icon: Server, multiOnly: true, adminOnly: true, badge: 'servers' },
  { key: 'nav.projects', href: '/dashboard/projects', icon: FolderKanban },
  { key: 'nav.applications', href: '/dashboard/applications', icon: Rocket, badge: 'applications' },
  { key: 'nav.php', href: '/dashboard/php', icon: FileCode2 },
  { key: 'nav.cron', href: '/dashboard/cron', icon: Clock },
  { key: 'nav.domains', href: '/dashboard/domains', icon: Globe },
  // Docker (@Roles on /docker) and Monitoring (/servers/local*) are
  // admin-only API surfaces — hide them from regular users.
  { key: 'nav.docker', href: '/dashboard/docker', icon: Container, adminOnly: true },
  { key: 'nav.databases', href: '/dashboard/databases', icon: Database },
  { key: 'nav.monitoring', href: '/dashboard/monitoring', icon: Activity, adminOnly: true },
  { key: 'nav.backups', href: '/dashboard/backups', icon: Archive },
  { key: 'nav.marketplace', href: '/dashboard/marketplace', icon: Store },
  { key: 'nav.emails', href: '/dashboard/emails', icon: Mail },
  { key: 'nav.files', href: '/dashboard/files', icon: FolderOpen },
  { key: 'nav.sftp', href: '/dashboard/sftp', icon: KeyRound },
  { key: 'nav.settings', href: '/dashboard/settings', icon: Settings },
];

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN']);

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebarStore();
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const isAdmin = user?.role && ADMIN_ROLES.has(user.role);
  const { data: publicSettings } = usePublicSettings<{ deployment_mode?: string }>({
    staleTime: 60_000,
  });
  const isMulti = publicSettings?.deployment_mode === 'MULTI';

  // Live count badges. /applications is already per-user sanitized.
  // /servers is admin-only; non-admins use the sanitized /servers/mine.
  const serversEndpoint = isAdmin ? '/servers' : '/servers/mine';
  const { data: applications, isLoading: appsLoading } = useApplications<Array<{ status?: string }>>({
    staleTime: 15_000,
  });
  const { data: servers, isLoading: serversLoading } = useQuery<Array<{ status?: string }>>({
    queryKey: ['servers', isAdmin ? 'all' : 'mine'],
    queryFn: () => api.get(serversEndpoint),
    staleTime: 15_000,
  });

  const runningAppsCount = Array.isArray(applications)
    ? applications.filter((a) => a?.status === 'RUNNING').length
    : 0;
  const onlineServersCount = Array.isArray(servers)
    ? servers.filter((s) => s?.status === 'ONLINE').length
    : 0;

  const badgeCount = (badge: NavBadge | undefined): number | null => {
    if (!badge) return null;
    if (badge === 'applications') {
      if (appsLoading) return null;
      return runningAppsCount > 0 ? runningAppsCount : null;
    }
    if (badge === 'servers') {
      if (serversLoading) return null;
      return onlineServersCount > 0 ? onlineServersCount : null;
    }
    return null;
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-300',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-4">
        {!collapsed && (
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-bold">
              K
            </div>
            <span className="text-lg font-bold">DockControl</span>
          </Link>
        )}
        <button
          onClick={toggle}
          className="rounded-md p-1.5 hover:bg-accent"
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {navigation.map((item) => {
          if (item.multiOnly && !isMulti) return null;
          if (item.adminOnly && !isAdmin) return null;
          const isActive =
            item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href);
          const count = badgeCount(item.badge);

          return (
            <Link
              key={item.key}
              href={item.href}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                collapsed && 'justify-center px-2',
              )}
              title={collapsed ? t(item.key) : undefined}
            >
              <item.icon size={20} />
              {!collapsed && (
                <>
                  <span className="flex-1">{t(item.key)}</span>
                  {count !== null && (
                    <span className="ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      {count}
                    </span>
                  )}
                </>
              )}
            </Link>
          );
        })}

        {isAdmin && (
          <>
            {!collapsed && (
              <div className="px-3 pt-4 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                {t('nav.admin')}
              </div>
            )}
            <Link
              href="/dashboard/admin"
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                pathname.startsWith('/dashboard/admin')
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                collapsed && 'justify-center px-2',
              )}
              title={collapsed ? t('nav.admin') : undefined}
            >
              <ShieldAlert size={20} />
              {!collapsed && <span>{t('nav.admin')}</span>}
            </Link>
          </>
        )}
      </nav>

    </aside>
  );
}
