'use client';

import { useState } from 'react';
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
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Backup {
  id: string;
  name: string;
  serverId: string;
  server?: { id: string; name: string } | null;
  target: string;
  status: string;
  size: number | null;
  sizeBytes: number | string | null;
  sha256: string | null;
  encryptedAt: boolean;
  schedule: string | null;
  lastRunAt: string | null;
  createdAt: string;
}

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
  const [target, setTarget] = useState('LOCAL');
  const [includeApplications, setIncludeApplications] = useState(true);
  const [includeDatabases, setIncludeDatabases] = useState(true);
  const [includeVolumes, setIncludeVolumes] = useState(true);
  const [schedule, setSchedule] = useState('');

  const { data: server } = useQuery<any>({
    queryKey: ['server-local'],
    queryFn: () => api.get('/servers/local'),
  });
  const serverId = server?.id || '';

  const { data: backups = [], isLoading } = useQuery<Backup[]>({
    queryKey: ['backups'],
    queryFn: () => api.get('/backups'),
  });

  const createMutation = useMutation({
    mutationFn: (data: {
      name: string;
      serverId: string;
      target: string;
      includeApplications?: boolean;
      includeDatabases?: boolean;
      includeVolumes?: boolean;
      schedule?: string;
    }) => api.post('/backups', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.success('Backup created successfully');
      closeCreateDialog();
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => api.post(`/backups/${id}/restore`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.success('Backup restore initiated');
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/backups/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.success('Backup deleted successfully');
      setDeleteId(null);
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  function closeCreateDialog() {
    setShowCreateDialog(false);
    setName('');
    setTarget('LOCAL');
    setIncludeApplications(true);
    setIncludeDatabases(true);
    setIncludeVolumes(true);
    setSchedule('');
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !serverId) return;
    createMutation.mutate({
      name: name.trim(),
      serverId,
      target,
      includeApplications,
      includeDatabases,
      includeVolumes,
      ...(schedule.trim() ? { schedule: schedule.trim() } : {}),
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
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus size={16} />
          {t('backups.create')}
        </Button>
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
                    <th className="px-6 py-3 font-medium">Name</th>
                    <th className="px-6 py-3 font-medium">Server</th>
                    <th className="px-6 py-3 font-medium">{t('backups.target')}</th>
                    <th className="px-6 py-3 font-medium">Status</th>
                    <th className="px-6 py-3 font-medium">{t('backups.size')}</th>
                    <th className="px-6 py-3 font-medium" title="sha256 of the on-disk dump">Integrity</th>
                    <th className="px-6 py-3 font-medium" title="At-rest encryption status">Enc</th>
                    <th className="px-6 py-3 font-medium">{t('backups.schedule')}</th>
                    <th className="px-6 py-3 font-medium">{t('backups.lastRun')}</th>
                    <th className="px-6 py-3 font-medium">Actions</th>
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
                          {backup.server?.name || '—'}
                        </span>
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
                            title="Encrypted at rest (AES-256-GCM)"
                          >
                            <Lock size={14} />
                          </span>
                        ) : (
                          <span
                            className="flex items-center gap-1 text-muted-foreground/60"
                            title="Stored in plaintext on disk"
                          >
                            <Unlock size={14} />
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm text-muted-foreground">
                        {backup.schedule || '—'}
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
                            title="Restore"
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
                            title="Delete"
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
            Configure a new backup job for your server
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
            <Label htmlFor="backup-target">{t('backups.target')}</Label>
            <Select
              id="backup-target"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {TARGETS.map((tgt) => (
                <option key={tgt.value} value={tgt.value}>
                  {tgt.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-3">
            <Label>Include</Label>
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
            <Input
              id="backup-schedule"
              placeholder="0 2 * * * (cron format)"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeCreateDialog}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 size={16} className="animate-spin" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onClose={() => setDeleteId(null)}>
        <DialogHeader>
          <DialogTitle>Delete Backup</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this backup? This action cannot be undone.
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
    </div>
  );
}
