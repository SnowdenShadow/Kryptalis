'use client';

import { useState, useEffect, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
  Loader2,
  Upload,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/toast-error';
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
import type { ProjectResponse } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Shared API resource types — local alias keeps the diff/readability small.
type Project = ProjectResponse;

interface LocalServer {
  id: string;
  name: string;
  status?: string;
  host?: string | null;
}

// ── Project import (.dctproj transfer) ──────────────────────────────
interface TransferManifest {
  project: { name: string; description?: string };
  applications: { name: string; framework?: string; gitUrl?: string; dockerImage?: string; requiresHostAccess?: boolean }[];
  databases: { name: string; type?: string }[];
  domains: { domain: string; applicationName?: string }[];
  includesData: boolean;
}
interface ParseResult {
  stagedId: string;
  manifest: TransferManifest;
  conflicts: { domains: string[]; projectNameTaken: boolean };
  warnings: string[];
}
interface ApplyResult {
  status: 'ok' | 'partial';
  projectId: string;
  message: string;
  warnings: string[];
}
type DomainStrategy = 'skip' | 'attach';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeDate(dateStr: string, t: (k: string, v?: Record<string, string | number>) => string): string {
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
  if (diffDay > 0) return t('projects.timeDay', { n: diffDay });
  if (diffHr > 0) return t('projects.timeHour', { n: diffHr });
  if (diffMin > 0) return t('projects.timeMin', { n: diffMin });
  return t('projects.timeJust');
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProjectsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPERADMIN';

  // --- List ---
  const { data: projects = [], isLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });

  // --- Local server (auto-select for new project in LOCAL mode) ---
  // Use the sanitized -public endpoint so non-admin USERs can still create
  // projects. The admin endpoint /servers/local returns agent tokens and is
  // gated to ADMIN/SUPERADMIN; we don't need any of that here.
  const { data: localServer } = useQuery<LocalServer>({
    queryKey: ['servers', 'local-public'],
    queryFn: () => api.get('/servers/local-public'),
  });

  // --- Deployment mode (LOCAL or MULTI) + servers list (only fetched in MULTI mode)
  const { data: publicSettings } = useQuery<{ deployment_mode?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
  });
  const isMultiMode = publicSettings?.deployment_mode === 'MULTI';

  // /servers is admin-only — a USER would just get a 403 here.
  const { data: allServers = [] } = useQuery<LocalServer[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/servers'),
    enabled: isMultiMode && isAdmin,
    retry: false,
  });
  const onlineServers = allServers.filter(s => s.status === 'ONLINE');

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

  // --- Import dialog (multi-step: 1=upload, 2=review) ---
  const [showImport, setShowImport] = useState(false);
  const [importStep, setImportStep] = useState<1 | 2>(1);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importParsed, setImportParsed] = useState<ParseResult | null>(null);
  const [importTargetServerId, setImportTargetServerId] = useState('');
  const [importDomainStrategy, setImportDomainStrategy] = useState<DomainStrategy>('skip');
  const [importAllowHost, setImportAllowHost] = useState(false);

  function resetImport() {
    setShowImport(false);
    setImportStep(1);
    setImportFile(null);
    setImportPassphrase('');
    setImportParsed(null);
    setImportTargetServerId('');
    setImportDomainStrategy('skip');
    setImportAllowHost(false);
  }

  // Step 1 → parse the raw .dctproj bytes. rawFetch streams the File body as
  // octet-stream (no multipart); the passphrase rides in the query string. A
  // wrong passphrase / corrupted archive surfaces as the backend's message.
  const parseMutation = useMutation({
    mutationFn: async () => {
      if (!importFile) throw new Error(t('projects.import.noFile'));
      const res = await api.rawFetch(
        `/projects/transfer/parse?passphrase=${encodeURIComponent(importPassphrase)}`,
        { method: 'POST', body: importFile, headers: { 'Content-Type': 'application/octet-stream' } },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body?.message === 'string' ? body.message : `Request failed (${res.status}).`);
      }
      return res.json() as Promise<ParseResult>;
    },
    onSuccess: (data) => {
      setImportParsed(data);
      setImportStep(2);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Step 2 → apply the staged transfer.
  const applyMutation = useMutation({
    mutationFn: () =>
      api.post<ApplyResult>('/projects/transfer/apply', {
        stagedId: importParsed!.stagedId,
        passphrase: importPassphrase,
        ...(isMultiMode && importTargetServerId ? { targetServerId: importTargetServerId } : {}),
        domainStrategy: importDomainStrategy,
        ...(importAllowHost ? { allowHostAccess: true } : {}),
      }),
    onSuccess: (data) => {
      if (data.status === 'partial') {
        toast.warning(t('projects.import.partial'));
      } else {
        toast.success(t('projects.import.success'));
      }
      for (const w of data.warnings || []) toast.warning(w);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      resetImport();
      router.push(`/dashboard/projects/${data.projectId}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // --- Mutations ---
  const createMutation = useMutation({
    mutationFn: (body: { name: string; description?: string; serverId: string }) =>
      api.post<Project>('/projects', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('toast.projectCreated'));
      setShowCreate(false);
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(t('toast.projectDeleted'));
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  // --- Handlers ---
  function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    const serverId = isMultiMode ? createForm.serverId : localServer?.id;
    if (!serverId) {
      toast.error(t(isMultiMode ? 'toast.pickServerFirst' : 'toast.noLocalServer'));
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
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowImport(true)}>
            <Upload size={16} />
            {t('projects.import.btn')}
          </Button>
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={16} />
            {t('projects.new')}
          </Button>
        </div>
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
                          <p className="text-xs text-muted-foreground">{t('projects.apps')}</p>
                        </div>
                        <div className="rounded-lg border border-border p-2 text-center">
                          <p className="text-xl font-bold text-emerald-500">{running}</p>
                          <p className="text-xs text-muted-foreground">{t('projects.running')}</p>
                        </div>
                        <div className="rounded-lg border border-border p-2 text-center">
                          <p className={`text-xl font-bold ${errors > 0 ? 'text-red-500' : stopped > 0 ? 'text-muted-foreground' : ''}`}>{stopped + errors}</p>
                          <p className="text-xs text-muted-foreground">{t('projects.stopped')}</p>
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
                          <span>{relativeDate(project.createdAt, t)}</span>
                          {totalDomains > 0 && (
                            <span className="flex items-center gap-1"><Globe size={11} /> {t(totalDomains === 1 ? 'projects.domainSingle' : 'projects.domainPlural', { n: totalDomains })}</span>
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
            {t('projects.createDialogDesc')}
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
              placeholder={t('projects.descPlaceholder')}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={createForm.description}
              onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>

          {/* Server selector — auto in LOCAL mode, dropdown in MULTI */}
          {isMultiMode ? (
            <div className="space-y-2">
              <Label htmlFor="proj-server">{t('projects.serverRequired')}</Label>
              {!isAdmin ? (
                <div className="flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-3 text-xs">
                  <Server size={14} className="text-orange-500 shrink-0 mt-0.5" />
                  <p className="text-muted-foreground">
                    {t('projects.serverAdminRequired')}
                  </p>
                </div>
              ) : onlineServers.length === 0 ? (
                <div className="flex items-start gap-2 rounded-md border border-orange-500/30 bg-orange-500/5 p-3 text-xs">
                  <Server size={14} className="text-orange-500 shrink-0 mt-0.5" />
                  <p className="text-muted-foreground">
                    {t('projects.noOnlineServerBefore')}{' '}
                    <a href="/dashboard/servers" className="text-primary hover:underline">{t('projects.noOnlineServerLink')}</a>.
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
                    <option value="">{t('projects.selectServer')}</option>
                    {onlineServers.map(s => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.host})
                      </option>
                    ))}
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {t('projects.serverDeployHint')}
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label>{t('projects.serverLabel')}</Label>
              <div className="flex items-center gap-2 rounded-md border border-input bg-muted/50 px-3 py-2 text-sm">
                <Server size={14} className="text-muted-foreground" />
                <span>{localServer?.name ?? t('common.loading')}</span>
                <span className="text-xs text-muted-foreground ml-auto">{t('projects.localModeHint')}</span>
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
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {createMutation.isPending ? t('common.creating') : t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* ---- Delete Confirmation Dialog ---- */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('common.delete')}</DialogTitle>
          <DialogDescription>
            {t('projects.deleteDialogDesc', { name: deleteTarget?.name ?? '' })}
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
            {deleteMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            {deleteMutation.isPending ? t('common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ---- Import Project Dialog (multi-step) ---- */}
      <Dialog open={showImport} onClose={resetImport} className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload size={16} /> {t('projects.import.title')}
          </DialogTitle>
          <DialogDescription>{t('projects.import.desc')}</DialogDescription>
        </DialogHeader>

        {importStep === 1 ? (
          <>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="import-file">{t('projects.import.file')}</Label>
                <Input
                  id="import-file"
                  type="file"
                  accept=".dctproj"
                  onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="import-pass">{t('projects.import.passphrase')}</Label>
                <Input
                  id="import-pass"
                  type="password"
                  placeholder={t('projects.import.passphrasePlaceholder')}
                  value={importPassphrase}
                  onChange={(e) => setImportPassphrase(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={resetImport}>{t('common.cancel')}</Button>
              <Button
                disabled={!importFile || !importPassphrase || parseMutation.isPending}
                onClick={() => parseMutation.mutate()}
              >
                {parseMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                {parseMutation.isPending ? t('projects.import.reviewing') : t('projects.import.review')}
              </Button>
            </DialogFooter>
          </>
        ) : importParsed ? (
          <>
            <div className="space-y-3">
              {/* Manifest summary */}
              <div className="rounded-lg border border-border p-3 space-y-2 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('projects.import.summary')}</p>
                <div className="flex items-center gap-2">
                  <FolderKanban size={14} className="text-primary shrink-0" />
                  <span className="font-medium">{importParsed.manifest.project.name}</span>
                </div>
                {importParsed.manifest.applications.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">{t('projects.import.appsCount', { n: importParsed.manifest.applications.length })}</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {importParsed.manifest.applications.map((a, i) => (
                        <Badge key={`${a.name}-${i}`} variant="outline" className="text-[10px] gap-1">
                          <AppWindow size={9} /> {a.name}{a.framework ? ` · ${a.framework}` : ''}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
                {importParsed.manifest.databases.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('projects.import.databasesCount', { n: importParsed.manifest.databases.length })}: {importParsed.manifest.databases.map((d) => d.name).join(', ')}
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{t('projects.import.domainsCount', { n: importParsed.manifest.domains.length })}</p>
                <p className="text-xs text-muted-foreground">
                  {importParsed.manifest.includesData ? t('projects.import.includesData') : t('projects.import.noData')}
                </p>
              </div>

              {/* Conflicts */}
              {(importParsed.conflicts.projectNameTaken || importParsed.conflicts.domains.length > 0) && (
                <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs space-y-1">
                  <p className="font-semibold text-orange-600 flex items-center gap-1">
                    <AlertTriangle size={12} /> {t('projects.import.conflicts')}
                  </p>
                  {importParsed.conflicts.projectNameTaken && (
                    <p className="text-muted-foreground">{t('projects.import.conflictProjectName', { name: importParsed.manifest.project.name })}</p>
                  )}
                  {importParsed.conflicts.domains.length > 0 && (
                    <p className="text-muted-foreground">{t('projects.import.conflictDomains', { domains: importParsed.conflicts.domains.join(', ') })}</p>
                  )}
                </div>
              )}

              {/* Warnings */}
              {importParsed.warnings.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1">
                  <p className="font-semibold flex items-center gap-1">
                    <AlertTriangle size={12} className="text-muted-foreground" /> {t('projects.import.warnings')}
                  </p>
                  <ul className="list-disc pl-4 text-muted-foreground space-y-0.5">
                    {importParsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {/* Target server (MULTI mode only) */}
              {isMultiMode && (
                <div className="space-y-2">
                  <Label className="text-xs">{t('projects.import.targetServer')}</Label>
                  <Select value={importTargetServerId} onChange={(e) => setImportTargetServerId(e.target.value)}>
                    <option value="">{t('projects.import.selectServerOption')}</option>
                    {onlineServers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}{s.host ? ` (${s.host})` : ''}</option>
                    ))}
                  </Select>
                </div>
              )}

              {/* Domain strategy */}
              <div className="space-y-2">
                <Label className="text-xs">{t('projects.import.domainStrategy')}</Label>
                <Select value={importDomainStrategy} onChange={(e) => setImportDomainStrategy(e.target.value as DomainStrategy)}>
                  <option value="skip">{t('projects.import.domainSkip')}</option>
                  <option value="attach">{t('projects.import.domainAttach')}</option>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {importDomainStrategy === 'attach' ? t('projects.import.domainAttachDesc') : t('projects.import.domainSkipDesc')}
                </p>
              </div>

              {/* Host-access consent — only when the archive carries apps that
                  take full host control (docker socket / host bind-mounts). */}
              {importParsed?.manifest.applications.some((a) => a.requiresHostAccess) && (
                <label className="flex items-start gap-2 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={importAllowHost}
                    onChange={(e) => setImportAllowHost(e.target.checked)}
                  />
                  <span>
                    <span className="flex items-center gap-1 font-semibold text-orange-600">
                      <AlertTriangle size={13} /> {t('projects.import.hostAccessTitle')}
                    </span>
                    <span className="text-muted-foreground block mt-0.5">{t('projects.import.hostAccessDesc')}</span>
                  </span>
                </label>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" disabled={applyMutation.isPending} onClick={() => { setImportStep(1); setImportParsed(null); }}>
                {t('projects.import.back')}
              </Button>
              <Button disabled={applyMutation.isPending} onClick={() => applyMutation.mutate()}>
                {applyMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                {applyMutation.isPending ? t('projects.import.importing') : t('projects.import.submit')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}
