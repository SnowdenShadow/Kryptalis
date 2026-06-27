'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Archive,
  Server,
  Clock,
  HardDrive,
  Trash2,
  RotateCcw,
  Loader2,
  Lock,
  Unlock,
  ShieldCheck,
  CalendarClock,
  FolderKanban,
  Settings2,
} from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/toast-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import type { BackupResponse, RestoreBackupResponse } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useProjects } from '@/lib/hooks';
import { useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// Shared API resource type — local alias keeps the diff/readability small.
// Note: GET /backups returns plain rows (no `server` relation) — the server
// name is resolved locally against the /servers/local query.
type Backup = BackupResponse;

// Minimal project shape from GET /projects. `userId` = owner; `members` is
// filtered server-side to the current user, so members[0]?.role is the
// caller's role on that project.
type ProjectLite = {
  id: string;
  name: string;
  userId?: string;
  members?: { role: string }[];
};

const TARGETS = [
  { value: 'LOCAL', label: 'Local' },
  { value: 'S3', label: 'Amazon S3' },
  { value: 'R2', label: 'Cloudflare R2' },
  { value: 'B2', label: 'Backblaze B2' },
] as const;

const statusVariant: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  PENDING: 'warning',
  IN_PROGRESS: 'warning',
  COMPLETED: 'success',
  FAILED: 'destructive',
};

const targetVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  LOCAL: 'secondary',
  S3: 'default',
  R2: 'default',
  B2: 'outline',
};

/**
 * Schedule presets matching the API's supported subset (see
 * apps/api/src/modules/backups/backup-schedule.util.ts): @hourly, @daily,
 * @weekly, or a 5-field cron "<minute> <hour> * * *". 'custom' expands to
 * the cron form from a time picker; '' means manual-only (no schedule sent).
 */
const SCHEDULE_PRESETS = ['', '@hourly', '@daily', '@weekly', 'custom'] as const;
type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];

const PRESET_LABEL_KEY: Record<SchedulePreset, string> = {
  '': 'backups.scheduleNone',
  '@hourly': 'backups.scheduleHourly',
  '@daily': 'backups.scheduleDaily',
  '@weekly': 'backups.scheduleWeekly',
  custom: 'backups.scheduleCustom',
};

/** "HH:MM" → "<minute> <hour> * * *", or null when not a valid time. */
function timeToCron(time: string): string | null {
  const m = time.match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return `${minute} ${hour} * * *`;
}

/**
 * Human label for a stored schedule expression. Rows with schedule null are
 * one-off dumps (incl. the "(YYYY-MM-DD HH:mm)" children the scheduler
 * spawns) and render as "—" without a badge.
 */
function scheduleBadgeLabel(
  schedule: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (schedule === '@hourly') return t('backups.scheduleBadgeHourly');
  if (schedule === '@daily') return t('backups.scheduleBadgeDaily');
  if (schedule === '@weekly') return t('backups.scheduleBadgeWeekly');
  const m = schedule.match(/^(\d{1,2})\s+(\*|\d{1,2})\s+\*\s+\*\s+\*$/);
  if (m) {
    const minute = String(Number(m[1])).padStart(2, '0');
    if (m[2] === '*') return t('backups.scheduleBadgeHourlyAt', { minute });
    const hour = String(Number(m[2])).padStart(2, '0');
    return t('backups.scheduleBadgeDailyAt', { time: `${hour}:${minute}` });
  }
  // Legacy/unknown expression — show it raw rather than hide it.
  return schedule;
}

function formatBytes(bytes: number | string | null): string {
  if (bytes === null || bytes === undefined) return '—';
  // Prisma BigInt serializes as string in JSON; normalize both shapes.
  const n = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatDate(date: string | null): string {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function BackupsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  // '' = whole-server backup; otherwise a project id to scope the backup to.
  const [projectId, setProjectId] = useState('');
  const [target, setTarget] = useState('LOCAL');
  const [includeApplications, setIncludeApplications] = useState(true);
  const [includeDatabases, setIncludeDatabases] = useState(true);
  const [includeVolumes, setIncludeVolumes] = useState(true);
  const [schedulePreset, setSchedulePreset] = useState<SchedulePreset>('');
  const [customTime, setCustomTime] = useState('03:00');

  const { data: server } = useQuery<any>({
    queryKey: ['server-local'],
    queryFn: () => api.get('/servers/local'),
  });
  const serverId = server?.id || '';

  // Admins may create a WHOLE-SERVER backup (every project). Regular users must
  // scope to one of their own projects — the 'whole server' option is hidden
  // and the picker defaults to their first project.
  const { user } = useAuthStore();
  const isAdmin = !!user?.role && (user.role === 'ADMIN' || user.role === 'SUPERADMIN');

  // Projects (for the scope selector + resolving a backup's project name).
  // userId = owner; members[] is filtered server-side to the current user so
  // members[0]?.role is THIS user's role on the project.
  const { data: projects = [] } = useProjects<ProjectLite[]>();
  const projectName = (id?: string | null) => projects.find((p) => p.id === id)?.name;

  // Effective project role helpers (mirror the API's RBAC ranks). Platform
  // admin = owner everywhere; project owner outranks any member role.
  const projectRoleRank = (p?: ProjectLite | null): number => {
    if (!p) return 0;
    if (isAdmin) return 100; // platform admin → OWNER-equivalent
    if (user?.id && p.userId === user.id) return 100; // project owner
    const role = p.members?.[0]?.role;
    return { OWNER: 100, ADMIN: 80, DEVELOPER: 50, VIEWER: 10 }[role || ''] ?? 0;
  };
  // Configuring remote storage = project ADMIN (rank >= 80).
  const canManageStorage = (p?: ProjectLite | null): boolean => projectRoleRank(p) >= 80;
  // Creating a backup = project DEVELOPER (rank >= 50) — matches create()'s gate.
  const canBackupProject = (p?: ProjectLite | null): boolean => projectRoleRank(p) >= 50;

  // Projects whose remote storage THIS user is allowed to configure.
  const manageableProjects = projects.filter(canManageStorage);
  // Projects this user may actually back up (avoids offering a doomed scope).
  const backupableProjects = projects.filter(canBackupProject);
  const selectedProject = projects.find((p) => p.id === projectId) || null;

  // Non-admins can't do whole-server backups → default the scope to a project
  // they can actually back up (DEVELOPER+), not just any accessible one.
  useEffect(() => {
    if (!isAdmin && !projectId && backupableProjects.length > 0) {
      setProjectId(backupableProjects[0].id);
    }
  }, [isAdmin, projectId, backupableProjects]);

  const { data: backups = [], isLoading } = useQuery<Backup[]>({
    queryKey: ['backups'],
    queryFn: () => api.get('/backups'),
  });

  // Remote targets (S3/R2/B2) are selectable once storage is configured — for
  // the SELECTED project (its own bucket) OR globally (admin). Re-queried per
  // project so picking a project reflects its own readiness.
  const { data: targetInfo } = useQuery<{ targets: string[]; s3Configured: boolean; projectConfigured: boolean }>({
    queryKey: ['backup-targets', projectId || 'server'],
    queryFn: () => api.get(`/backups/targets${projectId ? `?projectId=${projectId}` : ''}`),
  });
  const s3Configured = targetInfo?.s3Configured ?? false;
  const projectStorageConfigured = targetInfo?.projectConfigured ?? false;

  // Per-project remote storage config dialog. Holds the project id being
  // configured (null = closed). Opened either from the page header (with a
  // built-in project picker) or from the create dialog (pre-scoped).
  const [storageProjectId, setStorageProjectId] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      serverId: string;
      projectId?: string;
      target: string;
      includeApplications?: boolean;
      includeDatabases?: boolean;
      includeVolumes?: boolean;
      schedule?: string;
    }) => api.post('/backups', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.success(t('toast.backupCreated'));
      closeCreateDialog();
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) =>
      api.post<RestoreBackupResponse>(`/backups/${id}/restore`),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      // Two API shapes: local server → synchronous counters
      // (databasesRestored/volumesRestored); remote server → task queued on
      // the agent (databasesQueued/volumesQueued, message contains "queued").
      if ('databasesRestored' in res) {
        toast.success(
          t('toast.backupRestoreDone', {
            dbs: res.databasesRestored,
            vols: res.volumesRestored,
          }),
        );
      } else {
        toast.success(t('toast.backupRestoreQueued'));
      }
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/backups/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.success(t('toast.backupDeleted'));
      setDeleteId(null);
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  function closeCreateDialog() {
    setShowCreateDialog(false);
    setName('');
    setProjectId('');
    setTarget('LOCAL');
    setIncludeApplications(true);
    setIncludeDatabases(true);
    setIncludeVolumes(true);
    setSchedulePreset('');
    setCustomTime('03:00');
  }

  // Resolved schedule expression sent to the API ('' = manual only,
  // null = custom preset with an invalid/empty time → block submit).
  const resolvedSchedule: string | null =
    schedulePreset === 'custom' ? timeToCron(customTime) : schedulePreset;

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !serverId) return;
    // Non-admins must scope to a project (whole-server backups are admin-only).
    if (!isAdmin && !projectId) return;
    if (resolvedSchedule === null) return; // invalid custom time — input shows the error
    createMutation.mutate({
      name: name.trim(),
      serverId,
      ...(projectId ? { projectId } : {}),
      target,
      includeApplications,
      includeDatabases,
      includeVolumes,
      ...(resolvedSchedule ? { schedule: resolvedSchedule } : {}),
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{t('backups.title')}</h1>
          <p className="text-muted-foreground">
            {t('backups.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Discoverable entry point: any project OWNER/ADMIN can wire their
              own S3/R2/B2 bucket without touching the create dialog. */}
          {manageableProjects.length > 0 && (
            <Button
              variant="outline"
              onClick={() => setStorageProjectId(manageableProjects[0].id)}
            >
              <Settings2 size={16} />
              {t('backups.remoteStorage')}
            </Button>
          )}
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus size={16} />
            {t('backups.create')}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="py-8">
            <div className="animate-pulse space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 rounded bg-muted" />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : backups.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Archive size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('backups.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('backups.emptyDesc')}
            </p>
            <Button className="mt-4" onClick={() => setShowCreateDialog(true)}>
              <Plus size={16} />
              {t('backups.create')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-left text-sm text-muted-foreground">
                    <th className="px-6 py-3 font-medium">{t('common.name')}</th>
                    <th className="px-6 py-3 font-medium">{t('backups.colServer')}</th>
                    <th className="px-6 py-3 font-medium">{t('backups.scope')}</th>
                    <th className="px-6 py-3 font-medium">{t('backups.target')}</th>
                    <th className="px-6 py-3 font-medium">{t('common.status')}</th>
                    <th className="px-6 py-3 font-medium">{t('backups.size')}</th>
                    <th className="px-6 py-3 font-medium" title={t('backups.colIntegrityTip')}>{t('backups.colIntegrity')}</th>
                    <th className="px-6 py-3 font-medium" title={t('backups.colEncTip')}>{t('backups.colEnc')}</th>
                    <th className="px-6 py-3 font-medium">{t('backups.schedule')}</th>
                    <th className="px-6 py-3 font-medium">{t('backups.lastRun')}</th>
                    <th className="px-6 py-3 font-medium">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map((backup) => (
                    <tr
                      key={backup.id}
                      className="border-b border-border last:border-0 hover:bg-muted/50"
                    >
                      <td className="px-6 py-4 font-medium">{backup.name}</td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Server size={14} />
                          {(backup.serverId === server?.id ? server?.name : null) || '—'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm">
                        {backup.projectId ? (
                          <Badge variant="outline" className="gap-1">
                            <FolderKanban size={12} />
                            {projectName(backup.projectId) || t('backups.aProject')}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground/70 text-xs">{t('backups.wholeServer')}</span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <Badge variant={targetVariant[backup.target] || 'secondary'}>
                          {backup.target}
                        </Badge>
                      </td>
                      <td className="px-6 py-4">
                        <Badge
                          variant={statusVariant[backup.status] || 'secondary'}
                          className={cn(
                            backup.status === 'IN_PROGRESS' && 'animate-pulse',
                          )}
                        >
                          {backup.status}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <HardDrive size={14} />
                          {formatBytes(backup.sizeBytes ?? backup.size)}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {backup.sha256 ? (
                          <span
                            className="flex items-center gap-1 font-mono"
                            title={`sha256: ${backup.sha256}`}
                          >
                            <ShieldCheck size={14} className="text-green-600" />
                            {backup.sha256.slice(0, 8)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {backup.encryptedAt ? (
                          <span
                            className="flex items-center gap-1 text-green-600"
                            title={t('backups.encryptedTip')}
                          >
                            <Lock size={14} />
                          </span>
                        ) : (
                          <span
                            className="flex items-center gap-1 text-muted-foreground/60"
                            title={t('backups.plaintextTip')}
                          >
                            <Unlock size={14} />
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {backup.schedule ? (
                          <Badge variant="outline" title={backup.schedule}>
                            <CalendarClock size={12} className="mr-1" />
                            {scheduleBadgeLabel(backup.schedule, t)}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Clock size={14} />
                          {formatDate(backup.lastRunAt)}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t('backups.restore')}
                            disabled={
                              restoreMutation.isPending ||
                              backup.status === 'IN_PROGRESS' ||
                              backup.status === 'PENDING'
                            }
                            onClick={() => restoreMutation.mutate(backup.id)}
                          >
                            <RotateCcw size={16} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t('common.delete')}
                            onClick={() => setDeleteId(backup.id)}
                          >
                            <Trash2 size={16} className="text-destructive" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Create Backup Dialog */}
      <Dialog open={showCreateDialog} onClose={closeCreateDialog}>
        <DialogHeader>
          <DialogTitle>{t('backups.create')}</DialogTitle>
          <DialogDescription>
            {t('backups.createDesc')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="backup-name">{t('common.name')}</Label>
            <Input
              id="backup-name"
              placeholder="daily-backup"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="backup-scope">{t('backups.scope')}</Label>
            <Select
              id="backup-scope"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {/* Whole-server backups are admin-only. */}
              {isAdmin && <option value="">{t('backups.wholeServer')}</option>}
              {/* Only projects the caller can actually back up (DEVELOPER+) —
                  offering a VIEWER project would guarantee a 403 on submit. */}
              {backupableProjects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              {projectId ? t('backups.scopeProjectHint') : t('backups.scopeServerHint')}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="backup-target">{t('backups.target')}</Label>
            <Select
              id="backup-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {TARGETS.map((tgt) => {
                const remoteDisabled = tgt.value !== 'LOCAL' && !s3Configured;
                return (
                  <option key={tgt.value} value={tgt.value} disabled={remoteDisabled}>
                    {tgt.label}
                    {remoteDisabled ? ` — ${t('backups.s3NotConfigured')}` : ''}
                  </option>
                );
              })}
            </Select>
            {/* Per-project remote storage: an OWNER/ADMIN of the project can
                wire its own S3/R2/B2 bucket so remote targets become available.
                Only OWNER/ADMIN see the configure action (others would 403). */}
            {projectId ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                {projectStorageConfigured ? t('backups.projectStorageOn') : t('backups.projectStorageOff')}
                {canManageStorage(selectedProject) ? (
                  <button
                    type="button"
                    onClick={() => setStorageProjectId(projectId)}
                    className="text-primary hover:underline inline-flex items-center gap-1"
                  >
                    <Settings2 size={12} /> {t('backups.configureStorage')}
                  </button>
                ) : (
                  !projectStorageConfigured && <span>{t('backups.storageAdminOnly')}</span>
                )}
              </p>
            ) : (
              // Whole-server scope (admin): remote uses the global admin bucket.
              !s3Configured && <p className="text-xs text-muted-foreground">{t('backups.s3Hint')}</p>
            )}
          </div>

          <div className="space-y-3">
            <Label>{t('backups.include')}</Label>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input
                  id="inc-apps"
                  type="checkbox"
                  checked={includeApplications}
                  onChange={(e) => setIncludeApplications(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor="inc-apps">{t('backups.includeApps')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="inc-dbs"
                  type="checkbox"
                  checked={includeDatabases}
                  onChange={(e) => setIncludeDatabases(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor="inc-dbs">{t('backups.includeDbs')}</Label>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="inc-vols"
                  type="checkbox"
                  checked={includeVolumes}
                  onChange={(e) => setIncludeVolumes(e.target.checked)}
                  className="h-4 w-4 rounded border-input"
                />
                <Label htmlFor="inc-vols">{t('backups.includeVolumes')}</Label>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="backup-schedule">{t('backups.schedule')}</Label>
            <Select
              id="backup-schedule"
              value={schedulePreset}
              onChange={(e) => setSchedulePreset(e.target.value as SchedulePreset)}
            >
              {SCHEDULE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {t(PRESET_LABEL_KEY[preset])}
                </option>
              ))}
            </Select>
            {schedulePreset === 'custom' && (
              <div className="space-y-1">
                <Label htmlFor="backup-schedule-time" className="text-xs text-muted-foreground">
                  {t('backups.scheduleCustomTime')}
                </Label>
                <Input
                  id="backup-schedule-time"
                  type="time"
                  value={customTime}
                  onChange={(e) => setCustomTime(e.target.value)}
                  required
                  className="w-40"
                />
                {resolvedSchedule === null ? (
                  <p className="text-xs text-destructive">
                    {t('backups.scheduleCustomInvalid')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('backups.scheduleCustomHint', { cron: resolvedSchedule })}
                  </p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeCreateDialog}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={createMutation.isPending || resolvedSchedule === null}>
              {createMutation.isPending && <Loader2 size={16} className="animate-spin" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onClose={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>{t('backups.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('backups.deleteConfirm')}
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
            {deleteMutation.isPending && <Loader2 size={16} className="animate-spin" />}
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Per-project remote storage config. The dialog carries its own project
          picker (limited to projects the user can manage) so it's a complete,
          self-contained flow whether opened from the header or the create form. */}
      {storageProjectId && (
        <ProjectStorageDialog
          projectId={storageProjectId}
          projects={manageableProjects}
          onChangeProject={setStorageProjectId}
          onClose={() => setStorageProjectId(null)}
        />
      )}
    </div>
  );
}

// ─── Per-project remote storage (S3 / R2 / B2) config dialog ──────────
//
// Lets a project OWNER/ADMIN wire the project's OWN bucket so its remote
// backups go there instead of the shared admin config. The secret key is
// write-only — the API never returns it; "leave empty to keep" applies on
// update. Carries its own project picker so it's a self-contained flow.
function ProjectStorageDialog({
  projectId,
  projects,
  onChangeProject,
  onClose,
}: {
  projectId: string;
  projects: ProjectLite[];
  onChangeProject: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const projectName = projects.find((p) => p.id === projectId)?.name || '';
  const [target, setTarget] = useState('R2');
  const [endpoint, setEndpoint] = useState('');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [secretKeySet, setSecretKeySet] = useState(false);

  const { data: cfg } = useQuery<any>({
    queryKey: ['project-storage', projectId],
    queryFn: () => api.get(`/backups/projects/${projectId}/storage`),
  });
  // CLEAR every field the instant the project changes — independent of the
  // fetch — so the previous project's credentials (endpoint/bucket/accessKey)
  // can never linger in the form while the new project's config loads.
  useEffect(() => {
    setTarget('R2');
    setEndpoint('');
    setBucket('');
    setRegion('');
    setAccessKey('');
    setSecretKey('');
    setSecretKeySet(false);
  }, [projectId]);
  // Then populate from the loaded config once it arrives for THIS project.
  useEffect(() => {
    if (!cfg) return;
    setTarget(cfg.configured ? cfg.target || 'R2' : 'R2');
    setEndpoint(cfg.configured ? cfg.endpoint || '' : '');
    setBucket(cfg.configured ? cfg.bucket || '' : '');
    setRegion(cfg.configured ? cfg.region || '' : '');
    setAccessKey(cfg.configured ? cfg.accessKey || '' : '');
    setSecretKeySet(!!cfg.configured && !!cfg.secretKeySet);
    setSecretKey('');
  }, [cfg]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project-storage', projectId] });
    queryClient.invalidateQueries({ queryKey: ['backup-targets'] });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put(`/backups/projects/${projectId}/storage`, {
        target, endpoint: endpoint.trim(), bucket: bucket.trim(),
        region: region.trim() || undefined, accessKey: accessKey.trim(),
        ...(secretKey.trim() ? { secretKey: secretKey.trim() } : {}),
      }),
    onSuccess: () => { invalidate(); toast.success(t('backups.storageSaved')); onClose(); },
    onError: (err: Error) => toastError(err),
  });
  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/backups/projects/${projectId}/storage`),
    onSuccess: () => { invalidate(); toast.success(t('backups.storageRemoved')); onClose(); },
    onError: (err: Error) => toastError(err),
  });
  const testMutation = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string }>(`/backups/projects/${projectId}/storage/test`, {}),
    onSuccess: (res) => {
      if (res.ok) toast.success(t('backups.storageTestOk'));
      else toast.error(t('backups.storageTestFail', { error: res.error || '' }));
    },
    onError: (err: Error) => toastError(err),
  });

  const canSave = !!endpoint.trim() && !!bucket.trim() && !!accessKey.trim() && (secretKeySet || !!secretKey.trim());
  // "Test" validates the SAVED credentials (the API reads them from the DB).
  // Disable it while the form diverges from what's stored, so a user never
  // tests stale values after editing — they must Save first.
  const dirty =
    !!cfg?.configured &&
    (target !== (cfg.target || 'R2') ||
      endpoint.trim() !== (cfg.endpoint || '') ||
      bucket.trim() !== (cfg.bucket || '') ||
      (region.trim() || '') !== (cfg.region || '') ||
      accessKey.trim() !== (cfg.accessKey || '') ||
      !!secretKey.trim());

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle>{t('backups.remoteStorage')}</DialogTitle>
        <DialogDescription>{t('backups.remoteStorageHint')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-2">
        {/* Project picker — switch which project's storage you're editing.
            Single project = a static label (no need to choose). */}
        <div className="space-y-1.5">
          <Label htmlFor="st-project">{t('backups.aProject')}</Label>
          {projects.length > 1 ? (
            <Select id="st-project" value={projectId} onChange={(e) => onChangeProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          ) : (
            <p className="text-sm font-medium">{projectName}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="st-target">{t('backups.target')}</Label>
          <Select id="st-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="S3">Amazon S3</option>
            <option value="R2">Cloudflare R2</option>
            <option value="B2">Backblaze B2</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="st-endpoint">{t('backups.s3Endpoint')}</Label>
          <Input id="st-endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://<id>.r2.cloudflarestorage.com" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="st-bucket">{t('backups.s3Bucket')}</Label>
            <Input id="st-bucket" value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-backups" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-region">{t('backups.s3Region')}</Label>
            <Input id="st-region" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="auto" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="st-access">{t('backups.s3AccessKey')}</Label>
          <Input id="st-access" value={accessKey} onChange={(e) => setAccessKey(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="st-secret">{t('backups.s3SecretKey')}</Label>
          <Input id="st-secret" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={secretKeySet ? t('backups.s3SecretKept') : ''} />
        </div>
      </div>

      {/* Test validates the SAVED config; tell the user when edits must be
          saved first so the result is never misread. */}
      {dirty && (
        <p className="text-xs text-muted-foreground">{t('backups.testSaveFirst')}</p>
      )}

      <DialogFooter className="flex-wrap gap-2">
        {cfg?.configured && (
          <Button variant="ghost" className="text-destructive mr-auto" onClick={() => deleteMutation.mutate()} disabled={deleteMutation.isPending}>
            {t('common.delete')}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => testMutation.mutate()}
          disabled={!cfg?.configured || dirty || testMutation.isPending}
          title={t('backups.testConnectionHint')}
        >
          {testMutation.isPending ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : null}
          {t('backups.testConnection')}
        </Button>
        <Button onClick={() => saveMutation.mutate()} disabled={!canSave || saveMutation.isPending}>
          {saveMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
          {t('common.save')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
