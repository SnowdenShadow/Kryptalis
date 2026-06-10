'use client';

import { useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Rocket,
  Globe,
  Cpu,
  MemoryStick,
  HardDrive,
  Container,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Zap,
  ExternalLink,
  Archive,
  Plus,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import Link from 'next/link';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const statusVariant: Record<string, 'success' | 'destructive' | 'warning' | 'secondary'> = {
  RUNNING: 'success', ONLINE: 'success', ACTIVE: 'success', COMPLETED: 'success',
  PENDING: 'warning', BUILDING: 'warning', DEPLOYING: 'warning', IN_PROGRESS: 'warning',
  FAILED: 'destructive', ERROR: 'destructive', OFFLINE: 'destructive',
  STOPPED: 'secondary', CANCELLED: 'secondary',
};

function timeAgo(date: string) {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtGB(bytes: number) {
  return `${(bytes / 1073741824).toFixed(1)}`;
}

// ---------------------------------------------------------------------------
// Tooltip style shared by both mini charts
// ---------------------------------------------------------------------------
const chartTooltipStyle = {
  backgroundColor: '#0f0f11',
  border: '1px solid #27272a',
  borderRadius: '8px',
  color: '#fafafa',
  fontSize: '11px',
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const { t } = useTranslation();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'SUPERADMIN';

  // --- server info (id, status, etc.) — admin-only endpoint ---
  const { data: server } = useQuery<any>({
    queryKey: ['server-local'],
    queryFn: () => api.get('/servers/local'),
    enabled: isAdmin,
    retry: false,
  });

  // --- trigger a background refresh of system info (once, admin only) ---
  const setupMutation = useMutation({
    mutationFn: () => api.post('/servers/local/setup'),
  });
  const triggerSetup = setupMutation.mutate;
  useEffect(() => {
    if (isAdmin) triggerSetup();
  }, [isAdmin, triggerSetup]);

  // --- live stats (cpu, mem, disk, docker, processes, uptime) ---
  const { data: stats } = useQuery<any>({
    queryKey: ['server-local-stats'],
    queryFn: () => api.get('/servers/local/stats'),
    refetchInterval: 10000,
    enabled: isAdmin,
    retry: false,
  });

  // --- historical metrics for charts ---
  const { data: metrics = [] } = useQuery<any[]>({
    queryKey: ['overview-metrics', server?.id],
    queryFn: () => api.get(`/monitoring/servers/${server!.id}/metrics?period=24h`),
    enabled: isAdmin && !!server?.id,
    refetchInterval: 15000,
  });

  // --- applications, domains, deployments ---
  const { data: applications = [] } = useQuery<any[]>({
    queryKey: ['applications'],
    queryFn: () => api.get('/applications'),
  });
  useQuery<any[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
  });
  const { data: deployments = [] } = useQuery<any[]>({
    queryKey: ['deployments'],
    queryFn: () => api.get('/deployments'),
  });

  // --- derived ---
  const recentDeploys = (Array.isArray(deployments) ? deployments : []).slice(0, 5);

  const cpuPct = Math.round(stats?.cpu?.average ?? 0);
  const cpuCores = stats?.cpu?.cores ?? server?.cpuCores ?? '?';

  const memUsed = stats?.memory?.used ?? 0;
  const memTotal = stats?.memory?.total ?? server?.totalMemory ?? 1;
  const memPct = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0;

  const diskUsed = stats?.disk?.used ?? 0;
  const diskTotal = stats?.disk?.total ?? 1;
  const diskPct = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;

  const dockerContainers: any[] = stats?.dockerContainers ?? [];
  const hostname = stats?.hostname ?? server?.name ?? 'Server';
  const uptimeStr = stats?.uptime?.formatted ?? '--';
  const serverStatus: string | undefined = server?.status;

  // chart data
  const cpuHistory = metrics.map((m: any, i: number) => ({ i, v: m.cpuPercent ?? 0 }));
  const ramHistory = metrics.map((m: any, i: number) => ({
    i,
    v: m.memoryTotal > 0 ? Math.round((m.memoryUsed / m.memoryTotal) * 100) : 0,
  }));

  // progress bar color fn
  const barColor = (pct: number, warn = 80) =>
    pct > 90 ? 'bg-red-500' : pct > warn ? 'bg-orange-500' : 'bg-violet-500';

  return (
    <div className="space-y-5">

      {/* ================================================================= */}
      {/* HEADER                                                            */}
      {/* ================================================================= */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          {isAdmin && (
            <>
              <span className="text-sm text-muted-foreground font-mono">{hostname}</span>
              {serverStatus && (
                <Badge variant={statusVariant[serverStatus] || 'secondary'} className="text-[11px] px-2 py-0.5 gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full inline-block ${
                    serverStatus === 'ONLINE' ? 'bg-green-400 animate-pulse' :
                    serverStatus === 'OFFLINE' ? 'bg-red-400' : 'bg-zinc-400'
                  }`} />
                  {serverStatus}
                </Badge>
              )}
            </>
          )}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Clock size={14} />
            <span className="font-mono">{uptimeStr}</span>
          </div>
        )}
      </div>

      {/* ================================================================= */}
      {/* SERVER HEALTH STRIP (4 compact cards) — admin only                */}
      {/* ================================================================= */}
      {isAdmin && (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">

        {/* CPU */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Cpu size={13} /> CPU
            </div>
            <span className="text-xs text-muted-foreground">{cpuCores} cores</span>
          </div>
          <p className={`text-3xl font-bold tabular-nums ${cpuPct > 90 ? 'text-red-500' : cpuPct > 70 ? 'text-orange-400' : ''}`}>
            {cpuPct}<span className="text-lg">%</span>
          </p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barColor(cpuPct)}`} style={{ width: `${cpuPct}%` }} />
          </div>
        </Card>

        {/* RAM */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <MemoryStick size={13} /> RAM
            </div>
            <span className="text-xs text-muted-foreground">{memPct}%</span>
          </div>
          <p className="text-3xl font-bold tabular-nums">
            {fmtGB(memUsed)}<span className="text-sm font-normal text-muted-foreground"> / {fmtGB(memTotal)} GB</span>
          </p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barColor(memPct)}`} style={{ width: `${memPct}%` }} />
          </div>
        </Card>

        {/* Disk */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <HardDrive size={13} /> Disk
            </div>
            <span className={`text-xs ${diskPct > 80 ? 'text-orange-400' : 'text-muted-foreground'}`}>{diskPct}%</span>
          </div>
          <p className="text-3xl font-bold tabular-nums">
            {fmtGB(diskUsed)}<span className="text-sm font-normal text-muted-foreground"> / {fmtGB(diskTotal)} GB</span>
          </p>
          <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barColor(diskPct, 70)}`} style={{ width: `${diskPct}%` }} />
          </div>
        </Card>

        {/* Docker */}
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Container size={13} /> Docker
            </div>
            <span className="h-2 w-2 rounded-full bg-green-500 inline-block" />
          </div>
          <p className="text-3xl font-bold tabular-nums">
            {dockerContainers.length}<span className="text-sm font-normal text-muted-foreground"> containers</span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground truncate">
            {dockerContainers.length > 0
              ? dockerContainers.map((c: any) => c.name).join(', ')
              : 'No running containers'}
          </p>
        </Card>
      </div>
      )}

      {/* ================================================================= */}
      {/* MINI CHARTS ROW — admin only                                      */}
      {/* ================================================================= */}
      {isAdmin && (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* CPU History */}
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-2">CPU &mdash; Last 24h</p>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cpuHistory}>
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#7c3aed" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#7c3aed" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <Tooltip
                  contentStyle={chartTooltipStyle}
                  labelFormatter={() => ''}
                  formatter={(v: number) => [`${v.toFixed(1)}%`, 'CPU']}
                />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#7c3aed"
                  strokeWidth={2}
                  fill="url(#cpuGrad)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* RAM History */}
        <Card className="p-4">
          <p className="text-xs text-muted-foreground mb-2">Memory &mdash; Last 24h</p>
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={ramHistory}>
                <defs>
                  <linearGradient id="ramGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <Tooltip
                  contentStyle={chartTooltipStyle}
                  labelFormatter={() => ''}
                  formatter={(v: number) => [`${v}%`, 'RAM']}
                />
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#ramGrad)"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
      )}

      {/* ================================================================= */}
      {/* TWO COLUMNS: Applications | Activity & Docker                     */}
      {/* ================================================================= */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">

        {/* ---------- Left: Applications ---------- */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div>
              <CardTitle className="text-base">Applications</CardTitle>
              <CardDescription>{applications.length} deployed</CardDescription>
            </div>
            <Link href="/dashboard/applications">
              <Button variant="outline" size="sm" className="h-7 text-xs">View all</Button>
            </Link>
          </CardHeader>
          <CardContent>
            {applications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <Rocket size={28} className="mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground mb-3">No applications deployed</p>
                <Link href="/dashboard/marketplace">
                  <Button size="sm">
                    <Plus size={14} className="mr-1" /> Install from Marketplace
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-1.5">
                {applications.slice(0, 6).map((app: any) => (
                  <Link key={app.id} href={`/dashboard/applications/${app.id}`} className="block">
                    <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 transition-colors hover:bg-accent/50 group">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`h-2 w-2 rounded-full shrink-0 ${
                          app.status === 'RUNNING' ? 'bg-green-500' :
                          app.status === 'ERROR' ? 'bg-red-500' : 'bg-zinc-500'
                        }`} />
                        <span className="text-sm font-medium truncate">{app.name}</span>
                        {app.framework && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                            {app.framework}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {app.port && (
                          <span className="text-[11px] text-muted-foreground font-mono">:{app.port}</span>
                        )}
                        <ExternalLink size={12} className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ---------- Right: Activity & Docker ---------- */}
        <div className="space-y-4">

          {/* Recent Deployments */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Recent Deployments</CardTitle>
            </CardHeader>
            <CardContent>
              {recentDeploys.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No recent deployments</p>
              ) : (
                <div className="space-y-1.5">
                  {recentDeploys.map((d: any) => (
                    <div key={d.id} className="flex items-center gap-2.5 rounded-md border border-border px-3 py-2">
                      {d.status === 'COMPLETED' || d.status === 'RUNNING' ? (
                        <CheckCircle2 size={15} className="text-green-500 shrink-0" />
                      ) : d.status === 'FAILED' ? (
                        <XCircle size={15} className="text-red-500 shrink-0" />
                      ) : (
                        <AlertTriangle size={15} className="text-yellow-500 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{d.application?.name || 'Deploy'}</p>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {timeAgo(d.createdAt)}
                          {d.commitMessage && ` - ${d.commitMessage}`}
                        </p>
                      </div>
                      <Badge variant={statusVariant[d.status] || 'secondary'} className="text-[10px] h-5">
                        {d.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Docker Containers — admin only (data comes from /servers/local/stats) */}
          {isAdmin && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Docker Containers</CardTitle>
              <CardDescription>{dockerContainers.length} running</CardDescription>
            </CardHeader>
            <CardContent>
              {dockerContainers.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No running containers</p>
              ) : (
                <div className="space-y-1.5">
                  {dockerContainers.slice(0, 6).map((c: any, i: number) => (
                    <div key={i} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Container size={13} className="text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium truncate">{c.name}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground truncate max-w-[140px]">{c.image}</span>
                        <Badge variant="success" className="text-[10px] h-5 shrink-0">{c.status?.split(' ')[0] || 'Up'}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          )}
        </div>
      </div>

      {/* ================================================================= */}
      {/* QUICK ACTIONS                                                     */}
      {/* ================================================================= */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Link href="/dashboard/marketplace">
          <Button variant="outline" className="w-full h-10 justify-start gap-2 text-sm">
            <Zap size={15} className="text-violet-500" /> Install App
          </Button>
        </Link>
        <Link href="/dashboard/applications">
          <Button variant="outline" className="w-full h-10 justify-start gap-2 text-sm">
            <Rocket size={15} className="text-blue-500" /> {t('overview.deployApp')}
          </Button>
        </Link>
        <Link href="/dashboard/domains">
          <Button variant="outline" className="w-full h-10 justify-start gap-2 text-sm">
            <Globe size={15} className="text-emerald-500" /> {t('overview.addDomain')}
          </Button>
        </Link>
        <Link href="/dashboard/backups">
          <Button variant="outline" className="w-full h-10 justify-start gap-2 text-sm">
            <Archive size={15} className="text-amber-500" /> {t('overview.createBackup')}
          </Button>
        </Link>
      </div>
    </div>
  );
}
