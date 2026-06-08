'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Trash2, Server, Rocket, Plus, ExternalLink, Store,
  FolderKanban, Activity, Users, Shield, Crown, UserPlus, Loader2,
  ArrowRightLeft, AlertTriangle, Network, Database, Copy, Check, Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

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

interface ProjectApp {
  id: string; name: string; status: string; framework: string; port: number | null;
  domains?: { id: string; domain: string; sslStatus: string }[];
}

interface Project {
  id: string; name: string; description: string | null; serverId: string; createdAt: string;
  server?: { id: string; name: string; host?: string };
  applications?: ProjectApp[];
  currentRole?: Role;
}

interface Member {
  id: string; role: Role; createdAt: string;
  user: { id: string; name: string; email: string };
}

const STATUS_COLOR: Record<string, string> = {
  RUNNING: 'bg-emerald-500', STOPPED: 'bg-zinc-400', ERROR: 'bg-red-500',
  DEPLOYING: 'bg-orange-500', BUILDING: 'bg-orange-500',
};
const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive'> = {
  RUNNING: 'success', STOPPED: 'secondary', BUILDING: 'warning', DEPLOYING: 'warning', ERROR: 'destructive',
};
const FW: Record<string, string> = {
  NEXTJS: 'Next.js', REACT: 'React', VUE: 'Vue', ANGULAR: 'Angular', NESTJS: 'NestJS',
  EXPRESS: 'Express', LARAVEL: 'Laravel', SYMFONY: 'Symfony', DJANGO: 'Django', FLASK: 'Flask',
  FASTAPI: 'FastAPI', STATIC: 'Static', DOCKER: 'Docker', DOCKER_COMPOSE: 'Compose',
};
const HTTPS_PORTS = [443, 8443, 9443];

function timeAgo(d: string) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

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

  const { data: publicSettings } = useQuery<{ deployment_mode?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
    staleTime: 60_000,
  });
  const isMulti = publicSettings?.deployment_mode === 'MULTI';

  const { data: servers = [] } = useQuery<{ id: string; name: string; host: string; status: string }[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/servers'),
    enabled: isMulti,
  });

  const { data: project, isLoading } = useQuery<Project>({
    queryKey: ['project', id],
    queryFn: () => api.get(`/projects/${id}`),
    enabled: !!id,
  });
  const myRole = project?.currentRole;

  const { data: members = [] } = useQuery<Member[]>({
    queryKey: ['project-members', id],
    queryFn: () => api.get(`/projects/${id}/members`),
    enabled: !!id && activeTab === 'members',
  });

  const TABS: { id: Tab; label: string }[] = [
    { id: 'overview', label: t('projects.tab.overview') },
    { id: 'applications', label: t('projects.tab.applications') },
    { id: 'mesh', label: 'Service mesh' },
    { id: 'members', label: t('projects.tab.members') },
    { id: 'settings', label: t('projects.tab.settings') },
  ];

  const { data: mesh } = useQuery<ServiceMesh>({
    queryKey: ['project-mesh', id],
    queryFn: () => api.get(`/projects/${id}/mesh`),
    enabled: !!id && activeTab === 'mesh',
  });

  const [copiedMesh, setCopiedMesh] = useState('');
  function copyMesh(text: string, key: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedMesh(key);
      toast.success(t('toast.copied'));
      setTimeout(() => setCopiedMesh(''), 1200);
    });
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
      api.post(`/projects/${id}/migrate`, { targetServerId }) as Promise<{ message: string; queued: string[]; warnings: string[] }>,
    onSuccess: (data) => {
      toast.success(data.message);
      if (data.warnings.length > 0) {
        toast.warning(t('toast.migrationWarnings', { n: data.warnings.length }));
      }
      queryClient.invalidateQueries({ queryKey: ['project', id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowMigrate(false);
      setMigrateTargetId('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

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
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: string) => api.delete(`/projects/${id}/members/${memberId}`),
    onSuccess: () => {
      toast.success(t('toast.memberRemoved'));
      queryClient.invalidateQueries({ queryKey: ['project-members', id] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const transferOwnershipMutation = useMutation({
    mutationFn: (targetUserId: string) => api.post(`/projects/${id}/transfer-ownership`, { targetUserId }),
    onSuccess: () => {
      toast.success(t('toast.ownershipTransferred'));
      queryClient.invalidateQueries({ queryKey: ['project-members', id] });
      queryClient.invalidateQueries({ queryKey: ['project', id] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">{[1, 2, 3, 4].map(i => <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />)}</div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => router.push('/dashboard/projects')}><ArrowLeft size={16} /> Back</Button>
        <p className="text-muted-foreground">Project not found.</p>
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
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Server</p>
                      <p className="font-semibold truncate">{project.server?.name ?? 'Unknown'}</p>
                      {project.server?.host && <p className="text-xs text-muted-foreground font-mono truncate">{project.server.host}</p>}
                    </div>
                    {isMulti && has(myRole, 'ADMIN') && servers.filter(s => s.id !== project.serverId && s.status === 'ONLINE').length > 0 && (
                      <Button size="sm" variant="outline" onClick={() => setShowMigrate(true)} title="Move project to another server">
                        <ArrowRightLeft size={12} />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Created</p>
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
            <p className="text-sm text-muted-foreground">{apps.length} application{apps.length !== 1 ? 's' : ''} in this project</p>
            {has(myRole, 'DEVELOPER') && (
              <div className="flex gap-2">
                <Link href="/dashboard/applications"><Button size="sm"><Plus size={14} /> Deploy</Button></Link>
                <Link href="/dashboard/marketplace"><Button size="sm" variant="outline"><Store size={14} /> Marketplace</Button></Link>
              </div>
            )}
          </div>

          {apps.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16">
                <Rocket size={48} className="mb-4 text-muted-foreground" />
                <p className="text-lg font-medium">No applications yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Deploy or install an application to get started</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {apps.map(app => {
                const isRunning = app.status === 'RUNNING';
                const proto = app.port && HTTPS_PORTS.includes(app.port) ? 'https' : 'http';
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
                            {isRunning && app.port && (
                              <Button size="sm" className="shrink-0" onClick={e => { e.preventDefault(); e.stopPropagation(); window.open(`${proto}://localhost:${app.port}`, '_blank'); }}>
                                <ExternalLink size={12} /> Open
                              </Button>
                            )}
                          </div>

                          <div className="grid grid-cols-2 gap-3 text-sm">
                            <div className="rounded-lg border border-border p-2">
                              <p className="text-xs text-muted-foreground">Port</p>
                              <p className="font-mono font-bold">{app.port || 'N/A'}</p>
                            </div>
                            <div className="rounded-lg border border-border p-2">
                              <p className="text-xs text-muted-foreground">Status</p>
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
                <Network size={18} /> Service mesh
              </CardTitle>
              <CardDescription>
                Containers in this project share a docker network — they can reach each other by these hostnames.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {mesh && (
                <div className="space-y-4">
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2 text-xs">
                    <Network size={12} className="text-muted-foreground" />
                    <span className="text-muted-foreground">Network:</span>
                    <code className="font-mono">{mesh.networkName}</code>
                  </div>

                  {/* Scope warning — internal hostnames are project-local. */}
                  <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 text-xs space-y-1">
                    <p className="font-semibold text-blue-600 flex items-center gap-1">
                      <Info size={11} /> Scope
                    </p>
                    <p className="text-muted-foreground">
                      These hostnames work <span className="font-semibold">only between services inside this project</span>, on the same Docker host. To reach a service in a different project (or on a different server), use its public HTTPS URL via its attached domain instead.
                    </p>
                  </div>

                  {mesh.apps.length === 0 && mesh.databases.length === 0 && (
                    <p className="text-sm text-muted-foreground italic">No apps or databases yet. Add some to see the mesh.</p>
                  )}

                  {mesh.apps.length > 0 && (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Applications ({mesh.apps.length})</p>
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
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Databases ({mesh.databases.length})</p>
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
                        <Info size={11} /> Suggested env vars
                      </p>
                      <p className="text-xs text-muted-foreground mb-2">Paste into an app's environment variables to link it to a database.</p>
                      <div className="space-y-2">
                        {mesh.envSuggestions.map((s, i) => {
                          const key = `env-${i}`;
                          const line = `${s.envVar}=${s.value}`;
                          return (
                            <div key={key} className="rounded-md border border-border p-2.5">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <p className="text-xs text-muted-foreground">
                                  Connect <span className="font-medium text-foreground">{s.to.name}</span> → <span className="font-medium text-foreground">{s.from.name}</span>
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
                            onChange={(e) =>
                              changeRoleMutation.mutate({ memberId: m.id, role: e.target.value as Role })
                            }
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
                              title="Transfer ownership"
                              onClick={() => {
                                if (confirm(`Transfer project ownership to ${m.user.email}? You will be downgraded to ADMIN.`)) {
                                  transferOwnershipMutation.mutate(m.user.id);
                                }
                              }}
                            >
                              <Crown size={12} />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => {
                              if (confirm(t('members.removeConfirm'))) {
                                removeMemberMutation.mutate(m.id);
                              }
                            }}
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
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">Name</p>
                  <p className="font-semibold">{project.name}</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">Description</p>
                  <p className="font-semibold">{project.description || 'No description'}</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">Server</p>
                  <p className="font-semibold">{project.server?.name}</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">Created</p>
                  <p className="font-semibold">{new Date(project.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
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
            <ArrowRightLeft size={16} /> Move project to another server
          </DialogTitle>
          <DialogDescription>
            Every app and database in <span className="font-mono">{project.name}</span> will be torn down on{' '}
            <span className="font-semibold">{project.server?.name}</span> and re-deployed on the target server. Domains follow automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs flex items-start gap-2">
            <AlertTriangle size={14} className="text-orange-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-orange-600">Downtime expected.</p>
              <p className="text-muted-foreground mt-0.5">Apps are unavailable while they redeploy on the new server. Data in mounted volumes is not copied across hosts — set up backups or use external DBs first.</p>
            </div>
          </div>

          <div>
            <Label className="text-xs">Target server</Label>
            <Select value={migrateTargetId} onChange={(e) => setMigrateTargetId(e.target.value)}>
              <option value="">Select server…</option>
              {servers
                .filter(s => s.id !== project.serverId && s.status === 'ONLINE')
                .map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                ))}
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { setShowMigrate(false); setMigrateTargetId(''); }}>Cancel</Button>
          <Button
            disabled={!migrateTargetId || migrateMutation.isPending}
            onClick={() => migrateMutation.mutate(migrateTargetId)}
          >
            {migrateMutation.isPending && <Loader2 size={12} className="animate-spin" />}
            Migrate project
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
