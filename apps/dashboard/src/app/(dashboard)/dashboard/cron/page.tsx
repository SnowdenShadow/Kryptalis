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
  CalendarClock,
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
import {
  buildCron,
  parseToSimple,
  describeCron,
  DEFAULT_SIMPLE,
  type SimpleSchedule,
  type CronFrequency,
} from '@/lib/cron-builder';

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
  // Schedule has two editors: a SIMPLE builder (frequency + time dropdowns) and
  // an ADVANCED raw-cron input. `simple` drives the expression in simple mode;
  // `advancedSchedule` holds the raw string in advanced mode.
  const [scheduleMode, setScheduleMode] = useState<'simple' | 'advanced'>('simple');
  const [simple, setSimple] = useState<SimpleSchedule>(DEFAULT_SIMPLE);
  const [advancedSchedule, setAdvancedSchedule] = useState('');
  const [command, setCommand] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // The effective cron expression sent to the API.
  const schedule = scheduleMode === 'simple' ? buildCron(simple) : advancedSchedule.trim();

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
    setScheduleMode('simple');
    setSimple(DEFAULT_SIMPLE);
    setAdvancedSchedule('');
    setCommand('');
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !applicationId || !schedule || !command.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      applicationId,
      schedule,
      command: command.trim(),
    });
  }

  // Localized plain-language description of the current expression, for the
  // preview line shown under the schedule editor.
  const scheduleHuman = describeCron(schedule, {
    everyMinutes: (n) => t('cron.descEveryMinutes', { n: String(n) }),
    hourlyAt: (m) => t('cron.descHourly', { m }),
    dailyAt: (time) => t('cron.descDaily', { time }),
    weeklyAt: (day, time) => t('cron.descWeekly', { day, time }),
    monthlyAt: (day, time) => t('cron.descMonthly', { day: String(day), time }),
    weekdayNames: [
      t('cron.sun'), t('cron.mon'), t('cron.tue'), t('cron.wed'),
      t('cron.thu'), t('cron.fri'), t('cron.sat'),
    ],
    raw: (e) => t('cron.descRaw', { expr: e }),
  });

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
                <div className="flex items-center justify-between">
                  <Label>{t('cron.schedule')}</Label>
                  {/* Simple ↔ Advanced toggle */}
                  <div className="flex text-xs rounded-md overflow-hidden border border-zinc-700">
                    <button
                      type="button"
                      onClick={() => {
                        // Carry the advanced expression into the simple form when possible.
                        const s = parseToSimple(advancedSchedule.trim() || schedule);
                        if (s) setSimple(s);
                        setScheduleMode('simple');
                      }}
                      className={
                        'px-2.5 py-1 ' +
                        (scheduleMode === 'simple' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-zinc-800')
                      }
                    >
                      {t('cron.modeSimple')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        // Seed the advanced box with whatever the simple form built.
                        setAdvancedSchedule(buildCron(simple));
                        setScheduleMode('advanced');
                      }}
                      className={
                        'px-2.5 py-1 ' +
                        (scheduleMode === 'advanced' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-zinc-800')
                      }
                    >
                      {t('cron.modeAdvanced')}
                    </button>
                  </div>
                </div>

                {scheduleMode === 'simple' ? (
                  <ScheduleBuilder simple={simple} onChange={setSimple} t={t} />
                ) : (
                  <>
                    <Input
                      id="cron-schedule"
                      value={advancedSchedule}
                      onChange={(e) => setAdvancedSchedule(e.target.value)}
                      placeholder="*/5 * * * *"
                      className="font-mono mt-1"
                    />
                    <p className="flex items-center gap-1 text-xs text-muted-foreground mt-1.5">
                      <Info size={12} />
                      {t('cron.scheduleHint')}
                    </p>
                  </>
                )}

                {/* Plain-language preview — always shown so the user sees what will happen. */}
                <div className="flex items-center gap-1.5 mt-2 text-xs text-primary/90">
                  <CalendarClock size={13} />
                  <span>{scheduleHuman}</span>
                  <code className="ml-auto px-1.5 py-0.5 rounded bg-zinc-900 text-[11px] text-muted-foreground">{schedule || '—'}</code>
                </div>
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

// ─── Simple schedule builder (frequency + time dropdowns) ─────────────
function ScheduleBuilder({
  simple,
  onChange,
  t,
}: {
  simple: SimpleSchedule;
  onChange: (s: SimpleSchedule) => void;
  t: (key: string, vars?: Record<string, string>) => string;
}) {
  const set = (patch: Partial<SimpleSchedule>) => onChange({ ...simple, ...patch });
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 60 }, (_, i) => i);
  const pad = (n: number) => String(n).padStart(2, '0');
  const weekdays = [
    t('cron.sun'), t('cron.mon'), t('cron.tue'), t('cron.wed'),
    t('cron.thu'), t('cron.fri'), t('cron.sat'),
  ];

  return (
    <div className="mt-1 space-y-2">
      {/* Frequency */}
      <Select
        value={simple.frequency}
        onChange={(e) => set({ frequency: e.target.value as CronFrequency })}
      >
        <option value="minutes">{t('cron.freqMinutes')}</option>
        <option value="hourly">{t('cron.freqHourly')}</option>
        <option value="daily">{t('cron.freqDaily')}</option>
        <option value="weekly">{t('cron.freqWeekly')}</option>
        <option value="monthly">{t('cron.freqMonthly')}</option>
      </Select>

      {/* Frequency-specific controls */}
      {simple.frequency === 'minutes' && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('cron.every')}</span>
          <Input
            type="number"
            min={1}
            max={59}
            value={simple.everyMinutes}
            onChange={(e) => set({ everyMinutes: Number(e.target.value) })}
            className="w-20"
          />
          <span className="text-muted-foreground">{t('cron.minutesUnit')}</span>
        </div>
      )}

      {simple.frequency === 'hourly' && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('cron.atMinute')}</span>
          <Select value={String(simple.minute)} onChange={(e) => set({ minute: Number(e.target.value) })} className="w-24">
            {minutes.map((m) => <option key={m} value={m}>:{pad(m)}</option>)}
          </Select>
        </div>
      )}

      {(simple.frequency === 'daily' || simple.frequency === 'weekly' || simple.frequency === 'monthly') && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {simple.frequency === 'weekly' && (
            <>
              <span className="text-muted-foreground">{t('cron.onDay')}</span>
              <Select value={String(simple.weekday)} onChange={(e) => set({ weekday: Number(e.target.value) })} className="w-32">
                {weekdays.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </Select>
            </>
          )}
          {simple.frequency === 'monthly' && (
            <>
              <span className="text-muted-foreground">{t('cron.onDayOfMonth')}</span>
              <Select value={String(simple.monthday)} onChange={(e) => set({ monthday: Number(e.target.value) })} className="w-20">
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
              </Select>
            </>
          )}
          <span className="text-muted-foreground">{t('cron.atTime')}</span>
          <Select value={String(simple.hour)} onChange={(e) => set({ hour: Number(e.target.value) })} className="w-20">
            {hours.map((h) => <option key={h} value={h}>{pad(h)}</option>)}
          </Select>
          <span className="text-muted-foreground">:</span>
          <Select value={String(simple.atMinute)} onChange={(e) => set({ atMinute: Number(e.target.value) })} className="w-20">
            {minutes.map((m) => <option key={m} value={m}>{pad(m)}</option>)}
          </Select>
        </div>
      )}
    </div>
  );
}
