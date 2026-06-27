'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Wifi,
  Bell,
  Plus,
  Trash2,
  Server,
  Clock,
  Container,
  Activity,
  Network,
  ShieldAlert,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
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
import type { AlertRuleResponse, CreateAlertRuleRequest } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useServers } from '@/lib/hooks';
import { useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// --- Types ---

interface Metric {
  cpuPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  timestamp: string;
}

interface ServerRow {
  id: string;
  name: string;
  host: string;
  status: string;
  lastSeenAt?: string | null;
  agentVersion?: string | null;
  os?: string | null;
  cpuCores?: number | null;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal', '::1'];

// Shared API resource type — local alias keeps the JSX readable.
type AlertRule = AlertRuleResponse;

const operatorSymbols: Record<string, string> = {
  GT: '>',
  GTE: '>=',
  LT: '<',
  LTE: '<=',
  EQ: '=',
};

interface ServerStats {
  hostname: string;
  platform: string;
  release: string;
  arch: string;
  uptime: { seconds: number; formatted: string };
  cpu: {
    cores: number;
    model: string;
    average: number;
    perCore: { core: number; model: string; speed: number; usage: number }[];
  };
  loadAverage: { '1m': number; '5m': number; '15m': number };
  memory: { total: number; used: number; free: number; percent: number };
  disk: { total: number; used: number; free: number; percent: number };
  network: {
    interfaces: {
      name: string;
      addresses: { address: string; family: string }[];
    }[];
  };
  topProcesses: { name: string; memoryMB: number; cpuTime: number }[];
  dockerContainers: {
    name: string;
    status: string;
    image: string;
    ports: string;
  }[];
}

type Period = '24h' | '7d' | '30d' | '90d';

const periods: { value: Period; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
];

// --- Helpers ---

function toGB(bytes: number): number {
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

function getBarColor(percent: number): string {
  if (percent > 90) return '#ef4444';
  if (percent > 80) return '#f97316';
  if (percent > 60) return '#eab308';
  return '#7c3aed';
}

function getStatusColor(status: string): 'success' | 'destructive' | 'warning' {
  const s = status.toLowerCase();
  if (s.startsWith('up')) return 'success';
  if (s.includes('exited') || s.includes('dead')) return 'destructive';
  return 'warning';
}

const chartTooltipStyle = {
  contentStyle: {
    backgroundColor: '#0f0f11',
    border: '1px solid #27272a',
    borderRadius: '8px',
    color: '#fafafa',
    fontSize: '12px',
  },
  labelStyle: { color: '#a1a1aa' },
};

// --- Compact circular gauge ---

function CircularGauge({ percent, size = 52, strokeWidth = 5, color }: {
  percent: number;
  size?: number;
  strokeWidth?: number;
  color: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(percent, 100) / 100) * circumference;
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="#27272a"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-all duration-700"
      />
    </svg>
  );
}

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: color }}
      />
    </div>
  );
}

// --- Main Component ---

export default function MonitoringPage() {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>('24h');
  const [showAlertDialog, setShowAlertDialog] = useState(false);
  const [alertForm, setAlertForm] = useState({
    name: '',
    metric: 'cpu',
    threshold: 80,
    operator: 'GTE',
    channel: 'EMAIL',
    webhookUrl: '',
  });
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPERADMIN';
  const accessDenied = !!user && !isAdmin;

  // --- Data fetching (admin-only endpoints) ---
  // Server picker: every registered server (local + remote agents). The
  // local one is the default selection.
  const { data: servers = [] } = useServers<ServerRow[]>({
    enabled: isAdmin,
    retry: false,
    refetchInterval: 30000,
  });
  const [selectedServerId, setSelectedServerId] = useState('');
  const localServer = servers.find((s) => LOCAL_HOSTS.includes(s.host));
  const selectedServer =
    servers.find((s) => s.id === selectedServerId) ?? localServer ?? servers[0];
  const serverId = selectedServer?.id || '';
  const isLocalSelected = !!selectedServer && LOCAL_HOSTS.includes(selectedServer.host);

  // Live process/docker/interface stats only exist for the LOCAL host (the
  // API reads its own /proc). Remote servers report metrics through their
  // agent heartbeats (ServerMetric rows) — charts + gauges come from there.
  const { data: stats } = useQuery<ServerStats>({
    queryKey: ['server-stats'],
    queryFn: () => api.get('/servers/local/stats'),
    refetchInterval: 10000,
    enabled: isAdmin && isLocalSelected,
    retry: false,
  });

  const { data: metrics = [] } = useQuery<Metric[]>({
    queryKey: ['metrics', serverId, period],
    queryFn: () =>
      api.get(`/monitoring/servers/${serverId}/metrics?period=${period}`),
    enabled: isAdmin && !!serverId,
    refetchInterval: 10000,
  });

  // Remote gauges: derive current CPU/RAM/disk from the latest agent metric
  // sample so the metric cards work for every server, not just the local one.
  const lastMetric = metrics.length > 0 ? metrics[metrics.length - 1] : null;

  const { data: alertRules = [] } = useQuery<AlertRule[]>({
    queryKey: ['monitoring', 'alert-rules', serverId],
    queryFn: () => api.get(`/monitoring/alert-rules?serverId=${serverId}`),
    enabled: isAdmin && !!serverId,
  });

  // --- Mutations ---
  const createAlert = useMutation({
    mutationFn: (data: CreateAlertRuleRequest) =>
      api.post('/monitoring/alert-rules', data),
    onSuccess: () => {
      toast.success(t('toast.alertCreated'));
      queryClient.invalidateQueries({
        queryKey: ['monitoring', 'alert-rules', serverId],
      });
      setShowAlertDialog(false);
      setAlertForm({ name: '', metric: 'cpu', threshold: 80, operator: 'GTE', channel: 'EMAIL', webhookUrl: '' });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteAlert = useMutation({
    mutationFn: (id: string) => api.delete(`/monitoring/alert-rules/${id}`),
    onSuccess: () => {
      toast.success(t('toast.alertDeleted'));
      queryClient.invalidateQueries({
        queryKey: ['monitoring', 'alert-rules', serverId],
      });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // --- Derived data ---
  // Local server → live /proc stats. Remote server → latest agent heartbeat
  // sample (Number() is safe: BigInt columns serialize as decimal strings).
  const remoteMemUsed = lastMetric ? Number(lastMetric.memoryUsed) : 0;
  const remoteMemTotal = lastMetric ? Number(lastMetric.memoryTotal) : 0;
  const remoteDiskUsed = lastMetric ? Number(lastMetric.diskUsed) : 0;
  const remoteDiskTotal = lastMetric ? Number(lastMetric.diskTotal) : 0;
  const cpuAvg = isLocalSelected ? (stats?.cpu.average ?? 0) : (lastMetric?.cpuPercent ?? 0);
  const memPercent = isLocalSelected
    ? (stats?.memory.percent ?? 0)
    : remoteMemTotal > 0 ? Math.round((remoteMemUsed / remoteMemTotal) * 100) : 0;
  const memUsedGB = isLocalSelected ? (stats ? toGB(stats.memory.used) : 0) : toGB(remoteMemUsed);
  const memTotalGB = isLocalSelected ? (stats ? toGB(stats.memory.total) : 0) : toGB(remoteMemTotal);
  const diskPercent = isLocalSelected
    ? (stats?.disk.percent ?? 0)
    : remoteDiskTotal > 0 ? Math.round((remoteDiskUsed / remoteDiskTotal) * 100) : 0;
  const diskUsedGB = isLocalSelected ? (stats ? toGB(stats.disk.used) : 0) : toGB(remoteDiskUsed);
  const diskTotalGB = isLocalSelected ? (stats ? toGB(stats.disk.total) : 0) : toGB(remoteDiskTotal);
  const diskFreeGB = isLocalSelected
    ? (stats ? toGB(stats.disk.free) : 0)
    : toGB(Math.max(0, remoteDiskTotal - remoteDiskUsed));
  const primaryIp = isLocalSelected
    ? (stats?.network.interfaces
        .flatMap((i) => i.addresses)
        .find((a) => a.family === 'IPv4')?.address ?? '---')
    : (selectedServer?.host ?? '---');
  const ifaceCount = stats?.network.interfaces.length ?? 0;
  // "Has data" gate for the metric sections — local needs live stats,
  // remote needs at least one heartbeat sample.
  const hasData = isLocalSelected ? !!stats : !!lastMetric;

  const chartData = metrics.map((m) => ({
    time: new Date(m.timestamp).toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    cpu: Math.round(m.cpuPercent * 10) / 10,
    ramUsed: toGB(m.memoryUsed),
    ramTotal: toGB(m.memoryTotal),
  }));

  const topProcesses = (stats?.topProcesses ?? [])
    .sort((a, b) => b.memoryMB - a.memoryMB)
    .slice(0, 10);

  function handleCreateAlert() {
    createAlert.mutate({
      name: alertForm.name,
      serverId,
      // Select values are constrained to the request unions by the <option>
      // lists below — the casts just bridge the untyped DOM string.
      metric: alertForm.metric as CreateAlertRuleRequest['metric'],
      threshold: alertForm.threshold,
      operator: alertForm.operator as CreateAlertRuleRequest['operator'],
      channel: alertForm.channel as CreateAlertRuleRequest['channel'],
      ...(alertForm.channel === 'WEBHOOK' && alertForm.webhookUrl
        ? { webhookUrl: alertForm.webhookUrl }
        : {}),
    });
  }

  if (accessDenied) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t('monitoring.title')}</h1>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <ShieldAlert size={48} className="mb-4 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('admin.restricted')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ========== 1. Header ========== */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">{t('monitoring.title')}</h1>
          {/* Server picker — local + every registered remote agent */}
          {servers.length > 1 && (
            <Select
              value={serverId}
              onChange={(e) => setSelectedServerId(e.target.value)}
              className="w-auto text-xs"
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({LOCAL_HOSTS.includes(s.host) ? 'local' : s.host}){s.status !== 'ONLINE' ? ` — ${s.status}` : ''}
                </option>
              ))}
            </Select>
          )}
          {selectedServer && (
            <Badge
              variant={selectedServer.status === 'ONLINE' ? 'success' : 'destructive'}
              className="gap-1 text-xs"
            >
              <Server size={12} />
              {selectedServer.status}
            </Badge>
          )}
          {isLocalSelected && stats && (
            <Badge variant="secondary" className="gap-1 text-xs">
              <Clock size={12} />
              {stats.uptime.formatted}
            </Badge>
          )}
          {!isLocalSelected && selectedServer?.lastSeenAt && (
            <Badge variant="secondary" className="gap-1 text-xs">
              <Clock size={12} />
              {t('monitoring.lastSeen')} {new Date(selectedServer.lastSeenAt).toLocaleTimeString()}
            </Badge>
          )}
        </div>
        <div className="flex gap-1 rounded-lg border border-border bg-muted/50 p-0.5 w-fit">
          {periods.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={cn(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                period === p.value
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* ========== 2. System Info Bar ========== */}
      {isLocalSelected && stats && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{stats.cpu.model}</span>
          <span>{stats.cpu.cores} {t('monitoring.cores')}</span>
          <span className="capitalize">{stats.platform} {stats.release}</span>
          <span>{stats.arch}</span>
          <span>{t('monitoring.up')} {stats.uptime.formatted}</span>
        </div>
      )}
      {!isLocalSelected && selectedServer && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground font-mono">{selectedServer.host}</span>
          {selectedServer.os && <span>{selectedServer.os}</span>}
          {selectedServer.cpuCores != null && <span>{selectedServer.cpuCores} {t('monitoring.cores')}</span>}
          {selectedServer.agentVersion && <span>agent v{selectedServer.agentVersion}</span>}
        </div>
      )}

      {!hasData ? (
        <Card>
          <CardContent className="flex items-center justify-center py-16">
            <p className="text-sm text-muted-foreground">
              {isLocalSelected ? t('monitoring.loadingStats') : t('monitoring.noRemoteData')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ========== 3. Metric Cards ========== */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {/* CPU */}
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <CircularGauge percent={cpuAvg} color={getBarColor(cpuAvg)} />
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold rotate-0">
                    {Math.round(cpuAvg)}%
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Cpu size={12} className="text-violet-500" />
                    CPU
                  </div>
                  <p className="text-lg font-bold leading-tight">{cpuAvg.toFixed(1)}%</p>
                  <p className="text-[10px] text-muted-foreground">
                    {(isLocalSelected ? stats?.cpu.cores : selectedServer?.cpuCores) ?? '—'} {t('monitoring.cores')}
                  </p>
                </div>
              </div>
            </Card>

            {/* RAM */}
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <CircularGauge percent={memPercent} color={getBarColor(memPercent)} />
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold">
                    {memPercent}%
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MemoryStick size={12} className="text-blue-500" />
                    RAM
                  </div>
                  <p className="text-lg font-bold leading-tight">{memUsedGB} GB</p>
                  <p className="text-[10px] text-muted-foreground">/ {memTotalGB} GB</p>
                </div>
              </div>
            </Card>

            {/* Disk */}
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <CircularGauge
                    percent={diskPercent}
                    color={diskPercent > 80 ? '#f97316' : getBarColor(diskPercent)}
                  />
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold">
                    {diskPercent}%
                  </span>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <HardDrive size={12} className="text-orange-500" />
                    Disk
                  </div>
                  <p className="text-lg font-bold leading-tight">{diskUsedGB} GB</p>
                  <p className="text-[10px] text-muted-foreground">/ {diskTotalGB} GB</p>
                </div>
              </div>
            </Card>

            {/* Network */}
            <Card className="p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full border-[5px] border-violet-500/30">
                  <Wifi size={18} className="text-violet-500" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Network size={12} className="text-violet-500" />
                    Network
                  </div>
                  <p className="text-sm font-bold leading-tight font-mono">{primaryIp}</p>
                  <p className="text-[10px] text-muted-foreground">{ifaceCount} {ifaceCount !== 1 ? t('monitoring.interfaces') : t('monitoring.interface')}</p>
                </div>
              </div>
            </Card>
          </div>

          {/* ========== 4. Charts ========== */}
          {chartData.length > 0 && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {/* CPU History */}
              <Card>
                <CardHeader className="px-4 py-3 pb-0">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <Cpu size={14} className="text-violet-500" />
                    {t('monitoring.cpuHistory')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3 pt-2">
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData}>
                        <defs>
                          <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                        <XAxis
                          dataKey="time"
                          stroke="#a1a1aa"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          domain={[0, 100]}
                          stroke="#a1a1aa"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v) => `${v}%`}
                          width={35}
                        />
                        <Tooltip
                          {...chartTooltipStyle}
                          formatter={(value: number) => [`${value}%`, 'CPU']}
                        />
                        <Area
                          type="monotone"
                          dataKey="cpu"
                          stroke="#7c3aed"
                          strokeWidth={2}
                          fill="url(#cpuGrad)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>

              {/* RAM History */}
              <Card>
                <CardHeader className="px-4 py-3 pb-0">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <MemoryStick size={14} className="text-blue-500" />
                    {t('monitoring.memoryHistory')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3 pt-2">
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={chartData}>
                        <defs>
                          <linearGradient id="ramGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                        <XAxis
                          dataKey="time"
                          stroke="#a1a1aa"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis
                          domain={[0, chartData.length > 0 ? chartData[0].ramTotal : 64]}
                          stroke="#a1a1aa"
                          fontSize={10}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(v) => `${v}G`}
                          width={35}
                        />
                        <Tooltip
                          {...chartTooltipStyle}
                          formatter={(value: number) => [`${value} GB`, t('monitoring.ramUsedLabel')]}
                        />
                        <Area
                          type="monotone"
                          dataKey="ramUsed"
                          stroke="#3b82f6"
                          strokeWidth={2}
                          fill="url(#ramGrad)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* ========== 5. Disk & Docker Row ========== */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* Disk Detail */}
            <Card>
              <CardHeader className="px-4 py-3 pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <HardDrive size={14} className="text-orange-500" />
                  {t('monitoring.diskUsage')}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-3">
                <div className="flex items-center gap-4">
                  <div className="relative">
                    <CircularGauge
                      percent={diskPercent}
                      size={72}
                      strokeWidth={7}
                      color={diskPercent > 80 ? '#f97316' : '#7c3aed'}
                    />
                    <span className="absolute inset-0 flex items-center justify-center text-sm font-bold">
                      {diskPercent}%
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-center flex-1">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('monitoring.used')}</p>
                      <p className="text-sm font-bold">{diskUsedGB} GB</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('monitoring.free')}</p>
                      <p className="text-sm font-bold">{diskFreeGB} GB</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('monitoring.total')}</p>
                      <p className="text-sm font-bold">{diskTotalGB} GB</p>
                    </div>
                  </div>
                </div>
                <div className="mt-3">
                  <ProgressBar
                    percent={diskPercent}
                    color={diskPercent > 80 ? '#f97316' : '#7c3aed'}
                  />
                </div>
              </CardContent>
            </Card>

            {/* Docker Containers — live data exists only for the local host;
                remote container state is visible per-app on the apps pages. */}
            {isLocalSelected && stats && (
            <Card>
              <CardHeader className="px-4 py-3 pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Container size={14} className="text-blue-500" />
                  {t('monitoring.dockerContainers')}
                  {stats.dockerContainers.length > 0 && (
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      {stats.dockerContainers.length}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0 pt-2">
                {stats.dockerContainers.length === 0 ? (
                  <p className="px-4 pb-4 text-xs text-muted-foreground">{t('monitoring.noContainersRunning')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="px-4 py-1.5 font-medium">{t('monitoring.colName')}</th>
                          <th className="px-4 py-1.5 font-medium">{t('monitoring.colImage')}</th>
                          <th className="px-4 py-1.5 font-medium">{t('monitoring.colStatus')}</th>
                          <th className="px-4 py-1.5 font-medium">{t('monitoring.colPorts')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats.dockerContainers.map((c) => (
                          <tr key={c.name} className="border-b border-border last:border-0 hover:bg-muted/50">
                            <td className="px-4 py-1.5 font-mono font-medium">{c.name}</td>
                            <td className="px-4 py-1.5 text-muted-foreground max-w-[180px] truncate">{c.image}</td>
                            <td className="px-4 py-1.5">
                              <Badge variant={getStatusColor(c.status)} className="text-[10px]">
                                {c.status}
                              </Badge>
                            </td>
                            <td className="px-4 py-1.5 font-mono text-muted-foreground text-[10px]">{c.ports || '---'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
            )}
          </div>

          {/* ========== 6. Top Processes & 7. Network Interfaces ========== */}
          {/* Both read live /proc + os.networkInterfaces() — local host only. */}
          {isLocalSelected && stats && (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* Top Processes */}
            <Card>
              <CardHeader className="px-4 py-3 pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Activity size={14} className="text-violet-500" />
                  {t('monitoring.topProcesses')}
                  <span className="ml-auto text-[10px] text-muted-foreground font-normal">{t('monitoring.byMemory')}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-0 pt-2">
                {topProcesses.length === 0 ? (
                  <p className="px-4 pb-4 text-xs text-muted-foreground">{t('monitoring.noProcessData')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="px-4 py-1.5 font-medium">#</th>
                          <th className="px-4 py-1.5 font-medium">{t('monitoring.colProcess')}</th>
                          <th className="px-4 py-1.5 font-medium text-right">{t('monitoring.colMemory')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topProcesses.map((p, i) => (
                          <tr key={`${p.name}-${i}`} className="border-b border-border last:border-0 hover:bg-muted/50">
                            <td className="px-4 py-1.5 text-muted-foreground">{i + 1}</td>
                            <td className="px-4 py-1.5 font-mono font-medium">{p.name}</td>
                            <td className="px-4 py-1.5 text-right font-mono">
                              {p.memoryMB >= 1024
                                ? `${(p.memoryMB / 1024).toFixed(1)} GB`
                                : `${Math.round(p.memoryMB)} MB`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Network Interfaces */}
            <Card>
              <CardHeader className="px-4 py-3 pb-0">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Network size={14} className="text-violet-500" />
                  {t('monitoring.networkInterfaces')}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-4 pb-4 pt-3">
                {stats.network.interfaces.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('monitoring.noInterfaces')}</p>
                ) : (
                  <div className="space-y-2">
                    {stats.network.interfaces.map((iface) => (
                      <div
                        key={iface.name}
                        className="flex items-start justify-between rounded-lg border border-border px-3 py-2"
                      >
                        <div>
                          <p className="text-xs font-medium">{iface.name}</p>
                          <div className="mt-0.5 flex flex-wrap gap-2">
                            {iface.addresses.map((addr) => (
                              <span
                                key={addr.address}
                                className="font-mono text-[11px] text-muted-foreground"
                              >
                                {addr.address}
                                <span className="ml-1 text-[9px] text-muted-foreground/60">{addr.family}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
          )}

          {/* ========== 8. Alert Rules ========== */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Bell size={16} />
                <h2 className="text-base font-semibold">{t('monitoring.alertRules')}</h2>
                <Badge variant="secondary" className="text-[10px]">{alertRules.length}</Badge>
              </div>
              <Button size="sm" onClick={() => setShowAlertDialog(true)}>
                <Plus size={14} />
                {t('monitoring.addAlert')}
              </Button>
            </div>

            <Card>
              {alertRules.length === 0 ? (
                <CardContent className="flex flex-col items-center justify-center py-8">
                  <Bell size={28} className="mb-2 text-muted-foreground" />
                  <p className="text-sm font-medium">{t('monitoring.noAlertRules')}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('monitoring.noAlertRulesDesc')}
                  </p>
                </CardContent>
              ) : (
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border text-left text-muted-foreground">
                          <th className="px-4 py-2 font-medium">{t('common.name')}</th>
                          <th className="px-4 py-2 font-medium">{t('monitoring.metric')}</th>
                          <th className="px-4 py-2 font-medium">{t('monitoring.threshold')}</th>
                          <th className="px-4 py-2 font-medium">{t('monitoring.channel')}</th>
                          <th className="px-4 py-2 font-medium">{t('common.actions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {alertRules.map((rule) => (
                          <tr
                            key={rule.id}
                            className="border-b border-border last:border-0 hover:bg-muted/50"
                          >
                            <td className="px-4 py-2 font-medium">{rule.name}</td>
                            <td className="px-4 py-2">
                              <Badge variant="outline" className="text-[10px]">{rule.metric}</Badge>
                            </td>
                            <td className="px-4 py-2 text-muted-foreground">{operatorSymbols[rule.operator ?? 'GTE'] ?? '>='} {rule.threshold}%</td>
                            <td className="px-4 py-2">
                              <Badge variant="secondary" className="text-[10px]">{rule.channel}</Badge>
                            </td>
                            <td className="px-4 py-2">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-destructive"
                                disabled={deleteAlert.isPending}
                                onClick={() => deleteAlert.mutate(rule.id)}
                              >
                                <Trash2 size={12} />
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              )}
            </Card>
          </div>

          {/* Add Alert Dialog */}
          <Dialog open={showAlertDialog} onClose={() => setShowAlertDialog(false)}>
            <DialogHeader>
              <DialogTitle>{t('monitoring.createAlertRule')}</DialogTitle>
              <DialogDescription>
                {t('monitoring.createAlertDesc')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="alert-name">{t('common.name')}</Label>
                <Input
                  id="alert-name"
                  placeholder={t('monitoring.alertNamePlaceholder')}
                  value={alertForm.name}
                  onChange={(e) => setAlertForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="alert-metric">{t('monitoring.metric')}</Label>
                <Select
                  id="alert-metric"
                  value={alertForm.metric}
                  onChange={(e) => setAlertForm((f) => ({ ...f, metric: e.target.value }))}
                >
                  <option value="cpu">CPU</option>
                  <option value="memory">{t('monitoring.metricMemory')}</option>
                  <option value="disk">{t('monitoring.metricDisk')}</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="alert-operator">{t('monitoring.condition')}</Label>
                <Select
                  id="alert-operator"
                  value={alertForm.operator}
                  onChange={(e) => setAlertForm((f) => ({ ...f, operator: e.target.value }))}
                >
                  <option value="GT">&gt;</option>
                  <option value="GTE">&gt;=</option>
                  <option value="LT">&lt;</option>
                  <option value="LTE">&lt;=</option>
                  <option value="EQ">=</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="alert-threshold">{t('monitoring.threshold')} (%)</Label>
                <Input
                  id="alert-threshold"
                  type="number"
                  min={1}
                  max={100}
                  value={alertForm.threshold}
                  onChange={(e) => setAlertForm((f) => ({ ...f, threshold: Number(e.target.value) }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="alert-channel">{t('monitoring.channel')}</Label>
                <Select
                  id="alert-channel"
                  value={alertForm.channel}
                  onChange={(e) => setAlertForm((f) => ({ ...f, channel: e.target.value }))}
                >
                  <option value="EMAIL">{t('monitoring.channelEmail')}</option>
                  <option value="DISCORD">{t('monitoring.channelDiscord')}</option>
                  <option value="SLACK">{t('monitoring.channelSlack')}</option>
                  <option value="WEBHOOK">{t('monitoring.channelWebhook')}</option>
                </Select>
              </div>
              {alertForm.channel === 'WEBHOOK' && (
                <div className="space-y-2">
                  <Label htmlFor="alert-webhook">{t('monitoring.webhookUrl')}</Label>
                  <Input
                    id="alert-webhook"
                    placeholder="https://..."
                    value={alertForm.webhookUrl}
                    onChange={(e) => setAlertForm((f) => ({ ...f, webhookUrl: e.target.value }))}
                  />
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAlertDialog(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleCreateAlert}
                disabled={!alertForm.name || createAlert.isPending}
              >
                {createAlert.isPending ? t('common.creating') : t('common.create')}
              </Button>
            </DialogFooter>
          </Dialog>
        </>
      )}
    </div>
  );
}
