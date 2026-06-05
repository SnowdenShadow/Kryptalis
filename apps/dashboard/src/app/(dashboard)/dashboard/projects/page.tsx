'use client';

import { useState, useEffect, type FormEvent } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  FolderKanban,
  Server,
  Calendar,
  Trash2,
  AppWindow,
  Circle,
  Globe,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectApplication {
  id: string;
  name: string;
  status: string;
  framework: string;
  port: number | null;
  domains?: { id: string; domain: string; sslStatus: string }[];
}

interface ProjectServer {
  id: string;
  name: string;
  host?: string;
}

interface Project {
  id: string;
  name: string;
  description: string | null;
  serverId: string;
  createdAt: string;
  server?: ProjectServer;
  applications?: ProjectApplication[];
}

interface LocalServer {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeDate(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffDay > 30) {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  if (diffDay > 0) return `${diffDay}d ago`;
  if (diffHr > 0) return `${diffHr}h ago`;
  if (diffMin > 0) return `${diffMin}m ago`;
  return 'just now';
}

function statusDotColor(status: string): string {
  switch (status) {
    case 'RUNNING':
      return 'bg-green-500';
    case 'STOPPED':
      return 'bg-gray-400';
    case 'ERROR':
      return 'bg-red-500';
    case 'BUILDING':
    case 'DEPLOYING':
      return 'bg-yellow-500';
    default:
      return 'bg-gray-400';
  }
}

function appStatusSummary(apps: ProjectApplication[]): string {
  if (apps.length === 0) return '0 apps';
  const running = apps.filter((a) => a.status === 'RUNNING').length;
  const stopped = apps.filter((a) => a.status === 'STOPPED').length;
  const error = apps.filter((a) => a.status === 'ERROR').length;
  const other = apps.length - running - stopped - error;

  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (stopped > 0) parts.push(`${stopped} stopped`);
  if (error > 0) parts.push(`${error} error`);
  if (other > 0) parts.push(`${other} other`);

  return `${apps.length} app${apps.length !== 1 ? 's' : ''} (${parts.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProjectsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // --- List ---
  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });

  // --- Local server (auto-select for new project in LOCAL mode) ---
  const { data: localServer } = useQuery<LocalServer>({
    queryKey: ['servers', 'local'],
    queryFn: () => api.get('/servers/local'),
  });

  // --- Deployment mode (LOCAL or MULTI) + servers list (only fetched in MULTI mode)
  const { data: publicSettings } = useQuery<{ deployment_mode?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
  });
  const isMultiMode = publicSettings?.deployment_mode === 'MULTI';

  const { data: allServers = [] } = useQuery<LocalServer[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/servers'),
    enabled: isMultiMode,
  });
  const onlineServers = allServers.filter(s => (s as any).status === 'ONLINE');

  // --- Create dialog ---
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    serverId: '',
  });

  // Reset form when dialog opens, pre-fill server in MULTI if there's only one online
  useEffect(() => {
    if (showCreate) {
      const defaultServer = isMultiMode
        ? (onlineServers.length === 1 ? onlineServers[0].id : '')
        : (localServer?.id ?? '');
      setCreateForm({ name: '', description: '', serverId: defaultServer });
    }
  }, [showCreate, isMultiMode, onlineServers.length, localServer?.id]);

  // --- Delete confirmation ---
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);

  // --- Mutations ---
  const createMutation = useMutation({
    mutationFn: (body: { name: string; description?: string; serverId: string }) =>
      api.post<Project>('/projects', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project created');
      setShowCreate(false);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to create project');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success('Project deleted');
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to delete project');
    },
  });

  // --- Handlers ---
  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    const serverId = isMultiMode ? createForm.serverId : localServer?.id;
    if (!serverId) {
      toast.error(isMultiMode ? 'Pick a server first' : 'No local server found');
      return;
    }
    createMutation.mutate({
      name: createForm.name,
      ...(createForm.description ? { description: createForm.description } : {}),
      serverId,
    });
  }

  // --- Render ---
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">{t('projects.title')}</h1>
          {!isLoading && (
            <Badge variant="secondary" className="text-sm">
              {projects.length}
            </Badge>
          )}
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus size={16} />
          {t('projects.new')}
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 w-32 rounded bg-muted" />
                <div className="mt-1 h-4 w-48 rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  <div className="h-4 w-full rounded bg-muted" />
                  <div className="h-4 w-3/4 rounded bg-muted" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <FolderKanban size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('projects.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('projects.emptyDesc')}
            </p>
            <Button className="mt-4" onClick={() => setShowCreate(true)}>
              <Plus size={16} />
              {t('projects.new')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {projects.map((project) => {
            const apps = project.applications ?? [];
            const running = apps.filter((a) => a.status === 'RUNNING').length;
            const stopped = apps.filter((a) => a.status === 'STOPPED').length;
            const errors = apps.filter((a) => a.status === 'ERROR').length;
            const totalDomains = apps.reduce((sum, a) => sum + (a.domains?.length ?? 0), 0);
            const allRunning = apps.length > 0 && running === apps.length;
            const hasError = errors > 0;

            return (
              <Link key={project.id} href={`/dashboard/projects/${project.id}`} className="block">
                <Card className="hover:border-primary/50 transition-colors cursor-pointer overflow-hidden">
                  <CardContent className="p-0">
                    <div className={`h-1 w-full ${hasError ? 'bg-red-500' : allRunning ? 'bg-emerald-500' : apps.length > 0 ? 'bg-orange-500' : 'bg-zinc-600'}`} />

                    <div className="p-5 space-y-4">
                      {/* Header */}
                      <div className="flex items-start justify-between">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <FolderKanban size={18} className="text-primary" />
                            <h3 className="text-lg font-semibold">{project.name}</h3>
                          </div>
                          {project.description && (
                            <p className="text-sm text-muted-foreground">{project.description}</p>
                          )}
                        </div>
                        <Button size="sm" variant="destructive"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setDeleteTarget(project); }}>
                          <Trash2 size={14} />
                        </Button>
                      </div>

                      {/* Stats row */}
                      <div className="grid grid-cols-3 gap-3">
                        <div className="rounded-lg border border-border p-2 text-center">
                          <p className="text-xl font-bold">{apps.length}</p>
                          <p className="text-xs text-muted-foreground">Apps</p>
                        </div>
                        <div className="rounded-lg border border-border p-2 text-center">
                          <p className="text-xl font-bold text-emerald-500">{running}</p>
                          <p className="text-xs text-muted-foreground">Running</p>
                        </div>
                        <div className="rounded-lg border border-border p-2 text-center">
                          <p className={`text-xl font-bold ${errors > 0 ? 'text-red-500' : stopped > 0 ? 'text-muted-foreground' : ''}`}>{stopped + errors}</p>
                          <p className="text-xs text-muted-foreground">Stopped</p>
                        </div>
                      </div>

                      {/* App list */}
                      {apps.length > 0 && (
                        <div className="space-y-1.5">
                          {apps.map((app) => (
                            <div key={app.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-1.5">
                              <div className="flex items-center gap-2">
                                <span className={`h-2 w-2 rounded-full ${statusDotColor(app.status)} ${app.status === 'RUNNING' ? 'animate-pulse' : ''}`} />
                                <span className="text-sm font-medium">{app.name}</span>
                                <Badge variant="outline" className="text-[10px]">{app.framework === 'DOCKER_COMPOSE' ? 'Compose' : app.framework}</Badge>
                              </div>
                              <div className="flex items-center gap-2">
                                {app.port && <span className="text-xs text-muted-foreground font-mono">:{app.port}</span>}
                                {app.domains && app.domains.length > 0 && (
                                  <span className="text-xs text-muted-foreground font-mono">{app.domains[0].domain}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Footer */}
                      <div className="flex items-center justify-between pt-2 border-t border-border">
                        <div className="flex items-center gap-3 text-xs text-muted-foreground">
                          <span>{relativeDate(project.createdAt)}</span>
                          {totalDomains > 0 && (
                            <span className="flex items-center gap-1"><Globe size={11} /> {totalDomains} domain{totalDomains !== 1 ? 's' : ''}</span>
                          )}
                        </div>
                        {project.server && (
                          <Badge variant="outline" className="text-[10px] gap-1">
                            <Server size={10} /> {project.server.name}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}

      {/* ---- Create Project Dialog ---- */}
      <Dialog open={showCreate} onClose={() => setShowCreate(false)}>
        <DialogHeader>
          <DialogTitle>{t('projects.new')}</DialogTitle>
          <DialogDescription>
            Create a project to group related applications
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleCreateSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="proj-name">{t('common.name')} *</Label>
            <Input
              id="proj-name"
              placeholder="my-project"
              required
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="proj-desc">{t('common.description')}</Label>
            <textarea
              id="proj-desc"
              rows={3}
              placeholder="Optional description..."
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={createForm.description}
              onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          {/* Server selector — auto in LOCAL mode, dropdown in MULTI */}
          {isMultiMode ? (
            <div className="space-y-2">
              <Label htmlFor="proj-server">Server *</Label>
              {onlineServers.length === 0 ? (
                <div className="flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-3 text-xs">
                  <Server size={14} className="text-orange-500 shrink-0 mt-0.5" />
                  <p className="text-muted-foreground">
                    No ONLINE server available yet. Ask an administrator to add one in{' '}
                    <a href="/dashboard/servers" className="text-primary hover:underline">Servers</a>.
                  </p>
                </div>
              ) : (
                <>
                  <Select
                    id="proj-server"
                    value={createForm.serverId}
                    onChange={(e) => setCreateForm(f => ({ ...f, serverId: e.target.value }))}
                    required
                  >
                    <option value="">Select a server</option>
                    {onlineServers.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({(s as any).host})
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Apps in this project will be deployed on the selected server.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Server</Label>
              <div className="flex items-center gap-2 rounded-md border border-input bg-muted/50 px-3 py-2 text-sm">
                <Server size={14} className="text-muted-foreground" />
                <span>{localServer?.name ?? 'Loading...'}</span>
                <span className="text-xs text-muted-foreground ml-auto">platform is in LOCAL mode</span>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                createMutation.isPending ||
                !createForm.name.trim() ||
                (isMultiMode ? !createForm.serverId : !localServer)
              }
            >
              {createMutation.isPending ? 'Creating...' : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* ---- Delete Confirmation Dialog ---- */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('common.delete')}</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This will
            permanently remove the project and all its data. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
          >
            {deleteMutation.isPending ? 'Deleting...' : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
