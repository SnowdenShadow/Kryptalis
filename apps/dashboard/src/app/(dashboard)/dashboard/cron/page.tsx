'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Clock,
  Trash2,
  Loader2,
  Play,
  Info,
  Terminal,
  CheckCircle2,
  XCircle,
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
import type { ApplicationResponse } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  command: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastExitCode: number | null;
  lastOutput: string | null;
  applicationId: string;
  nextRunAt: string | null;
  application?: { id: string; name: string; displayName?: string | null };
}

export default function CronJobsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [schedule, setSchedule] = useState('');
  const [command, setCommand] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const { data: jobs = [], isLoading } = useQuery<CronJob[]>({
    queryKey: ['cron-jobs'],
    queryFn: () => api.get('/cron-jobs'),
  });

  const { data: apps = [] } = useQuery<ApplicationResponse[]>({
    queryKey: ['applications'],
    queryFn: () => api.get('/applications'),
  });

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/cron-jobs', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
      toast.success(t('cron.created'));
      closeCreate();
    },
    onError: (err: Error) => toastError(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/cron-jobs/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
      toast.success(t('cron.deleted'));
      setDeleteId(null);
    },
    onError: (err: Error) => toastError(err),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => api.post(`/cron-jobs/${id}/run`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cron-jobs'] });
      toast.success(t('cron.ranNow'));
    },
    onError: (err: Error) => toastError(err),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch(`/cron-jobs/${id}`, { enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cron-jobs'] }),
    onError: (err: Error) => toastError(err),
  });

  function closeCreate() {
    setShowCreate(false);
    setName('');
    setApplicationId('');
    setSchedule('');
    setCommand('');
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !applicationId || !schedule.trim() || !command.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      applicationId,
      schedule: schedule.trim(),
      command: command.trim(),
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Clock className="text-primary" size={24} />
            {t('cron.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('cron.subtitle')}</p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus size={16} className="mr-1.5" />
          {t('cron.create')}
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-muted-foreground" />
        </div>
      ) : jobs.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Clock className="text-muted-foreground/50 mb-3" size={40} />
            <p className="font-medium">{t('cron.empty')}</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">{t('cron.emptyHint')}</p>
            <Button className="mt-4" onClick={() => setShowCreate(true)}>
              <Plus size={16} className="mr-1.5" />
              {t('cron.create')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => (
            <Card key={job.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{job.name}</span>
                      {!job.enabled && (
                        <Badge className="bg-zinc-700/40 text-zinc-400 border-transparent">
                          {t('common.disabled')}
                        </Badge>
                      )}
                      {job.lastExitCode != null && (
                        job.lastExitCode === 0 ? (
                          <CheckCircle2 size={14} className="text-success" />
                        ) : (
                          <XCircle size={14} className="text-destructive" />
                        )
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-muted-foreground">
                      <code className="px-1.5 py-0.5 rounded bg-zinc-900 text-foreground/80">{job.schedule}</code>
                      {job.application?.name && <span>· {job.application.name}</span>}
                      {job.nextRunAt && (
                        <span>· {t('cron.nextRun')}: {new Date(job.nextRunAt).toLocaleString()}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-2 text-xs text-muted-foreground/80">
                      <Terminal size={12} />
                      <code className="truncate">{job.command}</code>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => toggleMutation.mutate({ id: job.id, enabled: !job.enabled })}
                      className="text-xs px-2 py-1 rounded hover:bg-zinc-800 text-muted-foreground"
                      title={job.enabled ? t('common.disabled') : t('common.enabled')}
                    >
                      {job.enabled ? t('common.enabled') : t('common.disabled')}
                    </button>
                    <button
                      onClick={() => runMutation.mutate(job.id)}
                      className="p-1.5 rounded hover:bg-zinc-800 text-muted-foreground hover:text-primary"
                      title={t('cron.runNow')}
                      disabled={runMutation.isPending}
                    >
                      <Play size={15} />
                    </button>
                    <button
                      onClick={() => setDeleteId(job.id)}
                      className="p-1.5 rounded hover:bg-zinc-800 text-muted-foreground hover:text-red-400"
                      title={t('common.delete')}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      {showCreate && (
        <Dialog open={showCreate} onClose={closeCreate}>
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>{t('cron.create')}</DialogTitle>
              <DialogDescription>{t('cron.subtitle')}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div>
                <Label htmlFor="cron-name">{t('cron.name')}</Label>
                <Input
                  id="cron-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Clear cache"
                  autoFocus
                />
              </div>

              <div>
                <Label htmlFor="cron-app">{t('cron.app')}</Label>
                <Select id="cron-app" value={applicationId} onChange={(e) => setApplicationId(e.target.value)}>
                  <option value="">—</option>
                  {apps.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </Select>
              </div>

              <div>
                <Label htmlFor="cron-schedule">{t('cron.schedule')}</Label>
                <Input
                  id="cron-schedule"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="font-mono"
                />
                <p className="flex items-center gap-1 text-xs text-muted-foreground mt-1.5">
                  <Info size={12} />
                  {t('cron.scheduleHint')}
                </p>
              </div>

              <div>
                <Label htmlFor="cron-command">{t('cron.command')}</Label>
                <Input
                  id="cron-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="php artisan schedule:run"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground mt-1.5">{t('cron.commandHint')}</p>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeCreate}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={!name.trim() || !applicationId || !schedule.trim() || !command.trim() || createMutation.isPending}
              >
                {createMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                {t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <Dialog open={!!deleteId} onClose={() => setDeleteId(null)}>
          <DialogHeader>
            <DialogTitle>{t('common.delete')}</DialogTitle>
            <DialogDescription>{t('cron.deleteConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </div>
  );
}
