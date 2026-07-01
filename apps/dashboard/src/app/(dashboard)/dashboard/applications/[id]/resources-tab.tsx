'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer, AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip,
} from 'recharts';
import { Cpu, MemoryStick, Network, HardDrive, Loader2, Activity } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';

/**
 * Per-app resource usage: live cards (auto-refresh) + historical charts.
 * A PHP-nginx app runs two containers (web + fpm), so both live stats and
 * history are keyed by containerName. Read-only — any VIEWER+ sees it.
 */

interface LiveStat {
  name: string;
  cpuPercent: number;
  memoryUsed: number;
  memoryLimit: number;
  networkIn: number;
  networkOut: number;
  blockRead: number;
  blockWrite: number;
}

interface HistRow {
  containerName: string;
  cpuPercent: number;
  memoryUsed: string | number;
  memoryLimit: string | number;
  timestamp: string;
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

export function ResourcesTab({ appId }: { appId: string }) {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>('24h');

  const { data: live, isLoading: liveLoading } = useQuery<{ stats: LiveStat[]; error?: string }>({
    queryKey: ['app-stats-live', appId],
    queryFn: () => api.get(`/applications/${appId}/stats/live`),
    refetchInterval: 5000,
  });

  const { data: history = [], isLoading: histLoading } = useQuery<HistRow[]>({
    queryKey: ['app-stats-history', appId, period],
    queryFn: () => api.get(`/monitoring/applications/${appId}/metrics?period=${period}`),
  });

  const stats = live?.stats ?? [];

  // Build chart series per container. Recharts wants one row per timestamp with
  // a key per series; with (usually) one container we keep it simple and chart
  // the FIRST container's series (the primary app container).
  const chartData = useMemo(() => {
    if (history.length === 0) return [];
    const primary = history[0]?.containerName;
    return history
      .filter((r) => r.containerName === primary)
      .map((r) => {
        const used = Number(r.memoryUsed);
        const limit = Number(r.memoryLimit);
        const d = new Date(r.timestamp);
        return {
          time: period === '24h'
            ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
          cpu: Math.round(r.cpuPercent * 10) / 10,
          memMiB: Math.round(used / (1024 * 1024)),
          memPct: limit > 0 ? Math.round((used / limit) * 100) : 0,
        };
      });
  }, [history, period]);

  return (
    <div className="space-y-5">
      {/* ── Live cards ── */}
      {liveLoading && stats.length === 0 ? (
        <div className="flex items-center justify-center py-10 text-muted-foreground">
          <Loader2 size={20} className="animate-spin" />
        </div>
      ) : stats.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Activity size={32} className="text-muted-foreground/50 mb-2" />
            <p className="text-sm text-muted-foreground">
              {live?.error ? t('resources.unavailable') : t('resources.noLive')}
            </p>
          </CardContent>
        </Card>
      ) : (
        stats.map((s) => {
          const memPct = s.memoryLimit > 0 ? (s.memoryUsed / s.memoryLimit) * 100 : 0;
          return (
            <div key={s.name} className="space-y-2">
              {stats.length > 1 && (
                <p className="text-xs font-mono text-muted-foreground">{s.name}</p>
              )}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Cpu size={14} className="text-violet-500" /> {t('resources.cpu')}
                    </div>
                    <p className="mt-1 text-2xl font-bold">{s.cpuPercent.toFixed(1)}%</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <MemoryStick size={14} className="text-blue-500" /> {t('resources.memory')}
                    </div>
                    <p className="mt-1 text-2xl font-bold">{fmtBytes(s.memoryUsed)}</p>
                    <p className="text-[11px] text-muted-foreground">
                      / {fmtBytes(s.memoryLimit)} ({memPct.toFixed(0)}%)
                    </p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Network size={14} className="text-emerald-500" /> {t('resources.network')}
                    </div>
                    <p className="mt-1 text-sm font-bold">↓ {fmtBytes(s.networkIn)}</p>
                    <p className="text-sm font-bold">↑ {fmtBytes(s.networkOut)}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="p-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <HardDrive size={14} className="text-orange-500" /> {t('resources.blockIo')}
                    </div>
                    <p className="mt-1 text-sm font-bold">R {fmtBytes(s.blockRead)}</p>
                    <p className="text-sm font-bold">W {fmtBytes(s.blockWrite)}</p>
                  </CardContent>
                </Card>
              </div>
            </div>
          );
        })
      )}

      {/* ── History ── */}
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
                      <linearGradient id="ctCpuGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#7c3aed" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#7c3aed" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="time" stroke="#a1a1aa" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#a1a1aa" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={35} />
                    <Tooltip formatter={(v: number) => [`${v}%`, 'CPU']} />
                    <Area type="monotone" dataKey="cpu" stroke="#7c3aed" strokeWidth={2} fill="url(#ctCpuGrad)" />
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
                      <linearGradient id="ctMemGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                    <XAxis dataKey="time" stroke="#a1a1aa" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#a1a1aa" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}M`} width={40} />
                    <Tooltip formatter={(v: number) => [`${v} MiB`, 'RAM']} />
                    <Area type="monotone" dataKey="memMiB" stroke="#3b82f6" strokeWidth={2} fill="url(#ctMemGrad)" />
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
