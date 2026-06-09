'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CheckCircle2, Download, AlertCircle, Loader2, RefreshCw, GitCommit,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface UpdateStatus {
  status: 'UP_TO_DATE' | 'UPDATE_AVAILABLE' | 'UPDATING' | 'ERROR' | 'UNKNOWN';
  message: string;
  currentSha: string | null;
  latestSha: string | null;
  branch: string;
  repo: string | null;
  lastCheckedAt: string | null;
  lastUpdatedAt: string | null;
  pollIntervalSec: number;
}

export function UpdatesTab() {
  const { t } = useTranslation();
  const [showLog, setShowLog] = useState(false);

  const { data, refetch, isFetching } = useQuery<UpdateStatus>({
    queryKey: ['system-updates'],
    queryFn: () => api.get('/system/updates'),
    // Refresh faster while an update is running so the UI flips quickly.
    refetchInterval: (q) => {
      const s = (q.state.data as UpdateStatus | undefined)?.status;
      return s === 'UPDATING' ? 2000 : 10_000;
    },
  });

  const { data: logData, refetch: refetchLog } = useQuery<{ log: string }>({
    queryKey: ['system-updates-log'],
    queryFn: () => api.get('/system/updates/log'),
    enabled: showLog,
    refetchInterval: data?.status === 'UPDATING' ? 1500 : false,
  });

  const checkNow = useMutation({
    mutationFn: () => api.post('/system/updates/check'),
    onSuccess: () => { refetch(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const applyNow = useMutation({
    mutationFn: () => api.post('/system/updates/apply') as Promise<{ message: string }>,
    onSuccess: (d) => { toast.success(d.message); refetch(); setShowLog(true); },
    onError: (e: Error) => toast.error(e.message),
  });

  const status = data?.status;
  const badge: 'success' | 'warning' | 'outline' | 'destructive' =
    status === 'UP_TO_DATE' ? 'success' :
    status === 'UPDATE_AVAILABLE' ? 'warning' :
    status === 'ERROR' ? 'destructive' : 'outline';
  const badgeLabel =
    status === 'UP_TO_DATE' ? t('admin.updates.badge.upToDate') :
    status === 'UPDATE_AVAILABLE' ? t('admin.updates.badge.available') :
    status === 'UPDATING' ? t('admin.updates.badge.updating') :
    status === 'ERROR' ? t('admin.updates.badge.error') :
    t('admin.updates.badge.unknown');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                {t('admin.updates.title')}
                {data && <Badge variant={badge as any} className="text-[10px]">{badgeLabel}</Badge>}
              </CardTitle>
              <CardDescription>
                {data?.repo ? (
                  <>
                    {t('admin.updates.subtitle', { branch: '' }).split('{branch}')[0]}
                    <span className="font-mono">{data.repo}@{data.branch}</span>
                    {t('admin.updates.subtitle', { branch: '' }).split('{branch}')[1] || ''}
                    {' '}
                    <span className="text-[11px]">({data.pollIntervalSec}s)</span>
                  </>
                ) : (
                  t('admin.updates.subtitle', { branch: 'main' })
                )}
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t('admin.updates.refresh')}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {data && (
            <div className={cn(
              'rounded-lg border p-3 flex items-start gap-3',
              status === 'UP_TO_DATE' ? 'border-emerald-500/30 bg-emerald-500/5' :
              status === 'UPDATE_AVAILABLE' ? 'border-orange-500/30 bg-orange-500/5' :
              status === 'UPDATING' ? 'border-blue-500/30 bg-blue-500/5' :
              status === 'ERROR' ? 'border-red-500/30 bg-red-500/5' :
              'border-border bg-muted/30',
            )}>
              {status === 'UP_TO_DATE' && <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" />}
              {status === 'UPDATE_AVAILABLE' && <Download size={16} className="text-orange-500 shrink-0 mt-0.5" />}
              {status === 'UPDATING' && <Loader2 size={16} className="text-blue-500 animate-spin shrink-0 mt-0.5" />}
              {status === 'ERROR' && <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />}
              {status === 'UNKNOWN' && <AlertCircle size={16} className="text-muted-foreground shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0 text-xs">
                <p className="font-medium">{data.message}</p>
                {data.lastCheckedAt && (
                  <p className="text-muted-foreground mt-0.5">
                    {t('admin.updates.lastCheck', { when: new Date(data.lastCheckedAt).toLocaleString() })}
                  </p>
                )}
              </div>
            </div>
          )}

          {data && (data.currentSha || data.latestSha) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <GitCommit size={10} /> {t('admin.updates.installed')}
                </p>
                <p className="font-mono text-xs mt-1 truncate">
                  {data.currentSha ? data.currentSha.slice(0, 12) : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <GitCommit size={10} /> {t('admin.updates.latestOn', { branch: data.branch })}
                </p>
                <p className="font-mono text-xs mt-1 truncate">
                  {data.latestSha ? data.latestSha.slice(0, 12) : '—'}
                </p>
              </div>
            </div>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => checkNow.mutate()}
              disabled={checkNow.isPending}
            >
              {checkNow.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t('admin.updates.checkBtn')}
            </Button>
            <Button
              size="sm"
              onClick={() => applyNow.mutate()}
              disabled={applyNow.isPending || status === 'UPDATING'}
            >
              {applyNow.isPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {t('admin.updates.applyBtn')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setShowLog((v) => !v); refetchLog(); }}
            >
              {t('admin.updates.viewLogBtn')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {showLog && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('admin.updates.logTitle')}</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="font-mono text-[11px] bg-muted/30 rounded p-3 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
              {logData?.log?.trim() || '(empty)'}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
