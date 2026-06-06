'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Rocket,
  Play,
  Square,
  RotateCcw,
  Trash2,
  Plus,
  GitBranch,
  Globe,
  ExternalLink,
  Terminal,
  RefreshCw,
  Search,
  Loader2,
  AlertTriangle,
  FileCode,
  Plug,
  ChevronRight,
  Eye,
  EyeOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
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
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Application {
  id: string;
  name: string;
  projectId: string;
  framework: string;
  status: string;
  gitUrl: string | null;
  gitBranch: string | null;
  port: number | null;
  createdAt: string;
  project?: { id: string; name: string };
  customPort?: boolean;
  domains?: { id: string; domain: string; sslStatus: string }[];
  portBindings?: {
    id: string;
    port: number;
    domain: { id: string; domain: string; sslStatus: string };
  }[];
}

interface ProjectOption {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FRAMEWORKS = [
  'NEXTJS',
  'REACT',
  'VUE',
  'ANGULAR',
  'NESTJS',
  'EXPRESS',
  'LARAVEL',
  'SYMFONY',
  'DJANGO',
  'FLASK',
  'FASTAPI',
  'STATIC',
  'DOCKER',
  'DOCKER_COMPOSE',
] as const;

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

function appUrl(port: number) {
  const proto = HTTPS_PORTS.includes(port) ? 'https' : 'http';
  return `${proto}://${typeof window !== 'undefined' ? window.location.hostname : 'localhost'}:${port}`;
}

/**
 * First URL the user can open — handles clean-URL domain, port-pinned domain,
 * port-binding (app co-hosted on another domain), or bare IP:port fallback.
 */
function publicAppUrl(app: {
  port?: number | null;
  customPort?: boolean;
  domains?: { domain: string; sslStatus: string }[];
  portBindings?: { port: number; domain: { domain: string; sslStatus: string } }[];
}): string | null {
  const main = app.domains?.[0];
  if (main) {
    return app.customPort && app.port
      ? `https://${main.domain}:${app.port}`
      : `https://${main.domain}`;
  }
  const bound = app.portBindings?.[0];
  if (bound) return `https://${bound.domain.domain}:${bound.port}`;
  return app.port ? appUrl(app.port) : null;
}

function truncateGitUrl(url: string, max = 40) {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + '…';
}

// ---------------------------------------------------------------------------
// Status dot component
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: string }) {
  const base = 'inline-block h-2.5 w-2.5 rounded-full shrink-0';
  switch (status) {
    case 'RUNNING':
      return <span className={`${base} bg-emerald-500 animate-pulse`} />;
    case 'ERROR':
      return <span className={`${base} bg-red-500`} />;
    case 'DEPLOYING':
    case 'BUILDING':
      return <span className={`${base} bg-orange-500 animate-pulse`} />;
    default:
      return <span className={`${base} bg-zinc-400`} />;
  }
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ApplicationsPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();

  // --- Search + filter ---
  const [search, setSearch] = useState('');
  const [filterProject, setFilterProject] = useState('');

  // --- List ---
  const { data: applications = [], isLoading } = useQuery<Application[]>({
    queryKey: ['applications'],
    queryFn: () => api.get('/applications'),
  });

  const filtered = useMemo(() => {
    let result = applications;
    if (filterProject) {
      result = result.filter((a) => a.project?.id === filterProject);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((a) => a.name.toLowerCase().includes(q));
    }
    return result;
  }, [applications, search, filterProject]);

  // --- Projects for dropdown ---
  const { data: projects = [] } = useQuery<ProjectOption[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });

  // --- Deploy dialog ---
  const [showDeploy, setShowDeploy] = useState(false);
  const [deployStep, setDeployStep] = useState(0);
  const [deployMode, setDeployMode] = useState<'docker' | 'git-provider' | 'git-url' | null>(null);
  const [selectedGitProviderId, setSelectedGitProviderId] = useState('');
  const [repoSearch, setRepoSearch] = useState('');
  const [deployForm, setDeployForm] = useState({
    name: '',
    projectId: '',
    framework: '',
    gitUrl: '',
    gitBranch: 'main',
    port: '',
    buildCommand: '',
    startCommand: '',
    gitToken: '',
  });
  const [showToken, setShowToken] = useState(false);
  const [composeOverride, setComposeOverride] = useState<string | null>(null);
  const [dockerfileOverride, setDockerfileOverride] = useState<string | null>(null);
  const [portRemap, setPortRemap] = useState<Record<string, string>>({});
  const [envRows, setEnvRows] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }]);

  const { data: gitProviders = [] } = useQuery<any[]>({
    queryKey: ['git-providers'],
    queryFn: () => api.get('/git-providers'),
    enabled: showDeploy,
  });

  const { data: repos = [], isLoading: reposLoading } = useQuery<any[]>({
    queryKey: ['git-provider-repos', selectedGitProviderId],
    queryFn: () => api.get(`/git-providers/${selectedGitProviderId}/repos`),
    enabled: !!selectedGitProviderId && deployMode === 'git-provider',
  });

  const [selectedRepo, setSelectedRepo] = useState<any>(null);
  const [deployDomainId, setDeployDomainId] = useState('');
  const [newDomainName, setNewDomainName] = useState('');

  const { data: availableDomains = [] } = useQuery<any[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
    enabled: showDeploy,
  });

  const { data: repoDetection } = useQuery<any>({
    queryKey: ['repo-detect', selectedGitProviderId, selectedRepo?.fullName, selectedRepo?.defaultBranch],
    queryFn: () => api.get(`/git-providers/${selectedGitProviderId}/detect?repo=${encodeURIComponent(selectedRepo.fullName)}&branch=${selectedRepo.defaultBranch}`),
    enabled: !!selectedGitProviderId && !!selectedRepo,
  });

  useEffect(() => {
    if (repoDetection) {
      setDeployForm(f => ({
        ...f,
        framework: repoDetection.framework || f.framework,
        buildCommand: repoDetection.buildCommand || '',
        startCommand: repoDetection.startCommand || '',
        port: f.port || String(repoDetection.port || ''),
      }));
    }
  }, [repoDetection]);

  // --- Delete confirmation ---
  const [deleteTarget, setDeleteTarget] = useState<Application | null>(null);

  // --- Logs viewer ---
  const [logsAppId, setLogsAppId] = useState<string | null>(null);
  const [logsAppName, setLogsAppName] = useState('');
  const logsEndRef = useRef<HTMLDivElement>(null);

  const { data: logsData, isLoading: logsLoading, refetch: refetchLogs } = useQuery<{ logs: string }>({
    queryKey: ['application-logs', logsAppId],
    queryFn: () => api.get(`/applications/${logsAppId}/logs?lines=200`),
    enabled: !!logsAppId,
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (logsEndRef.current && logsData?.logs) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logsData]);

  // --- Mutations ---
  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<Application>('/applications', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success('Application created');
      setShowDeploy(false);
      setDeployStep(0);
      setDeployMode(null);
      setSelectedRepo(null);
      setComposeOverride(null);
      setDockerfileOverride(null);
      setPortRemap({});
      setEnvRows([{ key: '', value: '' }]);
      setEnvImported(false);
      setDeployForm({
        name: '',
        projectId: '',
        framework: '',
        gitUrl: '',
        gitBranch: 'main',
        port: '',
        buildCommand: '',
        startCommand: '',
        gitToken: '',
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to create application');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/applications/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success('Application deleted');
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Failed to delete application');
    },
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
      api.post(`/applications/${id}/${action}`),
    onSuccess: (_, { action }) => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success(`Application ${action} initiated`);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Action failed');
    },
  });

  // --- File preview (compose/Dockerfile) for git-provider mode ---
  const composeFileName = repoDetection?.detectedFiles?.find((f: string) => f.startsWith('docker-compose') || f.startsWith('compose')) || 'docker-compose.yml';
  const { data: composePreview } = useQuery<{ content: string; exists: boolean }>({
    queryKey: ['repo-file', selectedGitProviderId, selectedRepo?.fullName, composeFileName],
    queryFn: () => api.get(`/git-providers/${selectedGitProviderId}/file?repo=${encodeURIComponent(selectedRepo.fullName)}&branch=${selectedRepo.defaultBranch}&path=${encodeURIComponent(composeFileName)}`),
    enabled: !!selectedGitProviderId && !!selectedRepo && !!repoDetection?.hasCompose,
  });
  const { data: dockerfilePreview } = useQuery<{ content: string; exists: boolean }>({
    queryKey: ['repo-file', selectedGitProviderId, selectedRepo?.fullName, 'Dockerfile'],
    queryFn: () => api.get(`/git-providers/${selectedGitProviderId}/file?repo=${encodeURIComponent(selectedRepo.fullName)}&branch=${selectedRepo.defaultBranch}&path=Dockerfile`),
    enabled: !!selectedGitProviderId && !!selectedRepo && !!repoDetection?.hasDockerfile && !repoDetection?.hasCompose,
  });

  // probe repo for env files (tries each filename, only renders the ones that exist)
  const ENV_FILE_CANDIDATES = ['.env', '.env.local', '.env.production', '.env.example', '.env.local.example'];
  const envFilesQuery = useQuery<Array<{ name: string; content: string }>>({
    queryKey: ['repo-env-files', selectedGitProviderId, selectedRepo?.fullName, selectedRepo?.defaultBranch],
    queryFn: async () => {
      const results = await Promise.all(
        ENV_FILE_CANDIDATES.map(name =>
          api.get<{ content: string; exists: boolean }>(
            `/git-providers/${selectedGitProviderId}/file?repo=${encodeURIComponent(selectedRepo.fullName)}&branch=${selectedRepo.defaultBranch}&path=${encodeURIComponent(name)}`
          ).then(r => r.exists && r.content ? { name, content: r.content } : null).catch(() => null)
        )
      );
      return results.filter(Boolean) as Array<{ name: string; content: string }>;
    },
    enabled: !!selectedGitProviderId && !!selectedRepo,
  });
  const envFilesFound = envFilesQuery.data || [];

  // parse env files into key/value (highest priority last wins, like server)
  function parseDotEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      } else {
        const h = val.indexOf(' #');
        if (h !== -1) val = val.slice(0, h).trimEnd();
      }
      out[m[1]] = val;
    }
    return out;
  }

  // auto-import keys from repo env files into the editor rows (only once)
  const [envImported, setEnvImported] = useState(false);
  useEffect(() => {
    if (envImported || envFilesFound.length === 0) return;
    const priority = ['.env.example', '.env.local.example', '.env.production', '.env', '.env.local'];
    const sorted = [...envFilesFound].sort((a, b) => priority.indexOf(a.name) - priority.indexOf(b.name));
    const merged: Record<string, string> = {};
    for (const f of sorted) Object.assign(merged, parseDotEnv(f.content));
    const existingKeys = new Set(envRows.map(r => r.key).filter(Boolean));
    const fresh = Object.entries(merged).filter(([k]) => !existingKeys.has(k));
    if (fresh.length === 0) { setEnvImported(true); return; }
    setEnvRows(d => {
      const filtered = d.filter(r => r.key || r.value);
      return [...filtered, ...fresh.map(([key, value]) => ({ key, value }))];
    });
    setEnvImported(true);
  }, [envFilesFound, envImported]);

  // initialize override drafts when previews arrive
  useEffect(() => {
    if (composePreview?.exists && composeOverride === null) {
      setComposeOverride(composePreview.content);
      // parse ports for remap UI
      const ports = parseComposePortsClient(composePreview.content);
      const init: Record<string, string> = {};
      for (const p of ports) init[String(p.container)] = String(p.host ?? p.container);
      setPortRemap(init);
    }
  }, [composePreview]);
  useEffect(() => {
    if (dockerfilePreview?.exists && dockerfileOverride === null) {
      setDockerfileOverride(dockerfilePreview.content);
    }
  }, [dockerfilePreview]);

  // --- Handlers ---
  function handleDeploySubmit(e?: React.FormEvent) {
    e?.preventDefault();
    const body: Record<string, unknown> = {
      name: deployForm.name,
      projectId: deployForm.projectId,
      framework: deployForm.framework || 'STATIC',
    };
    if (deployForm.gitUrl) body.gitUrl = deployForm.gitUrl;
    if (deployForm.gitBranch) body.gitBranch = deployForm.gitBranch;
    if (deployForm.port) body.port = Number(deployForm.port);
    if (deployForm.buildCommand) body.buildCommand = deployForm.buildCommand;
    if (deployForm.startCommand) body.startCommand = deployForm.startCommand;
    if (selectedGitProviderId && deployMode === 'git-provider') body.gitProviderId = selectedGitProviderId;
    if (deployMode === 'git-url' && deployForm.gitToken.trim()) body.gitToken = deployForm.gitToken.trim();

    // overrides — only send if user actually changed them from the upstream
    if (composeOverride && composePreview && composeOverride !== composePreview.content) {
      body.composeOverride = composeOverride;
    }
    if (dockerfileOverride && dockerfilePreview && dockerfileOverride !== dockerfilePreview.content) {
      body.dockerfileOverride = dockerfileOverride;
    }
    // port mapping — only send if at least one differs from container port default
    const mapping: Record<string, number> = {};
    for (const [ct, ht] of Object.entries(portRemap)) {
      const n = Number(ht);
      if (Number.isFinite(n) && n > 0 && n !== Number(ct)) mapping[ct] = n;
    }
    if (Object.keys(mapping).length) body.portMapping = mapping;

    // env vars
    const env: Record<string, string> = {};
    for (const { key, value } of envRows) {
      const k = key.trim();
      if (k) env[k] = value;
    }
    if (Object.keys(env).length) body.envVars = env;

    // Inline domain attach — picking an existing domain goes through the
    // backend create endpoint which calls DomainAttachService (same conflict
    // rules as marketplace). Creating a NEW domain still needs a follow-up
    // request because the domain row doesn't exist yet.
    if (deployDomainId && deployDomainId !== '__new__') {
      body.domainId = deployDomainId;
    }

    createMutation.mutate(body, {
      onSuccess: async (created: any) => {
        if (!created?.id) return;
        try {
          if (deployDomainId === '__new__' && newDomainName) {
            // Create a brand-new domain for this app
            await api.post('/domains', {
              domain: newDomainName,
              projectId: body.projectId,
              applicationId: created.id,
              autoSsl: true,
            });
            toast.success(`Domain ${newDomainName} reserved — point its A record at the server IP.`);
          }
          setNewDomainName('');
          setDeployDomainId('');
        } catch (err: any) {
          toast.error(`App created, but domain attach failed: ${err.message}`);
        }
      },
    });
  }

  // light-weight client-side compose port parser (mirrors server logic for preview only)
  function parseComposePortsClient(content: string): Array<{ service: string; host: number | null; container: number; protocol: string }> {
    const out: Array<{ service: string; host: number | null; container: number; protocol: string }> = [];
    try {
      const lines = content.split('\n');
      let curSvc = '';
      let inServices = false;
      let inPorts = false;
      let svcIndent = -1;
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '');
        if (/^services:/.test(line)) { inServices = true; continue; }
        if (!inServices) continue;
        const m = line.match(/^(\s+)([a-zA-Z0-9._-]+):\s*$/);
        if (m) {
          const indent = m[1].length;
          if (svcIndent === -1) svcIndent = indent;
          if (indent === svcIndent) {
            curSvc = m[2];
            inPorts = false;
            continue;
          }
          if (line.match(/^\s+ports:\s*$/)) { inPorts = true; continue; }
        }
        if (inPorts && curSvc) {
          const pm = line.match(/^\s+-\s+["']?([^"'\s]+)["']?/);
          if (!pm) { if (line.trim() && !line.match(/^\s+-/)) inPorts = false; continue; }
          const [spec, proto] = pm[1].split('/');
          const parts = spec.split(':');
          let host: number | null = null;
          let container: number;
          if (parts.length === 1) container = Number(parts[0]);
          else if (parts.length === 2) { host = Number(parts[0]); container = Number(parts[1]); }
          else { host = Number(parts[1]); container = Number(parts[2]); }
          if (Number.isFinite(container)) out.push({ service: curSvc, host, container, protocol: proto || 'tcp' });
        }
      }
    } catch {}
    return out;
  }

  function stop(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  // --- Render ---
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">{t('apps.title')}</h1>
          {applications.length > 0 && (
            <Badge variant="secondary" className="text-sm">
              {applications.length}
            </Badge>
          )}
        </div>
        <Button onClick={() => setShowDeploy(true)}>
          <Plus size={16} />
          {t('apps.deploy')}
        </Button>
      </div>

      {/* Search + Project Filter */}
      {applications.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search applications..."
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={filterProject === '' ? 'default' : 'outline'}
              onClick={() => setFilterProject('')}
            >
              All
            </Button>
            {projects.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={filterProject === p.id ? 'default' : 'outline'}
                onClick={() => setFilterProject(filterProject === p.id ? '' : p.id)}
              >
                {p.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="flex items-center gap-4 py-4">
                <div className="h-3 w-3 rounded-full bg-muted" />
                <div className="h-5 w-40 rounded bg-muted" />
                <div className="h-5 w-16 rounded bg-muted" />
                <div className="flex-1" />
                <div className="h-5 w-48 rounded bg-muted" />
                <div className="h-8 w-24 rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : filtered.length === 0 && !search ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Rocket size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('apps.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('apps.emptyDesc')}
            </p>
            <Button className="mt-4" onClick={() => setShowDeploy(true)}>
              <Plus size={16} />
              {t('apps.deploy')}
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 && search ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Search size={40} className="mb-3 text-muted-foreground" />
            <p className="text-muted-foreground">No applications matching &quot;{search}&quot;</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filtered.map((app) => {
            const isRunning = app.status === 'RUNNING';
            const isStopped = app.status === 'STOPPED';
            const isDeploying = app.status === 'DEPLOYING' || app.status === 'BUILDING';
            const statusLabel = app.status === 'RUNNING' ? 'Running' : app.status === 'STOPPED' ? 'Stopped' : app.status === 'ERROR' ? 'Error' : app.status === 'DEPLOYING' ? 'Deploying' : app.status;

            return (
              <Card
                key={app.id}
                className="hover:border-primary/50 transition-colors cursor-pointer overflow-hidden"
                onClick={() => router.push(`/dashboard/applications/${app.id}`)}
              >
                <CardContent className="p-0">
                  {/* Status bar top */}
                  <div className={`h-1 w-full ${isRunning ? 'bg-emerald-500' : app.status === 'ERROR' ? 'bg-red-500' : isDeploying ? 'bg-orange-500' : 'bg-zinc-600'}`} />

                  <div className="p-5 space-y-4">
                    {/* Header: name + status + framework */}
                    <div className="flex items-start justify-between">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <StatusDot status={app.status} />
                          <h3 className="text-lg font-semibold">{app.name}</h3>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[11px]">
                            {FRAMEWORK_LABELS[app.framework] || app.framework}
                          </Badge>
                          <span className={`text-xs font-medium ${isRunning ? 'text-emerald-500' : app.status === 'ERROR' ? 'text-red-500' : isDeploying ? 'text-orange-500' : 'text-muted-foreground'}`}>
                            {statusLabel}
                          </span>
                        </div>
                      </div>
                      {isRunning && app.port && (
                        <Button
                          size="sm"
                          className="shrink-0"
                          onClick={(e) => {
                            stop(e);
                            const url = publicAppUrl(app);
                            if (url) window.open(url, '_blank');
                          }}
                        >
                          <ExternalLink size={12} /> Open
                        </Button>
                      )}
                    </div>

                    {/* Info grid */}
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      {app.project?.name && (
                        <div>
                          <p className="text-xs text-muted-foreground">Project</p>
                          <Link
                            href={`/dashboard/projects/${app.project.id}`}
                            className="font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {app.project.name}
                          </Link>
                        </div>
                      )}
                      {app.port && (
                        <div>
                          <p className="text-xs text-muted-foreground">Port</p>
                          <p className="font-mono font-medium">{app.port}</p>
                        </div>
                      )}
                      {app.gitUrl && (
                        <div className="col-span-2">
                          <p className="text-xs text-muted-foreground">Git Repository</p>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs truncate">{truncateGitUrl(app.gitUrl)}</span>
                            {app.gitBranch && (
                              <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
                                <GitBranch size={9} /> {app.gitBranch}
                              </Badge>
                            )}
                          </div>
                        </div>
                      )}
                      {((app.domains && app.domains.length > 0) || (app.portBindings && app.portBindings.length > 0)) && (
                        <div className="col-span-2">
                          <p className="text-xs text-muted-foreground">Routes</p>
                          <div className="flex flex-wrap gap-1.5 mt-0.5">
                            {(app.domains || []).map((d) => (
                              <Badge key={d.id} variant={d.sslStatus === 'ACTIVE' ? 'success' : 'outline'} className="text-[10px] gap-1 font-mono">
                                <Globe size={9} /> {app.customPort && app.port ? `${d.domain}:${app.port}` : d.domain}
                              </Badge>
                            ))}
                            {(app.portBindings || []).map((b) => (
                              <Badge key={b.id} variant={b.domain.sslStatus === 'ACTIVE' ? 'success' : 'outline'} className="text-[10px] gap-1 font-mono">
                                <Globe size={9} /> {b.domain.domain}:{b.port}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Domains */}
                    {app.domains && app.domains.length > 0 && (
                      <div className="rounded-lg border border-border bg-muted/30 p-3">
                        <p className="text-xs font-medium text-muted-foreground mb-2">Domains</p>
                        <div className="space-y-1.5">
                          {app.domains.map((d) => (
                            <div key={d.id} className="flex items-center justify-between">
                              <span className="font-mono text-sm">{d.domain}</span>
                              <Badge variant={d.sslStatus === 'ACTIVE' ? 'success' : d.sslStatus === 'PENDING' ? 'warning' : 'destructive'} className="text-[10px]">
                                {d.sslStatus === 'ACTIVE' ? '🔒 SSL' : d.sslStatus === 'PENDING' ? '⏳ SSL Pending' : '⚠️ SSL Error'}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Footer: actions + date */}
                    <div className="flex items-center justify-between pt-2 border-t border-border">
                      <span className="text-xs text-muted-foreground">{timeAgo(app.createdAt)}</span>
                      <div className="flex items-center gap-2">
                        {isStopped && (
                          <Button size="sm" variant="outline" disabled={actionMutation.isPending}
                            onClick={(e) => { stop(e); actionMutation.mutate({ id: app.id, action: 'start' }); }}>
                            <Play size={14} /> Start
                          </Button>
                        )}
                        {isRunning && (
                          <>
                            <Button size="sm" variant="outline" disabled={actionMutation.isPending}
                              onClick={(e) => { stop(e); actionMutation.mutate({ id: app.id, action: 'stop' }); }}>
                              <Square size={14} /> Stop
                            </Button>
                            <Button size="sm" variant="outline" disabled={actionMutation.isPending}
                              onClick={(e) => { stop(e); actionMutation.mutate({ id: app.id, action: 'restart' }); }}>
                              <RotateCcw size={14} /> Restart
                            </Button>
                          </>
                        )}
                        <Button size="sm" variant="outline"
                          onClick={(e) => { stop(e); setLogsAppId(app.id); setLogsAppName(app.name); }}>
                          <Terminal size={14} /> Logs
                        </Button>
                        <Button size="sm" variant="destructive"
                          onClick={(e) => { stop(e); setDeleteTarget(app); }}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ---- Deploy Wizard ---- */}
      <Dialog open={showDeploy} onClose={() => { setShowDeploy(false); setDeployStep(0); }} className="max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* Step indicators */}
        <div className="flex items-center gap-2 mb-4">
          {['Source', 'Config', 'Files', 'Deploy'].map((label, i) => (
            <div key={label} className="flex items-center gap-2 flex-1">
              <div className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shrink-0',
                deployStep >= i ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              )}>
                {i + 1}
              </div>
              <span className={cn('text-sm', deployStep >= i ? 'text-foreground' : 'text-muted-foreground')}>{label}</span>
              {i < 3 && <div className={cn('flex-1 h-px', deployStep > i ? 'bg-primary' : 'bg-muted')} />}
            </div>
          ))}
        </div>

        {/* Step 0: Source */}
        {deployStep === 0 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Where is your code?</h3>
              <p className="text-sm text-muted-foreground">Choose how to deploy your application</p>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {gitProviders.length > 0 && (
                <button
                  className={cn(
                    'flex items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:border-primary/50',
                    deployMode === 'git-provider' ? 'border-primary bg-primary/5' : 'border-border'
                  )}
                  onClick={() => { setDeployMode('git-provider'); setDeployForm(f => ({ ...f, framework: '' })); }}
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-lg">🔗</div>
                  <div className="flex-1">
                    <p className="font-medium">Import from Git Provider</p>
                    <p className="text-xs text-muted-foreground">
                      Browse repos from {gitProviders.map((g: any) => g.name).join(', ')}
                    </p>
                  </div>
                </button>
              )}

              <button
                className={cn(
                  'flex items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:border-primary/50',
                  deployMode === 'git-url' ? 'border-primary bg-primary/5' : 'border-border'
                )}
                onClick={() => { setDeployMode('git-url'); setDeployForm(f => ({ ...f, framework: '' })); }}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-lg">📦</div>
                <div>
                  <p className="font-medium">Public Git URL</p>
                  <p className="text-xs text-muted-foreground">Paste any public Git repository URL</p>
                </div>
              </button>

              <button
                className={cn(
                  'flex items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:border-primary/50',
                  deployMode === 'docker' ? 'border-primary bg-primary/5' : 'border-border'
                )}
                onClick={() => { setDeployMode('docker'); setDeployForm(f => ({ ...f, framework: 'DOCKER' })); }}
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-lg">🐳</div>
                <div>
                  <p className="font-medium">Docker Image</p>
                  <p className="text-xs text-muted-foreground">Deploy from a Docker image or Dockerfile</p>
                </div>
              </button>

              {gitProviders.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                  💡 <Link href="/dashboard/settings" className="text-primary hover:underline">Connect a Git provider</Link> in Settings to deploy from private repos
                </div>
              )}
            </div>

            {/* Git Provider mode: select provider + browse repos */}
            {deployMode === 'git-provider' && (
              <div className="space-y-3 pt-2">
                <div className="space-y-2">
                  <Label>Provider</Label>
                  <Select value={selectedGitProviderId} onChange={(e) => setSelectedGitProviderId(e.target.value)}>
                    <option value="">Select a provider...</option>
                    {gitProviders.map((g: any) => (
                      <option key={g.id} value={g.id}>{g.name} (@{g.username})</option>
                    ))}
                  </Select>
                </div>

                {selectedGitProviderId && (
                  <div className="space-y-2">
                    <Label>Repository</Label>
                    <div className="relative">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input className="pl-9" placeholder="Search repos..." value={repoSearch}
                        onChange={(e) => setRepoSearch(e.target.value)} />
                    </div>
                    <div className="max-h-64 overflow-y-auto rounded-lg border border-border divide-y divide-border">
                      {reposLoading ? (
                        <div className="p-4 text-center text-sm text-muted-foreground">Loading repos...</div>
                      ) : repos.length === 0 ? (
                        <div className="p-4 text-center text-sm text-muted-foreground">No repos found</div>
                      ) : (
                        repos
                          .filter((r: any) => !repoSearch || r.fullName.toLowerCase().includes(repoSearch.toLowerCase()))
                          .slice(0, 30)
                          .map((r: any) => (
                            <button
                              key={r.url}
                              onClick={() => {
                                setSelectedRepo(r);
                                setDeployForm(f => ({
                                  ...f,
                                  gitUrl: r.url,
                                  gitBranch: r.defaultBranch,
                                  name: f.name || r.name.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                                }));
                              }}
                              className={cn(
                                'w-full text-left p-3 hover:bg-accent transition-colors',
                                deployForm.gitUrl === r.url && 'bg-primary/5'
                              )}
                            >
                              <div className="flex items-center justify-between">
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold text-sm">{r.fullName}</span>
                                    {r.private && <Badge variant="outline" className="text-[10px]">Private</Badge>}
                                    {r.language && <Badge variant="secondary" className="text-[10px]">{r.language}</Badge>}
                                  </div>
                                  {r.description && <p className="text-xs text-muted-foreground truncate mt-0.5">{r.description}</p>}
                                </div>
                                <Badge variant="outline" className="text-[10px] ml-2 shrink-0">
                                  <GitBranch size={9} /> {r.defaultBranch}
                                </Badge>
                              </div>
                            </button>
                          ))
                      )}
                    </div>
                  </div>
                )}

                {deployForm.gitUrl && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm space-y-2">
                    <div>
                      <p className="font-semibold">Selected:</p>
                      <p className="font-mono text-xs">{deployForm.gitUrl}</p>
                      <p className="text-xs text-muted-foreground mt-1">Branch: {deployForm.gitBranch}</p>
                    </div>
                    {repoDetection && (
                      <div className="pt-2 border-t border-primary/20">
                        <p className="text-xs font-semibold mb-1">🔍 Auto-detected:</p>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="success" className="text-[10px]">{FRAMEWORK_LABELS[repoDetection.framework] || repoDetection.framework}</Badge>
                          {repoDetection.hasCompose && <Badge variant="outline" className="text-[10px]">docker-compose</Badge>}
                          {repoDetection.hasDockerfile && <Badge variant="outline" className="text-[10px]">Dockerfile</Badge>}
                          {repoDetection.hasPackageJson && <Badge variant="outline" className="text-[10px]">package.json</Badge>}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Git URL mode */}
            {deployMode === 'git-url' && (
              <div className="space-y-3 pt-2">
                <div className="space-y-2">
                  <Label>Repository URL</Label>
                  <Input placeholder="https://github.com/user/repo" value={deployForm.gitUrl}
                    onChange={(e) => setDeployForm(f => ({ ...f, gitUrl: e.target.value }))} className="font-mono" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>Branch</Label>
                    <Input value={deployForm.gitBranch} onChange={(e) => setDeployForm(f => ({ ...f, gitBranch: e.target.value }))} />
                  </div>
                  <div className="space-y-2">
                    <Label>Framework</Label>
                    <Select value={deployForm.framework} onChange={(e) => setDeployForm(f => ({ ...f, framework: e.target.value }))}>
                      <option value="">Auto-detect</option>
                      {FRAMEWORKS.filter(fw => fw !== 'DOCKER' && fw !== 'DOCKER_COMPOSE').map(fw => (
                        <option key={fw} value={fw}>{FRAMEWORK_LABELS[fw]}</option>
                      ))}
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    Personal Access Token <span className="text-xs text-muted-foreground">(optional — for private repos)</span>
                  </Label>
                  <div className="relative">
                    <Input
                      type={showToken ? 'text' : 'password'}
                      placeholder="ghp_..."
                      className="font-mono pr-9"
                      value={deployForm.gitToken}
                      onChange={(e) => setDeployForm(f => ({ ...f, gitToken: e.target.value }))}
                    />
                    <button
                      type="button"
                      onClick={() => setShowToken(s => !s)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Used once to clone the private repo. Not stored. Prefer connecting a Git provider in Settings for re-deploys.
                  </p>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => { setShowDeploy(false); setDeployStep(0); setDeployMode(null); }}>Cancel</Button>
              <Button onClick={() => setDeployStep(1)}
                disabled={!deployMode || (deployMode !== 'docker' && !deployForm.gitUrl)}>
                Next
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 1: Config */}
        {deployStep === 1 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Configure your app</h3>
              <p className="text-sm text-muted-foreground">Name your app and set the basics</p>
            </div>

            <div className="space-y-3">
              <div className="space-y-2">
                <Label>App Name *</Label>
                <Input
                  placeholder="my-awesome-app"
                  value={deployForm.name}
                  onChange={(e) => setDeployForm(f => ({ ...f, name: e.target.value }))}
                />
              </div>

              <div className="space-y-2">
                <Label>Project *</Label>
                <Select value={deployForm.projectId} onChange={(e) => setDeployForm(f => ({ ...f, projectId: e.target.value }))}>
                  <option value="">Select project</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </div>

              {repoDetection?.hasCompose ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                  <p className="font-semibold flex items-center gap-2">🐳 Docker Compose detected</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Ports, build commands and env will be loaded from your <code className="font-mono">docker-compose.yml</code>.
                    Tweak them in the next step.
                  </p>
                </div>
              ) : repoDetection?.hasDockerfile ? (
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                  <p className="font-semibold flex items-center gap-2">🐳 Dockerfile detected</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Build uses your <code className="font-mono">Dockerfile</code>. Ports come from <code>EXPOSE</code> directives —
                    edit them in the next step if needed.
                  </p>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <Label>Port</Label>
                    <Input type="number" placeholder={String(repoDetection?.port || 3000)} value={deployForm.port}
                      onChange={(e) => setDeployForm(f => ({ ...f, port: e.target.value }))} />
                  </div>
                  {deployForm.framework !== 'DOCKER' && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-2">
                        <Label>Build Command</Label>
                        <Input placeholder="npm run build" value={deployForm.buildCommand}
                          onChange={(e) => setDeployForm(f => ({ ...f, buildCommand: e.target.value }))} />
                      </div>
                      <div className="space-y-2">
                        <Label>Start Command</Label>
                        <Input placeholder="npm start" value={deployForm.startCommand}
                          onChange={(e) => setDeployForm(f => ({ ...f, startCommand: e.target.value }))} />
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDeployStep(0)}>Back</Button>
              <Button onClick={() => setDeployStep(2)}
                disabled={!deployForm.name || !deployForm.projectId}>
                Next
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 2: Files & Ports & Env */}
        {deployStep === 2 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Files, ports & env</h3>
              <p className="text-sm text-muted-foreground">
                Review and tweak before deploy. Changes here override what&apos;s in the repo.
              </p>
            </div>

            {envFilesFound.length > 0 && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
                <p className="font-semibold flex items-center gap-2">📄 {envFilesFound.length} env file{envFilesFound.length > 1 ? 's' : ''} detected</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Imported into the form below: {envFilesFound.map(f => <code key={f.name} className="mx-1 font-mono">{f.name}</code>)}
                </p>
              </div>
            )}

            {/* Compose preview / editor */}
            {repoDetection?.hasCompose && composePreview?.exists && (
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <FileCode size={14} /> {composeFileName}
                </Label>
                <textarea
                  className="w-full font-mono text-xs rounded-md border border-border bg-zinc-950 text-green-300 p-3 min-h-[180px] outline-none focus:ring-2 focus:ring-primary"
                  spellCheck={false}
                  value={composeOverride ?? ''}
                  onChange={(e) => setComposeOverride(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Edit if needed. Default is loaded from the repo.
                </p>
              </div>
            )}

            {/* Dockerfile preview / editor */}
            {repoDetection?.hasDockerfile && !repoDetection?.hasCompose && dockerfilePreview?.exists && (
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <FileCode size={14} /> Dockerfile
                </Label>
                <textarea
                  className="w-full font-mono text-xs rounded-md border border-border bg-zinc-950 text-green-300 p-3 min-h-[160px] outline-none focus:ring-2 focus:ring-primary"
                  spellCheck={false}
                  value={dockerfileOverride ?? ''}
                  onChange={(e) => setDockerfileOverride(e.target.value)}
                />
              </div>
            )}

            {/* Dockerfile EXPOSE remap */}
            {dockerfileOverride && !composeOverride && (() => {
              const exposed = (dockerfileOverride.match(/^\s*EXPOSE\s+.+$/gim) || [])
                .flatMap(l => l.replace(/^\s*EXPOSE\s+/i, '').split(/\s+/))
                .map(t => Number(t.split('/')[0]))
                .filter(n => Number.isFinite(n));
              if (exposed.length === 0) {
                return (
                  <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
                    <AlertTriangle size={16} className="text-orange-500 shrink-0 mt-0.5" />
                    <div className="text-xs">
                      <p className="font-semibold">No EXPOSE in Dockerfile</p>
                      <p className="text-muted-foreground mt-0.5">
                        Add an <code>EXPOSE</code> directive or set the port below.
                      </p>
                    </div>
                  </div>
                );
              }
              return (
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Plug size={14} /> Port Mapping (from Dockerfile EXPOSE)
                  </Label>
                  <div className="space-y-2 rounded-md border border-border p-3">
                    {exposed.map((p, i) => (
                      <div key={`expose-${p}-${i}`} className="flex items-center gap-2">
                        <Badge variant="secondary" className="font-mono text-[10px]">app</Badge>
                        <Input
                          type="number"
                          min={1}
                          max={65535}
                          className="font-mono h-8 w-24"
                          value={portRemap[String(p)] ?? String(p)}
                          onChange={(e) => setPortRemap(d => ({ ...d, [String(p)]: e.target.value }))}
                        />
                        <ChevronRight size={12} className="text-muted-foreground" />
                        <span className="font-mono text-xs text-muted-foreground">{p}/tcp</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Port remap */}
            {composeOverride && (() => {
              const ports = parseComposePortsClient(composeOverride);
              if (ports.length === 0) {
                return (
                  <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
                    <AlertTriangle size={16} className="text-orange-500 shrink-0 mt-0.5" />
                    <div className="text-xs">
                      <p className="font-semibold">No port declared in compose</p>
                      <p className="text-muted-foreground mt-0.5">
                        Container will start but won&apos;t be reachable from the host. Add a <code>ports:</code> entry above.
                      </p>
                    </div>
                  </div>
                );
              }
              return (
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Plug size={14} /> Port Mapping
                  </Label>
                  <div className="space-y-2 rounded-md border border-border p-3">
                    {ports.map((p, i) => (
                      <div key={`${p.service}-${p.container}-${i}`} className="flex items-center gap-2">
                        <Badge variant="secondary" className="font-mono text-[10px]">{p.service}</Badge>
                        <Input
                          type="number"
                          min={1}
                          max={65535}
                          className="font-mono h-8 w-24"
                          value={portRemap[String(p.container)] ?? String(p.host ?? p.container)}
                          onChange={(e) => setPortRemap(d => ({ ...d, [String(p.container)]: e.target.value }))}
                        />
                        <ChevronRight size={12} className="text-muted-foreground" />
                        <span className="font-mono text-xs text-muted-foreground">{p.container}/{p.protocol}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Change host port if it conflicts with another app. Container port is fixed.
                  </p>
                </div>
              );
            })()}

            {/* Env vars */}
            <div className="space-y-2">
              <Label>Environment Variables</Label>
              <div className="space-y-2">
                {envRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      placeholder="KEY"
                      className="font-mono h-8"
                      value={row.key}
                      onChange={(e) => setEnvRows(d => d.map((r, j) => j === i ? { ...r, key: e.target.value } : r))}
                    />
                    <span className="text-muted-foreground">=</span>
                    <Input
                      placeholder="value"
                      className="font-mono h-8"
                      value={row.value}
                      onChange={(e) => setEnvRows(d => d.map((r, j) => j === i ? { ...r, value: e.target.value } : r))}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEnvRows(d => d.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                ))}
                <Button size="sm" variant="outline" onClick={() => setEnvRows(d => [...d, { key: '', value: '' }])}>
                  <Plus size={14} /> Add Variable
                </Button>
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDeployStep(1)}>Back</Button>
              <Button onClick={() => setDeployStep(3)}>Next</Button>
            </DialogFooter>
          </div>
        )}

        {/* Step 3: Review & Deploy */}
        {deployStep === 3 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">Ready to deploy</h3>
              <p className="text-sm text-muted-foreground">Review and confirm</p>
            </div>

            <div className="rounded-lg border border-border divide-y divide-border">
              <div className="flex justify-between px-4 py-2.5 text-sm">
                <span className="text-muted-foreground">Name</span>
                <span className="font-semibold">{deployForm.name}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5 text-sm">
                <span className="text-muted-foreground">Project</span>
                <span className="font-semibold">{projects.find(p => p.id === deployForm.projectId)?.name}</span>
              </div>
              <div className="flex justify-between px-4 py-2.5 text-sm">
                <span className="text-muted-foreground">Source</span>
                <span className="font-mono text-xs">{deployForm.gitUrl || 'Docker'}</span>
              </div>
              {deployForm.framework && (
                <div className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground">Framework</span>
                  <Badge variant="outline">{FRAMEWORK_LABELS[deployForm.framework] || deployForm.framework}</Badge>
                </div>
              )}
              {deployForm.port && (
                <div className="flex justify-between px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground">Port</span>
                  <span className="font-mono">{deployForm.port}</span>
                </div>
              )}
            </div>

            {/* Domain section — every domain shows up; backend rules decide
                whether the app takes :443 or a custom port. */}
            <div className="space-y-2">
              <Label>Domain (optional)</Label>
              <Select value={deployDomainId} onChange={(e) => {
                setDeployDomainId(e.target.value);
                if (e.target.value !== '__new__') setNewDomainName('');
              }}>
                <option value="">No domain</option>
                {availableDomains.map((d: any) => (
                  <option key={d.id} value={d.id}>
                    {d.domain}{d.applicationId ? ' (main :443 used — will bind on the app port)' : ''}
                  </option>
                ))}
                <option value="__new__">+ Add a new domain…</option>
              </Select>
              {deployDomainId === '__new__' && (
                <div className="space-y-1">
                  <Input
                    placeholder="app.mydomain.com"
                    value={newDomainName}
                    onChange={(e) => setNewDomainName(e.target.value.trim().toLowerCase())}
                  />
                  <p className="text-xs text-muted-foreground">
                    The domain will be created and auto-linked. Point its A record at the server IP after deploy.
                  </p>
                </div>
              )}
              {deployDomainId !== '__new__' && (
                <p className="text-xs text-muted-foreground">
                  Picking a domain that already serves another app on :443 will bind this one on its custom port instead. <Link href="/dashboard/domains" className="text-primary hover:underline">Manage domains</Link>
                </p>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setDeployStep(2)}>Back</Button>
              <Button onClick={handleDeploySubmit} disabled={createMutation.isPending}>
                {createMutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Deploying...</> : <><Rocket size={14} /> Deploy</>}
              </Button>
            </DialogFooter>
          </div>
        )}
      </Dialog>

      {/* ---- Delete Confirmation Dialog ---- */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>Delete Application</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete <strong>{deleteTarget?.name}</strong>? This will stop all
            containers and permanently remove the application. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
          >
            {deleteMutation.isPending ? 'Deleting...' : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ---- Logs Dialog ---- */}
      <Dialog open={!!logsAppId} onClose={() => setLogsAppId(null)} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal size={18} />
            Logs — {logsAppName}
          </DialogTitle>
          <DialogDescription>
            Live application logs (auto-refreshes every 5s)
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <div className="absolute right-2 top-2 z-10 flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => refetchLogs()}
            >
              <RefreshCw size={14} />
              Refresh
            </Button>
          </div>

          <div className="max-h-96 overflow-y-auto rounded-md bg-zinc-950 p-4 font-mono text-xs text-green-400">
            {logsLoading ? (
              <p className="text-muted-foreground">Loading logs...</p>
            ) : logsData?.logs ? (
              <pre className="whitespace-pre-wrap break-all">{logsData.logs}</pre>
            ) : (
              <p className="text-muted-foreground">No logs available</p>
            )}
            <div ref={logsEndRef} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setLogsAppId(null)}>
            Close
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
