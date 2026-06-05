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
  Settings,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSidebarStore, useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';

const navigation = [
  { key: 'nav.overview', href: '/dashboard', icon: LayoutDashboard },
  { key: 'nav.server', href: '/dashboard/servers', icon: Server },
  { key: 'nav.projects', href: '/dashboard/projects', icon: FolderKanban },
  { key: 'nav.applications', href: '/dashboard/applications', icon: Rocket },
  { key: 'nav.domains', href: '/dashboard/domains', icon: Globe },
  { key: 'nav.docker', href: '/dashboard/docker', icon: Container },
  { key: 'nav.databases', href: '/dashboard/databases', icon: Database },
  { key: 'nav.monitoring', href: '/dashboard/monitoring', icon: Activity },
  { key: 'nav.backups', href: '/dashboard/backups', icon: Archive },
  { key: 'nav.marketplace', href: '/dashboard/marketplace', icon: Store },
  { key: 'nav.emails', href: '/dashboard/emails', icon: Mail },
  { key: 'nav.files', href: '/dashboard/files', icon: FolderOpen },
  { key: 'nav.settings', href: '/dashboard/settings', icon: Settings },
];

const ADMIN_ROLES = new Set(['ADMIN', 'SUPERADMIN']);

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebarStore();
  const { user } = useAuthStore();
  const { t } = useTranslation();
  const isAdmin = user?.role && ADMIN_ROLES.has(user.role);

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
            <span className="text-lg font-bold">Kryptalis</span>
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
          const isActive =
            item.href === '/dashboard'
              ? pathname === '/dashboard'
              : pathname.startsWith(item.href);

          return (
            <Link
              key={t(item.key)}
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
              {!collapsed && <span>{t(item.key)}</span>}
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
