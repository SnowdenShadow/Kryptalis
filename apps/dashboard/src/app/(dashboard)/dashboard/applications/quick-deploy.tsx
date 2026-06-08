'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Rocket, Loader2, GitBranch, Globe, Github, Sparkles, AlertCircle,
  Link2, Container, Search, Package, ChevronRight, ChevronDown,
  Plus, X, Eye, EyeOff, ArrowLeft,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

/**
 * Unified Deploy dialog.
 *
 * One entry point, three modes:
 *
 *   1. Git           — pick a connected provider repo OR paste a Git URL.
 *   2. Docker image  — pull-and-run any registry image.
 *   3. Marketplace   — install from the curated catalog.
 *
 * Same flow for all three: Mode → Source-specific fields → Project +
 * Name (auto-prefilled) → Domain or Host Port → Advanced (env vars,
 * collapsible). One Deploy button.
 *
 * Replaces the previous quick-deploy + advanced-wizard + marketplace-
 * install split: every deploy goes through the same screen so the user
 * never has to remember which dialog to open for which case.
 */

type Mode = 'git' | 'docker' | 'marketplace';
type GitSource = 'provider' | 'url';

interface Project { id: string; name: string }
interface GitProvider { id: string; provider: string; username?: string }
interface Repo {
  fullName: string;
  defaultBranch?: string;
  private?: boolean;
  description?: string | null;
  url?: string;
}
interface DomainRow {
  id: string;
  domain: string;
  projectId?: string | null;
  applicationId?: string | null;
}
interface RepoDetection {
  framework?: string;
  hasDockerfile?: boolean;
  hasCompose?: boolean;
}
interface MarketplaceApp {
  id: string;
  slug: string;
  name: string;
  description?: string;
  category?: string;
  dockerImage?: string;
  defaultPort?: number;
  iconUrl?: string;
  envVars?: Array<{ key: string; defaultValue?: string; required?: boolean; description?: string }>;
}

interface EnvRow { key: string; value: string; hidden?: boolean }

const RESERVED_PORTS = new Set([
  22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 2019, 3000, 4000, 5432, 6379,
]);
const DOMAIN_RE = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;

export function QuickDeployDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  // ── Mode selection (step 0) ─────────────────────────────────────
  const [mode, setMode] = useState<Mode | null>(null);

  // ── Git mode state ──────────────────────────────────────────────
  const [gitSource, setGitSource] = useState<GitSource>('provider');
  const [providerId, setProviderId] = useState('');
  const [repo, setRepo] = useState<Repo | null>(null);
  const [repoSearch, setRepoSearch] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [gitToken, setGitToken] = useState('');

  // ── Docker mode state ───────────────────────────────────────────
  const [dockerImage, setDockerImage] = useState('');

  // ── Marketplace mode state ──────────────────────────────────────
  const [marketplaceSearch, setMarketplaceSearch] = useState('');
  const [marketplaceApp, setMarketplaceApp] = useState<MarketplaceApp | null>(null);

  // ── Common fields ───────────────────────────────────────────────
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');

  // ── Networking — exclusive: domain OR host port ─────────────────
  const [exposeMode, setExposeMode] = useState<'domain' | 'port' | 'none'>('none');
  const [domainChoice, setDomainChoice] = useState<'new' | string>('new');
  const [newDomain, setNewDomain] = useState('');
  const [hostPort, setHostPort] = useState('');

  // ── Advanced (env vars) ─────────────────────────────────────────
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);

  // ── Loaders ─────────────────────────────────────────────────────
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
    enabled: open,
  });
  const { data: providers = [] } = useQuery<GitProvider[]>({
    queryKey: ['git-providers'],
    queryFn: () => api.get('/git-providers'),
    enabled: open && mode === 'git',
  });
  const { data: domains = [] } = useQuery<DomainRow[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
    enabled: open,
  });
  const { data: catalog = [] } = useQuery<MarketplaceApp[]>({
    queryKey: ['marketplace-catalog'],
    queryFn: () => api.get('/marketplace/apps'),
    enabled: open && mode === 'marketplace',
  });

  const { data: repos = [], isLoading: reposLoading } = useQuery<Repo[]>({
    queryKey: ['unified-deploy-repos', providerId],
    queryFn: () => api.get(`/git-providers/${providerId}/repos`),
    enabled: open && mode === 'git' && gitSource === 'provider' && !!providerId,
  });

  const { data: detection } = useQuery<RepoDetection>({
    queryKey: ['unified-deploy-detect', providerId, repo?.fullName, repo?.defaultBranch],
    queryFn: () =>
      api.get(
        `/git-providers/${providerId}/detect?repo=${encodeURIComponent(repo!.fullName)}&branch=${repo!.defaultBranch || 'main'}`,
      ),
    enabled: open && mode === 'git' && gitSource === 'provider' && !!providerId && !!repo,
  });

  // ── Auto-prefills ───────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    if (providers.length === 1 && !providerId) setProviderId(providers[0].id);
    if (projects.length === 1 && !projectId) setProjectId(projects[0].id);
  }, [open, providers, projects, providerId, projectId]);

  // Default git source: provider if connected, else URL.
  useEffect(() => {
    if (open && mode === 'git' && providers.length === 0 && gitSource === 'provider') {
      setGitSource('url');
    }
  }, [open, mode, providers.length, gitSource]);

  // Auto-name from source.
  useEffect(() => {
    if (name) return;
    if (mode === 'git' && gitSource === 'provider' && repo) {
      const short = repo.fullName.split('/').pop() || repo.fullName;
      setName(slug(short));
    } else if (mode === 'git' && gitSource === 'url' && gitUrl) {
      const m = gitUrl.match(/\/([^/]+?)(?:\.git)?$/);
      if (m) setName(slug(m[1]));
    } else if (mode === 'docker' && dockerImage) {
      const short = dockerImage.split('/').pop()?.split(':')[0] || '';
      if (short) setName(slug(short));
    } else if (mode === 'marketplace' && marketplaceApp) {
      setName(slug(marketplaceApp.slug));
    }
  }, [mode, gitSource, repo, gitUrl, dockerImage, marketplaceApp, name]);

  // Preload marketplace env vars into the editor when an app is picked.
  useEffect(() => {
    if (mode === 'marketplace' && marketplaceApp?.envVars?.length) {
      setEnvRows(
        marketplaceApp.envVars.map((e) => ({
          key: e.key,
          value: e.defaultValue || '',
          hidden: !!(e.description?.toLowerCase().includes('password') || e.key.toLowerCase().includes('secret')),
        })),
      );
      // Auto-open Advanced when required vars exist with no defaults.
      if (marketplaceApp.envVars.some((e) => e.required && !e.defaultValue)) {
        setShowAdvanced(true);
      }
    }
  }, [mode, marketplaceApp]);

  // ── Helpers ─────────────────────────────────────────────────────
  function slug(s: string) {
    return s.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
  }

  function reset() {
    setMode(null);
    setProviderId('');
    setRepo(null);
    setRepoSearch('');
    setGitUrl('');
    setGitBranch('main');
    setGitToken('');
    setDockerImage('');
    setMarketplaceSearch('');
    setMarketplaceApp(null);
    setProjectId('');
    setName('');
    setExposeMode('none');
    setDomainChoice('new');
    setNewDomain('');
    setHostPort('');
    setShowAdvanced(false);
    setEnvRows([]);
    setGitSource('provider');
  }

  function handleClose() {
    onClose();
    reset();
  }

  // ── Validation ──────────────────────────────────────────────────
  const sourceValid =
    (mode === 'git' && gitSource === 'provider' && !!repo) ||
    (mode === 'git' && gitSource === 'url' && /^https?:\/\//.test(gitUrl)) ||
    (mode === 'docker' && dockerImage.trim().length > 0) ||
    (mode === 'marketplace' && !!marketplaceApp);

  const hostPortNumber = hostPort.trim() ? parseInt(hostPort.trim(), 10) : null;
  const hostPortValid =
    exposeMode !== 'port' ||
    (Number.isFinite(hostPortNumber!) &&
      hostPortNumber! >= 1024 &&
      hostPortNumber! <= 65535 &&
      !RESERVED_PORTS.has(hostPortNumber!));

  const domainValid =
    exposeMode !== 'domain' ||
    (domainChoice === 'new' ? DOMAIN_RE.test(newDomain.trim()) : !!domainChoice);

  // Required env vars satisfied?
  const requiredKeys =
    mode === 'marketplace'
      ? (marketplaceApp?.envVars || []).filter((e) => e.required).map((e) => e.key)
      : [];
  const envValid = requiredKeys.every((k) =>
    envRows.some((r) => r.key === k && r.value.trim() !== ''),
  );

  const canDeploy =
    !!mode && sourceValid && !!projectId && !!name && hostPortValid && domainValid && envValid;

  // ── Mutation ────────────────────────────────────────────────────
  const deployMutation = useMutation({
    mutationFn: async () => {
      const envVars = Object.fromEntries(
        envRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]),
      );

      // Marketplace install is a separate endpoint — it stamps the
      // platform template + persistent volumes the catalog declares.
      if (mode === 'marketplace' && marketplaceApp) {
        const body: any = {
          appId: marketplaceApp.id,
          appSlug: marketplaceApp.slug,
          name,
          projectId,
          envVars,
        };
        if (exposeMode === 'domain') {
          if (domainChoice === 'new') body.newDomain = newDomain.trim();
          else body.domainId = domainChoice;
        }
        if (exposeMode === 'port' && hostPortNumber) body.hostPort = hostPortNumber;
        return api.post('/marketplace/install', body);
      }

      // Git + Docker → /applications.
      const body: any = {
        name,
        projectId,
        envVars,
      };
      if (mode === 'git') {
        body.framework = detection?.framework || 'STATIC';
        if (gitSource === 'provider' && repo) {
          body.gitProvider = providers.find((p) => p.id === providerId)?.provider || 'GITHUB';
          body.gitProviderId = providerId;
          body.gitUrl = repo.url || `https://github.com/${repo.fullName}.git`;
          body.gitBranch = repo.defaultBranch || 'main';
        } else {
          body.gitUrl = gitUrl.trim();
          body.gitBranch = gitBranch.trim() || 'main';
          if (gitToken.trim()) body.gitToken = gitToken.trim();
        }
      } else if (mode === 'docker') {
        body.framework = 'DOCKER';
        body.dockerImage = dockerImage.trim();
      }
      if (exposeMode === 'domain') {
        if (domainChoice === 'new') body.domain = newDomain.trim();
        else body.domainId = domainChoice;
      } else if (exposeMode === 'port' && hostPortNumber) {
        body.hostPort = hostPortNumber;
      }
      return api.post('/applications', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['applications'] });
      qc.invalidateQueries({ queryKey: ['domains'] });
      toast.success(t('toast.appCreated'));
      handleClose();
    },
    onError: (err: Error) => toastError(err),
  });

  // ── Derived ─────────────────────────────────────────────────────
  const filteredRepos = repoSearch
    ? repos.filter((r) => r.fullName.toLowerCase().includes(repoSearch.toLowerCase()))
    : repos;

  const reusableDomains = domains.filter(
    (d) => d.projectId === projectId && !d.applicationId,
  );

  const filteredCatalog = marketplaceSearch
    ? catalog.filter(
        (a) =>
          a.name.toLowerCase().includes(marketplaceSearch.toLowerCase()) ||
          a.slug.toLowerCase().includes(marketplaceSearch.toLowerCase()),
      )
    : catalog;

  // ── Layout: Mode picker first ──────────────────────────────────
  if (!mode) {
    return (
      <Dialog open={open} onClose={handleClose} className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Rocket size={18} /> {t('quickDeploy.title') || 'Deploy'}
          </DialogTitle>
          <DialogDescription>
            {t('quickDeploy.pickMode') ||
              "Pick where the app comes from. You'll configure it on the next screen."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid sm:grid-cols-3 gap-3 py-2">
          <ModeCard
            icon={Github}
            title={t('quickDeploy.modeGit') || 'From Git'}
            desc={t('quickDeploy.modeGitDesc') || 'GitHub/GitLab/Bitbucket. Framework auto-detected.'}
            onClick={() => setMode('git')}
          />
          <ModeCard
            icon={Container}
            title={t('quickDeploy.modeDocker') || 'Docker image'}
            desc={t('quickDeploy.modeDockerDesc') || 'Any image from Docker Hub, GHCR, or a private registry.'}
            onClick={() => setMode('docker')}
          />
          <ModeCard
            icon={Package}
            title={t('quickDeploy.modeMarket') || 'Marketplace'}
            desc={t('quickDeploy.modeMarketDesc') || 'WordPress, Postgres, n8n, Nextcloud + more — pre-configured.'}
            onClick={() => setMode('marketplace')}
          />
        </div>
      </Dialog>
    );
  }

  // ── Layout: Unified configuration screen ───────────────────────
  return (
    <Dialog open={open} onClose={handleClose} className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setMode(null)}
            className="text-muted-foreground hover:text-foreground"
            title={t('common.back') || 'Back'}
          >
            <ArrowLeft size={16} />
          </button>
          <Rocket size={18} />
          {mode === 'git' && (t('quickDeploy.titleGit') || 'Deploy from Git')}
          {mode === 'docker' && (t('quickDeploy.titleDocker') || 'Deploy a Docker image')}
          {mode === 'marketplace' && (t('quickDeploy.titleMarket') || 'Install from Marketplace')}
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-5 py-2">
        {/* ── Source-specific picker ─────────────────────────── */}
        {mode === 'git' && <GitSourcePicker
          gitSource={gitSource} setGitSource={setGitSource}
          providers={providers} providerId={providerId} setProviderId={setProviderId}
          repo={repo} setRepo={setRepo} reposLoading={reposLoading}
          repoSearch={repoSearch} setRepoSearch={setRepoSearch}
          filteredRepos={filteredRepos} detection={detection}
          gitUrl={gitUrl} setGitUrl={setGitUrl}
          gitBranch={gitBranch} setGitBranch={setGitBranch}
          gitToken={gitToken} setGitToken={setGitToken}
          t={t}
        />}

        {mode === 'docker' && (
          <div className="space-y-2">
            <Label htmlFor="qd-img" className="text-sm">
              {t('quickDeploy.dockerImage') || 'Docker image (with tag)'}
            </Label>
            <Input
              id="qd-img"
              placeholder="ghcr.io/owner/app:latest"
              value={dockerImage}
              onChange={(e) => setDockerImage(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('quickDeploy.dockerHint') ||
                'Public images pull as-is. For private registries, save credentials in Admin → System Config first.'}
            </p>
          </div>
        )}

        {mode === 'marketplace' && (
          <MarketplacePicker
            catalog={filteredCatalog}
            search={marketplaceSearch}
            setSearch={setMarketplaceSearch}
            picked={marketplaceApp}
            setPicked={setMarketplaceApp}
            t={t}
          />
        )}

        {/* ── Project ────────────────────────────────────────── */}
        {sourceValid && (
          <div className="space-y-2">
            <Label className="text-sm">{t('quickDeploy.project') || 'Project'}</Label>
            {projects.length === 0 ? (
              <p className="text-xs text-orange-500 flex items-center gap-1">
                <AlertCircle size={12} />{' '}
                {t('quickDeploy.noProjects') || 'Create a project first (Projects → New project).'}
              </p>
            ) : (
              <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">{t('quickDeploy.pickProject') || 'Pick a project'}</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            )}
          </div>
        )}

        {/* ── App name ────────────────────────────────────────── */}
        {sourceValid && projectId && (
          <div className="space-y-2">
            <Label htmlFor="qd-name" className="text-sm">{t('quickDeploy.appName') || 'App name'}</Label>
            <Input
              id="qd-name"
              value={name}
              onChange={(e) => setName(slug(e.target.value))}
              placeholder="my-app"
            />
          </div>
        )}

        {/* ── Networking (exclusive radio) ──────────────────── */}
        {sourceValid && projectId && (
          <div className="space-y-2">
            <Label className="text-sm flex items-center gap-2">
              <Globe size={14} /> {t('quickDeploy.howToReach') || 'How will people reach it?'}
            </Label>
            <div className="grid sm:grid-cols-3 gap-2">
              <ExposeOption
                active={exposeMode === 'domain'}
                onClick={() => setExposeMode('domain')}
                title={t('quickDeploy.optDomain') || 'A domain (HTTPS)'}
                desc={t('quickDeploy.optDomainDesc') || 'Auto-issued SSL via Let\'s Encrypt.'}
              />
              <ExposeOption
                active={exposeMode === 'port'}
                onClick={() => setExposeMode('port')}
                title={t('quickDeploy.optPort') || 'A host port'}
                desc={t('quickDeploy.optPortDesc') || 'Reach at http://server-ip:port.'}
              />
              <ExposeOption
                active={exposeMode === 'none'}
                onClick={() => setExposeMode('none')}
                title={t('quickDeploy.optNone') || 'Add later'}
                desc={t('quickDeploy.optNoneDesc') || 'Skip for now, configure on the app page.'}
              />
            </div>

            {exposeMode === 'domain' && (
              <div className="space-y-2 pt-2">
                <Select value={domainChoice} onChange={(e) => setDomainChoice(e.target.value)}>
                  <option value="new">{t('quickDeploy.domainNew') || '+ Add a new domain'}</option>
                  {reusableDomains.length > 0 && (
                    <optgroup label={t('quickDeploy.domainExisting') || 'Existing domains in this project'}>
                      {reusableDomains.map((d) => (
                        <option key={d.id} value={d.id}>{d.domain}</option>
                      ))}
                    </optgroup>
                  )}
                </Select>
                {domainChoice === 'new' && (
                  <>
                    <Input
                      placeholder="app.acme.com"
                      value={newDomain}
                      onChange={(e) => setNewDomain(e.target.value.toLowerCase().trim())}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t('quickDeploy.domainHint') ||
                        "Point this domain's A record at your server IP. Caddy auto-issues a Let's Encrypt cert on first hit."}
                    </p>
                  </>
                )}
              </div>
            )}

            {exposeMode === 'port' && (
              <div className="space-y-2 pt-2">
                <Input
                  type="number"
                  min={1024}
                  max={65535}
                  placeholder="5050"
                  value={hostPort}
                  onChange={(e) => setHostPort(e.target.value)}
                />
                {!hostPortValid && hostPort.trim() !== '' && (
                  <p className="text-[11px] text-destructive">
                    {t('quickDeploy.hostPortInvalid') ||
                      'Port must be 1024–65535 and not one of the reserved Kryptalis ports.'}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {t('quickDeploy.hostPortHint') ||
                    'App reachable at http://<server-ip>:<port>. Reserved ports (3000, 4000, 5432, 80/443) are refused.'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Advanced (env vars) ────────────────────────────── */}
        {sourceValid && projectId && (
          <div className="space-y-2 pt-2">
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t('quickDeploy.advanced') || 'Advanced'} ({envRows.length} env vars)
            </button>
            {showAdvanced && (
              <EnvEditor envRows={envRows} setEnvRows={setEnvRows} requiredKeys={requiredKeys} t={t} />
            )}
          </div>
        )}
      </div>

      <DialogFooter className="flex justify-end gap-2">
        <Button variant="outline" onClick={handleClose}>
          {t('common.cancel') || 'Cancel'}
        </Button>
        <Button
          disabled={!canDeploy || deployMutation.isPending}
          onClick={() => deployMutation.mutate()}
        >
          {deployMutation.isPending && <Loader2 size={14} className="animate-spin" />}
          <Rocket size={14} className="mr-1" />
          {deployMutation.isPending
            ? t('quickDeploy.deploying') || 'Deploying…'
            : t('quickDeploy.deploy') || 'Deploy'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── Mode card ──────────────────────────────────────────────────────
function ModeCard({
  icon: Icon, title, desc, onClick,
}: {
  icon: typeof Github;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg border border-border p-4 text-left hover:border-primary hover:bg-primary/5 transition-colors"
    >
      <Icon size={22} className="mb-2 text-primary" />
      <p className="font-medium text-sm">{title}</p>
      <p className="text-[11px] text-muted-foreground mt-1">{desc}</p>
    </button>
  );
}

// ── Expose option pill ────────────────────────────────────────────
function ExposeOption({
  active, onClick, title, desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg border p-3 text-left transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
      )}
    >
      <p className="font-medium text-xs">{title}</p>
      <p className="text-[10px] text-muted-foreground mt-0.5">{desc}</p>
    </button>
  );
}

// ── Git source sub-component ──────────────────────────────────────
function GitSourcePicker(props: any) {
  const {
    gitSource, setGitSource, providers, providerId, setProviderId,
    repo, setRepo, reposLoading, repoSearch, setRepoSearch, filteredRepos, detection,
    gitUrl, setGitUrl, gitBranch, setGitBranch, gitToken, setGitToken, t,
  } = props;
  return (
    <div className="space-y-2">
      <div className="flex gap-1 rounded-md border border-border p-0.5 w-fit">
        <button
          type="button"
          onClick={() => setGitSource('provider')}
          disabled={providers.length === 0}
          className={cn(
            'px-3 py-1 text-xs rounded-sm transition-colors',
            gitSource === 'provider' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            providers.length === 0 && 'opacity-40 cursor-not-allowed',
          )}
        >
          {t('quickDeploy.fromConnected') || 'Connected provider'}
        </button>
        <button
          type="button"
          onClick={() => setGitSource('url')}
          className={cn(
            'px-3 py-1 text-xs rounded-sm transition-colors',
            gitSource === 'url' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t('quickDeploy.fromUrl') || 'Git URL'}
        </button>
      </div>

      {gitSource === 'provider' && providers.length > 0 && (
        <>
          {providers.length > 1 && (
            <Select value={providerId} onChange={(e: any) => { setProviderId(e.target.value); setRepo(null); }}>
              <option value="">{t('quickDeploy.pickProvider') || 'Pick a provider'}</option>
              {providers.map((p: GitProvider) => (
                <option key={p.id} value={p.id}>
                  {p.provider}{p.username ? ` (${p.username})` : ''}
                </option>
              ))}
            </Select>
          )}
          {providerId && (
            <>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" size={14} />
                <Input
                  className="pl-8"
                  placeholder={t('quickDeploy.searchRepo') || 'Search your repos…'}
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                />
              </div>
              <div className="max-h-56 overflow-y-auto rounded-md border border-border">
                {reposLoading ? (
                  <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                    <Loader2 className="animate-spin" size={12} />{' '}
                    {t('quickDeploy.loadingRepos') || 'Loading your repos…'}
                  </div>
                ) : filteredRepos.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground">
                    {t('quickDeploy.noRepos') || 'No matching repos.'}
                  </p>
                ) : (
                  filteredRepos.slice(0, 50).map((r: Repo) => (
                    <button
                      key={r.fullName}
                      type="button"
                      onClick={() => setRepo(r)}
                      className={cn(
                        'w-full text-left px-3 py-2 text-xs hover:bg-accent/40 border-b border-border last:border-b-0',
                        repo?.fullName === r.fullName && 'bg-accent/60',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <GitBranch size={12} className="text-muted-foreground" />
                        <span className="font-mono">{r.fullName}</span>
                        {r.private && <Badge variant="outline" className="text-[9px]">{t('quickDeploy.private') || 'private'}</Badge>}
                      </div>
                      {r.description && (
                        <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">{r.description}</p>
                      )}
                    </button>
                  ))
                )}
              </div>
            </>
          )}
          {repo && detection && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs flex items-center gap-2 flex-wrap">
              <Sparkles size={14} className="text-primary" />
              <span>{t('quickDeploy.detected') || 'Detected'}:</span>
              {detection.hasCompose ? (
                <Badge variant="secondary" className="text-[10px]">docker-compose</Badge>
              ) : detection.hasDockerfile ? (
                <Badge variant="secondary" className="text-[10px]">Dockerfile</Badge>
              ) : detection.framework ? (
                <Badge variant="secondary" className="text-[10px]">{detection.framework}</Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">static</Badge>
              )}
            </div>
          )}
        </>
      )}

      {gitSource === 'url' && (
        <div className="space-y-2">
          <Input
            placeholder="https://github.com/owner/repo.git"
            value={gitUrl}
            onChange={(e) => setGitUrl(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <Input
              placeholder={t('quickDeploy.branch') || 'main'}
              value={gitBranch}
              onChange={(e) => setGitBranch(e.target.value)}
            />
            <Input
              type="password"
              placeholder={t('quickDeploy.tokenOptional') || 'Token (private repos, optional)'}
              value={gitToken}
              onChange={(e) => setGitToken(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Marketplace picker ────────────────────────────────────────────
function MarketplacePicker({
  catalog, search, setSearch, picked, setPicked, t,
}: {
  catalog: MarketplaceApp[];
  search: string;
  setSearch: (v: string) => void;
  picked: MarketplaceApp | null;
  setPicked: (a: MarketplaceApp | null) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" size={14} />
        <Input
          className="pl-8"
          placeholder={t('quickDeploy.searchMarket') || 'Search the catalog (Postgres, WordPress, n8n…)'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {catalog.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">{t('quickDeploy.loadingCatalog') || 'Loading catalog…'}</p>
        ) : (
          <div className="grid sm:grid-cols-2 gap-1 p-1">
            {catalog.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setPicked(a)}
                className={cn(
                  'flex items-start gap-2 rounded-md p-2 text-left hover:bg-accent/40 transition-colors',
                  picked?.id === a.id && 'bg-accent/60 ring-1 ring-primary/40',
                )}
              >
                {a.iconUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.iconUrl} alt="" className="h-6 w-6 rounded shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium">{a.name}</p>
                  {a.description && (
                    <p className="text-[10px] text-muted-foreground line-clamp-1">{a.description}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Env editor ────────────────────────────────────────────────────
function EnvEditor({
  envRows, setEnvRows, requiredKeys, t,
}: {
  envRows: EnvRow[];
  setEnvRows: (rows: EnvRow[]) => void;
  requiredKeys: string[];
  t: (k: string) => string;
}) {
  function update(i: number, patch: Partial<EnvRow>) {
    setEnvRows(envRows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function remove(i: number) {
    setEnvRows(envRows.filter((_, idx) => idx !== i));
  }
  function add() {
    setEnvRows([...envRows, { key: '', value: '' }]);
  }
  return (
    <div className="space-y-2 rounded-md border border-border p-3 bg-muted/20">
      {envRows.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          {t('quickDeploy.envEmpty') || 'No env vars yet. Add KEY=value pairs here.'}
        </p>
      )}
      {envRows.map((row, i) => {
        const required = requiredKeys.includes(row.key);
        const missing = required && !row.value.trim();
        return (
          <div key={i} className="flex items-center gap-2">
            <Input
              className="font-mono text-xs"
              placeholder="KEY"
              value={row.key}
              onChange={(e) => update(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
            />
            <div className="flex-1 relative">
              <Input
                className={cn('font-mono text-xs', missing && 'border-destructive')}
                type={row.hidden ? 'password' : 'text'}
                placeholder={required ? 'required' : 'value'}
                value={row.value}
                onChange={(e) => update(i, { value: e.target.value })}
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => update(i, { hidden: !row.hidden })}
              >
                {row.hidden ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
            </div>
            {required ? (
              <Badge variant="outline" className="text-[9px]">req</Badge>
            ) : (
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-muted-foreground hover:text-destructive"
              >
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
      <Button size="sm" variant="ghost" onClick={add} className="text-xs gap-1">
        <Plus size={12} /> {t('quickDeploy.envAdd') || 'Add env var'}
      </Button>
    </div>
  );
}
