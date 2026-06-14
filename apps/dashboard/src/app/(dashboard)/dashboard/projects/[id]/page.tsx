'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Trash2, Server, Rocket, Plus, ExternalLink, Store,
  FolderKanban, Activity, Users, Shield, Crown, UserPlus, Loader2,
  ArrowRightLeft, AlertTriangle, Network, Database, Copy, Check, Info,
  HardDrive, Download,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import type { ProjectResponse } from '@dockcontrol/types';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  STATUS_COLOR,
  STATUS_VARIANT,
  FRAMEWORK_LABELS as FW,
  makeTimeAgo,
  publicAppUrl,
} from '@/lib/app-format';

type Role = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER';
const ROLE_RANK: Record<Role, number> = { OWNER: 100, ADMIN: 80, DEVELOPER: 50, VIEWER: 10 };
function has(role: Role | undefined, min: Role) {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

const ROLE_BADGE: Record<Role, { variant: 'success' | 'warning' | 'secondary' | 'outline'; icon: typeof Crown }> = {
  OWNER: { variant: 'success', icon: Crown },
  ADMIN: { variant: 'warning', icon: Shield },
  DEVELOPER: { variant: 'secondary', icon: Users },
  VIEWER: { variant: 'outline', icon: Users },
};

// Shared API resource type — local alias keeps the diff/readability small.
type Project = ProjectResponse;

interface Member {
  id: string; role: Role; createdAt: string;
  user: { id: string; name: string; email: string };
}

// STATUS_COLOR / STATUS_VARIANT / FW / publicAppUrl / makeTimeAgo come
// from @/lib/app-format.

type Tab = 'overview' | 'applications' | 'mesh' | 'members' | 'settings';

interface MeshNode {
  id: string;
  name: string;
  kind: 'app' | 'database';
  host: string;
  port: number;
  url: string;
  status?: string;
  framework?: string;
  dbType?: string;
  username?: string;
}
interface MeshEnvSuggestion {
  from: { id: string; name: string };
  to: { id: string; name: string };
  envVar: string;
  value: string;
}
interface ServiceMesh {
  projectId: string;
  networkName: string;
  apps: MeshNode[];
  databases: MeshNode[];
  envSuggestions: MeshEnvSuggestion[];
  hint: string;
}

export default function ProjectDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [showDelete, setShowDelete] = useState(false);
  const [showMigrate, setShowMigrate] = useState(false);
  const [migrateTargetId, setMigrateTargetId] = useState('');
  const [migrateIncludePinned, setMigrateIncludePinned] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportIncludeData, setExportIncludeData] = useState(false);
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportConfirm, setExportConfirm] = useState('');
  const timeAgo = useMemo(
    () =>
      makeTimeAgo(t, {
        just: 'projects.timeJust',
        min: 'projects.timeMin',
        hour: 'projects.timeHour',
        day: 'projects.timeDay',
      }),
    [t],
  );

  const { data: publicSettings } = useQuery<{ deployment_mode?: string; public_ip?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
    staleTime: 60_000,
  });
  const isMulti = publicSettings?.deployment_mode === 'MULTI';
  // Direct-IP app links use the server's address, not the panel's hostname.
  const serverIp = publicSettings?.public_ip && publicSettings.public_ip !== 'localhost'
    ? publicSettings.public_ip
    : undefined;

  const { data: servers = [] } = useQuery<{ id: string; name: string; host: string; status: string }[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/servers'),
    enabled: isMulti,
  });

  const {
    data: project,
    isLoading,
    isError: projectError,
    error: projectErrorObj,
    refetch: refetchProject,
  } = useQuery<Project>({
    queryKey: ['project', id],
    queryFn: () => api.get(`/projects/${id}`),
    enabled: !!id,
    retry: (failureCount, err) =>
      !(err instanceof ApiError && err.status === 404) && failureCount < 2,
  });
  const myRole = project?.currentRole;

  // Always fetched (it's a light list) so the members badge count is right
  // even before the tab is opened.
  const { data: members = [] } = useQuery<Member[]>({
    queryKey: ['project-members', id],
    queryFn: () => api.get(`/projects/${id}/members`),
    enabled: !!id,
  });

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('projects.tab.overview') },
    { id: 'applications', label: t('projects.tab.applications') },
    { id: 'mesh', label: t('projects.tab.mesh') },
    { id: 'members', label: t('projects.tab.members') },
    { id: 'settings', label: t('projects.tab.settings') },
  ];

  const {
    data: mesh,
    isLoading: meshLoading,
    isError: meshError,
    refetch: refetchMesh,
  } = useQuery<ServiceMesh>({
    queryKey: ['project-mesh', id],
    queryFn: () => api.get(`/projects/${id}/mesh`),
    enabled: !!id && activeTab === 'mesh',
  });

  // navigator.clipboard rejects on non-secure (plain HTTP) origins — fall
  // back to the hidden-textarea trick so copy still works on LAN installs.
  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    }
  }

  const [copiedMesh, setCopiedMesh] = useState('');
  async function copyMesh(text: string, key: string) {
    const ok = await copyText(text);
    if (ok) {
      setCopiedMesh(key);
      toast.success(t('toast.copied'));
      setTimeout(() => setCopiedMesh(''), 1200);
    } else {
      toast.error(t('toast.failedToCopy'));
    }
  }

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('toast.projectDeleted'));
      router.push('/dashboard/projects');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const migrateMutation = useMutation({
    mutationFn: (targetServerId: string) =>
      api.post(`/projects/${id}/migrate`, { targetServerId, includePinned: migrateIncludePinned }) as Promise<{ status: string; message: string; queued: string[]; warnings: string[] }>,
    onSuccess: (data) => {
      // The backend now reports an honest status: 'ok' only when nothing
      // degraded, 'partial' when a transfer/teardown/deploy was imperfect,
      // 'failed' when it rolled back to the source. Surface it accordingly.
      if (data.status === 'failed') {
        toast.error(data.message);
      } else if (data.status === 'partial') {
        toast.warning(data.message);
      } else {
        toast.success(data.message);
      }
      // Show each concrete warning (mail stays on host, pinned apps, port
      // reassignment, volume notes) so a 'partial' isn't a silent surprise.
      for (const w of data.warnings || []) toast.warning(w);
      queryClient.invalidateQueries({ queryKey: ['project', id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowMigrate(false);
      setMigrateTargetId('');
      setMigrateIncludePinned(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Export project (.dctproj) ───────────────────────────────────────
  // Two-step: POST /export returns a one-shot download token, then a raw
  // GET streams the binary which we turn into a browser download. rawFetch
  // shares the auth/refresh pipeline (the bearer is added for us).
  const exportPassValid = exportPassphrase.length >= 12;
  const exportPassMatch = exportPassphrase === exportConfirm;
  const exportMutation = useMutation({
    mutationFn: async () => {
      const { downloadToken, filename } = await api.post<{ downloadToken: string; filename: string }>(
        `/projects/${id}/export`,
        { includeData: exportIncludeData, passphrase: exportPassphrase },
      );
      const res = await api.rawFetch(`/projects/transfer/download/${downloadToken}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      toast.success(t('projects.export.success'));
      setShowExport(false);
      setExportIncludeData(false);
      setExportPassphrase('');
      setExportConfirm('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Storage quota (Settings tab) ────────────────────────────────────
  // Usage is computed server-side from real on-disk bytes; quota edit is
  // platform-ADMIN only (PATCH /projects/:id/quota is @Roles-guarded).
  const me = useAuthStore((s) => s.user);
  const isPlatformAdmin = me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';
  const [quotaGiB, setQuotaGiB] = useState('');
  const { data: storageUsage } = useQuery<{ used: string; quota: string }>({
    queryKey: ['project-storage', id],
    queryFn: () => api.get(`/files/project/${id}/usage`),
    enabled: !!id && activeTab === 'settings',
  });
  const quotaMutation = useMutation({
    mutationFn: (bytes: string) => api.patch(`/projects/${id}/quota`, { quotaBytes: bytes }),
    onSuccess: () => {
      toast.success(t('projects.quotaSaved'));
      setQuotaGiB('');
      queryClient.invalidateQueries({ queryKey: ['project-storage', id] });
      queryClient.invalidateQueries({ queryKey: ['project', id] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const usedB = storageUsage ? Number(storageUsage.used) : 0;
  const quotaB = storageUsage ? Number(storageUsage.quota) : 0;
  const quotaPct = quotaB > 0 ? Math.min(100, (usedB / quotaB) * 100) : 0;
  const fmtGiB = (n: number) => `${(n / 1024 ** 3).toFixed(n >= 100 * 1024 ** 3 ? 0 : 2)} GiB`;
  const quotaGiBNumber = quotaGiB.trim() ? parseFloat(quotaGiB.trim()) : null;
  const quotaInputValid = quotaGiBNumber !== null && Number.isFinite(quotaGiBNumber) && quotaGiBNumber > 0 && quotaGiBNumber <= 100_000;

  // ── Member management ───────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState('');
  const [addRole, setAddRole] = useState<Role>('DEVELOPER');
  const addMemberMutation = useMutation({
    mutationFn: () => api.post(`/projects/${id}/members`, { email: addEmail, role: addRole }),
    onSuccess: () => {
      toast.success(t('toast.memberAdded'));
      setShowAdd(false);
      setAddEmail('');
      setAddRole('DEVELOPER');
      queryClient.invalidateQueries({ queryKey: ['project-members', id] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const changeRoleMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: Role }) =>
      api.patch(`/projects/${id}/members/${memberId}`, { role }),
    onSuccess: () => {
      toast.success(t('toast.roleUpdated'));
      queryClient.invalidateQueries({ queryKey: ['project-members', id] });
      queryClient.invalidateQueries({ queryKey: ['project', id] });
      setRoleChangeTarget(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => api.delete(`/projects/${id}/members/${memberId}`),
    onSuccess: () => {
      toast.success(t('toast.memberRemoved'));
      queryClient.invalidateQueries({ queryKey: ['project-members', id] });
      setRemoveTarget(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const transferOwnershipMutation = useMutation({
    mutationFn: (targetUserId: string) => api.post(`/projects/${id}/transfer-ownership`, { targetUserId }),
    onSuccess: () => {
      toast.success(t('toast.ownershipTransferred'));
      queryClient.invalidateQueries({ queryKey: ['project-members', id] });
      queryClient.invalidateQueries({ queryKey: ['project', id] });
      setTransferTarget(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Confirmation dialogs (replace the old native confirm() calls).
  const [transferTarget, setTransferTarget] = useState<Member | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  // Changing YOUR OWN role is confirmed first — an OWNER demoting themselves
  // would otherwise lose control of the project with a single mis-click.
  const [roleChangeTarget, setRoleChangeTarget] = useState<{ member: Member; role: Role } | null>(null);
  const currentUserId = useAuthStore((s) => s.user?.id);

  function requestRoleChange(member: Member, role: Role) {
    if (role === member.role) return;
    if (member.user.id === currentUserId) {
      setRoleChangeTarget({ member, role });
    } else {
      changeRoleMutation.mutate({ memberId: member.id, role });
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">{[1, 2, 3, 4].map(i => <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />)}</div>
      </div>
    );
  }

  if (projectError && !(projectErrorObj instanceof ApiError && projectErrorObj.status === 404)) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => router.push('/dashboard/projects')}><ArrowLeft size={16} /> {t('common.back')}</Button>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
            <AlertTriangle size={32} className="text-destructive" />
            <p className="font-medium">{t('projects.loadError')}</p>
            <p className="text-sm text-muted-foreground">
              {projectErrorObj instanceof Error ? projectErrorObj.message : t('projects.loadErrorDesc')}
            </p>
            <Button variant="outline" onClick={() => refetchProject()}>{t('common.retry')}</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => router.push('/dashboard/projects')}><ArrowLeft size={16} /> {t('common.back')}</Button>
        <p className="text-muted-foreground">{t('projects.notFound')}</p>
      </div>
    );
  }

  const apps = project.applications ?? [];
  const running = apps.filter(a => a.status === 'RUNNING').length;
  const stopped = apps.filter(a => a.status === 'STOPPED').length;
  const errors = apps.filter(a => a.status === 'ERROR').length;
  const totalDomains = apps.reduce((s, a) => s + (a.domains?.length ?? 0), 0);
  const allRunning = apps.length > 0 && running === apps.length;
  const hasError = errors > 0;

  const RoleBadge = ({ role }: { role: Role }) => {
    const meta = ROLE_BADGE[role];
    const Icon = meta.icon;
    return (
      <Badge variant={meta.variant} className="gap-1 text-[10px]">
        <Icon size={10} /> {role}
      </Badge>
    );
  };

  return (
    <div className="space-y-5">
      {/* Status bar */}
      <div className={`h-1 -mx-6 -mt-6 ${hasError ? 'bg-red-500' : allRunning ? 'bg-emerald-500' : apps.length > 0 ? 'bg-orange-500' : 'bg-zinc-600'}`} />

      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push('/dashboard/projects')}>
          <ArrowLeft size={20} />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <FolderKanban size={22} className="text-primary" />
            <h1 className="text-2xl font-bold truncate">{project.name}</h1>
            {project.server && (
              <Badge variant="outline" className="gap-1"><Server size={10} /> {project.server.name}</Badge>
            )}
            {myRole && <RoleBadge role={myRole} />}
          </div>
          {project.description && <p className="text-sm text-muted-foreground mt-1">{project.description}</p>}
        </div>
        {has(myRole, 'ADMIN') && (
          <Button variant="outline" onClick={() => setShowExport(true)}>
            <Download size={14} /> {t('projects.export.btn')}
          </Button>
        )}
        {has(myRole, 'OWNER') && (
          <Button variant="destructive" onClick={() => setShowDelete(true)}>
            <Trash2 size={14} /> {t('common.delete')}
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={cn(
            'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
            activeTab === tab.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}>
            {tab.label}
            {tab.id === 'applications' && <Badge variant="secondary" className="ml-2 text-[10px]">{apps.length}</Badge>}
            {tab.id === 'members' && members.length > 0 && <Badge variant="secondary" className="ml-2 text-[10px]">{members.length}</Badge>}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('projects.totalApps')}</p>
              <p className="text-2xl font-bold">{apps.length}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('projects.running')}</p>
              <p className="text-2xl font-bold text-emerald-500">{running}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('projects.stopped')}</p>
              <p className="text-2xl font-bold text-muted-foreground">{stopped}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-muted-foreground">{t('projects.domains')}</p>
              <p className="text-2xl font-bold">{totalDomains}</p>
            </div>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-lg">{t('projects.info')}</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">{t('projects.serverLabel')}</p>
                      <p className="font-semibold truncate">{project.server?.name ?? t('projects.unknown')}</p>
                      {project.server?.host && <p className="text-xs text-muted-foreground font-mono truncate">{project.server.host}</p>}
                    </div>
                    {isMulti && has(myRole, 'ADMIN') && servers.filter(s => s.id !== project.serverId && s.status === 'ONLINE').length > 0 && (
                      <Button size="sm" variant="outline" onClick={() => setShowMigrate(true)} title={t('projects.moveServerTitle')}>
                        <ArrowRightLeft size={12} />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">{t('common.created')}</p>
                  <p className="font-semibold">{timeAgo(project.createdAt)}</p>
                  <p className="text-xs text-muted-foreground">{new Date(project.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {apps.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Activity size={16} /> {t('projects.appStatus')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {apps.map(app => (
                    <Link key={app.id} href={`/dashboard/applications/${app.id}`} className="block">
                      <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-accent transition-colors">
                        <div className="flex items-center gap-2">
                          <span className={cn('h-2.5 w-2.5 rounded-full', STATUS_COLOR[app.status] || 'bg-zinc-400', ['RUNNING', 'DEPLOYING'].includes(app.status) && 'animate-pulse')} />
                          <span className="font-medium text-sm">{app.name}</span>
                          <Badge variant="outline" className="text-[10px]">{FW[app.framework] || app.framework}</Badge>
                        </div>
                        <div className="flex items-center gap-2">
                          {app.port && <span className="text-xs text-muted-foreground font-mono">:{app.port}</span>}
                          <Badge variant={STATUS_VARIANT[app.status] || 'secondary'} className="text-[10px]">{app.status}</Badge>
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Applications Tab */}
      {activeTab === 'applications' && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{t('projects.appsCount', { n: apps.length })}</p>
            {has(myRole, 'DEVELOPER') && (
              <div className="flex gap-2">
                <Link href="/dashboard/applications"><Button size="sm"><Plus size={14} /> {t('projects.deployBtn')}</Button></Link>
                <Link href="/dashboard/marketplace"><Button size="sm" variant="outline"><Store size={14} /> {t('projects.marketplaceBtn')}</Button></Link>
              </div>
            )}
          </div>

          {apps.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16">
                <Rocket size={48} className="mb-4 text-muted-foreground" />
                <p className="text-lg font-medium">{t('projects.noApps')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('projects.noAppsDesc')}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {apps.map(app => {
                const isRunning = app.status === 'RUNNING';
                // publicAppUrl resolves domain → binding → host:port. The
                // direct-IP fallback targets the server's public_ip — not the
                // hostname the panel is browsed through.
                const openUrl = publicAppUrl(app, serverIp);
                return (
                  <Link key={app.id} href={`/dashboard/applications/${app.id}`} className="block">
                    <Card className="hover:border-primary/50 transition-colors cursor-pointer overflow-hidden">
                      <CardContent className="p-0">
                        <div className={`h-1 w-full ${STATUS_COLOR[app.status] || 'bg-zinc-600'}`} />
                        <div className="p-4 space-y-3">
                          <div className="flex items-start justify-between">
                            <div className="flex items-center gap-2">
                              <span className={cn('h-2.5 w-2.5 rounded-full', STATUS_COLOR[app.status] || 'bg-zinc-400', ['RUNNING', 'DEPLOYING'].includes(app.status) && 'animate-pulse')} />
                              <h3 className="font-semibold">{app.name}</h3>
                              <Badge variant="outline" className="text-[10px]">{FW[app.framework] || app.framework}</Badge>
                            </div>
                            {isRunning && openUrl && (
                              <Button size="sm" className="shrink-0" onClick={e => { e.preventDefault(); e.stopPropagation(); window.open(openUrl, '_blank'); }}>
                                <ExternalLink size={12} /> {t('projects.open')}
                              </Button>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div className="rounded-lg border border-border p-2">
                              <p className="text-xs text-muted-foreground">{t('projects.port')}</p>
                              <p className="font-mono font-bold">{app.port || t('common.na')}</p>
                            </div>
                            <div className="rounded-lg border border-border p-2">
                              <p className="text-xs text-muted-foreground">{t('common.status')}</p>
                              <p className={cn('font-bold', isRunning ? 'text-emerald-500' : app.status === 'ERROR' ? 'text-red-500' : 'text-muted-foreground')}>{app.status}</p>
                            </div>
                          </div>

                          {app.domains && app.domains.length > 0 && (
                            <div className="rounded-lg border border-border bg-muted/30 p-2">
                              {app.domains.map(d => (
                                <div key={d.id} className="flex items-center justify-between">
                                  <span className="font-mono text-sm">{d.domain}</span>
                                  <Badge variant={d.sslStatus === 'ACTIVE' ? 'success' : 'warning'} className="text-[10px]">
                                    {d.sslStatus === 'ACTIVE' ? '🔒 SSL' : '⏳'}
                                  </Badge>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Service Mesh Tab */}
      {activeTab === 'mesh' && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Network size={18} /> {t('projects.mesh.title')}
              </CardTitle>
              <CardDescription>{t('projects.mesh.desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {meshLoading && (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 size={20} className="animate-spin" />
                </div>
              )}
              {meshError && (
                <div className="flex flex-col items-center justify-center py-10 gap-3">
                  <AlertTriangle size={24} className="text-destructive" />
                  <p className="text-sm text-muted-foreground">{t('projects.mesh.loadError')}</p>
                  <Button size="sm" variant="outline" onClick={() => refetchMesh()}>{t('common.retry')}</Button>
                </div>
              )}
              {mesh && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
                    <Network size={12} className="text-muted-foreground" />
                    <span className="text-muted-foreground">{t('projects.mesh.network')}</span>
                    <code className="font-mono">{mesh.networkName}</code>
                  </div>

                  {/* Scope warning — internal hostnames are project-local. */}
                  <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-xs space-y-1">
                    <p className="font-semibold text-blue-600 flex items-center gap-1">
                      <Info size={11} /> {t('projects.mesh.scope')}
                    </p>
                    <p className="text-muted-foreground">
                      {(() => {
                        const parts = t('projects.mesh.scopeDesc', { bold: '__B__' }).split('__B__');
                        return (
                          <>
                            {parts[0]}
                            <span className="font-semibold">{t('projects.mesh.scopeBold')}</span>
                            {parts[1] || ''}
                          </>
                        );
                      })()}
                    </p>
                  </div>

                  {mesh.apps.length === 0 && mesh.databases.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">{t('projects.mesh.empty')}</p>
                  )}

                  {mesh.apps.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{t('projects.mesh.apps', { n: mesh.apps.length })}</p>
                      <div className="space-y-2">
                        {mesh.apps.map((n) => (
                          <div key={n.id} className="rounded-md border border-border p-2.5 flex items-center gap-3">
                            <Rocket size={14} className="text-primary shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium truncate">{n.name}</p>
                              <p className="text-[11px] text-muted-foreground font-mono truncate">{n.url}</p>
                            </div>
                            <button onClick={() => copyMesh(n.url, `app-${n.id}`)} className="text-muted-foreground hover:text-foreground shrink-0">
                              {copiedMesh === `app-${n.id}` ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {mesh.databases.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{t('projects.mesh.databases', { n: mesh.databases.length })}</p>
                      <div className="space-y-2">
                        {mesh.databases.map((d) => (
                          <div key={d.id} className="rounded-md border border-border p-2.5 flex items-center gap-3">
                            <Database size={14} className="text-primary shrink-0" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium truncate">{d.name} <Badge variant="outline" className="text-[9px] ml-1">{d.dbType}</Badge></p>
                              <p className="text-[11px] text-muted-foreground font-mono truncate">{d.url}</p>
                            </div>
                            <button onClick={() => copyMesh(d.url, `db-${d.id}`)} className="text-muted-foreground hover:text-foreground shrink-0">
                              {copiedMesh === `db-${d.id}` ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {mesh.envSuggestions.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
                        <Info size={11} /> {t('projects.mesh.envSuggestions')}
                      </p>
                      <p className="text-xs text-muted-foreground mb-2">{t('projects.mesh.envHint')}</p>
                      <div className="space-y-2">
                        {mesh.envSuggestions.map((s, i) => {
                          const key = `env-${i}`;
                          const line = `${s.envVar}=${s.value}`;
                          return (
                            <div key={key} className="rounded-md border border-border p-2.5">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <p className="text-xs text-muted-foreground">
                                  {(() => {
                                    const parts = t('projects.mesh.connectLabel', { to: '__T__', from: '__F__' }).split(/__T__|__F__/);
                                    return (
                                      <>
                                        {parts[0]}
                                        <span className="font-medium text-foreground">{s.to.name}</span>
                                        {parts[1] || ''}
                                        <span className="font-medium text-foreground">{s.from.name}</span>
                                        {parts[2] || ''}
                                      </>
                                    );
                                  })()}
                                </p>
                                <button onClick={() => copyMesh(line, key)} className="text-muted-foreground hover:text-foreground">
                                  {copiedMesh === key ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                                </button>
                              </div>
                              <code className="block mt-1 text-[11px] font-mono break-all bg-muted/40 rounded px-2 py-1">{line}</code>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Members Tab */}
      {activeTab === 'members' && (
        <Card>
          <CardHeader className="flex flex-row items-start justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Users size={18} /> {t('members.title')}
              </CardTitle>
              <CardDescription>{t('members.subtitle')}</CardDescription>
            </div>
            {has(myRole, 'ADMIN') && (
              <Button size="sm" onClick={() => setShowAdd(true)}>
                <UserPlus size={14} /> {t('members.add')}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {members.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">{t('members.none')}</p>
              ) : (
                members.map(m => {
                  const canEdit = has(myRole, 'ADMIN') && (m.role !== 'OWNER' || myRole === 'OWNER');
                  return (
                    <div key={m.id} className="flex items-center gap-3 rounded-md border border-border p-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="font-medium truncate">{m.user.name}</p>
                          <RoleBadge role={m.role} />
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{m.user.email}</p>
                      </div>
                      {canEdit ? (
                        <>
                          <Select
                            value={m.role}
                            disabled={changeRoleMutation.isPending}
                            onChange={(e) => requestRoleChange(m, e.target.value as Role)}
                            className="w-36 h-8 text-xs"
                          >
                            {(['VIEWER', 'DEVELOPER', 'ADMIN', ...(myRole === 'OWNER' ? ['OWNER'] : [])] as Role[]).map(r => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </Select>
                          {myRole === 'OWNER' && m.role !== 'OWNER' && (
                            <Button
                              size="sm"
                              variant="outline"
                              title={t('members.transferTitle')}
                              onClick={() => setTransferTarget(m)}
                            >
                              <Crown size={12} />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setRemoveTarget(m)}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">{m.role}</Badge>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <div className="mt-6 rounded-md border border-border bg-muted/30 p-3 space-y-2 text-xs">
              <p className="font-semibold">{t('members.rolePermissions')}</p>
              <ul className="space-y-1 text-muted-foreground">
                <li><strong className="text-foreground">{t('members.role.OWNER')}</strong> — {t('members.roleDesc.OWNER')}</li>
                <li><strong className="text-foreground">{t('members.role.ADMIN')}</strong> — {t('members.roleDesc.ADMIN')}</li>
                <li><strong className="text-foreground">{t('members.role.DEVELOPER')}</strong> — {t('members.roleDesc.DEVELOPER')}</li>
                <li><strong className="text-foreground">{t('members.role.VIEWER')}</strong> — {t('members.roleDesc.VIEWER')}</li>
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Settings Tab */}
      {activeTab === 'settings' && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-lg">{t('projects.details')}</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">{t('common.name')}</p>
                  <p className="font-semibold">{project.name}</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">{t('common.description')}</p>
                  <p className="font-semibold">{project.description || t('projects.noDescription')}</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">{t('projects.serverLabel')}</p>
                  <p className="font-semibold">{project.server?.name}</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">{t('common.created')}</p>
                  <p className="font-semibold">{new Date(project.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Storage quota — usage visible to all members, edit is platform-admin only */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <HardDrive size={18} /> {t('projects.storageTitle')}
              </CardTitle>
              <CardDescription>{t('projects.storageDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {storageUsage && (
                <div>
                  <div className="flex items-center justify-between text-xs mb-1.5">
                    <span className="font-medium">{t('projects.storageUsed')}</span>
                    <span className={cn('font-mono', quotaPct > 95 ? 'text-red-500' : quotaPct > 80 ? 'text-orange-500' : 'text-muted-foreground')}>
                      {fmtGiB(usedB)} / {fmtGiB(quotaB)} ({quotaPct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full rounded-full transition-all', quotaPct > 95 ? 'bg-red-500' : quotaPct > 80 ? 'bg-orange-500' : 'bg-primary')}
                      style={{ width: `${quotaPct}%` }}
                    />
                  </div>
                </div>
              )}
              {isPlatformAdmin ? (
                <div className="flex items-end gap-2">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs">{t('projects.quotaLabel')}</Label>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      placeholder={quotaB ? String(Math.round(quotaB / 1024 ** 3)) : '10'}
                      value={quotaGiB}
                      onChange={(e) => setQuotaGiB(e.target.value)}
                    />
                  </div>
                  <Button
                    disabled={!quotaInputValid || quotaMutation.isPending}
                    onClick={() => quotaMutation.mutate(String(Math.round(quotaGiBNumber! * 1024 ** 3)))}
                  >
                    {quotaMutation.isPending && <Loader2 size={12} className="animate-spin" />}
                    {t('projects.quotaSaveBtn')}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('projects.quotaAdminOnly')}</p>
              )}
            </CardContent>
          </Card>

          {has(myRole, 'OWNER') && (
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-lg text-destructive">{t('projects.dangerZone')}</CardTitle>
                <CardDescription>{t('projects.dangerDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between rounded-lg border border-destructive/30 p-4">
                  <div>
                    <p className="font-medium">{t('projects.deleteThis')}</p>
                    <p className="text-sm text-muted-foreground">{t('projects.deleteThisDesc')}</p>
                  </div>
                  <Button variant="destructive" onClick={() => setShowDelete(true)}>
                    <Trash2 size={14} /> {t('projects.deleteBtn')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Add Member Dialog */}
      <Dialog open={showAdd} onClose={() => setShowAdd(false)}>
        <DialogHeader>
          <DialogTitle>{t('members.addTitle')}</DialogTitle>
          <DialogDescription>{t('members.addDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>{t('common.email')}</Label>
            <Input
              type="email"
              placeholder="teammate@example.com"
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('common.role')}</Label>
            <Select value={addRole} onChange={(e) => setAddRole(e.target.value as Role)}>
              <option value="VIEWER">{t('members.role.VIEWER')} — {t('members.roleDesc.VIEWER')}</option>
              <option value="DEVELOPER">{t('members.role.DEVELOPER')} — {t('members.roleDesc.DEVELOPER')}</option>
              <option value="ADMIN">{t('members.role.ADMIN')} — {t('members.roleDesc.ADMIN')}</option>
              {myRole === 'OWNER' && <option value="OWNER">{t('members.role.OWNER')} — {t('members.roleDesc.OWNER')}</option>}
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowAdd(false)}>{t('common.cancel')}</Button>
          <Button
            disabled={!addEmail.trim() || addMemberMutation.isPending}
            onClick={() => addMemberMutation.mutate()}
          >
            {addMemberMutation.isPending ? t('members.adding') : t('members.add')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={showDelete} onClose={() => setShowDelete(false)}>
        <DialogHeader>
          <DialogTitle>{t('projects.deleteTitle')} — &ldquo;{project.name}&rdquo;</DialogTitle>
          <DialogDescription>{t('projects.deleteDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDelete(false)}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
            {deleteMutation.isPending ? t('common.deleting') : t('projects.deleteBtn')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Migrate Dialog */}
      <Dialog open={showMigrate} onClose={() => { setShowMigrate(false); setMigrateTargetId(''); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft size={16} /> {t('projects.moveServerTitle')}
          </DialogTitle>
          <DialogDescription>
            {(() => {
              const parts = t('projects.moveServerDesc', { name: '__N__', server: '__S__' }).split(/__N__|__S__/);
              return (
                <>
                  {parts[0]}
                  <span className="font-mono">{project.name}</span>
                  {parts[1] || ''}
                  <span className="font-semibold">{project.server?.name}</span>
                  {parts[2] || ''}
                </>
              );
            })()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs flex items-start gap-2">
            <AlertTriangle size={14} className="text-orange-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-orange-600">{t('projects.moveDowntime')}</p>
              <p className="text-muted-foreground mt-0.5">{t('projects.moveDowntimeDesc')}</p>
            </div>
          </div>

          <div>
            <Label className="text-xs">{t('projects.targetServer')}</Label>
            <Select value={migrateTargetId} onChange={(e) => setMigrateTargetId(e.target.value)}>
              <option value="">{t('projects.selectServerOption')}</option>
              {servers
                .filter(s => s.id !== project.serverId && s.status === 'ONLINE')
                .map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                ))}
            </Select>
          </div>

          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={migrateIncludePinned}
              onChange={(e) => setMigrateIncludePinned(e.target.checked)}
            />
            <span>
              <span className="font-medium">{t('projects.migrateIncludePinned')}</span>
              <span className="text-muted-foreground block">{t('projects.migrateIncludePinnedDesc')}</span>
            </span>
          </label>

          <p className="text-xs text-muted-foreground">{t('projects.migrateDataNote')}</p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { setShowMigrate(false); setMigrateTargetId(''); setMigrateIncludePinned(false); }}>{t('common.cancel')}</Button>
          <Button
            disabled={!migrateTargetId || migrateMutation.isPending}
            onClick={() => migrateMutation.mutate(migrateTargetId)}
          >
            {migrateMutation.isPending && <Loader2 size={12} className="animate-spin" />}
            {t('projects.migrateBtn')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Export Dialog */}
      <Dialog open={showExport} onClose={() => { setShowExport(false); setExportPassphrase(''); setExportConfirm(''); }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download size={16} /> {t('projects.export.title')}
          </DialogTitle>
          <DialogDescription>{t('projects.export.desc')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={exportIncludeData}
              onChange={(e) => setExportIncludeData(e.target.checked)}
            />
            <span>
              <span className="font-medium">{t('projects.export.includeData')}</span>
              <span className="text-muted-foreground block">{t('projects.export.includeDataDesc')}</span>
            </span>
          </label>

          <div className="space-y-2">
            <Label className="text-xs">{t('projects.export.passphrase')}</Label>
            <Input
              type="password"
              placeholder={t('projects.export.passphrasePlaceholder')}
              value={exportPassphrase}
              onChange={(e) => setExportPassphrase(e.target.value)}
            />
            {exportPassphrase.length > 0 && !exportPassValid && (
              <p className="text-xs text-red-500">{t('projects.export.passphraseTooShort')}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t('projects.export.confirmPassphrase')}</Label>
            <Input
              type="password"
              placeholder={t('projects.export.passphrasePlaceholder')}
              value={exportConfirm}
              onChange={(e) => setExportConfirm(e.target.value)}
            />
            {exportConfirm.length > 0 && !exportPassMatch && (
              <p className="text-xs text-red-500">{t('projects.export.passphraseMismatch')}</p>
            )}
          </div>

          <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs flex items-start gap-2">
            <AlertTriangle size={14} className="text-orange-500 shrink-0 mt-0.5" />
            <p className="text-muted-foreground">{t('projects.export.warning')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { setShowExport(false); setExportPassphrase(''); setExportConfirm(''); }}>{t('common.cancel')}</Button>
          <Button
            disabled={!exportPassValid || !exportPassMatch || exportMutation.isPending}
            onClick={() => exportMutation.mutate()}
          >
            {exportMutation.isPending && <Loader2 size={12} className="animate-spin" />}
            {exportMutation.isPending ? t('projects.export.exporting') : t('projects.export.submit')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Transfer Ownership Dialog (replaces native confirm) */}
      <Dialog open={!!transferTarget} onClose={() => setTransferTarget(null)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Crown size={16} /> {t('members.transferTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('members.transferDesc', { email: transferTarget?.user.email ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setTransferTarget(null)}>{t('common.cancel')}</Button>
          <Button
            disabled={transferOwnershipMutation.isPending}
            onClick={() => transferTarget && transferOwnershipMutation.mutate(transferTarget.user.id)}
          >
            {transferOwnershipMutation.isPending && <Loader2 size={12} className="animate-spin" />}
            {t('members.transferBtn')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Remove Member Dialog (replaces native confirm) */}
      <Dialog open={!!removeTarget} onClose={() => setRemoveTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('members.removeTitle')}</DialogTitle>
          <DialogDescription>
            {removeTarget && <span className="font-medium">{removeTarget.user.email}</span>}
            {removeTarget && ' — '}
            {t('members.removeConfirm')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRemoveTarget(null)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={removeMemberMutation.isPending}
            onClick={() => removeTarget && removeMemberMutation.mutate(removeTarget.id)}
          >
            {removeMemberMutation.isPending && <Loader2 size={12} className="animate-spin" />}
            {t('common.remove')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Change Own Role Dialog — confirm before self-demotion */}
      <Dialog open={!!roleChangeTarget} onClose={() => setRoleChangeTarget(null)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-orange-500" /> {t('members.changeOwnRoleTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('members.changeOwnRoleDesc', { role: roleChangeTarget?.role ?? '' })}
            {roleChangeTarget?.member.role === 'OWNER' && (
              <span className="block mt-2 font-semibold text-orange-600">
                {t('members.changeOwnRoleOwnerWarn')}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRoleChangeTarget(null)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={changeRoleMutation.isPending}
            onClick={() =>
              roleChangeTarget &&
              changeRoleMutation.mutate({ memberId: roleChangeTarget.member.id, role: roleChangeTarget.role })
            }
          >
            {changeRoleMutation.isPending && <Loader2 size={12} className="animate-spin" />}
            {t('members.changeOwnRoleBtn')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
