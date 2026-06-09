'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CheckCircle2, Download, AlertCircle, Loader2, RefreshCw, GitCommit, Power,
  Webhook, Copy, Check, Eye, EyeOff,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface UpdateStatus {
  state: 'UP_TO_DATE' | 'UPDATE_AVAILABLE' | 'UPDATING' | 'ERROR' | 'UNKNOWN';
  message: string;
  currentSha: string | null;
  latestSha: string | null;
  branch: string | null;
  updatedAt: string | null;
  autoUpdateEnabled: boolean | null;
  manualTriggerAvailable: boolean | null;
  hasUpdateLog: boolean | null;
  webhook?: {
    url: string;
    secret: string;
    fired: boolean;
    lastFiredAt: string | null;
  };
}

/**
 * Self-update controls. Poll cadence speeds up to 3 s while a
 * pull is in progress so the user sees the state flip live.
 */
export function UpdatesTab() {
  const { t } = useTranslation();
  const {
    data: updateStatus,
    refetch: refetchUpdate,
    isFetching: updateFetching,
  } = useQuery<UpdateStatus>({
    queryKey: ['system-updates'],
    queryFn: () => api.get('/system/updates'),
    refetchInterval: (q) => {
      const s = (q.state.data as UpdateStatus | undefined)?.state;
      return s === 'UPDATING' ? 3000 : false;
    },
  });

  const [updateLog, setUpdateLog] = useState('');
  const fetchLog = useMutation({
    mutationFn: () => api.get('/system/updates/log') as Promise<{ log: string }>,
    onSuccess: (d) => setUpdateLog(d.log || '(empty)'),
    onError: (e: Error) => toast.error(e.message),
  });
  const checkUpdate = useMutation({
    mutationFn: () => api.post('/system/updates/check'),
    onSuccess: () => {
      toast.success(t('admin.updates.toastCheck'));
      refetchUpdate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const applyUpdate = useMutation({
    mutationFn: () => api.post('/system/updates/apply') as Promise<{ message: string }>,
    onSuccess: (d) => {
      toast.success(d.message);
      refetchUpdate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggleAuto = useMutation({
    mutationFn: (enabled: boolean) =>
      api.post('/system/updates/auto', { enabled }) as Promise<{ enabled: boolean; message: string }>,
    onSuccess: (d) => {
      toast.success(d.message);
      refetchUpdate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rotateWebhook = useMutation({
    mutationFn: () => api.post('/system/updates/webhook/rotate') as Promise<{ secret: string }>,
    onSuccess: () => {
      toast.success(t('admin.updates.webhookRotated'));
      refetchUpdate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [revealSecret, setRevealSecret] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  async function copyText(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  }

  // Manual trigger flag may be null on first paint — treat null as "unknown"
  // and assume true (best-effort enable). Falsy only when explicitly false.
  const manualOk = updateStatus?.manualTriggerAvailable !== false;
  const autoDisabled = updateStatus?.autoUpdateEnabled === false;
  const branch = updateStatus?.branch || 'main';

  const state = updateStatus?.state;
  const badgeVariant: 'success' | 'warning' | 'outline' | 'destructive' =
    state === 'UP_TO_DATE' ? 'success' :
    state === 'UPDATE_AVAILABLE' ? 'warning' :
    state === 'ERROR' ? 'destructive' : 'outline';
  const badgeLabel =
    state === 'UP_TO_DATE' ? t('admin.updates.badge.upToDate') :
    state === 'UPDATE_AVAILABLE' ? t('admin.updates.badge.available') :
    state === 'UPDATING' ? t('admin.updates.badge.updating') :
    state === 'ERROR' ? t('admin.updates.badge.error') :
    t('admin.updates.badge.unknown');

  return (
    <div className="space-y-6">
      {/* Status card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                {t('admin.updates.title')}
                {updateStatus && (
                  <Badge variant={badgeVariant as any} className="text-[10px]">{badgeLabel}</Badge>
                )}
              </CardTitle>
              <CardDescription>
                {t('admin.updates.subtitle', { branch }).split('{branch}')[0]}
                <span className="font-mono">{branch}</span>
                {t('admin.updates.subtitle', { branch }).split('{branch}')[1] || ''}
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => refetchUpdate()} disabled={updateFetching}>
              {updateFetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t('admin.updates.refresh')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {updateStatus && (
            <div className={cn(
              'rounded-lg border p-3 flex items-start gap-3',
              state === 'UP_TO_DATE' ? 'border-emerald-500/30 bg-emerald-500/5' :
              state === 'UPDATE_AVAILABLE' ? 'border-orange-500/30 bg-orange-500/5' :
              state === 'UPDATING' ? 'border-blue-500/30 bg-blue-500/5' :
              state === 'ERROR' ? 'border-red-500/30 bg-red-500/5' :
              'border-border bg-muted/30',
            )}>
              {state === 'UP_TO_DATE' && <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" />}
              {state === 'UPDATE_AVAILABLE' && <Download size={16} className="text-orange-500 shrink-0 mt-0.5" />}
              {state === 'UPDATING' && <Loader2 size={16} className="text-blue-500 animate-spin shrink-0 mt-0.5" />}
              {state === 'ERROR' && <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />}
              {state === 'UNKNOWN' && <AlertCircle size={16} className="text-muted-foreground shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0 text-xs">
                <p className="font-medium">{updateStatus.message}</p>
                {updateStatus.updatedAt && (
                  <p className="text-muted-foreground mt-0.5">
                    {t('admin.updates.lastCheck', { when: new Date(updateStatus.updatedAt).toLocaleString() })}
                  </p>
                )}
              </div>
            </div>
          )}

          {updateStatus && (updateStatus.currentSha || updateStatus.latestSha) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <GitCommit size={10} /> {t('admin.updates.installed')}
                </p>
                <p className="font-mono text-xs mt-1 truncate">
                  {updateStatus.currentSha ? updateStatus.currentSha.slice(0, 12) : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <GitCommit size={10} /> {t('admin.updates.latestOn', { branch })}
                </p>
                <p className="font-mono text-xs mt-1 truncate">
                  {updateStatus.latestSha ? updateStatus.latestSha.slice(0, 12) : '—'}
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => checkUpdate.mutate()}
              disabled={checkUpdate.isPending || !manualOk}
            >
              {checkUpdate.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t('admin.updates.checkBtn')}
            </Button>
            <Button
              size="sm"
              onClick={() => applyUpdate.mutate()}
              disabled={applyUpdate.isPending || !manualOk || state === 'UPDATING'}
            >
              {applyUpdate.isPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {t('admin.updates.applyBtn')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { fetchLog.mutate(); }}
              disabled={fetchLog.isPending || updateStatus?.hasUpdateLog === false}
            >
              {fetchLog.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              {t('admin.updates.viewLogBtn')}
            </Button>
          </div>

          {updateStatus?.manualTriggerAvailable === false && (
            <p className="text-[11px] text-muted-foreground">{t('admin.updates.manualUnavailable')}</p>
          )}
        </CardContent>
      </Card>

      {/* Auto-update toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Power size={16} /> {t('admin.updates.autoTitle')}
          </CardTitle>
          <CardDescription>{t('admin.updates.autoDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-4">
            <div className="flex-1">
              <p className="font-medium text-sm">
                {autoDisabled ? t('admin.updates.autoDisabled') : t('admin.updates.autoEnabled')}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {autoDisabled ? t('admin.updates.autoDisabledHint') : t('admin.updates.autoEnabledHint')}
              </p>
            </div>
            <Button
              size="sm"
              variant={autoDisabled ? 'default' : 'destructive'}
              onClick={() => toggleAuto.mutate(autoDisabled)}
              disabled={toggleAuto.isPending}
            >
              {toggleAuto.isPending && <Loader2 size={12} className="animate-spin" />}
              {autoDisabled ? t('admin.updates.btnEnable') : t('admin.updates.btnDisable')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Webhook (instant updates) */}
      {updateStatus?.webhook && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2 flex-wrap">
              <Webhook size={16} /> {t('admin.updates.webhookTitle')}
              {updateStatus.webhook.fired ? (
                <Badge variant="success" className="text-[10px]">
                  {t('admin.updates.webhookConfigured', {
                    when: updateStatus.webhook.lastFiredAt
                      ? new Date(updateStatus.webhook.lastFiredAt).toLocaleString()
                      : '',
                  })}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">{t('admin.updates.webhookNotConfigured')}</Badge>
              )}
            </CardTitle>
            <CardDescription>{t('admin.updates.webhookDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('admin.updates.webhookUrl')}</p>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <code className="font-mono text-xs flex-1 truncate">{updateStatus.webhook.url}</code>
                <Button size="icon" variant="ghost" className="h-7 w-7"
                  onClick={() => copyText(updateStatus.webhook!.url, 'url')}>
                  {copied === 'url'
                    ? <Check size={12} className="text-emerald-500" />
                    : <Copy size={12} />}
                </Button>
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('admin.updates.webhookSecret')}</p>
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <code className="font-mono text-xs flex-1 truncate">
                  {revealSecret ? updateStatus.webhook.secret : '••••••••••••••••••••••••••••••••'}
                </code>
                <Button size="icon" variant="ghost" className="h-7 w-7"
                  onClick={() => setRevealSecret((v) => !v)}>
                  {revealSecret ? <EyeOff size={12} /> : <Eye size={12} />}
                </Button>
                <Button size="icon" variant="ghost" className="h-7 w-7"
                  onClick={() => copyText(updateStatus.webhook!.secret, 'secret')}>
                  {copied === 'secret'
                    ? <Check size={12} className="text-emerald-500" />
                    : <Copy size={12} />}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('admin.updates.webhookSteps', {
                ct: 'application/json',
                event: 'Just the push event',
              })}
            </p>
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={rotateWebhook.isPending}
                onClick={() => {
                  if (confirm(t('admin.updates.webhookRotateConfirm'))) rotateWebhook.mutate();
                }}
              >
                {rotateWebhook.isPending
                  ? <Loader2 size={12} className="animate-spin" />
                  : <RefreshCw size={12} />}
                {t('admin.updates.webhookRotate')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Log viewer */}
      {updateLog && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('admin.updates.logTitle')}</CardTitle>
            <CardDescription className="text-xs">
              {t('admin.updates.logDesc', { path: '' }).split('{path}')[0]}
              <span className="font-mono">.kryptalis/update.log</span>
              {t('admin.updates.logDesc', { path: '' }).split('{path}')[1] || ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="font-mono text-[11px] bg-muted/30 rounded p-3 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
              {updateLog}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
