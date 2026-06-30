'use client';

import { useState, type MouseEvent } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Database,
  Trash2,
  Loader2,
  Eye,
  EyeOff,
  Copy,
  Check,
  Play,
  Square,
  FolderKanban,
  Rocket,
  Link as LinkIcon,
  Download,
  KeyRound,
  UserCog,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/toast-error';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { DatabaseResponse } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useProjects, useApplications, useDeployTargets, usePublicSettings } from '@/lib/hooks';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// Shared API resource type — local alias keeps the diff/readability small.
type DatabaseItem = DatabaseResponse;

interface ProjectOpt { id: string; name: string }
interface AppOpt { id: string; name: string; projectId: string }

const DB_TYPES = [
  { value: 'POSTGRESQL', label: 'PostgreSQL', emoji: '🐘' },
  { value: 'MYSQL', label: 'MySQL', emoji: '🐬' },
  { value: 'MARIADB', label: 'MariaDB', emoji: '🦭' },
  { value: 'REDIS', label: 'Redis', emoji: '🔴' },
  { value: 'KEYDB', label: 'KeyDB', emoji: '🗝️' },
  { value: 'DRAGONFLY', label: 'Dragonfly', emoji: '🐉' },
  { value: 'MONGODB', label: 'MongoDB', emoji: '🍃' },
  { value: 'CLICKHOUSE', label: 'ClickHouse', emoji: '📊' },
] as const;

const typeBadgeColors: Record<string, string> = {
  POSTGRESQL: 'bg-blue-500/20 text-blue-400 border-transparent',
  MYSQL: 'bg-orange-500/20 text-orange-400 border-transparent',
  MARIADB: 'bg-teal-500/20 text-teal-400 border-transparent',
  REDIS: 'bg-red-500/20 text-red-400 border-transparent',
  KEYDB: 'bg-amber-500/20 text-amber-400 border-transparent',
  DRAGONFLY: 'bg-fuchsia-500/20 text-fuchsia-400 border-transparent',
  MONGODB: 'bg-green-500/20 text-green-400 border-transparent',
  CLICKHOUSE: 'bg-yellow-500/20 text-yellow-400 border-transparent',
};

const typeEmoji: Record<string, string> = {
  POSTGRESQL: '🐘',
  MYSQL: '🐬',
  MARIADB: '🦭',
  REDIS: '🔴',
  KEYDB: '🗝️',
  DRAGONFLY: '🐉',
  MONGODB: '🍃',
  CLICKHOUSE: '📊',
};

const typeLabel: Record<string, string> = {
  POSTGRESQL: 'PostgreSQL',
  MYSQL: 'MySQL',
  MARIADB: 'MariaDB',
  REDIS: 'Redis',
  KEYDB: 'KeyDB',
  DRAGONFLY: 'Dragonfly',
  MONGODB: 'MongoDB',
  CLICKHOUSE: 'ClickHouse',
};

export default function DatabasesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Per-database visibility toggles
  const [visiblePasswords, setVisiblePasswords] = useState<Set<string>>(new Set());
  const [visibleConnStrings, setVisibleConnStrings] = useState<Set<string>>(new Set());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [type, setType] = useState('POSTGRESQL');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [projectId, setProjectId] = useState('');
  const [applicationId, setApplicationId] = useState('');
  // '' = inherit the project's default server (per-DB placement, MULTI mode)
  const [serverChoice, setServerChoice] = useState('');

  // Filter state
  const [filterProjectId, setFilterProjectId] = useState('');
  const [search, setSearch] = useState('');

  // Credential-management dialogs (target a single DB by id).
  const [manageDb, setManageDb] = useState<DatabaseItem | null>(null);
  const [manageMode, setManageMode] = useState<'password' | 'username' | null>(null);

  // Projects + applications (for selectors and badges)
  const { data: projects = [] } = useProjects<ProjectOpt[]>();
  const { data: allApps = [] } = useApplications<AppOpt[]>();
  const appsForCurrentProject = projectId
    ? allApps.filter((a) => a.projectId === projectId)
    : [];

  // MULTI mode → per-DB server picker; default = the project's server
  // (the API resolves that when serverId is omitted).
  const { data: publicSettings } = usePublicSettings<{ deployment_mode?: string }>({
    staleTime: 60_000,
  });
  const isMultiMode = publicSettings?.deployment_mode === 'MULTI';
  // /servers/mine — accessible to non-admin DEVELOPERs (unlike admin-only /servers).
  const { data: servers = [] } = useDeployTargets({ enabled: isMultiMode });

  const { data: databases = [], isLoading } = useQuery<DatabaseItem[]>({
    queryKey: ['databases', filterProjectId],
    queryFn: () => api.get(`/databases${filterProjectId ? `?projectId=${filterProjectId}` : ''}`),
  });

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      type: string;
      serverId?: string;
      projectId: string;
      applicationId?: string;
      username?: string;
      password?: string;
    }) => api.post('/databases', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      toast.success(t('toast.dbCreated'));
      closeCreateDialog();
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/databases/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      toast.success(t('toast.dbDeleted'));
      setDeleteId(null);
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  function closeCreateDialog() {
    setShowCreateDialog(false);
    setName('');
    setType('POSTGRESQL');
    setUsername('');
    setPassword('');
    setProjectId('');
    setApplicationId('');
    setServerChoice('');
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !projectId) return;
    createMutation.mutate({
      name: name.trim(),
      type,
      projectId,
      // omitted = the API places the DB on the project's server
      ...(serverChoice ? { serverId: serverChoice } : {}),
      ...(applicationId ? { applicationId } : {}),
      ...(username.trim() ? { username: username.trim() } : {}),
      ...(password ? { password } : {}),
    });
  }

  function togglePasswordVisibility(dbId: string) {
    setVisiblePasswords((prev) => {
      const next = new Set(prev);
      if (next.has(dbId)) next.delete(dbId);
      else next.add(dbId);
      return next;
    });
  }

  function toggleConnStringVisibility(dbId: string) {
    setVisibleConnStrings((prev) => {
      const next = new Set(prev);
      if (next.has(dbId)) next.delete(dbId);
      else next.add(dbId);
      return next;
    });
  }

  async function copyToClipboard(text: string, dbId: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(dbId);
      toast.success(t('toast.copiedToClipboard'));
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error(t('toast.failedToCopy'));
    }
  }

  function formatDate(date: string) {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  function getStatus(status: string): 'running' | 'deploying' | 'stopped' {
    if (status === 'running') return 'running';
    if (status === 'deploying') return 'deploying';
    return 'stopped';
  }

  const dbActionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
      api.post(`/databases/${id}/${action}`),
    onSuccess: (_, { action }) => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      toast.success(
        t(action === 'start' ? 'toast.dbStarted' : action === 'stop' ? 'toast.dbStopped' : 'databases.restarted'),
      );
    },
    onError: (err: Error) => toastError(err),
  });

  // Engines whose credentials can be managed (mirror the API guard).
  const SQL_ENGINES = ['POSTGRESQL', 'MYSQL', 'MARIADB'];
  const canManageCreds = (db: DatabaseItem) =>
    !db.autoImported && SQL_ENGINES.includes(db.type);

  // One-click dump download. Streams the dump through the auth-aware
  // rawFetch (shares the access-token refresh pipeline), then materializes
  // the response as a blob so the browser saves it with the server-suggested
  // filename. We hold a per-row in-flight id so the button shows a spinner.
  const [exportingId, setExportingId] = useState<string | null>(null);
  async function handleExport(id: string) {
    setExportingId(id);
    try {
      const res = await api.rawFetch(`/databases/${id}/export`);
      if (!res.ok) {
        // The API returns JSON {message} for the BadRequest cases (remote
        // server, unsupported engine) — surface that message verbatim.
        let msg = `Export failed (${res.status})`;
        try { const j = await res.json(); if (j?.message) msg = j.message; } catch {}
        throw new Error(msg);
      }
      const disp = res.headers.get('Content-Disposition') || '';
      const m = /filename="([^"]+)"/.exec(disp);
      const filename = m?.[1] || `database-${id}.sql`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(t('toast.dbExported') || 'Database exported');
    } catch (err) {
      toastError(err as Error);
    } finally {
      setExportingId(null);
    }
  }

  const deletingDb = databases.find((db) => db.id === deleteId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">{t('databases.title')}</h1>
          <p className="text-muted-foreground">{t('databases.subtitle')}</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus size={16} />
          {t('databases.create')}
        </Button>
      </div>

      {/* Search + project filter — search fills the row, filters on the right.
          Gated on whether filtering is even possible (projects exist) or active
          (search/filter set), NOT on the result count — otherwise a project
          filter that yields zero rows would HIDE its own 'Clear' button and
          trap the user on an empty view with no way to reset. */}
      {(databases.length > 0 || projects.length > 0 || !!search || !!filterProjectId) && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Database size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t('databases.searchPlaceholder')}
              className="pl-9 h-10"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {projects.length > 0 && projects.length <= 4 ? (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="default" variant={filterProjectId === '' ? 'default' : 'outline'} onClick={() => setFilterProjectId('')}>
                {t('databases.filterAll')}
              </Button>
              {projects.map((p) => (
                <Button
                  key={p.id}
                  size="default"
                  variant={filterProjectId === p.id ? 'default' : 'outline'}
                  onClick={() => setFilterProjectId(filterProjectId === p.id ? '' : p.id)}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          ) : projects.length > 0 ? (
            <div className="w-52 shrink-0">
              <Select value={filterProjectId} onChange={(e) => setFilterProjectId(e.target.value)}>
                <option value="">{t('databases.filterAll')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
          ) : null}
          {(search || filterProjectId) && (
            <Button variant="ghost" onClick={() => { setSearch(''); setFilterProjectId(''); }}>
              {t('databases.filterClear')}
            </Button>
          )}
        </div>
      )}

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[1, 2].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader>
                <div className="h-5 w-40 rounded bg-muted" />
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="h-4 w-full rounded bg-muted" />
                  <div className="h-4 w-3/4 rounded bg-muted" />
                  <div className="h-4 w-1/2 rounded bg-muted" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : databases.length === 0 ? (
        /* Empty state */
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <Database size={32} className="text-muted-foreground" />
            </div>
            <p className="mt-4 text-lg font-semibold">{t('databases.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('databases.emptyDescLong')}
            </p>
            <Button className="mt-6" onClick={() => setShowCreateDialog(true)}>
              <Plus size={16} />
              {t('databases.emptyCta')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        /* Database cards */
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {databases
            .filter((db) => {
              const q = search.trim().toLowerCase();
              if (!q) return true;
              return (
                db.name.toLowerCase().includes(q) ||
                (db.username || '').toLowerCase().includes(q) ||
                db.type.toLowerCase().includes(q)
              );
            })
            .map((db) => {
            const status = getStatus(db.status);
            const running = status === 'running';
            const deploying = status === 'deploying';
            const pwVisible = visiblePasswords.has(db.id);
            const connVisible = visibleConnStrings.has(db.id);
            const isCopied = copiedId === db.id;

            return (
              <Card
                key={db.id}
                className="hover:border-primary/50 transition-colors"
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-2xl" role="img" aria-label={typeLabel[db.type]}>
                        {typeEmoji[db.type] || '🗄️'}
                      </span>
                      <div>
                        <CardTitle className="text-xl">{db.name}</CardTitle>
                        <div className="mt-1 flex items-center gap-2 flex-wrap">
                          <Badge className={cn(typeBadgeColors[db.type] || '')}>
                            {typeLabel[db.type] || db.type}
                          </Badge>
                          <span className="flex items-center gap-1.5 text-xs">
                            {deploying ? (
                              <>
                                <Loader2 size={12} className="animate-spin text-warning" />
                                <span className="text-warning">{t('databases.statusDeploying')}</span>
                              </>
                            ) : (
                              <>
                                <span className={cn('inline-block h-2 w-2 rounded-full', running ? 'bg-emerald-500' : 'bg-red-500')} />
                                <span className={running ? 'text-emerald-500' : 'text-red-400'}>
                                  {running ? t('databases.statusRunning') : t('databases.statusStopped')}
                                </span>
                              </>
                            )}
                          </span>
                        </div>
                        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                          {db.project ? (
                            <Link href={`/dashboard/projects/${db.project.id}`} onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}>
                              <Badge variant="outline" className="gap-1 text-[10px] hover:bg-accent">
                                <FolderKanban size={9} /> {db.project.name}
                              </Badge>
                            </Link>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground border-dashed">
                              <LinkIcon size={9} className="mr-1" /> {t('databases.unlinked')}
                            </Badge>
                          )}
                          {db.application && (
                            <Link href={`/dashboard/applications/${db.application.id}`} onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}>
                              <Badge variant="outline" className="gap-1 text-[10px] hover:bg-accent">
                                <Rocket size={9} /> {db.application.name}
                              </Badge>
                            </Link>
                          )}
                          {db.autoImported && (
                            <Badge
                              variant="outline"
                              className="text-[10px] border-amber-500/40 text-amber-500"
                              title={t('databases.autoTitle', { service: db.serviceName ? t('databases.autoTitleService', { name: db.serviceName }) : '' })}
                            >
                              {t('databases.autoBadge')}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {/* Export (download dump) — read-only, so it's safe for
                          BOTH auto-imported (parent-app-owned) and manually
                          provisioned DBs. Only when the container is up. */}
                      {!deploying && running && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-primary"
                          disabled={exportingId === db.id}
                          onClick={() => handleExport(db.id)}
                          title={t('databases.actionExport') || 'Export (download dump)'}
                        >
                          {exportingId === db.id ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Download size={14} />
                          )}
                        </Button>
                      )}
                      {/* Auto-imported DBs are owned by the parent app's
                          compose stack — start/stop/delete must go through
                          the application page so the whole stack stays
                          consistent. We show a quick jump-link instead. */}
                      {db.autoImported ? (
                        <>
                          {db.application && (
                            <Link
                              href={`/dashboard/applications/${db.application.id}`}
                              onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                            >
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs"
                                title={t('databases.manageInAppTitle')}
                              >
                                <Rocket size={12} className="mr-1" />
                                {t('databases.manageInApp')}
                              </Button>
                            </Link>
                          )}
                          {/* Bundled DBs ARE deletable now (backend tears down
                              the real sidecar container + warns). The confirm
                              dialog carries the "stack becomes incomplete"
                              caveat for auto-imported rows. */}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteId(db.id)}
                            title={t('databases.actionDelete') || 'Delete'}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </>
                      ) : (
                        <>
                          {/* Credential management (SQL engines only). */}
                          {canManageCreds(db) && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-primary"
                                onClick={() => { setManageDb(db); setManageMode('password'); }}
                                title={t('databases.resetPassword')}
                              >
                                <KeyRound size={14} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-muted-foreground hover:text-primary"
                                onClick={() => { setManageDb(db); setManageMode('username'); }}
                                title={t('databases.changeUsername')}
                              >
                                <UserCog size={14} />
                              </Button>
                            </>
                          )}
                          {!deploying && running && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-blue-500"
                              disabled={dbActionMutation.isPending}
                              onClick={() => dbActionMutation.mutate({ id: db.id, action: 'restart' })}
                              title={t('databases.restart')}
                            >
                              <RefreshCw size={14} />
                            </Button>
                          )}
                          {!deploying && running && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-orange-500"
                              disabled={dbActionMutation.isPending}
                              onClick={() => dbActionMutation.mutate({ id: db.id, action: 'stop' })}
                              title={t('databases.actionStop')}
                            >
                              <Square size={14} />
                            </Button>
                          )}
                          {!deploying && !running && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-emerald-500"
                              disabled={dbActionMutation.isPending}
                              onClick={() => dbActionMutation.mutate({ id: db.id, action: 'start' })}
                              title={t('databases.actionStart')}
                            >
                              <Play size={14} />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => setDeleteId(db.id)}
                          >
                            <Trash2 size={15} />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  {/* ── INTERNAL: app→DB inside the project (the one that works
                      for PrestaShop/WordPress hosted here). Shown FIRST + as
                      recommended. Only when the API provides inNetwork. ── */}
                  {db.inNetwork && (
                    <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                          {t('databases.connInternal')}
                        </p>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(db.inNetwork!.url, db.id + ':int')}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          title={t('databases.copyConnString')}
                        >
                          {copiedId === db.id + ':int' ? (
                            <Check size={14} className="text-emerald-500" />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground">{t('databases.connInternalHint')}</p>
                      <div className="grid grid-cols-[80px_1fr] gap-y-2 text-sm">
                        <span className="text-muted-foreground">{t('databases.host')}</span>
                        <span className="font-mono text-foreground">{db.inNetwork.host}</span>
                        <span className="text-muted-foreground">{t('databases.port')}</span>
                        <span className="font-mono text-foreground">{db.inNetwork.port}</span>
                        <span className="text-muted-foreground">{t('databases.user')}</span>
                        <span className="font-mono text-foreground">{db.username}</span>
                        <span className="text-muted-foreground">{t('databases.password')}</span>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-foreground">
                            {pwVisible ? db.password : '••••••••••••'}
                          </span>
                          <button
                            type="button"
                            onClick={() => togglePasswordVisibility(db.id)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                            title={pwVisible ? t('databases.hidePassword') : t('databases.showPassword')}
                          >
                            {pwVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── EXTERNAL: from your own machine (localhost:published-port). ── */}
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2.5">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      {db.inNetwork ? t('databases.connExternal') : t('databases.connectionDetails')}
                    </p>
                    {db.inNetwork && (
                      <p className="text-xs text-muted-foreground">{t('databases.connExternalHint')}</p>
                    )}

                    <div className="grid grid-cols-[80px_1fr] gap-y-2 text-sm">
                      {/* Host */}
                      <span className="text-muted-foreground">{t('databases.host')}</span>
                      <span className="font-mono text-foreground">{db.host}</span>

                      {/* Port */}
                      <span className="text-muted-foreground">{t('databases.port')}</span>
                      <span className="font-mono text-foreground">{db.port}</span>

                      {/* Username */}
                      <span className="text-muted-foreground">{t('databases.user')}</span>
                      <span className="font-mono text-foreground">{db.username}</span>

                      {/* Password */}
                      <span className="text-muted-foreground">{t('databases.password')}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-foreground">
                          {pwVisible ? db.password : '••••••••••••'}
                        </span>
                        <button
                          type="button"
                          onClick={() => togglePasswordVisibility(db.id)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                          title={pwVisible ? t('databases.hidePassword') : t('databases.showPassword')}
                        >
                          {pwVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Connection string (external) */}
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        {t('databases.connectionString')}
                      </p>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => toggleConnStringVisibility(db.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          title={connVisible ? t('databases.hide') : t('databases.reveal')}
                        >
                          {connVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(db.connectionString, db.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          title={t('databases.copyConnString')}
                        >
                          {isCopied ? (
                            <Check size={14} className="text-emerald-500" />
                          ) : (
                            <Copy size={14} />
                          )}
                        </button>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <code className="block break-all rounded bg-background/60 px-2 py-1.5 text-xs font-mono text-foreground">
                        {connVisible
                          ? db.connectionString
                          : db.connectionString.replace(/\/\/[^@/]*@/, '//••••••••@')}
                      </code>
                    </div>
                  </div>

                  {/* Created date */}
                  <div className="text-xs text-muted-foreground">
                    {t('databases.createdOn', { date: formatDate(db.createdAt) })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create Database Dialog */}
      <Dialog open={showCreateDialog} onClose={closeCreateDialog}>
        <DialogHeader>
          <DialogTitle>{t('databases.create')}</DialogTitle>
          <DialogDescription>
            {t('databases.createDesc')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="db-name">{t('common.name')}</Label>
            <Input
              id="db-name"
              placeholder={t('databases.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="db-type">{t('databases.type')}</Label>
            <Select
              id="db-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {DB_TYPES.map((dbType) => (
                <option key={dbType.value} value={dbType.value}>
                  {dbType.emoji} {dbType.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="db-project">{t('databases.projectLabel')}</Label>
            <Select
              id="db-project"
              value={projectId}
              onChange={(e) => { setProjectId(e.target.value); setApplicationId(''); }}
              required
            >
              <option value="">{t('databases.selectProject')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
            {projects.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('databases.needProjectBefore')}<Link href="/dashboard/projects" className="text-primary hover:underline">{t('databases.needProjectLink')}</Link>{t('databases.needProjectAfter')}
              </p>
            )}
          </div>

          {projectId && appsForCurrentProject.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="db-app">{t('databases.appLabel')}</Label>
              <Select
                id="db-app"
                value={applicationId}
                onChange={(e) => setApplicationId(e.target.value)}
              >
                <option value="">{t('databases.projectWide')}</option>
                {appsForCurrentProject.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('databases.appHint')}
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="db-username">{t('databases.username')}</Label>
            <Input
              id="db-username"
              placeholder={t('databases.usernamePlaceholder')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="db-password">{t('databases.passwordLabel')}</Label>
            <Input
              id="db-password"
              type="password"
              placeholder={t('databases.passwordPlaceholder')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {isMultiMode && servers.length > 1 && (
            <div className="space-y-2">
              <Label htmlFor="db-server">{t('databases.serverLabel')}</Label>
              <Select
                id="db-server"
                value={serverChoice}
                onChange={(e) => setServerChoice(e.target.value)}
              >
                <option value="">{t('databases.serverDefault')}</option>
                {servers.filter((s) => s.status === 'ONLINE').map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({s.host})</option>
                ))}
              </Select>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            {t('databases.serverInfo')}
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeCreateDialog}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={createMutation.isPending || !projectId}>
              {createMutation.isPending && (
                <Loader2 size={16} className="animate-spin" />
              )}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onClose={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>{t('databases.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('databases.deleteConfirmBefore')}
            <span className="font-semibold text-foreground">
              {deletingDb?.name}
            </span>
            {t('databases.deleteConfirmAfter')}
          </DialogDescription>
        </DialogHeader>
        {deletingDb?.autoImported && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            {t('databases.deleteBundledWarning') ||
              'This database is bundled in an application. Deleting it removes its container now, but the app\'s stack will be incomplete — redeploying the app recreates it. To remove it for good, delete the application.'}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteId(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteId && deleteMutation.mutate(deleteId)}
          >
            {deleteMutation.isPending && (
              <Loader2 size={16} className="animate-spin" />
            )}
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Credential management dialog (reset password / change username) */}
      {manageDb && manageMode && (
        <ManageCredentialsDialog
          db={manageDb}
          mode={manageMode}
          onClose={() => { setManageDb(null); setManageMode(null); }}
          onDone={() => queryClient.invalidateQueries({ queryKey: ['databases'] })}
        />
      )}
    </div>
  );
}

// ─── Credential management dialog ─────────────────────────────────────
//
// Reset password (type or generate) OR change username. Both apply the change
// inside the live DB container AND refresh the linked app, so we warn about the
// redeploy. The new password is shown ONCE on success (the API returns it).
function ManageCredentialsDialog({
  db,
  mode,
  onClose,
  onDone,
}: {
  db: DatabaseItem;
  mode: 'password' | 'username';
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [newUsername, setNewUsername] = useState(db.username || '');
  const [resultPw, setResultPw] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const genPassword = () => {
    // Browser CSPRNG → base64url, mirrors the server's strong default.
    const bytes = new Uint8Array(15);
    crypto.getRandomValues(bytes);
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    setPassword(`dockcontrol_${b64}`);
  };

  const resetPw = useMutation({
    mutationFn: () =>
      api.post<{ password: string; redeployedApp: boolean | null }>(
        `/databases/${db.id}/reset-password`,
        password.trim() ? { password: password.trim() } : {},
      ),
    onSuccess: (res) => {
      setResultPw(res.password);
      if (res.redeployedApp === false) toast.warning(t('databases.linkedAppRedeployFailed'));
      onDone();
    },
    onError: (err: Error) => toastError(err),
  });

  const changeUser = useMutation({
    mutationFn: () => api.patch(`/databases/${db.id}/username`, { username: newUsername.trim() }),
    onSuccess: (res: any) => {
      toast.success(t('databases.usernameChanged'));
      if (res?.redeployedApp === false) toast.warning(t('databases.linkedAppRedeployFailed'));
      onDone();
      onClose();
    },
    onError: (err: Error) => toastError(err),
  });

  const copyPw = async () => {
    if (!resultPw) return;
    try { await navigator.clipboard.writeText(resultPw); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          {mode === 'password' ? <KeyRound size={18} /> : <UserCog size={18} />}
          {mode === 'password' ? t('databases.resetPassword') : t('databases.changeUsername')}
          {' — '}<span className="font-mono text-base">{db.name}</span>
        </DialogTitle>
        <DialogDescription>
          {mode === 'password' ? t('databases.resetPasswordDesc') : t('databases.changeUsernameDesc')}
        </DialogDescription>
      </DialogHeader>

      {/* Success state for password reset — show the new pw once. */}
      {mode === 'password' && resultPw ? (
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">{t('databases.newPasswordOnce')}</p>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 p-2.5">
            <code className="flex-1 font-mono text-sm break-all">{resultPw}</code>
            <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={copyPw}>
              {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('databases.linkedAppsRedeploy')}</p>
        </div>
      ) : mode === 'password' ? (
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="mc-pw">{t('databases.newPassword')}</Label>
            <div className="flex gap-2">
              <Input
                id="mc-pw"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('databases.newPasswordPlaceholder')}
                className="font-mono"
              />
              <Button type="button" variant="outline" className="shrink-0" onClick={genPassword}>
                {t('databases.generate')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('databases.linkedAppsRedeploy')}</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="mc-user">{t('databases.newUsername')}</Label>
            <Input
              id="mc-user"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">{t('databases.linkedAppsRedeploy')}</p>
          </div>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {mode === 'password' && resultPw ? t('common.close') : t('common.cancel')}
        </Button>
        {mode === 'password' && !resultPw && (
          <Button onClick={() => resetPw.mutate()} disabled={resetPw.isPending}>
            {resetPw.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {t('databases.resetPassword')}
          </Button>
        )}
        {mode === 'username' && (
          <Button
            onClick={() => changeUser.mutate()}
            disabled={changeUser.isPending || !newUsername.trim() || newUsername.trim() === db.username}
          >
            {changeUser.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {t('common.save')}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
