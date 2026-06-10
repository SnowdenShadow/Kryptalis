'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users, Settings, Activity, ShieldAlert, Crown, Shield, Eye, Search,
  Trash2, UserPlus, Ban, KeyRound, RefreshCw, AlertTriangle, Lock, LockOpen,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { makeTimeAgo } from '@/lib/app-format';
import { SystemConfigTab } from './system-config-tab';
import { InfrastructureTab } from './infrastructure-tab';
import { UpdatesTab } from './updates-tab';

type Role = 'SUPERADMIN' | 'ADMIN' | 'USER' | 'VIEWER';
type Status = 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'PENDING_VERIFICATION' | 'PENDING_APPROVAL';

interface AdminUser {
  id: string; name: string; email: string; role: Role; status: Status;
  twoFactorEnabled: boolean; lastLoginAt: string | null; createdAt: string;
  _count: { projects: number; memberships: number; gitProviders: number; deployments: number };
}

interface AuditLog {
  id: string; action: string; resource: string; resourceId: string | null;
  details: any; ipAddress: string | null; createdAt: string;
  user: { id: string; email: string; name: string } | null;
}

interface Overview {
  totals: {
    users: number; projects: number; apps: number; deployments: number;
    gitProviders: number; runningApps: number; errorApps: number; dau: number;
  };
  recentSignups: { id: string; name: string; email: string; status: Status; createdAt: string }[];
}

type Tab = 'overview' | 'users' | 'settings' | 'system' | 'updates' | 'infrastructure' | 'audit';

const ROLE_BADGE: Record<Role, { variant: 'success' | 'warning' | 'secondary' | 'outline'; icon: typeof Crown }> = {
  SUPERADMIN: { variant: 'success', icon: Crown },
  ADMIN: { variant: 'warning', icon: Shield },
  USER: { variant: 'secondary', icon: Users },
  VIEWER: { variant: 'outline', icon: Eye },
};

const STATUS_BADGE: Record<Status, 'success' | 'warning' | 'destructive' | 'outline'> = {
  ACTIVE: 'success', SUSPENDED: 'warning', BANNED: 'destructive',
  PENDING_VERIFICATION: 'outline',
  // Signups gated by the `require_admin_approval` setting — admins flip
  // these to ACTIVE from the edit dialog or the reactivate button.
  PENDING_APPROVAL: 'warning',
};

// Shared formatter, parameterized with this page's translation keys.
const makeAdminTimeAgo = (t: (k: string, v?: Record<string, string | number>) => string) =>
  makeTimeAgo(t, {
    just: 'admin.timeJustNow',
    min: 'admin.timeMinAgo',
    hour: 'admin.timeHourAgo',
    day: 'admin.timeDayAgo',
    never: 'admin.timeNever',
  });

export default function AdminPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const router = useRouter();
  const me = useAuthStore((s) => s.user);
  const timeAgo = useMemo(() => makeAdminTimeAgo(t), [t]);

  // Client-side role guard. Backend still enforces RBAC on every endpoint.
  // IMPORTANT: this must NOT early-return before the hooks below — on first
  // render `me` is null (zustand rehydration) so every hook runs; a later
  // render with a non-admin `me` would then call fewer hooks and React
  // throws "Rendered fewer hooks than expected". Redirect via effect and
  // gate rendering AFTER all hooks instead.
  const isAdmin = me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';
  const accessDenied = !!me && !isAdmin;
  useEffect(() => {
    if (accessDenied) {
      toast.error(t('admin.restricted'));
      router.replace('/dashboard');
    }
  }, [accessDenied, router, t]);

  // ── Overview ─────────────────────────────────────────────────────
  const { data: overview } = useQuery<Overview>({
    queryKey: ['admin-overview'],
    queryFn: () => api.get('/admin/overview'),
    refetchInterval: 15000,
    enabled: isAdmin,
  });

  // ── Users ────────────────────────────────────────────────────────
  const [userSearch, setUserSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<Role | ''>('');
  const [statusFilter, setStatusFilter] = useState<Status | ''>('');

  // Debounced copy used in the queryKey — typing previously fired one
  // /admin/users request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(userSearch), 300);
    return () => clearTimeout(handle);
  }, [userSearch]);

  const { data: usersData } = useQuery<{ total: number; users: AdminUser[] }>({
    queryKey: ['admin-users', debouncedSearch, roleFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (roleFilter) params.set('role', roleFilter);
      if (statusFilter) params.set('status', statusFilter);
      return api.get(`/admin/users?${params}`);
    },
    enabled: isAdmin && activeTab === 'users',
  });

  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  // Confirmation dialogs (replace the old native confirm() calls).
  const [confirmDeleteUser, setConfirmDeleteUser] = useState(false);
  const [pendingDeployMode, setPendingDeployMode] = useState<string | null>(null);
  const [resetPwUser, setResetPwUser] = useState<AdminUser | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newUser, setNewUser] = useState({ name: '', email: '', password: '', role: 'USER' as Role });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: Role }) =>
      api.patch(`/admin/users/${id}/role`, { role }),
    onSuccess: (_data, vars) => {
      toast.success(t('admin.roleUpdated'));
      // Keep the dialog state in sync — the selects are controlled by
      // editUser, so a failed mutation snaps back to the server value.
      setEditUser((u) => (u && u.id === vars.id ? { ...u, role: vars.role } : u));
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Status }) =>
      api.patch(`/admin/users/${id}/status`, { status }),
    onSuccess: (_data, vars) => {
      toast.success(t('admin.statusUpdated'));
      setEditUser((u) => (u && u.id === vars.id ? { ...u, status: vars.status } : u));
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetPwMutation = useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.post(`/admin/users/${id}/reset-password`, { password }),
    onSuccess: () => {
      toast.success(t('admin.pwResetSuccess'));
      setResetPwUser(null);
      setResetPwValue('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteUserMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/users/${id}`),
    onSuccess: () => {
      toast.success(t('admin.userDeleted'));
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setConfirmDeleteUser(false);
      setEditUser(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const createUserMutation = useMutation({
    mutationFn: () => api.post('/admin/users', newUser),
    onSuccess: () => {
      toast.success(t('admin.userCreated'));
      setCreateOpen(false);
      setNewUser({ name: '', email: '', password: '', role: 'USER' });
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Settings ─────────────────────────────────────────────────────
  const { data: settings } = useQuery<Record<string, unknown>>({
    queryKey: ['admin-settings'],
    queryFn: () => api.get('/admin/settings'),
    enabled: activeTab === 'settings',
  });
  const updateSettingMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) =>
      api.patch(`/admin/settings/${key}`, { value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      setPendingDeployMode(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Audit ────────────────────────────────────────────────────────
  const { data: auditData } = useQuery<{ total: number; logs: AuditLog[] }>({
    queryKey: ['admin-audit'],
    queryFn: () => api.get('/admin/audit-logs?take=100'),
    enabled: activeTab === 'audit',
  });

  const TABS: { id: Tab; label: string; icon: typeof Users }[] = [
    { id: 'overview', label: t('admin.tab.overview'), icon: Activity },
    { id: 'users', label: t('admin.tab.users'), icon: Users },
    { id: 'settings', label: t('admin.tab.settings'), icon: Settings },
    { id: 'system', label: t('admin.tab.system'), icon: Settings },
    { id: 'infrastructure', label: t('admin.tab.infrastructure'), icon: Activity },
    { id: 'updates', label: t('admin.tab.updates'), icon: RefreshCw },
    { id: 'audit', label: t('admin.tab.audit'), icon: ShieldAlert },
  ];

  const RoleBadge = ({ role }: { role: Role }) => {
    const meta = ROLE_BADGE[role];
    const Icon = meta.icon;
    return (
      <Badge variant={meta.variant} className="gap-1 text-[10px]">
        <Icon size={10} /> {role}
      </Badge>
    );
  };

  // All hooks have run — safe to bail out now (redirect happens in effect).
  if (!isAdmin) return null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <ShieldAlert size={26} className="text-primary" />
        <h1 className="text-3xl font-bold">{t('admin.title')}</h1>
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map(tab => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon size={14} /> {tab.label}
            </button>
          );
        })}
      </div>

      {/* ─────────────── Overview ─────────────── */}
      {activeTab === 'overview' && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: t('admin.totalUsers'), value: overview?.totals.users ?? '—', color: 'text-primary' },
              { label: t('admin.activeDay'), value: overview?.totals.dau ?? '—', color: 'text-emerald-500' },
              { label: t('admin.totalProjects'), value: overview?.totals.projects ?? '—' },
              { label: t('admin.totalApps'), value: overview?.totals.apps ?? '—' },
              { label: t('admin.runningApps'), value: overview?.totals.runningApps ?? '—', color: 'text-emerald-500' },
              { label: t('admin.errorApps'), value: overview?.totals.errorApps ?? '—', color: 'text-red-500' },
              { label: t('admin.totalDeployments'), value: overview?.totals.deployments ?? '—' },
              { label: t('admin.totalProviders'), value: overview?.totals.gitProviders ?? '—' },
            ].map(s => (
              <div key={s.label} className="rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className={cn('text-2xl font-bold', s.color)}>{s.value}</p>
              </div>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('admin.recentSignups')}</CardTitle>
              <CardDescription>{t('admin.recentSignupsDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {overview?.recentSignups?.length === 0 && (
                  <p className="text-sm text-muted-foreground">{t('admin.noSignups')}</p>
                )}
                {overview?.recentSignups?.map(u => (
                  <div key={u.id} className="flex items-center justify-between rounded-md border border-border p-3">
                    <div>
                      <p className="font-medium text-sm">{u.name}</p>
                      <p className="text-xs text-muted-foreground">{u.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_BADGE[u.status]} className="text-[10px]">{u.status}</Badge>
                      <span className="text-xs text-muted-foreground">{timeAgo(u.createdAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─────────────── Users ─────────────── */}
      {activeTab === 'users' && (
        <div className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[220px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder={t('admin.searchUser')} value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)} />
            </div>
            <Select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as Role | '')} className="w-40 h-9">
              <option value="">{t('admin.allRoles')}</option>
              <option value="SUPERADMIN">SUPERADMIN</option>
              <option value="ADMIN">ADMIN</option>
              <option value="USER">USER</option>
              <option value="VIEWER">VIEWER</option>
            </Select>
            <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as Status | '')} className="w-40 h-9">
              <option value="">{t('admin.allStatuses')}</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="SUSPENDED">SUSPENDED</option>
              <option value="BANNED">BANNED</option>
              <option value="PENDING_VERIFICATION">PENDING_VERIFICATION</option>
              <option value="PENDING_APPROVAL">PENDING_APPROVAL</option>
            </Select>
            <Button onClick={() => setCreateOpen(true)}><UserPlus size={14} /> {t('admin.createUser')}</Button>
          </div>

          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/30">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">{t('admin.user')}</th>
                    <th className="px-4 py-2 font-medium">{t('admin.role')}</th>
                    <th className="px-4 py-2 font-medium">{t('admin.status')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('admin.resources')}</th>
                    <th className="px-4 py-2 font-medium">{t('admin.lastLogin')}</th>
                    <th className="px-4 py-2 font-medium text-right">{t('admin.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {usersData?.users?.map(u => (
                    <tr key={u.id} className="border-b last:border-0 hover:bg-accent/30">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <div>
                            <p className="font-medium">{u.name}</p>
                            <p className="text-xs text-muted-foreground">{u.email}</p>
                          </div>
                          {u.twoFactorEnabled && (
                            <Badge variant="outline" className="text-[10px] gap-1">
                              <Lock size={9} /> 2FA
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-2.5"><RoleBadge role={u.role} /></td>
                      <td className="px-4 py-2.5">
                        <Badge variant={STATUS_BADGE[u.status]} className="text-[10px]">{u.status}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">
                        {u._count.projects}p · {u._count.memberships}m · {u._count.gitProviders}g
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{timeAgo(u.lastLoginAt)}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1">
                          <Button size="icon" variant="ghost" title={t('admin.editRole')} onClick={() => setEditUser(u)}>
                            <Shield size={14} />
                          </Button>
                          <Button size="icon" variant="ghost" title={t('admin.resetPw')} onClick={() => setResetPwUser(u)}>
                            <KeyRound size={14} />
                          </Button>
                          {u.status === 'ACTIVE' ? (
                            <Button size="icon" variant="ghost" title={t('admin.suspend')}
                              onClick={() => statusMutation.mutate({ id: u.id, status: 'SUSPENDED' })}>
                              <Ban size={14} />
                            </Button>
                          ) : (
                            <Button size="icon" variant="ghost" title={t('admin.reactivate')}
                              onClick={() => statusMutation.mutate({ id: u.id, status: 'ACTIVE' })}>
                              <LockOpen size={14} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {usersData?.users?.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-muted-foreground text-sm">{t('admin.noUsers')}</td></tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
          <p className="text-xs text-muted-foreground text-right">{t('admin.totalCount', { n: usersData?.total ?? 0 })}</p>
        </div>
      )}

      {/* ─────────────── Settings ─────────────── */}
      {activeTab === 'settings' && (
        <div className="space-y-3">
          {[
            {
              key: 'registration_enabled',
              label: t('admin.settings.registrationLabel'),
              desc: t('admin.settings.registrationDesc'),
              type: 'bool',
            },
            {
              key: 'require_admin_approval',
              label: t('admin.settings.approvalLabel'),
              desc: t('admin.settings.approvalDesc'),
              type: 'bool',
            },
            {
              key: 'maintenance_mode',
              label: t('admin.settings.maintenanceLabel'),
              desc: t('admin.settings.maintenanceDesc'),
              type: 'bool',
            },
            {
              key: 'platform_name',
              label: t('admin.settings.platformLabel'),
              desc: t('admin.settings.platformDesc'),
              type: 'text',
            },
            {
              key: 'default_user_role',
              label: t('admin.settings.defaultRoleLabel'),
              desc: t('admin.settings.defaultRoleDesc'),
              type: 'role',
            },
            {
              key: 'deployment_mode',
              label: t('admin.settings.deployModeLabel'),
              desc: t('admin.settings.deployModeDesc'),
              type: 'deployMode',
            },
          ].map(s => {
            const val = settings?.[s.key];
            return (
              <Card key={s.key}>
                <CardContent className="flex items-center justify-between gap-4 p-4">
                  <div className="flex-1">
                    <p className="font-medium">{s.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{s.desc}</p>
                  </div>
                  {s.type === 'bool' && (
                    <Button
                      variant={val ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => updateSettingMutation.mutate({ key: s.key, value: !val })}
                    >
                      {val ? t('common.enabled') : t('common.disabled')}
                    </Button>
                  )}
                  {s.type === 'text' && (
                    <Input
                      defaultValue={(val as string) ?? ''}
                      className="w-60"
                      onBlur={(e) => {
                        if (e.target.value !== val) {
                          updateSettingMutation.mutate({ key: s.key, value: e.target.value });
                        }
                      }}
                    />
                  )}
                  {s.type === 'role' && (
                    <Select
                      value={(val as string) ?? 'USER'}
                      onChange={(e) => updateSettingMutation.mutate({ key: s.key, value: e.target.value })}
                      className="w-40"
                    >
                      <option value="USER">USER</option>
                      <option value="VIEWER">VIEWER</option>
                    </Select>
                  )}
                  {s.type === 'deployMode' && (
                    <Select
                      value={(val as string) ?? 'LOCAL'}
                      onChange={(e) => {
                        if (e.target.value !== val) setPendingDeployMode(e.target.value);
                      }}
                      className="w-40"
                    >
                      <option value="LOCAL">LOCAL</option>
                      <option value="MULTI">MULTI</option>
                    </Select>
                  )}
                </CardContent>
              </Card>
            );
          })}

          {settings?.maintenance_mode === true && (
            <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
              <AlertTriangle size={18} className="text-orange-500 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-semibold">{t('admin.settings.maintenanceActive')}</p>
                <p className="text-muted-foreground mt-1">{t('admin.settings.maintenanceWarn')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─────────────── System config ─────────────── */}
      {activeTab === 'system' && <SystemConfigTab />}

      {/* ─────────────── Infrastructure (LOCAL/MULTI) ─────────────── */}
      {activeTab === 'infrastructure' && <InfrastructureTab />}

      {/* ─────────────── System Updates ─────────────── */}
      {activeTab === 'updates' && <UpdatesTab />}

      {/* ─────────────── Audit ─────────────── */}
      {activeTab === 'audit' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('admin.audit.title')}</CardTitle>
            <CardDescription>{t('admin.audit.desc')}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {auditData?.logs?.length === 0 ? (
              <p className="px-4 py-8 text-center text-muted-foreground text-sm">{t('admin.audit.none')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-muted/30">
                  <tr className="text-left text-muted-foreground">
                    <th className="px-4 py-2 font-medium">{t('admin.audit.user')}</th>
                    <th className="px-4 py-2 font-medium">{t('admin.audit.action')}</th>
                    <th className="px-4 py-2 font-medium">{t('admin.audit.resource')}</th>
                    <th className="px-4 py-2 font-medium">{t('admin.audit.ip')}</th>
                    <th className="px-4 py-2 font-medium">{t('admin.audit.when')}</th>
                  </tr>
                </thead>
                <tbody>
                  {auditData?.logs?.map(l => (
                    <tr key={l.id} className="border-b last:border-0">
                      <td className="px-4 py-2 text-xs">{l.user?.email ?? <span className="text-muted-foreground italic">{t('admin.audit.system')}</span>}</td>
                      <td className="px-4 py-2 text-xs font-mono">{l.action}</td>
                      <td className="px-4 py-2 text-xs font-mono">{l.resource}{l.resourceId ? `/${l.resourceId.slice(0, 8)}` : ''}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{l.ipAddress ?? '—'}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{timeAgo(l.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── Edit role dialog ─── */}
      <Dialog open={!!editUser} onClose={() => setEditUser(null)}>
        <DialogHeader>
          <DialogTitle>{t('admin.editUserTitle', { name: editUser?.name ?? '' })}</DialogTitle>
          <DialogDescription>{editUser?.email}</DialogDescription>
        </DialogHeader>
        {editUser && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>{t('common.role')}</Label>
              <Select
                value={editUser.role}
                onChange={(e) => roleMutation.mutate({ id: editUser.id, role: e.target.value as Role })}
              >
                <option value="VIEWER">VIEWER</option>
                <option value="USER">USER</option>
                <option value="ADMIN">ADMIN</option>
                <option value="SUPERADMIN">SUPERADMIN</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('common.status')}</Label>
              <Select
                value={editUser.status}
                onChange={(e) => statusMutation.mutate({ id: editUser.id, status: e.target.value as Status })}
              >
                <option value="ACTIVE">ACTIVE</option>
                <option value="SUSPENDED">SUSPENDED</option>
                <option value="BANNED">BANNED</option>
                <option value="PENDING_VERIFICATION">PENDING_VERIFICATION</option>
                <option value="PENDING_APPROVAL">PENDING_APPROVAL</option>
              </Select>
            </div>
            <div className="rounded-md border border-destructive/40 p-3">
              <p className="text-xs text-muted-foreground mb-2">{t('admin.deleteWarning')}</p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirmDeleteUser(true)}
              >
                <Trash2 size={14} /> {t('admin.deleteUser')}
              </Button>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditUser(null)}>{t('common.close')}</Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Delete user confirmation (replaces native confirm) ─── */}
      <Dialog open={confirmDeleteUser && !!editUser} onClose={() => setConfirmDeleteUser(false)}>
        <DialogHeader>
          <DialogTitle>{t('admin.deleteUser')}</DialogTitle>
          <DialogDescription>
            {t('admin.deleteUserConfirm', { email: editUser?.email ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmDeleteUser(false)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={deleteUserMutation.isPending}
            onClick={() => editUser && deleteUserMutation.mutate(editUser.id)}
          >
            <Trash2 size={14} /> {deleteUserMutation.isPending ? t('common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Deployment-mode change confirmation (replaces native confirm) ─── */}
      <Dialog open={!!pendingDeployMode} onClose={() => setPendingDeployMode(null)}>
        <DialogHeader>
          <DialogTitle>{t('admin.settings.deployModeTitle')}</DialogTitle>
          <DialogDescription>
            {t('admin.settings.deployModeConfirm', { mode: pendingDeployMode ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPendingDeployMode(null)}>{t('common.cancel')}</Button>
          <Button
            disabled={updateSettingMutation.isPending}
            onClick={() => pendingDeployMode && updateSettingMutation.mutate({ key: 'deployment_mode', value: pendingDeployMode })}
          >
            {t('common.confirm')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Reset password dialog ─── */}
      <Dialog open={!!resetPwUser} onClose={() => { setResetPwUser(null); setResetPwValue(''); }}>
        <DialogHeader>
          <DialogTitle>{t('admin.resetPwTitle', { name: resetPwUser?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('admin.resetPwDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>{t('admin.newPw')}</Label>
          <Input
            type="text"
            value={resetPwValue}
            onChange={(e) => setResetPwValue(e.target.value)}
            placeholder={t('admin.newPwPlaceholder')}
            className="font-mono"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setResetPwUser(null); setResetPwValue(''); }}>{t('common.cancel')}</Button>
          <Button
            disabled={!resetPwValue || resetPwValue.length < 8 || resetPwMutation.isPending}
            onClick={() => resetPwUser && resetPwMutation.mutate({ id: resetPwUser.id, password: resetPwValue })}
          >
            <RefreshCw size={14} /> {resetPwMutation.isPending ? t('admin.resetting') : t('admin.resetAndRevoke')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Create user dialog ─── */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)}>
        <DialogHeader>
          <DialogTitle>{t('admin.createUser')}</DialogTitle>
          <DialogDescription>{t('admin.createUserDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2"><Label>{t('common.name')}</Label>
            <Input value={newUser.name} onChange={(e) => setNewUser(u => ({ ...u, name: e.target.value }))} />
          </div>
          <div className="space-y-2"><Label>{t('common.email')}</Label>
            <Input type="email" value={newUser.email} onChange={(e) => setNewUser(u => ({ ...u, email: e.target.value }))} />
          </div>
          <div className="space-y-2"><Label>{t('auth.password')}</Label>
            <Input type="text" className="font-mono" value={newUser.password} onChange={(e) => setNewUser(u => ({ ...u, password: e.target.value }))} />
          </div>
          <div className="space-y-2"><Label>{t('common.role')}</Label>
            <Select value={newUser.role} onChange={(e) => setNewUser(u => ({ ...u, role: e.target.value as Role }))}>
              <option value="VIEWER">VIEWER</option>
              <option value="USER">USER</option>
              <option value="ADMIN">ADMIN</option>
              <option value="SUPERADMIN">SUPERADMIN</option>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
          <Button
            disabled={!newUser.email || !newUser.password || newUser.password.length < 8 || createUserMutation.isPending}
            onClick={() => createUserMutation.mutate()}
          >
            {createUserMutation.isPending ? t('common.creating') : t('common.create')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
