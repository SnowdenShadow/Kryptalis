'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip,
} from 'recharts';
import { Cpu, MemoryStick, Network, HardDrive, Loader2, Activity, Rocket } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';

/**
 * Whole-project resource consumption: summed totals across every app, a
 * per-app breakdown table, and a project-wide CPU + memory history chart.
 * Read-only (VIEWER+). Mirrors the per-app Resources tab visually.
 */

interface Usage {
  cpuPercent: number;
  memoryUsed: number;
  memoryLimit: number;
  networkIn: number;
  networkOut: number;
  blockRead: number;
  blockWrite: number;
  containers: number;
}
interface AppUsage {
  id: string;
  name: string;
  status: string;
  framework: string;
  usage: Usage;
}
interface UsageResponse {
  projectId: string;
  totals: Usage;
  apps: AppUsage[];
}
interface HistRow {
  timestamp: string;
  cpuPercent: number;
  memoryUsed: string | number;
}

const PERIODS = ['24h', '7d', '30d'] as const;

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function ProjectResourcesTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>('24h');

  const { data: usage, isLoading } = useQuery<UsageResponse>({
    queryKey: ['project-usage', projectId],
    queryFn: () => api.get(`/projects/${projectId}/usage`),
    refetchInterval: 10000,
  });

  const { data: history = [], isLoading: histLoading } = useQuery<HistRow[]>({
    queryKey: ['project-usage-history', projectId, period],
    queryFn: () => api.get(`/projects/${projectId}/usage/history?period=${period}`),
  });

  const chartData = useMemo(
    () =>
      history.map((r) => {
        const d = new Date(r.timestamp);
        return {
          time: period === '24h'
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
          cpu: Math.round(r.cpuPercent * 10) / 10,
          memMiB: Math.round(Number(r.memoryUsed) / (1024 * 1024)),
        };
      }),
    [history, period],
  );

  const totals = usage?.totals;
  const apps = usage?.apps ?? [];
  const activeApps = [...apps].sort((a, b) => b.usage.cpuPercent - a.usage.cpuPercent);

  if (isLoading && !usage) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Project totals ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Cpu size={14} className="text-violet-500" /> {t('resources.cpu')}
            </div>
            <p className="mt-1 text-2xl font-bold">{(totals?.cpuPercent ?? 0).toFixed(1)}%</p>
            <p className="text-[11px] text-muted-foreground">
              {t('projectResources.acrossContainers', { n: totals?.containers ?? 0 })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <MemoryStick size={14} className="text-blue-500" /> {t('resources.memory')}
            </div>
            <p className="mt-1 text-2xl font-bold">{fmtBytes(totals?.memoryUsed ?? 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Network size={14} className="text-emerald-500" /> {t('resources.network')}
            </div>
            <p className="mt-1 text-sm font-bold">↓ {fmtBytes(totals?.networkIn ?? 0)}</p>
            <p className="text-sm font-bold">↑ {fmtBytes(totals?.networkOut ?? 0)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <HardDrive size={14} className="text-orange-500" /> {t('resources.blockIo')}
            </div>
            <p className="mt-1 text-sm font-bold">R {fmtBytes(totals?.blockRead ?? 0)}</p>
            <p className="text-sm font-bold">W {fmtBytes(totals?.blockWrite ?? 0)}</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Per-app breakdown ── */}
      <Card>
        <CardHeader className="px-4 py-3 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Activity size={14} /> {t('projectResources.perApp')}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {apps.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('projectResources.empty')}</p>
          ) : (
            <div className="divide-y divide-border">
              {activeApps.map((a) => {
                const memPct = a.usage.memoryLimit > 0 ? (a.usage.memoryUsed / a.usage.memoryLimit) * 100 : 0;
                return (
                  <Link
                    key={a.id}
                    href={`/dashboard/applications/${a.id}`}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/40"
                  >
                    <Rocket size={14} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{a.name}</p>
                      <Badge variant="outline" className="text-[9px]">{a.framework}</Badge>
                    </div>
                    <div className="flex shrink-0 items-center gap-4 text-sm">
                      <span className="flex items-center gap-1">
                        <Cpu size={12} className="text-violet-500" />
                        <span className="font-mono">{a.usage.cpuPercent.toFixed(1)}%</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <MemoryStick size={12} className="text-blue-500" />
                        <span className="font-mono">{fmtBytes(a.usage.memoryUsed)}</span>
                        {a.usage.memoryLimit > 0 && (
                          <span className="text-[11px] text-muted-foreground">({memPct.toFixed(0)}%)</span>
                        )}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Project-wide history ── */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('resources.history')}</h3>
        <div className="flex gap-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                period === p ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>

      {histLoading ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : chartData.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t('resources.noHistory')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader className="px-4 py-3 pb-0">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <Cpu size={14} className="text-violet-500" /> {t('resources.cpuHistory')}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-2">
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="pjCpuGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="time" stroke="#a1a1aa" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#a1a1aa" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={35} />
                    <Tooltip formatter={(v: number) => [`${v}%`, 'CPU']} />
                    <Area type="monotone" dataKey="cpu" stroke="#7c3aed" strokeWidth={2} fill="url(#pjCpuGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="px-4 py-3 pb-0">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <MemoryStick size={14} className="text-blue-500" /> {t('resources.memoryHistory')}
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-2">
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="pjMemGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="time" stroke="#a1a1aa" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#a1a1aa" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}M`} width={40} />
                    <Tooltip formatter={(v: number) => [`${v} MiB`, 'RAM']} />
                    <Area type="monotone" dataKey="memMiB" stroke="#3b82f6" strokeWidth={2} fill="url(#pjMemGrad)" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
