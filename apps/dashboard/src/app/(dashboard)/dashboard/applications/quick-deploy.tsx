'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Rocket, Loader2, GitBranch, Globe, Github, Sparkles, AlertCircle,
  Link2, Container, Pencil, Search,
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

type Source = 'provider' | 'gitUrl' | 'docker' | 'blank';

interface Project { id: string; name: string }
interface GitProvider { id: string; provider: string; username?: string }
interface Repo {
  fullName: string;
  defaultBranch?: string;
  private?: boolean;
  description?: string | null;
  url?: string; // canonical clone URL (works for GitLab / Bitbucket too)
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

/**
 * Quick-deploy: single-screen wizard for all the canonical flows.
 *
 *   - Source: 4 tabs — connected Git provider (e.g. GitHub OAuth),
 *     raw Git URL (public or PAT), Docker image, or blank scaffold.
 *   - Project picker.
 *   - App name (auto-prefilled).
 *   - Domain: dropdown of the project's unassigned existing domains,
 *     plus "+ Add a new domain" and "Skip — add later" options.
 *
 * The backend handles the rest: framework auto-detect, Dockerfile
 * generation, atomic domain create-or-attach, shared-bridge networking
 * (no host port questions).
 *
 * Power users open the original 4-step wizard via "Advanced…" for
 * env editor, port mapping, compose overrides, etc.
 */
export function QuickDeployDialog({
  open,
  onClose,
  onAdvanced,
}: {
  open: boolean;
  onClose: () => void;
  onAdvanced: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  // ── Loaders ─────────────────────────────────────────────────────
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
    enabled: open,
  });
  const { data: providers = [] } = useQuery<GitProvider[]>({
    queryKey: ['git-providers'],
    queryFn: () => api.get('/git-providers'),
    enabled: open,
  });
  const { data: domains = [] } = useQuery<DomainRow[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
    enabled: open,
  });

  // ── State ───────────────────────────────────────────────────────
  const [source, setSource] = useState<Source>('provider');
  const [projectId, setProjectId] = useState('');
  const [name, setName] = useState('');

  // Provider mode
  const [providerId, setProviderId] = useState('');
  const [repo, setRepo] = useState<Repo | null>(null);
  const [repoSearch, setRepoSearch] = useState('');

  // Git URL mode
  const [gitUrl, setGitUrl] = useState('');
  const [gitBranch, setGitBranch] = useState('main');
  const [gitToken, setGitToken] = useState('');

  // Docker mode
  const [dockerImage, setDockerImage] = useState('');

  // Domain
  const [domainChoice, setDomainChoice] = useState<'skip' | 'new' | string>('skip');
  const [newDomain, setNewDomain] = useState('');
  // Host-port publish (only meaningful when domainChoice === 'skip').
  const [hostPort, setHostPort] = useState('');

  // ── Resets ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    if (providers.length === 1 && !providerId) setProviderId(providers[0].id);
    if (projects.length === 1 && !projectId) setProjectId(projects[0].id);
  }, [open, providers, projects, providerId, projectId]);

  // Default source: if no Git provider is connected, start on Git URL.
  useEffect(() => {
    if (open && providers.length === 0 && source === 'provider') {
      setSource('gitUrl');
    }
  }, [open, providers.length, source]);

  // ── Provider repo listing + framework detection ─────────────────
  const { data: repos = [], isLoading: reposLoading } = useQuery<Repo[]>({
    queryKey: ['quick-deploy-repos', providerId],
    queryFn: () => api.get(`/git-providers/${providerId}/repos`),
    enabled: source === 'provider' && !!providerId && open,
  });

  const { data: detection } = useQuery<RepoDetection>({
    queryKey: ['quick-deploy-detect', providerId, repo?.fullName, repo?.defaultBranch],
    queryFn: () =>
      api.get(
        `/git-providers/${providerId}/detect?repo=${encodeURIComponent(repo!.fullName)}&branch=${repo!.defaultBranch || 'main'}`,
      ),
    enabled: source === 'provider' && !!providerId && !!repo,
  });

  // Auto-fill name from picked repo / git URL / docker image.
  useEffect(() => {
    if (name) return;
    if (source === 'provider' && repo) {
      const short = repo.fullName.split('/').pop() || repo.fullName;
      setName(short.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40));
    }
    if (source === 'gitUrl' && gitUrl) {
      const m = gitUrl.match(/\/([^/]+?)(?:\.git)?$/);
      if (m) setName(m[1].toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40));
    }
    if (source === 'docker' && dockerImage) {
      const short = dockerImage.split('/').pop()?.split(':')[0] || '';
      if (short) setName(short.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40));
    }
  }, [source, repo, gitUrl, dockerImage, name]);

  // ── Mutation ────────────────────────────────────────────────────
  const deployMutation = useMutation({
    mutationFn: () => {
      const body: any = {
        name,
        projectId,
        framework: detection?.framework || 'STATIC',
      };

      if (source === 'provider' && repo) {
        body.framework = detection?.framework || 'STATIC';
        body.gitProvider = providers.find((p) => p.id === providerId)?.provider || 'GITHUB';
        body.gitProviderId = providerId;
        // Use the canonical clone URL returned by the provider — works
        // for GitLab / Bitbucket too, where the host isn't github.com.
        body.gitUrl = repo.url || `https://github.com/${repo.fullName}.git`;
        body.gitBranch = repo.defaultBranch || 'main';
      } else if (source === 'gitUrl') {
        body.gitUrl = gitUrl.trim();
        body.gitBranch = gitBranch.trim() || 'main';
        if (gitToken.trim()) body.gitToken = gitToken.trim();
      } else if (source === 'docker') {
        body.framework = 'DOCKER';
        body.dockerImage = dockerImage.trim();
      } else {
        body.framework = 'STATIC';
      }

      // Domain handling.
      if (domainChoice === 'new' && newDomain.trim()) {
        body.domain = newDomain.trim();
      } else if (domainChoice !== 'skip' && domainChoice !== 'new') {
        body.domainId = domainChoice;
      } else if (domainChoice === 'skip' && hostPort.trim()) {
        // No domain → publish on a host port for direct IP access.
        const n = parseInt(hostPort, 10);
        if (Number.isFinite(n) && n >= 1024 && n <= 65535) {
          body.hostPort = n;
        }
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

  function handleClose() {
    onClose();
    setRepo(null);
    setName('');
    setGitUrl('');
    setGitToken('');
    setDockerImage('');
    setNewDomain('');
    setDomainChoice('skip');
    setRepoSearch('');
    setHostPort('');
  }

  const filteredRepos = repoSearch
    ? repos.filter((r) => r.fullName.toLowerCase().includes(repoSearch.toLowerCase()))
    : repos;

  // Show only domains that belong to the picked project AND aren't already
  // attached to another app.
  const reusableDomains = domains.filter(
    (d) => d.projectId === projectId && !d.applicationId,
  );

  // ── Validation ──────────────────────────────────────────────────
  const sourceValid =
    (source === 'provider' && !!repo) ||
    (source === 'gitUrl' && /^https?:\/\//.test(gitUrl)) ||
    (source === 'docker' && dockerImage.trim().length > 0) ||
    source === 'blank';

  // RFC 1035 hostname regex aligned with the backend DTO: no leading/
  // trailing dashes per label, TLD must be alphabetic, total ≤253 chars.
  // Misalignment caused the Deploy button to enable for "-foo.com" and
  // hit a 400 on submit.
  const domainRegex = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;
  const domainValid =
    domainChoice === 'skip' ||
    (domainChoice === 'new' && domainRegex.test(newDomain.trim())) ||
    (domainChoice !== 'skip' && domainChoice !== 'new');

  // Host port: when typed, it must be 1024-65535 AND not match the
  // reserved set the backend rejects. We surface invalidity inline so
  // the user sees the problem before clicking Deploy.
  const RESERVED = new Set([22, 25, 53, 80, 110, 143, 443, 465, 587, 993, 995, 2019, 3000, 4000, 5432, 6379]);
  const hostPortNumber = hostPort.trim() ? parseInt(hostPort.trim(), 10) : null;
  const hostPortValid =
    hostPort.trim() === '' ||
    (Number.isFinite(hostPortNumber!) && hostPortNumber! >= 1024 && hostPortNumber! <= 65535 && !RESERVED.has(hostPortNumber!));

  const canDeploy = sourceValid && !!projectId && !!name && domainValid && hostPortValid;

  const sourceTabs: { id: Source; label: string; icon: typeof Github; available: boolean }[] = [
    {
      id: 'provider',
      label: t('quickDeploy.source.provider') || 'GitHub / GitLab',
      icon: Github,
      available: providers.length > 0,
    },
    { id: 'gitUrl', label: t('quickDeploy.source.gitUrl') || 'Git URL', icon: Link2, available: true },
    { id: 'docker', label: t('quickDeploy.source.docker') || 'Docker image', icon: Container, available: true },
    { id: 'blank', label: t('quickDeploy.source.blank') || 'Empty', icon: Pencil, available: true },
  ];

  return (
    <Dialog open={open} onClose={handleClose} className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Rocket size={18} /> {t('quickDeploy.title') || 'Deploy a site'}
        </DialogTitle>
        <DialogDescription>
          {t('quickDeploy.desc') ||
            'Pick a source, a project, optionally a domain. The platform handles the rest.'}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-5 py-2">
        {/* ── Source tabs ────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label className="text-sm">{t('quickDeploy.sourceLabel') || 'Source'}</Label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {sourceTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => tab.available && setSource(tab.id)}
                  disabled={!tab.available}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-lg border p-3 text-xs transition-colors',
                    source === tab.id
                      ? 'border-primary bg-primary/5 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent/40',
                    !tab.available && 'opacity-40 cursor-not-allowed',
                  )}
                >
                  <Icon size={18} />
                  <span className="text-center leading-tight">{tab.label}</span>
                </button>
              );
            })}
          </div>
          {!providers.length && (
            <p className="text-[11px] text-muted-foreground">
              {t('quickDeploy.noProviderHint') ||
                'No Git provider connected yet. Connect GitHub from Settings → Git providers to enable the first tab.'}
            </p>
          )}
        </div>

        {/* ── Source body ────────────────────────────────────────── */}
        {source === 'provider' && (
          <div className="space-y-2">
            {providers.length > 1 && (
              <Select value={providerId} onChange={(e) => { setProviderId(e.target.value); setRepo(null); }}>
                <option value="">{t('quickDeploy.pickProvider') || 'Pick a provider'}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.provider}
                    {p.username ? ` (${p.username})` : ''}
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
                    filteredRepos.slice(0, 50).map((r) => (
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
            {repo && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs flex items-center gap-2 flex-wrap">
                <Sparkles size={14} className="text-primary" />
                {detection ? (
                  <>
                    <span>{t('quickDeploy.detected') || 'Detected'}:</span>
                    {detection.hasCompose ? (
                      <Badge variant="secondary" className="text-[10px]">docker-compose</Badge>
                    ) : detection.hasDockerfile ? (
                      <Badge variant="secondary" className="text-[10px]">Dockerfile</Badge>
                    ) : detection.framework && detection.framework !== 'STATIC' ? (
                      <Badge variant="secondary" className="text-[10px]">{detection.framework}</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">static</Badge>
                    )}
                    <span className="text-muted-foreground">
                      {t('quickDeploy.detectedDesc') || '— image is built automatically.'}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{t('quickDeploy.detecting') || 'Detecting framework…'}</span>
                )}
              </div>
            )}
          </div>
        )}

        {source === 'gitUrl' && (
          <div className="space-y-2">
            <Label htmlFor="qd-giturl" className="text-sm">
              {t('quickDeploy.gitUrl') || 'Git repository URL'}
            </Label>
            <Input
              id="qd-giturl"
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

        {source === 'docker' && (
          <div className="space-y-2">
            <Label htmlFor="qd-dockerimg" className="text-sm">
              {t('quickDeploy.dockerImage') || 'Docker image (with tag)'}
            </Label>
            <Input
              id="qd-dockerimg"
              placeholder="ghcr.io/you/your-app:latest"
              value={dockerImage}
              onChange={(e) => setDockerImage(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              {t('quickDeploy.dockerHint') || 'The image is pulled and run as-is. Caddy routes the domain to the container.'}
            </p>
          </div>
        )}

        {source === 'blank' && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs">
            <p>
              {t('quickDeploy.blankHint') || 'Creates an empty application stub. You can wire it up later from the app\'s Settings tab (Git URL, Dockerfile, or upload files).'}
            </p>
          </div>
        )}

        {/* ── Project ────────────────────────────────────────────── */}
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

        {/* ── App name ───────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label htmlFor="qd-name" className="text-sm">{t('quickDeploy.appName') || 'App name'}</Label>
          <Input
            id="qd-name"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
            placeholder="my-app"
          />
        </div>

        {/* ── Domain ─────────────────────────────────────────────── */}
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm">
            <Globe size={14} /> {t('quickDeploy.domain') || 'Domain'}
          </Label>
          <Select value={domainChoice} onChange={(e) => setDomainChoice(e.target.value as any)}>
            <option value="skip">{t('quickDeploy.domainSkip') || 'Skip — add later'}</option>
            {reusableDomains.length > 0 && (
              <optgroup label={t('quickDeploy.domainExisting') || 'Existing domains in this project'}>
                {reusableDomains.map((d) => (
                  <option key={d.id} value={d.id}>{d.domain}</option>
                ))}
              </optgroup>
            )}
            <option value="new">{t('quickDeploy.domainNew') || '+ Add a new domain'}</option>
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
          {domainChoice === 'skip' && (
            <div className="space-y-2 pt-1">
              <Label htmlFor="qd-hostport" className="text-xs text-muted-foreground">
                {t('quickDeploy.hostPort') || 'Or publish on a host port (no domain)'}
              </Label>
              <Input
                id="qd-hostport"
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
                  'App reachable at http://<server-ip>:<port>. Reserved ports (3000 dashboard, 4000 API, 5432 postgres, 80/443 Caddy) are refused.'}
              </p>
            </div>
          )}
        </div>
      </div>

      <DialogFooter className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onAdvanced}>
          {t('quickDeploy.advanced') || 'Advanced…'}
        </Button>
        <div className="flex gap-2">
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
        </div>
      </DialogFooter>
    </Dialog>
  );
}
