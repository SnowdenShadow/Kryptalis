'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Play,
  Square,
  RotateCcw,
  Trash2,
  ExternalLink,
  Terminal,
  RefreshCw,
  Globe,
  GitBranch,
  Clock,
  Box,
  FolderOpen,
  Activity,
  ShieldCheck,
  Plus,
  Send,
  Settings,
  Layers,
  ChevronRight,
  Rocket,
  FileCode,
  Plug,
  Save,
  AlertTriangle,
  Loader2,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
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
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApplicationDetail {
  id: string;
  name: string;
  projectId: string;
  framework: string;
  status: string;
  gitUrl: string | null;
  gitBranch: string | null;
  dockerImage?: string | null;
  port: number | null;
  customPort?: boolean;
  buildCommand?: string | null;
  startCommand?: string | null;
  createdAt: string;
  project?: {
    id: string;
    name: string;
    server?: { id: string; name: string };
  };
  domains?: { id: string; domain: string; sslStatus: string }[];
  portBindings?: {
    id: string;
    port: number;
    domain: { id: string; domain: string; sslStatus: string };
  }[];
}

interface Deployment {
  id: string;
  status: string;
  commitSha?: string | null;
  commitMessage?: string | null;
  buildLogs?: string | null;
  deployLogs?: string | null;
  duration?: number | null;
  triggeredBy?: string | null;
  createdAt: string;
}

interface TerminalEntry {
  cmd: string;
  output: string;
  exitCode: number;
  timestamp: number;
}

type TabId = 'overview' | 'logs' | 'terminal' | 'deployments' | 'files' | 'ports' | 'env' | 'settings';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive'> = {
  RUNNING: 'success',
  STOPPED: 'secondary',
  BUILDING: 'warning',
  DEPLOYING: 'warning',
  ERROR: 'destructive',
  SUCCESS: 'success',
  FAILED: 'destructive',
  PENDING: 'warning',
  CANCELLED: 'secondary',
};

const STATUS_COLOR: Record<string, string> = {
  RUNNING: 'bg-emerald-500',
  STOPPED: 'bg-zinc-400',
  BUILDING: 'bg-orange-500',
  DEPLOYING: 'bg-orange-500',
  ERROR: 'bg-red-500',
  FAILED: 'bg-red-500',
  PENDING: 'bg-orange-500',
};

const FRAMEWORK_LABELS: Record<string, string> = {
  NEXTJS: 'Next.js',
  REACT: 'React',
  VUE: 'Vue',
  ANGULAR: 'Angular',
  NESTJS: 'NestJS',
  EXPRESS: 'Express',
  LARAVEL: 'Laravel',
  SYMFONY: 'Symfony',
  DJANGO: 'Django',
  FLASK: 'Flask',
  FASTAPI: 'FastAPI',
  STATIC: 'Static',
  DOCKER: 'Docker',
  DOCKER_COMPOSE: 'Compose',
};

const HTTPS_PORTS = [443, 8443, 9443];
const LOG_LINE_OPTIONS = [50, 100, 200, 500] as const;
const TABS: { id: TabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'logs', label: 'Logs' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'files', label: 'Files' },
  { id: 'ports', label: 'Ports' },
  { id: 'env', label: 'Env' },
  { id: 'settings', label: 'Settings' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(date: string) {
  const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function appUrl(hostname: string, port: number) {
  const proto = HTTPS_PORTS.includes(port) ? 'https' : 'http';
  return `${proto}://${hostname}:${port}`;
}

/**
 * Every URL this app is reachable at:
 *   - clean-URL domains (app on :443)  → https://<domain>
 *   - port bindings (app co-hosted on another domain) → https://<domain>:<port>
 *   - no domain at all → fallback to <hostname>:<port>
 *
 * Multi-URL is real: an app linked to "myapp.com" as the main app AND port-
 * bound to "shared.com:8080" exposes BOTH URLs.
 */
function publicUrls(
  app: {
    port?: number | null;
    customPort?: boolean;
    domains?: { domain: string; sslStatus: string }[];
    portBindings?: { port: number; domain: { domain: string; sslStatus: string } }[];
  },
  fallbackHostname: string,
): string[] {
  const urls: string[] = [];
  for (const d of app.domains || []) {
    // Clean URL on :443 → HTTPS via Caddy. Port-pinned → direct to container
    // (http://) because Caddy only binds 80/443 and the container holds the
    // custom port itself.
    urls.push(app.customPort && app.port
      ? `http://${d.domain}:${app.port}`
      : `https://${d.domain}`);
  }
  for (const b of app.portBindings || []) {
    urls.push(`http://${b.domain.domain}:${b.port}`);
  }
  if (urls.length === 0 && app.port) {
    urls.push(appUrl(fallbackHostname, app.port));
  }
  return urls;
}

/** First URL — used by Open button / single-line displays. */
function publicUrl(
  app: Parameters<typeof publicUrls>[0],
  fallbackHostname: string,
): string | null {
  return publicUrls(app, fallbackHostname)[0] || null;
}

// ---------------------------------------------------------------------------
// Status dot
// ---------------------------------------------------------------------------

function RenameRow({
  current,
  slugName,
  onSave,
  saving,
}: {
  current: string;
  slugName: string;
  onSave: (value: string) => void;
  saving: boolean;
}) {
  const [value, setValue] = useState(current);
  const dirty = value.trim() !== current.trim();
  return (
    <div className="flex items-end gap-2">
      <div className="flex-1">
        <Label className="text-xs text-muted-foreground">Display name</Label>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={slugName}
          disabled={saving}
        />
      </div>
      <Button
        size="sm"
        disabled={!dirty || saving || !value.trim()}
        onClick={() => onSave(value.trim())}
      >
        {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
      </Button>
      {current !== slugName && (
        <Button
          size="sm"
          variant="outline"
          disabled={saving}
          onClick={() => { setValue(slugName); onSave(''); }}
          title="Revert to the canonical slug name"
        >
          Reset
        </Button>
      )}
    </div>
  );
}

function StatusDot({ status, size = 'sm' }: { status: string; size?: 'sm' | 'lg' }) {
  const dim = size === 'lg' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';
  const pulse = ['RUNNING', 'DEPLOYING', 'BUILDING', 'PENDING'].includes(status);
  const color = STATUS_COLOR[status] || 'bg-zinc-400';
  return <span className={cn('inline-block rounded-full shrink-0', dim, color, pulse && 'animate-pulse')} />;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApplicationDetailPage() {
  const { t } = useTranslation();
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = params.id as string;

  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>('overview');

  // Delete dialog
  const [showDelete, setShowDelete] = useState(false);

  // Domain link
  const [showLinkDomain, setShowLinkDomain] = useState(false);
  const [selectedDomainId, setSelectedDomainId] = useState('');

  // Port edit
  const [editingPort, setEditingPort] = useState(false);
  const [portValue, setPortValue] = useState('');

  // Logs state
  const [logLines, setLogLines] = useState<number>(200);
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const logsRef = useRef<HTMLDivElement>(null);

  // Terminal state
  const [termHistory, setTermHistory] = useState<TerminalEntry[]>([]);
  const [termInput, setTermInput] = useState('');
  const termRef = useRef<HTMLDivElement>(null);
  const termInputRef = useRef<HTMLInputElement>(null);

  // --- Application data ---
  const { data: app, isLoading } = useQuery<ApplicationDetail>({
    queryKey: ['application', id],
    queryFn: () => api.get(`/applications/${id}`),
    refetchInterval: 5000,
  });

  // --- Deployment history ---
  const { data: deployments = [] } = useQuery<Deployment[]>({
    queryKey: ['deployments', id],
    queryFn: () => api.get(`/applications/${id}/deployments`),
    refetchInterval: 10000,
    enabled: activeTab === 'deployments',
  });
  const [deploymentDetail, setDeploymentDetail] = useState<Deployment | null>(null);
  const deploymentLogsEndRef = useRef<HTMLDivElement>(null);

  // live poll the open deployment as long as it's not in a final state
  const FINAL_STATES = new Set(['RUNNING', 'FAILED', 'CANCELLED', 'ROLLED_BACK']);
  const { data: liveDeployment } = useQuery<Deployment>({
    queryKey: ['deployment', id, deploymentDetail?.id],
    queryFn: () => api.get(`/applications/${id}/deployments/${deploymentDetail!.id}`),
    enabled: !!deploymentDetail,
    refetchInterval: (q) => {
      const status = (q.state.data as Deployment | undefined)?.status ?? deploymentDetail?.status;
      return status && !FINAL_STATES.has(status) ? 1500 : false;
    },
  });
  const liveDep = liveDeployment || deploymentDetail;

  // auto-scroll logs to bottom as they grow
  useEffect(() => {
    deploymentLogsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [liveDep?.buildLogs]);

  // --- Logs ---
  const { data: logsData, refetch: refetchLogs } = useQuery<{ logs: string }>({
    queryKey: ['app-logs', id, logLines],
    queryFn: () => api.get(`/applications/${id}/logs?lines=${logLines}`),
    refetchInterval: activeTab === 'logs' && logsAutoRefresh ? 3000 : false,
    enabled: activeTab === 'logs',
  });

  // Scroll logs to bottom when data changes
  useEffect(() => {
    if (activeTab === 'logs' && logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logsData?.logs, activeTab]);

  // Scroll terminal to bottom when history changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight;
    }
  }, [termHistory]);

  // Auto-focus terminal input when switching to terminal tab
  useEffect(() => {
    if (activeTab === 'terminal') {
      termInputRef.current?.focus();
    }
  }, [activeTab]);

  // --- Mutations ---
  const actionMutation = useMutation({
    mutationFn: (action: string) => api.post(`/applications/${id}/${action}`),
    onSuccess: (_, action) => {
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success(`Application ${action} initiated`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Fetch all domains for linking
  const { data: allDomains = [] } = useQuery<any[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
  });
  const unlinkedDomains = allDomains.filter((d: any) => !d.applicationId);

  const linkDomainMutation = useMutation({
    mutationFn: (domainId: string) => api.patch(`/domains/${domainId}`, { applicationId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Domain linked');
      setShowLinkDomain(false);
      setSelectedDomainId('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const unlinkDomainMutation = useMutation({
    mutationFn: (domainId: string) => api.patch(`/domains/${domainId}`, { applicationId: null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Domain unlinked');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updatePortMutation = useMutation({
    mutationFn: (port: number) => api.patch(`/applications/${id}`, { port }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success('Port updated');
      setEditingPort(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: (displayName: string) => api.patch(`/applications/${id}`, { displayName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success('Name updated');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const urlModeMutation = useMutation({
    mutationFn: (customPort: boolean) =>
      api.patch(`/applications/${id}/url-mode`, { customPort }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success('URL mode updated — Caddy reloading');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const [newBindingDomainId, setNewBindingDomainId] = useState('');
  const [newBindingPort, setNewBindingPort] = useState('');
  const addBindingMutation = useMutation({
    mutationFn: ({ domainId, port }: { domainId: string; port: number }) =>
      api.post(`/applications/${id}/port-bindings`, { domainId, port }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success('Port binding added — Caddy reloading');
      setNewBindingDomainId('');
      setNewBindingPort('');
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const removeBindingMutation = useMutation({
    mutationFn: (bindingId: string) =>
      api.delete(`/applications/port-bindings/${bindingId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success('Binding removed');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(`/applications/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success('Application deleted');
      router.push('/dashboard/applications');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // --- Files (compose / Dockerfile) ---
  const { data: composeFile, refetch: refetchCompose } = useQuery<{ exists: boolean; content: string; path: string | null }>({
    queryKey: ['app-compose', id],
    queryFn: () => api.get(`/applications/${id}/files/compose`),
    enabled: activeTab === 'files',
  });
  const { data: dockerfile, refetch: refetchDockerfile } = useQuery<{ exists: boolean; content: string }>({
    queryKey: ['app-dockerfile', id],
    queryFn: () => api.get(`/applications/${id}/files/dockerfile`),
    enabled: activeTab === 'files',
  });
  const [composeDraft, setComposeDraft] = useState<string | null>(null);
  const [dockerfileDraft, setDockerfileDraft] = useState<string | null>(null);
  useEffect(() => { if (composeFile && composeDraft === null) setComposeDraft(composeFile.content); }, [composeFile, composeDraft]);
  useEffect(() => { if (dockerfile && dockerfileDraft === null) setDockerfileDraft(dockerfile.content); }, [dockerfile, dockerfileDraft]);

  const saveComposeMutation = useMutation({
    mutationFn: (content: string) => api.patch(`/applications/${id}/files/compose`, { content }),
    onSuccess: () => { toast.success('Compose saved'); refetchCompose(); queryClient.invalidateQueries({ queryKey: ['app-ports', id] }); },
    onError: (err: Error) => toast.error(err.message),
  });
  const saveDockerfileMutation = useMutation({
    mutationFn: (content: string) => api.patch(`/applications/${id}/files/dockerfile`, { content }),
    onSuccess: () => { toast.success('Dockerfile saved'); refetchDockerfile(); queryClient.invalidateQueries({ queryKey: ['app-ports', id] }); },
    onError: (err: Error) => toast.error(err.message),
  });

  // --- Ports ---
  const { data: portsData, refetch: refetchPorts } = useQuery<{ compose: Array<{ service: string; host: number | null; container: number; protocol: string }>; dockerfileExposed: number[]; appPort: number | null }>({
    queryKey: ['app-ports', id],
    queryFn: () => api.get(`/applications/${id}/ports`),
    enabled: activeTab === 'ports',
  });
  const [portsDraft, setPortsDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (portsData?.compose && Object.keys(portsDraft).length === 0) {
      const init: Record<string, string> = {};
      for (const p of portsData.compose) {
        init[String(p.container)] = String(p.host ?? p.container);
      }
      setPortsDraft(init);
    }
  }, [portsData]);

  const remapPortsMutation = useMutation({
    mutationFn: (mapping: Record<string, number>) => api.patch(`/applications/${id}/ports`, { mapping }),
    onSuccess: () => {
      toast.success('Ports remapped — redeploy to apply');
      refetchPorts();
      queryClient.invalidateQueries({ queryKey: ['app-compose', id] });
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // --- Env vars ---
  const { data: envData, refetch: refetchEnv } = useQuery<{ envVars: Record<string, string> }>({
    queryKey: ['app-env', id],
    queryFn: () => api.get(`/applications/${id}/env`),
    enabled: activeTab === 'env',
  });
  const [envDraft, setEnvDraft] = useState<Array<{ key: string; value: string }>>([]);
  useEffect(() => {
    if (envData && envDraft.length === 0) {
      const entries = Object.entries(envData.envVars || {});
      setEnvDraft(entries.length ? entries.map(([k, v]) => ({ key: k, value: v })) : [{ key: '', value: '' }]);
    }
  }, [envData]);

  const saveEnvMutation = useMutation({
    mutationFn: (envVars: Record<string, string>) => api.patch(`/applications/${id}/env`, { envVars }),
    onSuccess: () => { toast.success('Env vars saved — redeploy to apply'); refetchEnv(); },
    onError: (err: Error) => toast.error(err.message),
  });

  // --- Webhook ---
  const { data: webhook, refetch: refetchWebhook } = useQuery<{ url: string; secret: string; autoDeploy: boolean; contentType: string }>({
    queryKey: ['app-webhook', id],
    queryFn: () => api.get(`/applications/${id}/webhook`),
    enabled: activeTab === 'settings',
  });
  const rotateWebhookMutation = useMutation({
    mutationFn: () => api.post(`/applications/${id}/webhook/rotate`),
    onSuccess: () => { toast.success('Secret rotated'); refetchWebhook(); },
    onError: (err: Error) => toast.error(err.message),
  });
  const autoDeployMutation = useMutation({
    mutationFn: (enabled: boolean) => api.patch(`/applications/${id}/auto-deploy`, { enabled }),
    onSuccess: () => { refetchWebhook(); queryClient.invalidateQueries({ queryKey: ['application', id] }); },
    onError: (err: Error) => toast.error(err.message),
  });
  const [showSecret, setShowSecret] = useState(false);

  // --- Redeploy ---
  const redeployMutation = useMutation({
    mutationFn: () => api.post(`/applications/${id}/redeploy`),
    onSuccess: () => {
      toast.success('Redeploy triggered');
      queryClient.invalidateQueries({ queryKey: ['application', id] });
      queryClient.invalidateQueries({ queryKey: ['deployments', id] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const execMutation = useMutation({
    mutationFn: (command: string) => api.post(`/applications/${id}/exec`, { command }),
    onSuccess: (res: any, command) => {
      setTermHistory(prev => [...prev, {
        cmd: command,
        output: res.output,
        exitCode: res.exitCode,
        timestamp: Date.now(),
      }]);
      setTermInput('');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const handleTermSubmit = useCallback(() => {
    const cmd = termInput.trim();
    if (!cmd || execMutation.isPending) return;
    execMutation.mutate(cmd);
  }, [termInput, execMutation]);

  // --- Loading state ---
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-2 w-full rounded bg-muted animate-pulse" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="py-6">
                <div className="h-5 w-20 rounded bg-muted mb-2" />
                <div className="h-7 w-28 rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // --- Not found ---
  if (!app) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" onClick={() => router.push('/dashboard/applications')}>
          <ArrowLeft size={16} /> Back to Applications
        </Button>
        <p className="text-muted-foreground">Application not found.</p>
      </div>
    );
  }

  const isRunning = app.status === 'RUNNING';
  const isStopped = app.status === 'STOPPED';
  const hostname = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const statusBarColor = STATUS_COLOR[app.status] || 'bg-zinc-400';

  return (
    <div className="-mt-6 -mx-6">
      <div className={cn('h-1 w-full', statusBarColor)} />

      <div className="px-6 pt-4 pb-3 space-y-3">
        <div className="flex items-start gap-4">
          <Button variant="ghost" size="icon" className="mt-1 shrink-0" onClick={() => router.push('/dashboard/applications')}>
            <ArrowLeft size={20} />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-3xl font-bold truncate">{app.name}</h1>
              <Badge variant={STATUS_VARIANT[app.status] || 'secondary'} className="gap-1.5">
                <StatusDot status={app.status} />
                {app.status}
              </Badge>
              <Badge variant="outline">{FRAMEWORK_LABELS[app.framework] || app.framework}</Badge>
            </div>
            {isRunning && app.port && (() => {
              const urls = publicUrls(app, hostname);
              if (urls.length === 0) return null;
              return (
                <div className="flex items-center gap-x-3 gap-y-1 mt-1.5 text-sm text-muted-foreground flex-wrap">
                  {urls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline font-mono truncate"
                    >
                      {url}
                    </a>
                  ))}
                </div>
              );
            })()}
          </div>
          <div className="flex gap-2 shrink-0 flex-wrap">
            {isRunning && app.port && (() => {
              const url = publicUrl(app, hostname);
              if (!url) return null;
              return (
                <Button onClick={() => window.open(url, '_blank')}>
                  <ExternalLink size={14} /> Open
                </Button>
              );
            })()}
            {isStopped ? (
              <Button variant="outline" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate('start')}>
                <Play size={14} /> {t('apps.start')}
              </Button>
            ) : isRunning ? (
              <Button variant="outline" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate('stop')}>
                <Square size={14} /> {t('apps.stop')}
              </Button>
            ) : null}
            {isRunning && (
              <Button variant="outline" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate('restart')}>
                <RotateCcw size={14} /> {t('apps.restart')}
              </Button>
            )}
            {(app.gitUrl || app.dockerImage) && (
              <Button
                variant="outline"
                disabled={redeployMutation.isPending || app.status === 'DEPLOYING'}
                onClick={() => redeployMutation.mutate()}
                title={app.gitUrl ? 'Pull latest commit and rebuild' : 'Re-pull image and recreate container'}
              >
                <Rocket size={14} /> Redeploy
              </Button>
            )}
            <Button variant="destructive" onClick={() => setShowDelete(true)}>
              <Trash2 size={14} /> {t('common.delete')}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex gap-1 border-b border-border px-6">
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              activeTab === tab.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="px-6 pt-5 pb-6 space-y-5">
        {/* ============================================================== */}
        {/* Overview Tab                                                    */}
        {/* ============================================================== */}
        {activeTab === 'overview' && (
          <>
            {/* Status card */}
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <Activity size={14} /> Status
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <StatusDot status={app.status} size="lg" />
                  <span className="text-2xl font-bold">{app.status}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  <Clock size={12} className="inline mr-1" />
                  Created {timeAgo(app.createdAt)}
                </p>
              </CardContent>
            </Card>

            {/* Connection info */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Connection Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Public URLs — one row per reachable URL */}
                <div className="rounded-lg border border-border p-3">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                    Public URLs
                  </p>
                  {(() => {
                    const urls = publicUrls(app, hostname);
                    if (urls.length === 0) {
                      return (
                        <p className="text-sm text-muted-foreground">
                          No URL yet — start the app, then link a domain or open the port directly.
                        </p>
                      );
                    }
                    // Pair each URL with the domain it came from (so we can show
                    // the SSL badge alongside).
                    const rows: { url: string; domain?: string; sslStatus?: string; kind: 'main' | 'binding' | 'ip' }[] = [];
                    for (const d of app.domains || []) {
                      rows.push({
                        url: app.customPort && app.port
                          ? `https://${d.domain}:${app.port}`
                          : `https://${d.domain}`,
                        domain: d.domain,
                        sslStatus: d.sslStatus,
                        kind: 'main',
                      });
                    }
                    for (const b of app.portBindings || []) {
                      rows.push({
                        url: `https://${b.domain.domain}:${b.port}`,
                        domain: b.domain.domain,
                        sslStatus: b.domain.sslStatus,
                        kind: 'binding',
                      });
                    }
                    if (rows.length === 0 && app.port) {
                      rows.push({ url: appUrl(hostname, app.port), kind: 'ip' });
                    }
                    return (
                      <div className="space-y-2">
                        {rows.map((r) => (
                          <div key={r.url} className="flex items-center gap-2 flex-wrap">
                            <a
                              href={r.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-primary hover:underline font-mono text-sm font-semibold flex items-center gap-1 break-all"
                            >
                              <ExternalLink size={11} /> {r.url}
                            </a>
                            {r.sslStatus && (
                              <Badge
                                variant={r.sslStatus === 'ACTIVE' ? 'success' : r.sslStatus === 'PENDING' ? 'warning' : 'destructive'}
                                className="text-[10px]"
                              >
                                {r.sslStatus === 'ACTIVE' ? '🔒 SSL' : r.sslStatus === 'PENDING' ? '⏳ SSL' : '⚠️ SSL'}
                              </Badge>
                            )}
                            {r.kind === 'ip' && (
                              <Badge variant="outline" className="text-[10px]">direct IP</Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Internal port</p>
                    <p className="font-mono text-lg font-bold">{app.port || 'Not set'}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Framework</p>
                    <p className="text-lg font-bold">{FRAMEWORK_LABELS[app.framework] || app.framework}</p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Project</p>
                    {app.project ? (
                      <Link href={`/dashboard/projects/${app.project.id}`} className="text-lg font-bold text-primary hover:underline">
                        {app.project.name}
                      </Link>
                    ) : (
                      <p className="text-lg font-bold text-muted-foreground">N/A</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Git info */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <GitBranch size={18} /> Git Info
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Repository URL</p>
                      <p className="mt-0.5 font-mono text-sm truncate">
                        {app.gitUrl || <span className="text-muted-foreground">Not set</span>}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Branch</p>
                      <p className="mt-0.5 text-sm">
                        {app.gitBranch ? (
                          <Badge variant="outline" className="gap-1">
                            <GitBranch size={10} /> {app.gitBranch}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">Not set</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Build Command</p>
                      <p className="mt-0.5 font-mono text-sm">
                        {app.buildCommand || <span className="text-muted-foreground">Not set</span>}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Start Command</p>
                      <p className="mt-0.5 font-mono text-sm">
                        {app.startCommand || <span className="text-muted-foreground">Not set</span>}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}

        {/* ============================================================== */}
        {/* Logs Tab                                                        */}
        {/* ============================================================== */}
        {activeTab === 'logs' && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Terminal size={18} /> Logs
              </CardTitle>
              <div className="flex items-center gap-2">
                {/* Lines selector */}
                <div className="flex items-center gap-1">
                  {LOG_LINE_OPTIONS.map((n) => (
                    <button
                      key={n}
                      onClick={() => setLogLines(n)}
                      className={cn(
                        'px-2 py-1 text-xs rounded font-mono transition-colors',
                        logLines === n
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                {/* Auto-refresh toggle */}
                <Button
                  size="sm"
                  variant={logsAutoRefresh ? 'default' : 'outline'}
                  onClick={() => setLogsAutoRefresh(!logsAutoRefresh)}
                  className="text-xs"
                >
                  {logsAutoRefresh ? 'Auto' : 'Paused'}
                </Button>
                {/* Manual refresh */}
                <Button size="sm" variant="outline" onClick={() => refetchLogs()}>
                  <RefreshCw size={14} />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div
                ref={logsRef}
                className="rounded-lg bg-zinc-950 p-4 max-h-[500px] overflow-y-auto"
              >
                <pre className="text-xs text-green-400 font-mono whitespace-pre-wrap break-all">
                  {logsData?.logs || 'Waiting for logs...'}
                </pre>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                {logsAutoRefresh ? 'Auto-refreshes every 3s' : 'Auto-refresh paused'} -- Showing last {logLines} lines
              </p>
            </CardContent>
          </Card>
        )}

        {/* ============================================================== */}
        {/* Terminal Tab                                                     */}
        {/* ============================================================== */}
        {activeTab === 'terminal' && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Terminal size={18} /> Terminal
              </CardTitle>
              <CardDescription>Execute commands in the application container</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg bg-zinc-950 overflow-hidden">
                {/* Terminal output */}
                <div
                  ref={termRef}
                  className="p-4 max-h-[500px] overflow-y-auto min-h-[200px]"
                >
                  {termHistory.length === 0 && (
                    <p className="text-xs text-zinc-500 font-mono">
                      Type a command below and press Enter to execute...
                    </p>
                  )}
                  {termHistory.map((entry, i) => (
                    <div key={i} className="mb-3 last:mb-0">
                      <div className="flex items-center gap-2 text-xs font-mono">
                        <span className="text-blue-400">$</span>
                        <span className="text-zinc-200">{entry.cmd}</span>
                      </div>
                      <pre
                        className={cn(
                          'text-xs font-mono whitespace-pre-wrap break-all mt-1 pl-4',
                          entry.exitCode === 0 ? 'text-green-400' : 'text-red-400'
                        )}
                      >
                        {entry.output || '(no output)'}
                      </pre>
                      {entry.exitCode !== 0 && (
                        <p className="text-xs font-mono text-red-500 pl-4 mt-0.5">
                          exit code: {entry.exitCode}
                        </p>
                      )}
                    </div>
                  ))}
                  {execMutation.isPending && (
                    <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                      <span className="animate-pulse">Running...</span>
                    </div>
                  )}
                </div>
                {/* Terminal input */}
                <div className="flex items-center gap-2 border-t border-zinc-800 px-4 py-3 bg-zinc-900">
                  <span className="text-blue-400 text-sm font-mono">$</span>
                  <input
                    ref={termInputRef}
                    type="text"
                    value={termInput}
                    onChange={(e) => setTermInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleTermSubmit();
                    }}
                    placeholder="Type a command..."
                    disabled={execMutation.isPending}
                    className="flex-1 bg-transparent text-zinc-200 text-sm font-mono outline-none placeholder:text-zinc-600 disabled:opacity-50"
                  />
                  <button
                    onClick={handleTermSubmit}
                    disabled={!termInput.trim() || execMutation.isPending}
                    className="text-zinc-400 hover:text-zinc-200 disabled:opacity-30 transition-colors"
                  >
                    <Send size={14} />
                  </button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ============================================================== */}
        {/* Deployments Tab                                                  */}
        {/* ============================================================== */}
        {activeTab === 'deployments' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Layers size={18} /> Deployment History
              </CardTitle>
              <CardDescription>Recent deployments for this application</CardDescription>
            </CardHeader>
            <CardContent>
              {deployments.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <Clock size={32} className="mb-2" />
                  <p className="text-sm">No deployments yet</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="pb-2 pr-4 font-medium">Status</th>
                        <th className="pb-2 pr-4 font-medium">Commit</th>
                        <th className="pb-2 pr-4 font-medium">Message</th>
                        <th className="pb-2 pr-4 font-medium">Duration</th>
                        <th className="pb-2 font-medium">Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deployments.map((dep) => (
                        <tr
                          key={dep.id}
                          className="border-b last:border-0 cursor-pointer hover:bg-accent/40"
                          onClick={() => setDeploymentDetail(dep)}
                        >
                          <td className="py-2.5 pr-4">
                            <div className="flex items-center gap-2">
                              <StatusDot status={dep.status} />
                              <Badge variant={STATUS_VARIANT[dep.status] || 'secondary'} className="text-[11px]">
                                {dep.status}
                              </Badge>
                            </div>
                          </td>
                          <td className="py-2.5 pr-4">
                            {dep.commitSha ? (
                              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                                {dep.commitSha.slice(0, 7)}
                              </code>
                            ) : (
                              <span className="text-muted-foreground">--</span>
                            )}
                          </td>
                          <td className="py-2.5 pr-4 max-w-[240px] truncate">
                            {dep.commitMessage || <span className="text-muted-foreground">--</span>}
                          </td>
                          <td className="py-2.5 pr-4 text-muted-foreground">
                            {dep.duration ? formatDuration(dep.duration) : '--'}
                          </td>
                          <td className="py-2.5 text-muted-foreground whitespace-nowrap">
                            {timeAgo(dep.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ============================================================== */}
        {/* Files Tab — compose / Dockerfile editor                         */}
        {/* ============================================================== */}
        {activeTab === 'files' && (
          <>
            <Card>
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <FileCode size={18} /> docker-compose.yml
                  </CardTitle>
                  <CardDescription>
                    {composeFile?.exists
                      ? `Editing ${composeFile.path}. Save then redeploy to apply changes.`
                      : 'No compose file yet — write one to provision this app via compose.'}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  disabled={composeDraft === null || composeDraft === composeFile?.content || saveComposeMutation.isPending}
                  onClick={() => composeDraft !== null && saveComposeMutation.mutate(composeDraft)}
                >
                  <Save size={14} /> {saveComposeMutation.isPending ? 'Saving...' : 'Save'}
                </Button>
              </CardHeader>
              <CardContent>
                <textarea
                  className="w-full font-mono text-xs rounded-md border border-border bg-zinc-950 text-green-300 p-3 min-h-[280px] outline-none focus:ring-2 focus:ring-primary"
                  spellCheck={false}
                  value={composeDraft ?? ''}
                  onChange={(e) => setComposeDraft(e.target.value)}
                  placeholder={`services:\n  app:\n    image: nginx\n    ports:\n      - "8080:80"`}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-start justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <FileCode size={18} /> Dockerfile
                  </CardTitle>
                  <CardDescription>
                    {dockerfile?.exists
                      ? 'Editing Dockerfile. Save then redeploy to apply.'
                      : 'No Dockerfile — only used when compose absent.'}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  disabled={dockerfileDraft === null || dockerfileDraft === dockerfile?.content || saveDockerfileMutation.isPending}
                  onClick={() => dockerfileDraft !== null && saveDockerfileMutation.mutate(dockerfileDraft)}
                >
                  <Save size={14} /> {saveDockerfileMutation.isPending ? 'Saving...' : 'Save'}
                </Button>
              </CardHeader>
              <CardContent>
                <textarea
                  className="w-full font-mono text-xs rounded-md border border-border bg-zinc-950 text-green-300 p-3 min-h-[220px] outline-none focus:ring-2 focus:ring-primary"
                  spellCheck={false}
                  value={dockerfileDraft ?? ''}
                  onChange={(e) => setDockerfileDraft(e.target.value)}
                  placeholder={`FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install\nEXPOSE 3000\nCMD ["npm","start"]`}
                />
              </CardContent>
            </Card>
          </>
        )}

        {/* ============================================================== */}
        {/* Ports Tab — preview + remap                                      */}
        {/* ============================================================== */}
        {activeTab === 'ports' && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Plug size={18} /> Port Mapping
              </CardTitle>
              <CardDescription>
                Map container ports to host ports. Save then redeploy to apply.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!portsData ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : portsData.compose.length === 0 && portsData.dockerfileExposed.length === 0 ? (
                <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
                  <AlertTriangle size={18} className="text-orange-500 shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-semibold">No port declared</p>
                    <p className="text-muted-foreground mt-1">
                      Container will start but won&apos;t be reachable from the host.
                      Add a <code>ports:</code> entry in <Link href="#" onClick={(e) => { e.preventDefault(); setActiveTab('files'); }} className="text-primary hover:underline">docker-compose.yml</Link> or an <code>EXPOSE</code> directive in your Dockerfile.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  {portsData.compose.length > 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Compose</p>
                      <div className="space-y-2">
                        {portsData.compose.map((p, i) => (
                          <div key={`${p.service}-${p.container}-${i}`} className="flex items-center gap-3 rounded-md border border-border p-3">
                            <Badge variant="secondary" className="font-mono">{p.service}</Badge>
                            <div className="flex items-center gap-2 flex-1">
                              <div className="flex-1">
                                <Label className="text-xs">Host port</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  max={65535}
                                  className="font-mono h-8"
                                  value={portsDraft[String(p.container)] ?? String(p.host ?? p.container)}
                                  onChange={(e) => setPortsDraft(d => ({ ...d, [String(p.container)]: e.target.value }))}
                                />
                              </div>
                              <ChevronRight size={14} className="mt-5 text-muted-foreground" />
                              <div className="flex-1">
                                <Label className="text-xs">Container port</Label>
                                <Input value={`${p.container}/${p.protocol}`} disabled className="font-mono h-8" />
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {portsData.dockerfileExposed.length > 0 && portsData.compose.length === 0 && (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Dockerfile EXPOSE</p>
                      <div className="flex flex-wrap gap-2">
                        {portsData.dockerfileExposed.map((p) => (
                          <Badge key={p} variant="outline" className="font-mono">{p}</Badge>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Switch to compose to remap ports — Dockerfile EXPOSE values are used as-is for both host and container.
                      </p>
                    </div>
                  )}

                  {portsData.compose.length > 0 && (
                    <div className="flex justify-end">
                      <Button
                        disabled={remapPortsMutation.isPending}
                        onClick={() => {
                          const mapping: Record<string, number> = {};
                          for (const [ct, ht] of Object.entries(portsDraft)) {
                            const n = Number(ht);
                            if (Number.isFinite(n) && n > 0) mapping[ct] = n;
                          }
                          remapPortsMutation.mutate(mapping);
                        }}
                      >
                        <Save size={14} /> {remapPortsMutation.isPending ? 'Saving...' : 'Save Mapping'}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ============================================================== */}
        {/* Env Tab — env vars editor                                        */}
        {/* ============================================================== */}
        {activeTab === 'env' && (
          <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <div>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Settings size={18} /> Environment Variables
                </CardTitle>
                <CardDescription>
                  Variables injected into the container at start. Save then redeploy.
                </CardDescription>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  const map: Record<string, string> = {};
                  for (const { key, value } of envDraft) {
                    const k = key.trim();
                    if (k) map[k] = value;
                  }
                  saveEnvMutation.mutate(map);
                }}
                disabled={saveEnvMutation.isPending}
              >
                <Save size={14} /> {saveEnvMutation.isPending ? 'Saving...' : 'Save'}
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {envDraft.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      placeholder="KEY"
                      className="font-mono"
                      value={row.key}
                      onChange={(e) => setEnvDraft(d => d.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                    />
                    <span className="text-muted-foreground">=</span>
                    <Input
                      placeholder="value"
                      className="font-mono"
                      value={row.value}
                      onChange={(e) => setEnvDraft(d => d.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEnvDraft(d => d.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEnvDraft(d => [...d, { key: '', value: '' }])}
                >
                  <Plus size={14} /> Add Variable
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ============================================================== */}
        {/* Settings Tab                                                     */}
        {/* ============================================================== */}
        {activeTab === 'settings' && (
          <>
            {/* Display name — cosmetic rename. The slug, container, and on-disk
                directory all stay frozen on the canonical `slugName` so
                start/stop/restart/logs keep working. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Settings size={18} /> Name
                </CardTitle>
                <CardDescription>
                  Change how this app appears in the dashboard. The internal slug
                  (<code className="font-mono text-[11px]">{(app as any).slugName || app.name}</code>) and container name stay locked
                  to avoid breaking the running stack.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RenameRow
                  current={app.name}
                  slugName={(app as any).slugName || app.name}
                  onSave={(v) => renameMutation.mutate(v)}
                  saving={renameMutation.isPending}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Settings size={18} /> Configuration
                </CardTitle>
                <CardDescription>Application settings and build configuration</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Git URL</p>
                      <p className="mt-0.5 font-mono text-sm truncate">
                        {app.gitUrl || <span className="text-muted-foreground">Not set</span>}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Branch</p>
                      <p className="mt-0.5 text-sm">
                        {app.gitBranch ? (
                          <Badge variant="outline" className="gap-1">
                            <GitBranch size={10} /> {app.gitBranch}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">Not set</span>
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Port</p>
                      <p className="mt-0.5 font-mono text-sm">
                        {app.port || <span className="text-muted-foreground">Not set</span>}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Build Command</p>
                      <p className="mt-0.5 font-mono text-sm">
                        {app.buildCommand || <span className="text-muted-foreground">Not set</span>}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Start Command</p>
                      <p className="mt-0.5 font-mono text-sm">
                        {app.startCommand || <span className="text-muted-foreground">Not set</span>}
                      </p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* URL mode */}
            {app.domains && app.domains.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <ExternalLink size={18} /> Public URL
                  </CardTitle>
                  <CardDescription>
                    Choose how Kryptalis exposes this app on its domain.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <button
                    onClick={() => urlModeMutation.mutate(false)}
                    disabled={urlModeMutation.isPending}
                    className={cn(
                      'w-full rounded-md border p-3 text-left transition-colors',
                      !app.customPort ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-sm">Clean URL (recommended)</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          <span className="font-mono">https://{app.domains[0].domain}</span> — Caddy proxies on 443 with a Let's Encrypt cert.
                        </p>
                      </div>
                      {!app.customPort && <Check size={16} className="text-primary shrink-0 mt-0.5" />}
                    </div>
                  </button>
                  <button
                    onClick={() => urlModeMutation.mutate(true)}
                    disabled={urlModeMutation.isPending || !app.port}
                    className={cn(
                      'w-full rounded-md border p-3 text-left transition-colors',
                      app.customPort ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-sm">Port-pinned URL</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          <span className="font-mono">http://{app.domains[0].domain}:{app.port}</span> — opens the container directly on its custom port. No HTTPS on this port (Caddy only proxies :443). Use clean URL above for HTTPS.
                        </p>
                      </div>
                      {app.customPort && <Check size={16} className="text-primary shrink-0 mt-0.5" />}
                    </div>
                  </button>
                </CardContent>
              </Card>
            )}

            {/* Port bindings — co-host this app on other domains on custom ports */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Plug size={18} /> Port bindings
                </CardTitle>
                <CardDescription>
                  Expose this app on <span className="font-mono">https://&lt;domain&gt;:&lt;port&gt;</span>. Lets several apps share the same hostname on different ports.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {(app.portBindings || []).length > 0 ? (
                  <div className="space-y-2">
                    {(app.portBindings || []).map((b) => (
                      <div key={b.id} className="flex items-center justify-between rounded-md border border-border p-2.5">
                        <a
                          href={`https://${b.domain.domain}:${b.port}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-sm text-primary hover:underline flex items-center gap-1"
                        >
                          <ExternalLink size={11} /> https://{b.domain.domain}:{b.port}
                        </a>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => removeBindingMutation.mutate(b.id)}
                          disabled={removeBindingMutation.isPending}
                        >
                          <Trash2 size={12} /> Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No port bindings yet.</p>
                )}

                <div className="flex items-end gap-2 pt-2 border-t border-border">
                  <div className="flex-1">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Domain</label>
                    <select
                      value={newBindingDomainId}
                      onChange={(e) => setNewBindingDomainId(e.target.value)}
                      className="w-full mt-0.5 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                    >
                      <option value="">Pick a domain…</option>
                      {(allDomains || []).map((d: any) => (
                        <option key={d.id} value={d.id}>{d.domain}</option>
                      ))}
                    </select>
                  </div>
                  <div className="w-32">
                    <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Port</label>
                    <input
                      type="number"
                      placeholder={String(app.port || 8080)}
                      value={newBindingPort}
                      onChange={(e) => setNewBindingPort(e.target.value)}
                      className="w-full mt-0.5 rounded-md border border-border bg-background px-2 py-1.5 text-sm font-mono"
                    />
                  </div>
                  <Button
                    size="sm"
                    onClick={() => {
                      const p = Number(newBindingPort);
                      if (!newBindingDomainId || !Number.isInteger(p) || p < 1) {
                        toast.error('Pick a domain and a valid port');
                        return;
                      }
                      addBindingMutation.mutate({ domainId: newBindingDomainId, port: p });
                    }}
                    disabled={addBindingMutation.isPending}
                  >
                    <Plus size={14} /> Add
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Port-pinned bindings open the container directly (http://, no TLS). The container's own port publish is what makes them reachable. For HTTPS use the clean URL on :443.
                </p>
              </CardContent>
            </Card>

            {/* Auto-deploy + webhook */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-lg">
                  <Rocket size={18} /> Auto-Deploy & Webhook
                </CardTitle>
                <CardDescription>
                  Trigger a redeploy automatically when your Git provider receives a push.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-md border border-border p-3">
                  <div>
                    <p className="font-medium text-sm">Auto-deploy on push</p>
                    <p className="text-xs text-muted-foreground">
                      When enabled, every push to <code>{app.gitBranch || 'main'}</code> triggers a deploy.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={webhook?.autoDeploy ? 'default' : 'outline'}
                    onClick={() => autoDeployMutation.mutate(!webhook?.autoDeploy)}
                    disabled={autoDeployMutation.isPending}
                  >
                    {webhook?.autoDeploy ? 'Enabled' : 'Disabled'}
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Webhook URL</Label>
                  <div className="flex gap-2">
                    <Input value={webhook?.url || ''} readOnly className="font-mono text-xs" />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { if (webhook?.url) { navigator.clipboard.writeText(webhook.url); toast.success('Copied'); } }}
                    >Copy</Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">Webhook Secret</Label>
                  <div className="flex gap-2">
                    <Input
                      value={webhook?.secret || ''}
                      readOnly
                      type={showSecret ? 'text' : 'password'}
                      className="font-mono text-xs"
                    />
                    <Button size="sm" variant="outline" onClick={() => setShowSecret(s => !s)}>
                      {showSecret ? 'Hide' : 'Show'}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => { if (webhook?.secret) { navigator.clipboard.writeText(webhook.secret); toast.success('Copied'); } }}
                    >Copy</Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rotateWebhookMutation.isPending}
                      onClick={() => { if (confirm('Rotate the secret? The old one will stop working.')) rotateWebhookMutation.mutate(); }}
                    >
                      <RefreshCw size={12} /> Rotate
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    GitHub: header <code>X-Hub-Signature-256</code> · GitLab: header <code>X-Gitlab-Token</code> (use secret as token).
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Danger zone */}
            <Card className="border-destructive/50">
              <CardHeader>
                <CardTitle className="text-lg text-destructive">Danger Zone</CardTitle>
                <CardDescription>
                  Irreversible actions. This will stop all Docker containers and permanently delete the application.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="destructive" onClick={() => setShowDelete(true)}>
                  <Trash2 size={14} /> Delete Application
                </Button>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Deployment Detail Dialog                                            */}
      {/* ------------------------------------------------------------------ */}
      <Dialog open={!!deploymentDetail} onClose={() => setDeploymentDetail(null)} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers size={18} />
            Deployment {liveDep?.id?.slice(0, 8)}
            {liveDep && (
              <Badge variant={STATUS_VARIANT[liveDep.status] || 'secondary'} className="gap-1.5">
                <StatusDot status={liveDep.status} />
                {liveDep.status}
              </Badge>
            )}
            {liveDep && !FINAL_STATES.has(liveDep.status) && (
              <span className="text-xs text-muted-foreground animate-pulse ml-1">live</span>
            )}
          </DialogTitle>
          <DialogDescription>
            {liveDep?.commitMessage || 'No commit message'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto">
          {liveDep?.buildLogs ? (
            <div>
              <p className="text-xs font-semibold mb-1 flex items-center gap-2">
                Build logs
                {!FINAL_STATES.has(liveDep.status) && (
                  <span className="text-[10px] text-emerald-500 animate-pulse">● streaming</span>
                )}
              </p>
              <pre className="whitespace-pre-wrap break-all text-xs font-mono bg-zinc-950 text-green-300 p-3 rounded-md max-h-72 overflow-y-auto">
                {liveDep.buildLogs}
                <div ref={deploymentLogsEndRef} />
              </pre>
            </div>
          ) : liveDep && !FINAL_STATES.has(liveDep.status) ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              Waiting for first log line...
            </div>
          ) : null}
          {liveDep?.deployLogs && (
            <div>
              <p className="text-xs font-semibold mb-1 text-destructive">Error</p>
              <pre className="whitespace-pre-wrap break-all text-xs font-mono bg-red-950/40 text-red-200 p-3 rounded-md max-h-60 overflow-y-auto">
                {liveDep.deployLogs}
              </pre>
            </div>
          )}
          {!liveDep?.buildLogs && !liveDep?.deployLogs && liveDep && FINAL_STATES.has(liveDep.status) && (
            <p className="text-sm text-muted-foreground">No logs captured for this deployment.</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeploymentDetail(null)}>Close</Button>
        </DialogFooter>
      </Dialog>

      {/* ------------------------------------------------------------------ */}
      {/* Delete Dialog                                                       */}
      {/* ------------------------------------------------------------------ */}
      <Dialog open={showDelete} onClose={() => setShowDelete(false)}>
        <DialogHeader>
          <DialogTitle>{t('common.delete')} {app.name}</DialogTitle>
          <DialogDescription>
            This will stop all Docker containers and permanently delete the application.
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDelete(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
          >
            {deleteMutation.isPending ? 'Deleting...' : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
