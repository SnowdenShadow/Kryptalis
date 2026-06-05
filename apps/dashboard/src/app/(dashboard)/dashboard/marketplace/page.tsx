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
      <div>
        <h1 className="text-3xl font-bold">{t('marketplace.title')}</h1>
        <p className="text-muted-foreground">
          {t('marketplace.subtitle')}
        </p>
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

          <div className="space-y-2">
            <Label>Domain (optional)</Label>
            <Select value={selectedDomainId} onChange={(e) => setSelectedDomainId(e.target.value)}>
              <option value="">No domain</option>
              {allDomains.filter((d: any) => !d.applicationId).map((d: any) => (
                <option key={d.id} value={d.id}>{d.domain}</option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">Select an existing domain to link, or leave empty</p>
          </div>

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
    </div>
  );
}
