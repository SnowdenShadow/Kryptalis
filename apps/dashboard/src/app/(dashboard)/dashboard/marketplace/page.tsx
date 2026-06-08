'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  Search,
  Download,
  Check,
  Loader2,
  Server,
  FolderKanban,
  CheckCircle2,
  XCircle,
  Circle,
  ExternalLink,
  RotateCcw,
  Container,
  Plus,
  Trash2,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
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
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { toast } from 'sonner';

interface MarketplaceApp {
  name: string;
  slug: string;
  description: string;
  category: string;
  icon: string;
  ports: number[];
}

interface InstallResponse {
  message: string;
  taskId: string;
  applicationId: string;
  app: MarketplaceApp;
}

interface AgentTask {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  error?: string;
}

const DEPLOY_STEPS = [
  'Creating application...',
  'Deploying container...',
  'Configuring network...',
  'Running health checks...',
  'Complete!',
];

const categories = [
  'All',
  'DevOps',
  'Automation',
  'Backend',
  'CMS',
  'Collaboration',
  'Storage',
  'Databases',
  'Email',
];

const ICON_MAP: Record<string, string> = {
  portainer: '🐳', grafana: '📊', 'uptime-kuma': '💓', n8n: '🤖',
  supabase: '⚡', wordpress: '✏️', ghost: '👻', minio: '🪣',
  nextcloud: '☁️', postgresql: '🐘', redis: '⚡', appwrite: '🔧',
  prestashop: '🛒',
  // Email
  roundcube: '📮', snappymail: '✉️', rainloop: '☔', mailpit: '🧪',
  postal: '📬', mailu: '🛡️',
};

function useDeployProgress(taskId: string | null) {
  const [currentStep, setCurrentStep] = useState(0);
  const [task, setTask] = useState<AgentTask | null>(null);

  useEffect(() => {
    if (!taskId) {
      setCurrentStep(0);
      setTask(null);
      return;
    }

    let cancelled = false;
    let stepTimer: ReturnType<typeof setInterval>;

    // Auto-advance visual steps every ~800ms
    stepTimer = setInterval(() => {
      if (cancelled) return;
      setCurrentStep((prev) => {
        // Don't advance past the second-to-last step until task completes
        if (prev >= DEPLOY_STEPS.length - 2) return prev;
        return prev + 1;
      });
    }, 800);

    // Poll task status every 1s
    const pollTimer = setInterval(async () => {
      if (cancelled) return;
      try {
        const result = await api.get<AgentTask>(`/agent/tasks/${taskId}`);
        if (cancelled) return;
        setTask(result);
        if (result.status === 'COMPLETED') {
          setCurrentStep(DEPLOY_STEPS.length - 1);
          clearInterval(pollTimer);
          clearInterval(stepTimer);
        } else if (result.status === 'FAILED') {
          clearInterval(pollTimer);
          clearInterval(stepTimer);
        }
      } catch {
        // Polling error, keep trying
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(stepTimer);
      clearInterval(pollTimer);
    };
  }, [taskId]);

  return { currentStep, task };
}

export default function MarketplacePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');
  const [installApp, setInstallApp] = useState<MarketplaceApp | null>(null);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedDomainId, setSelectedDomainId] = useState('');
  const [customPort, setCustomPort] = useState('');

  // ── custom image dialog (any Docker Hub image) ──────────────────
  const [showCustom, setShowCustom] = useState(false);
  const [customForm, setCustomForm] = useState({
    name: '',
    image: '',
    containerPort: '',
    hostPort: '',
    domainId: '',
    command: '',
  });
  const [customEnvList, setCustomEnvList] = useState<{ key: string; value: string }[]>([]);
  const [customVolList, setCustomVolList] = useState<string[]>([]);

  // Progress modal state
  const [progressApp, setProgressApp] = useState<MarketplaceApp | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [applicationId, setApplicationId] = useState<string | null>(null);

  const { currentStep, task } = useDeployProgress(activeTaskId);

  const isCompleted = task?.status === 'COMPLETED';
  const isFailed = task?.status === 'FAILED';

  // Invalidate applications query on completion
  useEffect(() => {
    if (isCompleted) {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
    }
  }, [isCompleted, queryClient]);

  const { data: servers } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<any[]>('/servers'),
  });

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<any[]>('/projects'),
  });

  const { data: apps = [] } = useQuery<MarketplaceApp[]>({
    queryKey: ['marketplace-apps'],
    queryFn: () => api.get('/marketplace'),
  });

  const { data: allDomains = [] } = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<any[]>('/domains'),
  });

  const installMutation = useMutation({
    mutationFn: (data: { appSlug: string; serverId: string; projectId: string; domainId?: string; port?: number }) =>
      api.post<InstallResponse>('/marketplace/install', data),
    onSuccess: (result) => {
      const app = installApp;
      setInstallApp(null);
      resetForm();
      setProgressApp(app);
      setActiveTaskId(result.taskId);
      setApplicationId(result.applicationId);
    },
    onError: (err: Error) => {
      toast.error('Installation failed', { description: err.message });
    },
  });

  const customMutation = useMutation({
    mutationFn: (data: {
      name: string;
      image: string;
      serverId: string;
      projectId: string;
      containerPort: number;
      hostPort?: number;
      domainId?: string;
      envVars?: Record<string, string>;
      volumes?: string[];
      command?: string;
    }) => api.post<{ taskId: string; applicationId: string; hostPort: number }>('/marketplace/install-custom', data),
    onSuccess: (result) => {
      setShowCustom(false);
      setProgressApp({
        name: customForm.name || customForm.image,
        slug: 'custom',
        description: customForm.image,
        category: 'Custom',
        icon: 'container',
        ports: [result.hostPort],
      });
      setActiveTaskId(result.taskId);
      setApplicationId(result.applicationId);
      setCustomForm({ name: '', image: '', containerPort: '', hostPort: '', domainId: '', command: '' });
      setCustomEnvList([]);
      setCustomVolList([]);
    },
    onError: (err: Error) => {
      toast.error('Custom deploy failed', { description: err.message });
    },
  });

  const handleCustomDeploy = () => {
    if (!selectedServerId) { toast.error('Pick a server'); return; }
    if (!selectedProjectId) { toast.error('Pick a project'); return; }
    if (!customForm.image.trim()) { toast.error('Image required'); return; }
    if (!customForm.containerPort) { toast.error('Container port required'); return; }
    const cport = Number(customForm.containerPort);
    if (!Number.isInteger(cport) || cport < 1 || cport > 65535) {
      toast.error('Container port must be 1-65535'); return;
    }
    const envVars = Object.fromEntries(
      customEnvList.filter((e) => e.key.trim()).map((e) => [e.key.trim(), e.value]),
    );
    customMutation.mutate({
      name: customForm.name.trim() || customForm.image.split('/').pop()?.split(':')[0] || 'custom',
      image: customForm.image.trim(),
      serverId: selectedServerId,
      projectId: selectedProjectId,
      containerPort: cport,
      ...(customForm.hostPort ? { hostPort: Number(customForm.hostPort) } : {}),
      ...(customForm.domainId ? { domainId: customForm.domainId } : {}),
      ...(Object.keys(envVars).length > 0 ? { envVars } : {}),
      ...(customVolList.filter(Boolean).length > 0 ? { volumes: customVolList.filter(Boolean) } : {}),
      ...(customForm.command.trim() ? { command: customForm.command.trim() } : {}),
    });
  };

  const resetForm = () => {
    setSelectedServerId('');
    setSelectedProjectId('');
    setSelectedDomainId('');
    setCustomPort('');
  };

  const closeProgressModal = useCallback(() => {
    setProgressApp(null);
    setActiveTaskId(null);
    setApplicationId(null);
  }, []);

  const handleInstall = () => {
    if (!installApp) return;
    if (!selectedServerId) {
      toast.error('Please select a server');
      return;
    }
    if (!selectedProjectId) {
      toast.error('Please select a project');
      return;
    }
    installMutation.mutate({
      appSlug: installApp.slug,
      serverId: selectedServerId,
      projectId: selectedProjectId,
      domainId: selectedDomainId || undefined,
      port: customPort ? Number(customPort) : undefined,
    });
  };

  const handleRetry = () => {
    if (!progressApp) return;
    closeProgressModal();
    setInstallApp(progressApp);
  };

  const filteredApps = apps.filter((app) => {
    const matchesSearch =
      app.name.toLowerCase().includes(search.toLowerCase()) ||
      app.description.toLowerCase().includes(search.toLowerCase());
    const matchesCategory =
      activeCategory === 'All' || app.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  const serverList = Array.isArray(servers) ? servers : [];
  const projectList = Array.isArray(projects) ? projects : [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">{t('marketplace.title')}</h1>
          <p className="text-muted-foreground">{t('marketplace.subtitle')}</p>
        </div>
        <Button onClick={() => setShowCustom(true)}>
          <Container size={14} /> Deploy custom image
        </Button>
      </div>

      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          placeholder={t('marketplace.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map((category) => (
          <Button
            key={category}
            variant={activeCategory === category ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveCategory(category)}
          >
            {category}
          </Button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredApps.map((app) => (
          <Card key={app.name} className="hover:border-primary/50 transition-colors">
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{ICON_MAP[app.slug] || '📦'}</span>
                  <div>
                    <CardTitle className="text-lg">{app.name}</CardTitle>
                    <Badge variant="outline" className="mt-1">
                      {app.category}
                    </Badge>
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription className="mb-4">
                {app.description}
              </CardDescription>
              <Button
                size="sm"
                className="w-full"
                onClick={() => {
                  setInstallApp(app);
                  resetForm();
                }}
              >
                <Download size={14} />
                {t('common.install')}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {filteredApps.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Search size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('marketplace.noResults')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('marketplace.noResultsDesc')}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Install Configuration Dialog */}
      <Dialog open={!!installApp} onClose={() => setInstallApp(null)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="text-2xl">{installApp?.icon}</span>
            {t('marketplace.installTitle')} {installApp?.name}
          </DialogTitle>
          <DialogDescription>
            {t('marketplace.configureWhere')} {installApp?.name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Server size={14} />
              {t('marketplace.selectServer')}
            </Label>
            {serverList.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-3 text-center text-sm text-muted-foreground">
                {t('marketplace.noServers')}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {serverList.map((s: any) => (
                  <button
                    key={s.id}
                    onClick={() => setSelectedServerId(s.id)}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
                      selectedServerId === s.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent',
                    )}
                  >
                    <Server size={16} className="text-muted-foreground" />
                    <div>
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">{s.host}</p>
                    </div>
                    {selectedServerId === s.id && (
                      <Check size={16} className="ml-auto text-primary" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <FolderKanban size={14} />
              {t('marketplace.selectProject')}
            </Label>
            {projectList.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-3 text-center text-sm text-muted-foreground">
                {t('marketplace.noProjects')}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {projectList.map((p: any) => (
                  <button
                    key={p.id}
                    onClick={() => setSelectedProjectId(p.id)}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border p-3 text-left text-sm transition-colors',
                      selectedProjectId === p.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent',
                    )}
                  >
                    <FolderKanban size={16} className="text-muted-foreground" />
                    <p className="font-medium">{p.name}</p>
                    {selectedProjectId === p.id && (
                      <Check size={16} className="ml-auto text-primary" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {(() => {
            const isWebmail = installApp && ['roundcube', 'snappymail', 'rainloop'].includes(installApp.slug);
            // Show every domain. Backend decides: if :443 is free → clean
            // URL; if taken → port-pinned binding. The label hints what
            // will happen so the user isn't surprised.
            const candidates = allDomains.filter((d: any) => {
              if (isWebmail && !d.mailServer) return false;
              return true;
            });
            return (
              <div className="space-y-2">
                <Label>{isWebmail ? 'Target mail server' : 'Domain (optional)'}</Label>
                <Select value={selectedDomainId} onChange={(e) => setSelectedDomainId(e.target.value)}>
                  <option value="">{isWebmail ? 'Select a mail server…' : 'No domain'}</option>
                  {candidates.map((d: any) => (
                    <option key={d.id} value={d.id}>
                      {isWebmail
                        ? `mail.${d.domain}`
                        : `${d.domain}${d.applicationId ? ' (main :443 used — will bind on the app port)' : ''}`}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-muted-foreground">
                  {isWebmail
                    ? candidates.length === 0
                      ? 'No mail server available — deploy one from a domain page first.'
                      : 'The webmail client will be pre-configured to log in to this mail server.'
                    : 'Picking a domain whose :443 is taken will bind this app on its custom port instead.'}
                </p>
              </div>
            );
          })()}

          <div className="space-y-2">
            <Label>Custom Port (optional)</Label>
            <Input
              type="number"
              placeholder={installApp ? `Default: ${installApp.ports[0]}` : 'Port'}
              value={customPort}
              onChange={(e) => setCustomPort(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Override the default port if needed</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setInstallApp(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleInstall}
            disabled={installMutation.isPending || !selectedServerId || !selectedProjectId}
          >
            {installMutation.isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t('marketplace.installing')}
              </>
            ) : (
              <>
                <Download size={14} />
                {t('common.install')} {installApp?.name}
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Deployment Progress Modal */}
      <Dialog open={!!progressApp} onClose={closeProgressModal}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <span className="text-2xl">{progressApp?.icon}</span>
            {isCompleted
              ? `${progressApp?.name} Installed`
              : isFailed
                ? `${progressApp?.name} Failed`
                : `Installing ${progressApp?.name}...`}
          </DialogTitle>
          <DialogDescription>
            {isCompleted
              ? 'Your application has been deployed successfully.'
              : isFailed
                ? (task?.error || 'An error occurred during deployment.')
                : 'Deployment in progress. This may take a moment.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {DEPLOY_STEPS.map((step, index) => {
            const isActive = index === currentStep && !isCompleted && !isFailed;
            const isDone = isCompleted
              ? true
              : isFailed
                ? index < currentStep
                : index < currentStep;
            const isPending = !isDone && !isActive;

            return (
              <div
                key={step}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all',
                  isActive && 'bg-primary/5 text-foreground',
                  isDone && 'text-foreground',
                  isPending && 'text-muted-foreground',
                )}
              >
                {isDone ? (
                  <CheckCircle2 size={18} className="shrink-0 text-green-500" />
                ) : isActive ? (
                  <Loader2 size={18} className="shrink-0 animate-spin text-primary" />
                ) : isFailed && index === currentStep ? (
                  <XCircle size={18} className="shrink-0 text-destructive" />
                ) : (
                  <Circle size={18} className="shrink-0 text-muted-foreground/40" />
                )}
                <span className={cn(isDone && 'line-through opacity-60')}>
                  {step}
                </span>
              </div>
            );
          })}
        </div>

        {isFailed && (
          <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-sm text-destructive">
              {task?.error || 'Deployment failed. Please try again.'}
            </p>
          </div>
        )}

        <DialogFooter>
          {isCompleted && (
            <>
              <Button variant="outline" onClick={closeProgressModal}>
                {t('common.close')}
              </Button>
              <Button
                onClick={() => {
                  closeProgressModal();
                  window.location.href = applicationId
                    ? `/dashboard/applications/${applicationId}`
                    : `/dashboard/applications`;
                }}
              >
                <ExternalLink size={14} />
                View Application
              </Button>
            </>
          )}
          {isFailed && (
            <>
              <Button variant="outline" onClick={closeProgressModal}>
                {t('common.close')}
              </Button>
              <Button onClick={handleRetry}>
                <RotateCcw size={14} />
                Retry
              </Button>
            </>
          )}
          {!isCompleted && !isFailed && (
            <Button variant="outline" onClick={closeProgressModal}>
              Run in Background
            </Button>
          )}
        </DialogFooter>
      </Dialog>

      {/* ─── Custom image deploy dialog ─────────────────────────── */}
      <Dialog open={showCustom} onClose={() => setShowCustom(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Container size={16} /> Deploy any Docker image
          </DialogTitle>
          <DialogDescription>
            Paste any image from Docker Hub or a registry — Kryptalis runs it like a marketplace app.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Server *</Label>
              <Select value={selectedServerId} onChange={(e) => setSelectedServerId(e.target.value)}>
                <option value="">Select a server…</option>
                {serverList.map((s: any) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Project *</Label>
              <Select value={selectedProjectId} onChange={(e) => setSelectedProjectId(e.target.value)}>
                <option value="">Select a project…</option>
                {projectList.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Image *</Label>
              <Input
                placeholder="linuxserver/jellyfin:latest"
                value={customForm.image}
                onChange={(e) => setCustomForm({ ...customForm, image: e.target.value })}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-2">
              <Label>App name</Label>
              <Input
                placeholder="Auto from image"
                value={customForm.name}
                onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Container port *</Label>
              <Input
                type="number"
                placeholder="8096"
                value={customForm.containerPort}
                onChange={(e) => setCustomForm({ ...customForm, containerPort: e.target.value })}
              />
              <p className="text-[10px] text-muted-foreground">Port the container listens on (from the image docs)</p>
            </div>
            <div className="space-y-2">
              <Label>Host port (optional)</Label>
              <Input
                type="number"
                placeholder="Auto-pick"
                value={customForm.hostPort}
                onChange={(e) => setCustomForm({ ...customForm, hostPort: e.target.value })}
              />
              <p className="text-[10px] text-muted-foreground">Leave empty to auto-pick from 18000+</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Domain (optional)</Label>
            <Select
              value={customForm.domainId}
              onChange={(e) => setCustomForm({ ...customForm, domainId: e.target.value })}
            >
              <option value="">No domain</option>
              {allDomains.map((d: any) => (
                <option key={d.id} value={d.id}>
                  {d.domain}{d.applicationId ? ' (main :443 used — will bind on the app port)' : ''}
                </option>
              ))}
            </Select>
            <p className="text-[10px] text-muted-foreground">Caddy will route this domain (with HTTPS) to your container.</p>
          </div>

          <div className="space-y-2">
            <Label>Custom command (optional)</Label>
            <Input
              placeholder="e.g. server /data"
              value={customForm.command}
              onChange={(e) => setCustomForm({ ...customForm, command: e.target.value })}
              className="font-mono text-sm"
            />
          </div>

          {/* Env vars */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Environment variables</Label>
              <Button size="sm" variant="outline" onClick={() => setCustomEnvList([...customEnvList, { key: '', value: '' }])}>
                <Plus size={12} /> Add
              </Button>
            </div>
            {customEnvList.length === 0 && (
              <p className="text-[10px] text-muted-foreground">None — most images run with sensible defaults.</p>
            )}
            {customEnvList.map((env, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="KEY"
                  value={env.key}
                  onChange={(e) => {
                    const next = [...customEnvList];
                    next[i] = { ...next[i], key: e.target.value };
                    setCustomEnvList(next);
                  }}
                  className="font-mono text-xs"
                />
                <Input
                  placeholder="value"
                  value={env.value}
                  onChange={(e) => {
                    const next = [...customEnvList];
                    next[i] = { ...next[i], value: e.target.value };
                    setCustomEnvList(next);
                  }}
                  className="font-mono text-xs"
                />
                <Button size="icon" variant="ghost" onClick={() => setCustomEnvList(customEnvList.filter((_, j) => j !== i))}>
                  <Trash2 size={12} />
                </Button>
              </div>
            ))}
          </div>

          {/* Volumes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Volumes</Label>
              <Button size="sm" variant="outline" onClick={() => setCustomVolList([...customVolList, ''])}>
                <Plus size={12} /> Add
              </Button>
            </div>
            {customVolList.length === 0 && (
              <p className="text-[10px] text-muted-foreground">Add a host:container mount to persist data, e.g. <span className="font-mono">/data/jellyfin:/config</span>.</p>
            )}
            {customVolList.map((vol, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="/host/path:/container/path"
                  value={vol}
                  onChange={(e) => {
                    const next = [...customVolList];
                    next[i] = e.target.value;
                    setCustomVolList(next);
                  }}
                  className="font-mono text-xs"
                />
                <Button size="icon" variant="ghost" onClick={() => setCustomVolList(customVolList.filter((_, j) => j !== i))}>
                  <Trash2 size={12} />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowCustom(false)}>{t('common.cancel')}</Button>
          <Button onClick={handleCustomDeploy} disabled={customMutation.isPending}>
            {customMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Deploy
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
