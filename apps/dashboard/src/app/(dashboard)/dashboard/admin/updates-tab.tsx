'use client';

import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  CheckCircle2, Download, AlertCircle, Loader2, RefreshCw, GitCommit, Power,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
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
}

/**
 * Self-update controls. Migrated from Settings to Admin where
 * platform-wide controls live. Poll cadence speeds up to 3 s while a
 * pull is in progress so the user sees the state flip live.
 */
export function UpdatesTab() {
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
      toast.success('Check complete');
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

  return (
    <div className="space-y-6">
      {/* Status card */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                System updates
                {updateStatus && (() => {
                  const s = updateStatus.state;
                  const variant =
                    s === 'UP_TO_DATE' ? 'success' :
                    s === 'UPDATE_AVAILABLE' ? 'warning' :
                    s === 'UPDATING' ? 'outline' :
                    s === 'ERROR' ? 'destructive' : 'outline';
                  const label =
                    s === 'UP_TO_DATE' ? 'Up to date' :
                    s === 'UPDATE_AVAILABLE' ? 'Update available' :
                    s === 'UPDATING' ? 'Updating…' :
                    s === 'ERROR' ? 'Error' : 'Unknown';
                  return <Badge variant={variant as any} className="text-[10px]">{label}</Badge>;
                })()}
              </CardTitle>
              <CardDescription>
                Your installation pulls the latest version from{' '}
                <span className="font-mono">{updateStatus?.branch || 'main'}</span>{' '}
                on a 5-minute timer. Override with KRYPTALIS_UPDATE_INTERVAL.
              </CardDescription>
            </div>
            <Button size="sm" variant="outline" onClick={() => refetchUpdate()} disabled={updateFetching}>
              {updateFetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {updateStatus && (
            <div className={cn(
              'rounded-lg border p-3 flex items-start gap-3',
              updateStatus.state === 'UP_TO_DATE' ? 'border-emerald-500/30 bg-emerald-500/5' :
              updateStatus.state === 'UPDATE_AVAILABLE' ? 'border-orange-500/30 bg-orange-500/5' :
              updateStatus.state === 'UPDATING' ? 'border-blue-500/30 bg-blue-500/5' :
              updateStatus.state === 'ERROR' ? 'border-red-500/30 bg-red-500/5' :
              'border-border bg-muted/30',
            )}>
              {updateStatus.state === 'UP_TO_DATE' && <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" />}
              {updateStatus.state === 'UPDATE_AVAILABLE' && <Download size={16} className="text-orange-500 shrink-0 mt-0.5" />}
              {updateStatus.state === 'UPDATING' && <Loader2 size={16} className="text-blue-500 animate-spin shrink-0 mt-0.5" />}
              {updateStatus.state === 'ERROR' && <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />}
              {updateStatus.state === 'UNKNOWN' && <AlertCircle size={16} className="text-muted-foreground shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0 text-xs">
                <p className="font-medium">{updateStatus.message}</p>
                {updateStatus.updatedAt && (
                  <p className="text-muted-foreground mt-0.5">
                    Last check: {new Date(updateStatus.updatedAt).toLocaleString()}
                  </p>
                )}
              </div>
            </div>
          )}

          {updateStatus && (updateStatus.currentSha || updateStatus.latestSha) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <GitCommit size={10} /> Installed
                </p>
                <p className="font-mono text-xs mt-1 truncate">
                  {updateStatus.currentSha ? updateStatus.currentSha.slice(0, 12) : '—'}
                </p>
              </div>
              <div className="rounded-lg border border-border p-3">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <GitCommit size={10} /> Latest on {updateStatus.branch || 'main'}
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
              disabled={checkUpdate.isPending || !updateStatus?.manualTriggerAvailable}
            >
              {checkUpdate.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              Check for updates
            </Button>
            <Button
              size="sm"
              onClick={() => applyUpdate.mutate()}
              disabled={
                applyUpdate.isPending ||
                !updateStatus?.manualTriggerAvailable ||
                updateStatus?.state === 'UPDATING'
              }
            >
              {applyUpdate.isPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              Update now
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { fetchLog.mutate(); }}
              disabled={fetchLog.isPending || !updateStatus?.hasUpdateLog}
            >
              {fetchLog.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
              View log
            </Button>
          </div>

          {!updateStatus?.manualTriggerAvailable && (
            <p className="text-[11px] text-muted-foreground">
              Manual trigger unavailable in this deployment — the timer runs every 5 minutes automatically.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Auto-update toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Power size={16} /> Auto-update
          </CardTitle>
          <CardDescription>
            When enabled, the platform pulls and applies updates on the 5-min timer.
            Disable for full manual control.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-4">
            <div className="flex-1">
              <p className="font-medium text-sm">
                {updateStatus?.autoUpdateEnabled === false ? 'Disabled' : 'Enabled'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {updateStatus?.autoUpdateEnabled === false
                  ? 'Updates will not be applied automatically. Use "Update now" when ready.'
                  : 'New commits on origin will land on your instance on the next poll cycle.'}
              </p>
            </div>
            <Button
              size="sm"
              variant={updateStatus?.autoUpdateEnabled === false ? 'default' : 'destructive'}
              onClick={() => toggleAuto.mutate(updateStatus?.autoUpdateEnabled === false)}
              disabled={toggleAuto.isPending}
            >
              {toggleAuto.isPending && <Loader2 size={12} className="animate-spin" />}
              {updateStatus?.autoUpdateEnabled === false ? 'Enable' : 'Disable'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Log viewer */}
      {updateLog && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent update log</CardTitle>
            <CardDescription className="text-xs">
              Last 200 lines of <span className="font-mono">.kryptalis/update.log</span>
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
