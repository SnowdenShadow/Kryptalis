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
import { toastError } from '@/lib/toast-error';
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
import { QuickDeployDialog } from './quick-deploy';

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
  hostPort?: number | null;
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
  server?: { id: string; name: string; host?: string } | null;
}

// Mirror of slugify() in apps/api/.../applications.service.ts — must stay
// byte-for-byte equivalent so the preview matches what the backend creates.
function slugifyPreview(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'app';
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

function makeTimeAgo(t: (k: string, v?: Record<string, string | number>) => string) {
  return (date: string) => {
    const s = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (s < 60) return t('apps.timeJust');
    if (s < 3600) return t('apps.timeMin', { n: Math.floor(s / 60) });
    if (s < 86400) return t('apps.timeHour', { n: Math.floor(s / 3600) });
    return t('apps.timeDay', { n: Math.floor(s / 86400) });
  };
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
  hostPort?: number | null;
  customPort?: boolean;
  domains?: { domain: string; sslStatus: string }[];
  portBindings?: { port: number; domain: { domain: string; sslStatus: string } }[];
}): string | null {
  const main = app.domains?.[0];
  if (main) {
    return app.customPort && app.port
      ? `http://${main.domain}:${app.port}`
      : `https://${main.domain}`;
  }
  const bound = app.portBindings?.[0];
  if (bound) return `http://${bound.domain.domain}:${bound.port}`;
  // No domain → use the host-port publish (the user-picked one). Falls
  // back to the internal container port only when nothing else is set.
  if (app.hostPort) return appUrl(app.hostPort);
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
  const timeAgo = makeTimeAgo(t);
  const router = useRouter();
  const queryClient = useQueryClient();

  // --- Search + filter ---
  const [search, setSearch] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterStatus, setFilterStatus] = useState<'' | 'RUNNING' | 'STOPPED' | 'ERROR' | 'DEPLOYING'>('');

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
    if (filterStatus) {
      result = result.filter((a) =>
        filterStatus === 'DEPLOYING'
          ? a.status === 'DEPLOYING' || a.status === 'BUILDING'
          : a.status === filterStatus,
      );
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((a) =>
        a.name.toLowerCase().includes(q) ||
        (a.gitUrl?.toLowerCase().includes(q) ?? false) ||
        (a.domains || []).some((d) => d.domain.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [applications, search, filterProject, filterStatus]);

  // --- Projects for dropdown ---
  const { data: projects = [] } = useQuery<ProjectOption[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });

  // --- Deploy dialogs ---
  // Single unified Deploy dialog — Git / Docker / Marketplace all flow
  // through the same screen now. The old 4-step "Advanced wizard" was
  // removed; every option it had (env editor, docker image, host port,
  // multi-source) is built into the new dialog as collapsible sections.
  const [showQuickDeploy, setShowQuickDeploy] = useState(false);
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
    dockerImage: '',
  });
  const [showToken, setShowToken] = useState(false);
  const [composeOverride, setComposeOverride] = useState<string | null>(null);
  const [dockerfileOverride, setDockerfileOverride] = useState<string | null>(null);
  const [portRemap, setPortRemap] = useState<Record<string, string>>({});
  const [envRows, setEnvRows] = useState<Array<{ key: string; value: string }>>([{ key: '', value: '' }]);

  const { data: gitProviders = [] } = useQuery<any[]>({
    queryKey: ['git-providers'],
    queryFn: () => api.get('/git-providers'),
    enabled: false,
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
    enabled: false,
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
      toast.success(t('toast.appCreated'));
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
        dockerImage: '',
      });
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/applications/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success(t('toast.appDeleted'));
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      toastError(err);
    },
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
      api.post(`/applications/${id}/${action}`),
    onSuccess: (_, { action }) => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success(t('toast.appActionInitiated', { action }));
    },
    onError: (err: Error) => {
      toastError(err);
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
    if (deployForm.dockerImage) body.dockerImage = deployForm.dockerImage;
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
            toast.success(t('toast.domainReserved', { name: newDomainName }));
          }
          setNewDomainName('');
          setDeployDomainId('');
        } catch (err: any) {
          toastError(err, t('apps.toastAppCreatedDomainFailed'));
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
        <Button onClick={() => setShowQuickDeploy(true)}>
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
              placeholder={t('apps.searchPlaceholder')}
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
              className="h-9 w-auto min-w-[140px]"
            >
              <option value="">{t('apps.filterAllStatuses')}</option>
              <option value="RUNNING">{t('apps.statusRunning')}</option>
              <option value="STOPPED">{t('apps.statusStopped')}</option>
              <option value="DEPLOYING">{t('apps.statusDeployingBuilding')}</option>
              <option value="ERROR">{t('apps.statusError')}</option>
            </Select>
            {projects.length <= 6 ? (
              <>
                <Button size="sm" variant={filterProject === '' ? 'default' : 'outline'} onClick={() => setFilterProject('')}>
                  {t('apps.filterAllProjects')}
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
              </>
            ) : (
              <Select
                value={filterProject}
                onChange={(e) => setFilterProject(e.target.value)}
                className="h-9 w-auto min-w-[160px]"
              >
                <option value="">{t('apps.filterAllProjects')}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            )}
            {(search || filterProject || filterStatus) && (
              <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setFilterProject(''); setFilterStatus(''); }}>
                {t('apps.filterClear')}
              </Button>
            )}
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
            <Button className="mt-4" onClick={() => setShowQuickDeploy(true)}>
              <Plus size={16} />
              {t('apps.deploy')}
            </Button>
          </CardContent>
        </Card>
      ) : filtered.length === 0 && (search || filterProject || filterStatus) ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
            <Search size={40} className="text-muted-foreground" />
            <p className="text-muted-foreground">{t('apps.filterNoMatch')}</p>
            <Button size="sm" variant="outline" onClick={() => { setSearch(''); setFilterProject(''); setFilterStatus(''); }}>
              {t('apps.filterClearAll')}
            </Button>
          </CardContent>
        </Card>
      ) : (() => {
        // Group filtered apps by project. Within each group, sort by status
        // (running first → then deploying → stopped → error), then alpha.
        // When a project filter is active we skip the headers — they'd
        // duplicate the active filter.
        const STATUS_ORDER: Record<string, number> = {
          RUNNING: 0, DEPLOYING: 1, BUILDING: 1, STOPPED: 2, ERROR: 3,
        };
        const sortApps = (apps: Application[]) =>
          [...apps].sort((a, b) => {
            const sa = STATUS_ORDER[a.status] ?? 99;
            const sb = STATUS_ORDER[b.status] ?? 99;
            if (sa !== sb) return sa - sb;
            return a.name.localeCompare(b.name);
          });
        const groups = new Map<string, { id: string; name: string; apps: Application[] }>();
        const orphan: Application[] = [];
        for (const app of filtered) {
          const proj = app.project;
          if (!proj?.id) { orphan.push(app); continue; }
          let g = groups.get(proj.id);
          if (!g) { g = { id: proj.id, name: proj.name, apps: [] }; groups.set(proj.id, g); }
          g.apps.push(app);
        }
        const groupList = Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name));
        const showHeaders = !filterProject;

        const renderCard = (app: Application) => {
          const isRunning = app.status === 'RUNNING';
          const isStopped = app.status === 'STOPPED';
          const isDeploying = app.status === 'DEPLOYING' || app.status === 'BUILDING';
          const statusLabel = app.status === 'RUNNING' ? t('apps.statusRunning') : app.status === 'STOPPED' ? t('apps.statusStopped') : app.status === 'ERROR' ? t('apps.statusError') : app.status === 'DEPLOYING' ? t('apps.statusDeploying') : app.status === 'BUILDING' ? t('apps.statusBuilding') : app.status;

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
                      {publicAppUrl(app) && (
                        <Button
                          size="sm"
                          className="shrink-0"
                          disabled={!isRunning}
                          title={isRunning ? t('apps.openTooltip') : t('apps.openDisabledTooltip')}
                          onClick={(e) => {
                            stop(e);
                            const url = publicAppUrl(app);
                            if (url) window.open(url, '_blank');
                          }}
                        >
                          <ExternalLink size={12} /> {t('apps.openLabel')}
                        </Button>
                      )}
                    </div>

                    {/* Info grid — project + port (port hidden for custom-port apps; visible in domain badges below) */}
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      {app.project?.name && (
                        <div>
                          <p className="text-xs text-muted-foreground">{t('apps.project')}</p>
                          <Link
                            href={`/dashboard/projects/${app.project.id}`}
                            className="font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {app.project.name}
                          </Link>
                        </div>
                      )}
                      {app.port && !app.customPort && (
                        <div>
                          <p className="text-xs text-muted-foreground">
                            {app.hostPort ? t('apps.portHostContainer') : t('apps.port')}
                          </p>
                          <p className="font-mono font-medium">
                            {app.hostPort ? `${app.hostPort} → ${app.port}` : app.port}
                          </p>
                        </div>
                      )}
                      {app.gitUrl && (
                        <div className="col-span-2">
                          <p className="text-xs text-muted-foreground">{t('apps.gitRepository')}</p>
                          <div className="flex items-center gap-2" title={app.gitUrl}>
                            <span className="font-mono text-xs truncate">{truncateGitUrl(app.gitUrl)}</span>
                            {app.gitBranch && (
                              <Badge variant="outline" className="text-[10px] gap-1 shrink-0">
                                <GitBranch size={9} /> {app.gitBranch}
                              </Badge>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Routes — single source of truth for URLs + SSL state */}
                    {((app.domains && app.domains.length > 0) || (app.portBindings && app.portBindings.length > 0)) && (
                      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
                        <p className="text-xs font-medium text-muted-foreground">{t('apps.publicUrls')}</p>
                        {(app.domains || []).map((d) => {
                          const url = app.customPort && app.port ? `https://${d.domain}:${app.port}` : `https://${d.domain}`;
                          return (
                            <div key={d.id} className="flex items-center justify-between gap-2">
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="font-mono text-sm truncate hover:underline text-primary"
                              >
                                {app.customPort && app.port ? `${d.domain}:${app.port}` : d.domain}
                              </a>
                              <Badge
                                variant={d.sslStatus === 'ACTIVE' ? 'success' : d.sslStatus === 'PENDING' ? 'warning' : 'destructive'}
                                className="text-[10px] shrink-0"
                                title={
                                  d.sslStatus === 'ACTIVE' ? t('apps.sslOkTooltip') :
                                  d.sslStatus === 'PENDING' ? t('apps.sslPendingTooltip') :
                                  t('apps.sslErrorTooltip')
                                }
                              >
                                {d.sslStatus === 'ACTIVE' ? t('apps.sslOk') : d.sslStatus === 'PENDING' ? t('apps.sslPending') : t('apps.sslError')}
                              </Badge>
                            </div>
                          );
                        })}
                        {(app.portBindings || []).map((b) => (
                          <div key={b.id} className="flex items-center justify-between gap-2">
                            <a
                              href={`https://${b.domain.domain}:${b.port}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="font-mono text-sm truncate hover:underline text-primary"
                            >
                              {b.domain.domain}:{b.port}
                            </a>
                            <Badge
                              variant={b.domain.sslStatus === 'ACTIVE' ? 'success' : 'outline'}
                              className="text-[10px] shrink-0"
                            >
                              {b.domain.sslStatus === 'ACTIVE' ? t('apps.sslOk') : t('apps.sslPending')}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Footer: actions + date */}
                    <div className="flex items-center justify-between pt-2 border-t border-border">
                      <span className="text-xs text-muted-foreground">{timeAgo(app.createdAt)}</span>
                      <div className="flex items-center gap-2">
                        {isStopped && (
                          <Button size="sm" variant="outline" disabled={actionMutation.isPending}
                            onClick={(e) => { stop(e); actionMutation.mutate({ id: app.id, action: 'start' }); }}>
                            <Play size={14} /> {t('apps.start')}
                          </Button>
                        )}
                        {isRunning && (
                          <>
                            <Button size="sm" variant="outline" disabled={actionMutation.isPending}
                              onClick={(e) => { stop(e); actionMutation.mutate({ id: app.id, action: 'stop' }); }}>
                              <Square size={14} /> {t('apps.stop')}
                            </Button>
                            <Button size="sm" variant="outline" disabled={actionMutation.isPending}
                              onClick={(e) => { stop(e); actionMutation.mutate({ id: app.id, action: 'restart' }); }}>
                              <RotateCcw size={14} /> {t('apps.restart')}
                            </Button>
                          </>
                        )}
                        <Button size="sm" variant="outline"
                          onClick={(e) => { stop(e); setLogsAppId(app.id); setLogsAppName(app.name); }}>
                          <Terminal size={14} /> {t('apps.logsButton')}
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
        };

        return (
          <div className="space-y-6">
            {groupList.map((g) => (
              <section key={g.id} className="space-y-3">
                {showHeaders && (
                  <div className="flex items-center justify-between border-b border-border pb-1.5">
                    <Link
                      href={`/dashboard/projects/${g.id}`}
                      className="flex items-center gap-2 text-sm font-semibold hover:text-primary transition-colors"
                    >
                      <Plug size={14} className="text-muted-foreground" />
                      {g.name}
                      <Badge variant="secondary" className="text-[10px]">{g.apps.length}</Badge>
                    </Link>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setShowQuickDeploy(true)}
                    >
                      <Plus size={12} /> {t('apps.addApp')}
                    </Button>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {sortApps(g.apps).map(renderCard)}
                </div>
              </section>
            ))}
            {orphan.length > 0 && (
              <section className="space-y-3">
                {showHeaders && (
                  <div className="flex items-center justify-between border-b border-border pb-1.5">
                    <span className="text-sm font-semibold text-muted-foreground">{t('apps.noProjectGroup')}</span>
                    <Badge variant="secondary" className="text-[10px]">{orphan.length}</Badge>
                  </div>
                )}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {sortApps(orphan).map(renderCard)}
                </div>
              </section>
            )}
          </div>
        );
      })()}

      {/* ---- Deploy — single unified entry point ---- */}
      <QuickDeployDialog
        open={showQuickDeploy}
        onClose={() => setShowQuickDeploy(false)}
      />

      {/* ---- Delete Confirmation Dialog ---- */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('apps.deleteApp')}</DialogTitle>
          <DialogDescription>
            {t('apps.deleteBodyName', { name: deleteTarget?.name ?? '' })}
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
            {deleteMutation.isPending ? t('common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ---- Logs Dialog ---- */}
      <Dialog open={!!logsAppId} onClose={() => setLogsAppId(null)} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal size={18} />
            {t('apps.logsDialogTitle', { name: logsAppName })}
          </DialogTitle>
          <DialogDescription>
            {t('apps.logsDialogDesc')}
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
              {t('apps.refresh')}
            </Button>
          </div>

          <div className="max-h-96 overflow-y-auto rounded-md bg-zinc-950 p-4 font-mono text-xs text-green-400">
            {logsLoading ? (
              <p className="text-muted-foreground">{t('apps.logsLoading')}</p>
            ) : logsData?.logs ? (
              <pre className="whitespace-pre-wrap break-all">{logsData.logs}</pre>
            ) : (
              <p className="text-muted-foreground">{t('apps.logsNone')}</p>
            )}
            <div ref={logsEndRef} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setLogsAppId(null)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
