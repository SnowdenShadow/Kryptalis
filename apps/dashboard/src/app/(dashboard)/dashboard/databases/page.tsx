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
} from 'lucide-react';
import { toast } from 'sonner';
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
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface DatabaseItem {
  id: string;
  name: string;
  type: string;
  serverId: string;
  projectId: string | null;
  applicationId: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  size: string | null;
  createdAt: string;
  status: string;
  connectionString: string;
  project?: { id: string; name: string } | null;
  application?: { id: string; name: string } | null;
}

interface ProjectOpt { id: string; name: string }
interface AppOpt { id: string; name: string; projectId: string }

const DB_TYPES = [
  { value: 'POSTGRESQL', label: 'PostgreSQL', emoji: '🐘' },
  { value: 'MYSQL', label: 'MySQL', emoji: '🐬' },
  { value: 'MARIADB', label: 'MariaDB', emoji: '🦭' },
  { value: 'REDIS', label: 'Redis', emoji: '🔴' },
  { value: 'MONGODB', label: 'MongoDB', emoji: '🍃' },
] as const;

const typeBadgeColors: Record<string, string> = {
  POSTGRESQL: 'bg-blue-500/20 text-blue-400 border-transparent',
  MYSQL: 'bg-orange-500/20 text-orange-400 border-transparent',
  MARIADB: 'bg-teal-500/20 text-teal-400 border-transparent',
  REDIS: 'bg-red-500/20 text-red-400 border-transparent',
  MONGODB: 'bg-green-500/20 text-green-400 border-transparent',
};

const typeEmoji: Record<string, string> = {
  POSTGRESQL: '🐘',
  MYSQL: '🐬',
  MARIADB: '🦭',
  REDIS: '🔴',
  MONGODB: '🍃',
};

const typeLabel: Record<string, string> = {
  POSTGRESQL: 'PostgreSQL',
  MYSQL: 'MySQL',
  MARIADB: 'MariaDB',
  REDIS: 'Redis',
  MONGODB: 'MongoDB',
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

  // Filter state
  const [filterProjectId, setFilterProjectId] = useState('');

  // Projects + applications (for selectors and badges)
  const { data: projects = [] } = useQuery<ProjectOpt[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });
  const { data: allApps = [] } = useQuery<AppOpt[]>({
    queryKey: ['applications'],
    queryFn: () => api.get('/applications'),
  });
  const appsForCurrentProject = projectId
    ? allApps.filter((a) => a.projectId === projectId)
    : [];

  const { data: server } = useQuery<any>({
    queryKey: ['server-local'],
    queryFn: () => api.get('/servers/local'),
  });
  const serverId = server?.id || '';

  const { data: databases = [], isLoading } = useQuery<DatabaseItem[]>({
    queryKey: ['databases', filterProjectId],
    queryFn: () => api.get(`/databases${filterProjectId ? `?projectId=${filterProjectId}` : ''}`),
  });

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      type: string;
      serverId: string;
      projectId: string;
      applicationId?: string;
      username?: string;
      password?: string;
    }) => api.post('/databases', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      toast.success('Database created successfully');
      closeCreateDialog();
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to create database');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/databases/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      toast.success('Database deleted successfully');
      setDeleteId(null);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to delete database');
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
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !serverId || !projectId) return;
    createMutation.mutate({
      name: name.trim(),
      type,
      serverId,
      projectId,
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
      toast.success('Copied to clipboard');
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      toast.error('Failed to copy');
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
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' }) =>
      api.post(`/databases/${id}/${action}`),
    onSuccess: (_, { action }) => {
      queryClient.invalidateQueries({ queryKey: ['databases'] });
      toast.success(`Database ${action === 'start' ? 'started' : 'stopped'}`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deletingDb = databases.find((db) => db.id === deleteId);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">{t('databases.title')}</h1>
          <p className="text-muted-foreground">{t('databases.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          {projects.length > 0 && (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={filterProjectId === '' ? 'default' : 'outline'}
                onClick={() => setFilterProjectId('')}
              >
                All
              </Button>
              {projects.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={filterProjectId === p.id ? 'default' : 'outline'}
                  onClick={() => setFilterProjectId(filterProjectId === p.id ? '' : p.id)}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          )}
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus size={16} />
            {t('databases.create')}
          </Button>
        </div>
      </div>

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
            <p className="mt-4 text-lg font-semibold">No databases yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Create your first database to get started
            </p>
            <Button className="mt-6" onClick={() => setShowCreateDialog(true)}>
              <Plus size={16} />
              Create your first database
            </Button>
          </CardContent>
        </Card>
      ) : (
        /* Database cards */
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {databases.map((db) => {
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
                                <span className="text-warning">Deploying...</span>
                              </>
                            ) : (
                              <>
                                <span className={cn('inline-block h-2 w-2 rounded-full', running ? 'bg-emerald-500' : 'bg-red-500')} />
                                <span className={running ? 'text-emerald-500' : 'text-red-400'}>
                                  {running ? 'Running' : 'Stopped'}
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
                              <LinkIcon size={9} className="mr-1" /> Unlinked
                            </Badge>
                          )}
                          {db.application && (
                            <Link href={`/dashboard/applications/${db.application.id}`} onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}>
                              <Badge variant="outline" className="gap-1 text-[10px] hover:bg-accent">
                                <Rocket size={9} /> {db.application.name}
                              </Badge>
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {!deploying && running && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-orange-500"
                          disabled={dbActionMutation.isPending}
                          onClick={() => dbActionMutation.mutate({ id: db.id, action: 'stop' })}
                          title="Stop"
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
                          title="Start"
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
                    </div>
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  {/* Connection details */}
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2.5">
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      Connection Details
                    </p>

                    <div className="grid grid-cols-[80px_1fr] gap-y-2 text-sm">
                      {/* Host */}
                      <span className="text-muted-foreground">Host</span>
                      <span className="font-mono text-foreground">{db.host}</span>

                      {/* Port */}
                      <span className="text-muted-foreground">Port</span>
                      <span className="font-mono text-foreground">{db.port}</span>

                      {/* Username */}
                      <span className="text-muted-foreground">User</span>
                      <span className="font-mono text-foreground">{db.username}</span>

                      {/* Password */}
                      <span className="text-muted-foreground">Password</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-foreground">
                          {pwVisible ? db.password : '••••••••••••'}
                        </span>
                        <button
                          type="button"
                          onClick={() => togglePasswordVisibility(db.id)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                          title={pwVisible ? 'Hide password' : 'Show password'}
                        >
                          {pwVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Connection string */}
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        Connection String
                      </p>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => toggleConnStringVisibility(db.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          title={connVisible ? 'Hide' : 'Reveal'}
                        >
                          {connVisible ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(db.connectionString, db.id)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                          title="Copy connection string"
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
                          : db.connectionString.replace(/\/\/.*@/, '//••••••••@')}
                      </code>
                    </div>
                  </div>

                  {/* Created date */}
                  <div className="text-xs text-muted-foreground">
                    Created {formatDate(db.createdAt)}
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
            Provision a new database on your local server
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="db-name">{t('common.name')}</Label>
            <Input
              id="db-name"
              placeholder="my-database"
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
            <Label htmlFor="db-project">Project *</Label>
            <Select
              id="db-project"
              value={projectId}
              onChange={(e) => { setProjectId(e.target.value); setApplicationId(''); }}
              required
            >
              <option value="">Select a project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
            {projects.length === 0 && (
              <p className="text-xs text-muted-foreground">
                You need to <Link href="/dashboard/projects" className="text-primary hover:underline">create a project</Link> first.
              </p>
            )}
          </div>

          {projectId && appsForCurrentProject.length > 0 && (
            <div className="space-y-2">
              <Label htmlFor="db-app">Application (optional)</Label>
              <Select
                id="db-app"
                value={applicationId}
                onChange={(e) => setApplicationId(e.target.value)}
              >
                <option value="">Project-wide (no specific app)</option>
                {appsForCurrentProject.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Link this database to a specific app for easier ownership tracking.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="db-username">{t('databases.username')}</Label>
            <Input
              id="db-username"
              placeholder="Defaults to database name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="db-password">Password (optional)</Label>
            <Input
              id="db-password"
              type="password"
              placeholder="Auto-generated if empty"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Server: auto (local)
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeCreateDialog}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={createMutation.isPending || !serverId || !projectId}>
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
          <DialogTitle>Delete Database</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete{' '}
            <span className="font-semibold text-foreground">
              {deletingDb?.name}
            </span>
            ? All data will be permanently lost. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
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
    </div>
  );
}
