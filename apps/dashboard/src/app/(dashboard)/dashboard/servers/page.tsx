'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Server,
  Clock,
  Trash2,
  Copy,
  Check,
  Eye,
  EyeOff,
  Cpu,
  HardDrive,
  MemoryStick,
  Info,
  Plus,
  RefreshCw,
  Wrench,
  Loader2,
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
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import type { ServerResponse } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { makeTimeAgo } from '@/lib/app-format';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Shared API resource type — local alias keeps the diff/readability small.
// Note: totalMemory/totalDisk are BigInt columns serialized as decimal
// strings by the API — wrap in Number() before arithmetic.
type ServerItem = ServerResponse;

interface Metric {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'warning' | 'secondary' | 'outline'> = {
  ONLINE: 'success',
  OFFLINE: 'destructive',
  PROVISIONING: 'warning',
  CONNECTING: 'warning',
  UNKNOWN: 'secondary',
};

function ProgressBar({ label, value, max, unit }: { label: string; value: number; max: number; unit?: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const color = pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">
          {max > 0 ? `${value}${unit} / ${max}${unit}` : 'N/A'}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${color} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {max > 0 && <p className="text-xs text-muted-foreground text-right">{pct}%</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ServersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const timeAgo = useMemo(
    () =>
      makeTimeAgo(t, {
        just: 'server.timeJust',
        min: 'server.timeMin',
        hour: 'server.timeHour',
        day: 'server.timeDay',
        never: 'common.never',
      }),
    [t],
  );

  const [setupDone, setSetupDone] = useState(false);

  // --- Auto-setup: refresh system info on page load ---
  useEffect(() => {
    api.post('/servers/local/setup').then(() => {
      setSetupDone(true);
      queryClient.invalidateQueries({ queryKey: ['server-local'] });
      queryClient.invalidateQueries({ queryKey: ['server-metrics'] });
    }).catch(() => setSetupDone(true));
  }, [queryClient]);

  // --- Fetch local server (includes agentTokens) ---
  const { data: server = null, isLoading } = useQuery<ServerItem | null>({
    queryKey: ['server-local'],
    queryFn: () => api.get('/servers/local'),
    refetchInterval: 15000,
    enabled: setupDone,
  });

  // --- Fetch latest metrics ---
  const { data: metrics = [] } = useQuery<Metric[]>({
    queryKey: ['server-metrics', server?.id],
    queryFn: () => api.get(`/monitoring/servers/${server!.id}/metrics?period=24h`),
    enabled: !!server?.id,
    refetchInterval: 10000,
  });

  const latestMetric = metrics.length > 0 ? metrics[metrics.length - 1] : null;

  // --- Token visibility ---
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState(false);

  // --- Reset (delete) confirmation ---
  const [showReset, setShowReset] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      toast.success(t('toast.serverReset'));
      setShowReset(false);
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  // ── Add server (multi-server) — only available in MULTI mode + admin role
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPERADMIN';

  const { data: publicSettings } = useQuery<{ deployment_mode?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
  });
  const isMultiMode = publicSettings?.deployment_mode === 'MULTI';

  const { data: allServers = [] } = useQuery<ServerItem[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/servers'),
    refetchInterval: 10000,
    enabled: isMultiMode,
  });

  const [showAdd, setShowAdd] = useState(false);
  const [newServerName, setNewServerName] = useState('');
  const [createdServer, setCreatedServer] = useState<{ id: string; installCommand: string } | null>(null);
  const [copiedInstall, setCopiedInstall] = useState(false);

  const createServerMutation = useMutation({
    mutationFn: (body: { name: string }) =>
      api.post<{ id: string; installCommand: string }>('/servers', body),
    onSuccess: (data) => {
      setCreatedServer({ id: data.id, installCommand: data.installCommand });
      setNewServerName('');
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      toast.success(t('toast.serverSlotCreated'));
    },
    onError: (err: Error) => toastError(err),
  });

  const regenInstallMutation = useMutation({
    mutationFn: (id: string) => api.get<{ installCommand: string; token: string }>(`/servers/${id}/install-command`),
    onSuccess: (data, id) => {
      setCreatedServer({ id, installCommand: data.installCommand });
      setShowAdd(true);
      toast.success(t('toast.installCmdGenerated'));
    },
    onError: (err: Error) => toastError(err),
  });

  // Per-server confirmation dialogs (replace the old native confirm()).
  const [rotateTarget, setRotateTarget] = useState<{ id: string; name: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const rotateTokenMutation = useMutation({
    mutationFn: (id: string) => api.post<{ installCommand: string; token: string }>(`/servers/${id}/regen-token`),
    onSuccess: (data, id) => {
      setCreatedServer({ id, installCommand: data.installCommand });
      setShowAdd(true);
      setRotateTarget(null);
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      toast.success(t('toast.tokenRotated'));
    },
    onError: (err: Error) => toastError(err),
  });

  const resetServerMutation = useMutation({
    mutationFn: (id: string) => api.post<{ installCommand: string; token: string }>(`/servers/${id}/reset`),
    onSuccess: (data, id) => {
      setCreatedServer({ id, installCommand: data.installCommand });
      setShowAdd(true);
      setResetTarget(null);
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      queryClient.invalidateQueries({ queryKey: ['server-local'] });
      toast.success(t('toast.serverResetInstall'));
    },
    onError: (err: Error) => toastError(err),
  });

  const removeServerMutation = useMutation({
    mutationFn: (opts: { id: string; force?: boolean }) =>
      api.delete(`/servers/${opts.id}`, { force: !!opts.force }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['servers'] });
      toast.success(t('toast.serverRemoved'));
      setDeleteTarget(null);
    },
    onError: (err: Error) => toastError(err),
  });

  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ONLINE' | 'PENDING_INSTALL' | 'OFFLINE'>('ALL');

  function closeAddDialog() {
    setShowAdd(false);
    setCreatedServer(null);
    setNewServerName('');
  }

  function handleCopyToken(token: string) {
    navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const agentToken = server?.agentTokens?.[0]?.token ?? null;

  // --- Render ---
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">{t('server.title')}</h1>
        <p className="text-muted-foreground">{t('server.subtitle')}</p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Card className="animate-pulse">
            <CardHeader>
              <div className="h-6 w-48 rounded bg-muted" />
              <div className="mt-2 h-4 w-64 rounded bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="h-4 w-full rounded bg-muted" />
                <div className="h-4 w-3/4 rounded bg-muted" />
                <div className="h-4 w-1/2 rounded bg-muted" />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : !server ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Server size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('server.noServer')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('server.noServerDesc')}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Server Overview Card */}
          <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                  <Server size={24} className="text-primary" />
                </div>
                <div>
                  <CardTitle className="text-xl">{server.name}</CardTitle>
                  <CardDescription className="flex items-center gap-2 mt-1">
                    {server.host}:{server.port}
                    <Badge variant={STATUS_VARIANT[server.status] || 'secondary'}>
                      {server.status}
                    </Badge>
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                <div>
                  <p className="text-muted-foreground">{t('server.os')}</p>
                  <p className="font-medium">{server.os || 'Unknown'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('server.arch')}</p>
                  <p className="font-medium">{server.arch || 'Unknown'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('server.cpuCores')}</p>
                  <p className="font-medium">{server.cpuCores ?? 'Unknown'}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('server.agentStatus')}</p>
                  <p className="font-medium">
                    {server.agentVersion ? `v${server.agentVersion}` : t('server.agentNotInstalled')}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('server.lastSeen')}</p>
                  <p className="font-medium flex items-center gap-1">
                    <Clock size={14} />
                    {timeAgo(server.lastSeenAt)}
                  </p>
                </div>
              </div>

              {/* Metrics Section */}
              <div className="mt-6 space-y-3">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('server.metrics')}
                </h3>
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="flex items-start gap-2">
                    <Cpu size={16} className="mt-1 text-muted-foreground" />
                    <div className="flex-1">
                      <ProgressBar
                        label={t('server.cpu')}
                        value={Math.round(latestMetric?.cpuPercent ?? 0)}
                        max={100}
                        unit="%"
                      />
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <MemoryStick size={16} className="mt-1 text-muted-foreground" />
                    <div className="flex-1">
                      <ProgressBar
                        label={t('server.memory')}
                        value={Math.round((latestMetric?.memoryUsed ?? 0) / (1024 ** 3) * 10) / 10}
                        max={Math.round((latestMetric?.memoryTotal ?? Number(server?.totalMemory ?? 0)) / (1024 ** 3) * 10) / 10}
                        unit=" GB"
                      />
                    </div>
                  </div>
                  <div className="flex items-start gap-2">
                    <HardDrive size={16} className="mt-1 text-muted-foreground" />
                    <div className="flex-1">
                      <ProgressBar
                        label={t('server.disk')}
                        value={Math.round((latestMetric?.diskUsed ?? 0) / (1024 ** 3) * 10) / 10}
                        max={Math.round((latestMetric?.diskTotal ?? Number(server?.totalDisk ?? 0)) / (1024 ** 3) * 10) / 10}
                        unit=" GB"
                      />
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Server Details Card */}
          <Card>
            <CardHeader>
              <CardTitle>{t('server.details')}</CardTitle>
              <CardDescription>{t('server.detailsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-3">
                <div>
                  <p className="text-muted-foreground">{t('server.hostLabel')}</p>
                  <p className="font-medium font-mono">{server.host}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('server.portLabel')}</p>
                  <p className="font-medium font-mono">{server.port}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">{t('server.usernameLabel')}</p>
                  <p className="font-medium font-mono">{server.username}</p>
                </div>
              </div>

              {/* Agent Token */}
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('server.agentToken')}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-sm font-mono">
                    {agentToken
                      ? showToken
                        ? agentToken
                        : '•'.repeat(32)
                      : t('server.noToken')}
                  </code>
                  {agentToken && (
                    <>
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => setShowToken(!showToken)}
                        title={showToken ? t('server.hideToken') : t('server.revealToken')}
                      >
                        {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => handleCopyToken(agentToken)}
                        title={t('server.copyToken')}
                      >
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Agent Status */}
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{t('server.agentStatus')}</p>
                {server.agentVersion ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="success">{t('server.connected')}</Badge>
                    <span className="text-sm text-muted-foreground">
                      {t('server.runningVersion', { version: server.agentVersion })}
                    </span>
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-md border border-dashed p-3">
                    <Info size={16} className="mt-0.5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{t('server.agentNotInstalled')}</p>
                      <p className="text-sm text-muted-foreground">{t('server.agentInstallHint')}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Reset Button — hidden for local server (cannot delete the host running DockControl) */}
              {server.host !== '127.0.0.1' && (
                <div className="flex justify-end pt-2">
                  <Button
                    variant="destructive"
                    onClick={() => setShowReset(true)}
                  >
                    <Trash2 size={14} />
                    {t('server.resetServer')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* ─── All servers + Add (MULTI mode only) ────────────────── */}
      {isMultiMode && (
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Server size={18} /> {t('server.allServers')}
            </CardTitle>
            <CardDescription>
              {isAdmin ? t('server.allServersDescAdmin') : t('server.allServersDescUser')}
            </CardDescription>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => setShowAdd(true)}>
              <Plus size={14} /> {t('server.addServer')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {/* Status filter */}
          {allServers.length > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/10">
              {(['ALL', 'ONLINE', 'PENDING_INSTALL', 'OFFLINE'] as const).map(s => {
                const count = s === 'ALL' ? allServers.length : allServers.filter((sv: any) => sv.status === s).length;
                return (
                  <Button
                    key={s}
                    size="sm"
                    variant={statusFilter === s ? 'default' : 'outline'}
                    onClick={() => setStatusFilter(s)}
                    className="text-xs h-7"
                  >
                    {s === 'ALL' ? t('server.filterAll') : s.replace('_', ' ')} ({count})
                  </Button>
                );
              })}
            </div>
          )}
          {allServers.length === 0 ? (
            <p className="px-6 py-8 text-sm text-muted-foreground text-center">{t('server.noServersYet')}</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr className="text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('common.name')}</th>
                  <th className="px-4 py-2 font-medium">{t('server.hostLabel')}</th>
                  <th className="px-4 py-2 font-medium">{t('common.status')}</th>
                  <th className="px-4 py-2 font-medium">{t('server.osArch')}</th>
                  <th className="px-4 py-2 font-medium">{t('server.lastSeen')}</th>
                  <th className="px-4 py-2 font-medium text-right">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {allServers
                  .filter((s: any) => statusFilter === 'ALL' || s.status === statusFilter)
                  .map((s: any) => {
                  const isLocal = s.host === '127.0.0.1';
                  return (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-accent/40">
                    <td className="px-4 py-2 font-medium">
                      <div className="flex items-center gap-2">
                        {s.name}
                        {isLocal && <Badge variant="outline" className="text-[10px]">{t('server.localBadge')}</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{s.host}</td>
                    <td className="px-4 py-2">
                      <Badge variant={
                        s.status === 'ONLINE' ? 'success' :
                        s.status === 'PENDING_INSTALL' ? 'warning' :
                        s.status === 'OFFLINE' ? 'destructive' : 'secondary'
                      } className="text-[10px]">
                        {s.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {s.os ? `${s.os} · ${s.arch || ''}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : t('common.never')}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-1">
                        {isAdmin && (s.status === 'PENDING_INSTALL' || s.status === 'OFFLINE') && (
                          <Button size="sm" variant="outline"
                            onClick={() => regenInstallMutation.mutate(s.id)}
                            disabled={regenInstallMutation.isPending}
                            title={t('server.getInstallCmd')}>
                            <Copy size={12} /> {t('common.install')}
                          </Button>
                        )}
                        {isAdmin && s.status === 'ONLINE' && (
                          <Button size="sm" variant="outline"
                            onClick={() => setRotateTarget({ id: s.id, name: s.name })}
                            disabled={rotateTokenMutation.isPending}
                            title={t('server.rotateTitle')}>
                            <RefreshCw size={12} />
                          </Button>
                        )}
                        {isAdmin && !isLocal && (
                          <Button size="sm" variant="outline"
                            onClick={() => setResetTarget({ id: s.id, name: s.name })}
                            disabled={resetServerMutation.isPending}
                            title={t('server.resetTitle')}>
                            <Wrench size={12} />
                          </Button>
                        )}
                        {isAdmin && !isLocal && (
                          <Button size="sm" variant="destructive"
                            onClick={() => setDeleteTarget({ id: s.id, name: s.name })}
                            disabled={removeServerMutation.isPending}
                            title={t('server.deleteTitle')}>
                            <Trash2 size={12} />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      )}

      {/* ─── Add Server dialog ─── */}
      <Dialog open={showAdd} onClose={closeAddDialog} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('server.addTitle')}</DialogTitle>
          <DialogDescription>{t('server.addDesc')}</DialogDescription>
        </DialogHeader>

        {!createdServer ? (
          <div className="space-y-3">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('server.serverName')}</label>
              <input
                value={newServerName}
                onChange={(e) => setNewServerName(e.target.value)}
                placeholder="production-1"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={closeAddDialog}>{t('common.cancel')}</Button>
              <Button
                disabled={!newServerName.trim() || createServerMutation.isPending}
                onClick={() => createServerMutation.mutate({ name: newServerName.trim() })}
              >
                {createServerMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                {createServerMutation.isPending ? t('common.creating') : t('server.createSlot')}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <Check size={18} className="text-emerald-500 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-semibold">{t('server.slotCreated')}</p>
                <p className="text-muted-foreground text-xs mt-1">{t('server.slotCreatedDesc')}</p>
              </div>
            </div>

            <pre className="font-mono text-xs bg-zinc-950 text-green-300 p-3 rounded-md whitespace-pre-wrap break-all">
              {createdServer.installCommand}
            </pre>

            <div className="flex justify-between">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard.writeText(createdServer.installCommand);
                  setCopiedInstall(true);
                  setTimeout(() => setCopiedInstall(false), 2000);
                }}
              >
                {copiedInstall ? <><Check size={12} /> {t('server.copied')}</> : <><Copy size={12} /> {t('common.copy')}</>}
              </Button>
              <Button size="sm" variant="outline"
                onClick={() => regenInstallMutation.mutate(createdServer.id)}
                disabled={regenInstallMutation.isPending}>
                {t('server.regenToken')}
              </Button>
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <p><strong>1.</strong> {t('server.step1')} <code>ssh root@your-vps</code></p>
              <p><strong>2.</strong> {t('server.step2')}</p>
              <p><strong>3.</strong> {t('server.step3')}</p>
              <p><strong>4.</strong> {t('server.step4')}</p>
            </div>

            <DialogFooter>
              <Button onClick={closeAddDialog}>{t('server.done')}</Button>
            </DialogFooter>
          </div>
        )}
      </Dialog>

      {/* ---- Reset Server Confirmation Dialog ---- */}
      <Dialog open={showReset} onClose={() => setShowReset(false)}>
        <DialogHeader>
          <DialogTitle>{t('server.resetServer')}</DialogTitle>
          <DialogDescription>{t('server.resetConfirmDesc')}</DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowReset(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => server && deleteMutation.mutate(server.id)}
          >
            {deleteMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            {deleteMutation.isPending ? t('server.resetting') : t('server.resetServer')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ---- Rotate Agent Token Dialog (replaces native confirm) ---- */}
      <Dialog open={!!rotateTarget} onClose={() => setRotateTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('server.rotateTitle')}</DialogTitle>
          <DialogDescription>
            {t('server.rotateDesc', { name: rotateTarget?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRotateTarget(null)}>{t('common.cancel')}</Button>
          <Button
            disabled={rotateTokenMutation.isPending}
            onClick={() => rotateTarget && rotateTokenMutation.mutate(rotateTarget.id)}
          >
            {rotateTokenMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('server.rotateBtn')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ---- Reset Remote Server Dialog (replaces native confirm) ---- */}
      <Dialog open={!!resetTarget} onClose={() => setResetTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('server.resetTitle')}</DialogTitle>
          <DialogDescription>
            {t('server.resetDesc', { name: resetTarget?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setResetTarget(null)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={resetServerMutation.isPending}
            onClick={() => resetTarget && resetServerMutation.mutate(resetTarget.id)}
          >
            {resetServerMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('server.resetBtn')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ---- Delete Server Dialog (replaces native confirm) ---- */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('server.deleteTitle')}</DialogTitle>
          <DialogDescription>
            {t('server.deleteDesc', { name: deleteTarget?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={removeServerMutation.isPending}
            onClick={() => deleteTarget && removeServerMutation.mutate({ id: deleteTarget.id, force: true })}
          >
            {removeServerMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('server.deleteBtn')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
