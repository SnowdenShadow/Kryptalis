'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Rocket, Loader2, GitBranch, Globe, Github, Sparkles, AlertCircle,
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

interface Project { id: string; name: string }
interface GitProvider { id: string; provider: string; username?: string }
interface Repo {
  id?: string;
  fullName: string;
  defaultBranch?: string;
  private?: boolean;
  description?: string | null;
}
interface RepoDetection {
  framework?: string;
  port?: number | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  hasDockerfile?: boolean;
  hasCompose?: boolean;
}

/**
 * Quick-deploy: the happy-path single-screen wizard.
 *
 *   1. Pick a GitHub repo from your connected provider.
 *   2. Pick a project to deploy into.
 *   3. Type your domain (or skip).
 *   4. Click Deploy.
 *
 * The platform auto-detects the framework (React / Vite / Next / Vue /
 * Astro / static / Node / Python / PHP), generates a production
 * Dockerfile, picks the right internal port, attaches Caddy to the
 * shared bridge, and creates + attaches the domain atomically. The user
 * never sees the word "port".
 *
 * Power users open the original "Advanced…" dialog for compose / docker
 * image / port mapping / env editor flows.
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

  // ── Data loads ──────────────────────────────────────────────────
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

  // ── State ───────────────────────────────────────────────────────
  const [providerId, setProviderId] = useState('');
  const [repo, setRepo] = useState<Repo | null>(null);
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [domain, setDomain] = useState('');
  const [search, setSearch] = useState('');

  // Auto-pick the first provider + project on open so the user types less.
  useEffect(() => {
    if (!open) return;
    if (providers.length === 1 && !providerId) setProviderId(providers[0].id);
    if (projects.length === 1 && !projectId) setProjectId(projects[0].id);
  }, [open, providers, projects, providerId, projectId]);

  const { data: repos = [], isLoading: reposLoading } = useQuery<Repo[]>({
    queryKey: ['quick-deploy-repos', providerId],
    queryFn: () => api.get(`/git-providers/${providerId}/repos`),
    enabled: !!providerId && open,
  });

  const { data: detection } = useQuery<RepoDetection>({
    queryKey: ['quick-deploy-detect', providerId, repo?.fullName, repo?.defaultBranch],
    queryFn: () =>
      api.get(
        `/git-providers/${providerId}/detect?repo=${encodeURIComponent(repo!.fullName)}&branch=${repo!.defaultBranch || 'main'}`,
      ),
    enabled: !!providerId && !!repo,
  });

  // Auto-fill the app name from the repo's name once picked.
  useEffect(() => {
    if (repo && !name) {
      const short = repo.fullName.split('/').pop() || repo.fullName;
      setName(short.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40));
    }
  }, [repo, name]);

  // ── Mutation ────────────────────────────────────────────────────
  const deployMutation = useMutation({
    mutationFn: () => {
      const body: any = {
        name,
        projectId,
        framework: detection?.framework || 'STATIC',
        gitProvider: providers.find((p) => p.id === providerId)?.provider || 'GITHUB',
        gitProviderId: providerId,
        gitUrl: `https://github.com/${repo!.fullName}.git`,
        gitBranch: repo!.defaultBranch || 'main',
      };
      // Atomic domain create-or-attach if the user typed one.
      if (domain.trim()) body.domain = domain.trim();
      return api.post('/applications', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['applications'] });
      toast.success(t('toast.appCreated'));
      handleClose();
    },
    onError: (err: Error) => toastError(err),
  });

  function handleClose() {
    onClose();
    // Reset state so reopening starts fresh.
    setRepo(null);
    setName('');
    setDomain('');
    setSearch('');
  }

  const filteredRepos = search
    ? repos.filter((r) =>
        r.fullName.toLowerCase().includes(search.toLowerCase()),
      )
    : repos;

  const canDeploy = !!repo && !!projectId && !!name;
  const frameworkBadge = detection?.framework && detection.framework !== 'STATIC'
    ? detection.framework
    : null;

  return (
    <Dialog open={open} onClose={handleClose} className="max-w-2xl max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Rocket size={18} /> {t('quickDeploy.title') || 'Deploy a site'}
        </DialogTitle>
        <DialogDescription>
          {t('quickDeploy.desc') ||
            'Pick a Git repo and a domain. We detect the framework, build the right image, and wire up SSL.'}
        </DialogDescription>
      </DialogHeader>

      {providers.length === 0 ? (
        <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-4 flex items-start gap-3">
          <AlertCircle className="text-orange-500 shrink-0 mt-0.5" size={16} />
          <div className="flex-1 text-sm">
            <p className="font-medium">
              {t('quickDeploy.noProvider') || 'Connect a Git provider first.'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {t('quickDeploy.noProviderDesc') ||
                'Head to Settings → Git providers, connect GitHub, then come back.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-5 py-2">
          {/* ── Step 1: Provider + Repo ─────────────────────────── */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2 text-sm">
              <Github size={14} /> {t('quickDeploy.repository') || 'Repository'}
            </Label>
            {providers.length > 1 && (
              <Select
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value);
                  setRepo(null);
                }}
              >
                <option value="">{t('quickDeploy.pickProvider') || 'Pick a Git provider'}</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.provider} {p.username ? `(${p.username})` : ''}
                  </option>
                ))}
              </Select>
            )}
            {providerId && (
              <>
                <Input
                  placeholder={t('quickDeploy.searchRepo') || 'Search your repos…'}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
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
                    filteredRepos.slice(0, 30).map((r) => (
                      <button
                        key={r.fullName}
                        type="button"
                        onClick={() => setRepo(r)}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-accent/40 border-b border-border last:border-b-0 ${
                          repo?.fullName === r.fullName ? 'bg-accent/60' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <GitBranch size={12} className="text-muted-foreground" />
                          <span className="font-mono">{r.fullName}</span>
                          {r.private && (
                            <Badge variant="outline" className="text-[9px]">
                              private
                            </Badge>
                          )}
                        </div>
                        {r.description && (
                          <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                            {r.description}
                          </p>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          {/* ── Detection summary (when a repo is picked) ───────── */}
          {repo && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs flex items-center gap-2 flex-wrap">
              <Sparkles size={14} className="text-primary" />
              {detection ? (
                <>
                  <span>{t('quickDeploy.detected') || 'Detected'}:</span>
                  {frameworkBadge ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {frameworkBadge}
                    </Badge>
                  ) : detection.hasCompose ? (
                    <Badge variant="secondary" className="text-[10px]">docker-compose</Badge>
                  ) : detection.hasDockerfile ? (
                    <Badge variant="secondary" className="text-[10px]">Dockerfile</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">static</Badge>
                  )}
                  <span className="text-muted-foreground">
                    {t('quickDeploy.detectedDesc') ||
                      "— we'll build the right image automatically."}
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">
                  {t('quickDeploy.detecting') || 'Detecting framework…'}
                </span>
              )}
            </div>
          )}

          {/* ── Step 2: Project ─────────────────────────────────── */}
          {repo && (
            <div className="space-y-2">
              <Label className="text-sm">{t('quickDeploy.project') || 'Project'}</Label>
              {projects.length === 0 ? (
                <p className="text-xs text-orange-500 flex items-center gap-1">
                  <AlertCircle size={12} />{' '}
                  {t('quickDeploy.noProjects') ||
                    'Create a project first (Projects → New project).'}
                </p>
              ) : (
                <Select
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                >
                  <option value="">{t('quickDeploy.pickProject') || 'Pick a project'}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}

          {/* ── Step 3: Name (auto-prefilled) ───────────────────── */}
          {repo && projectId && (
            <div className="space-y-2">
              <Label htmlFor="qd-name" className="text-sm">
                {t('quickDeploy.appName') || 'App name'}
              </Label>
              <Input
                id="qd-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                placeholder="my-react-site"
              />
            </div>
          )}

          {/* ── Step 4: Domain (optional but encouraged) ────────── */}
          {repo && projectId && (
            <div className="space-y-2">
              <Label htmlFor="qd-domain" className="flex items-center gap-2 text-sm">
                <Globe size={14} /> {t('quickDeploy.domain') || 'Domain'}
              </Label>
              <Input
                id="qd-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value.toLowerCase().trim())}
                placeholder="app.acme.com"
              />
              <p className="text-[11px] text-muted-foreground">
                {t('quickDeploy.domainHint') ||
                  'Point this domain\'s A record at your server IP. Caddy auto-issues a Let\'s Encrypt cert on first hit. Leave blank to skip and add later.'}
              </p>
            </div>
          )}
        </div>
      )}

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
