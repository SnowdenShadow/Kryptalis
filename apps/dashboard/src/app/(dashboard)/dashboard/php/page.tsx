'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  FileCode2,
  Trash2,
  Loader2,
  ExternalLink,
  Globe,
  KeyRound,
  Info,
  Database as DatabaseIcon,
  FolderOpen,
  Unlink,
  Settings2,
} from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/toast-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import type { ApplicationResponse, DatabaseResponse } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { publicAppUrl } from '@/lib/app-format';
import { StatusDot } from '@/components/ui/status-dot';
import { cn } from '@/lib/utils';

// PHP versions offered — mirrors SUPPORTED_PHP_VERSIONS on the API
// (apps/api/.../applications/php-site.constants.ts). Newest first.
const PHP_VERSIONS = ['8.3', '8.2', '8.1', '8.0', '7.4'] as const;

// Optional extensions (mirror PHP_OPTIONAL_EXTENSIONS on the API). The base
// pack (DB drivers, gd, intl, zip, opcache, bcmath) is always included.
const PHP_EXTENSIONS = [
  'mbstring', 'exif', 'soap', 'xsl', 'gmp', 'pcntl', 'sockets', 'redis', 'imagick',
] as const;
const PHP_PRESETS = ['none', 'wordpress', 'laravel', 'symfony'] as const;
// Preset → extensions + php.ini (mirrors PHP_PRESETS on the API). Selecting a
// preset pre-fills the toggles/inputs once; after that the toggles are
// authoritative (manually changing one switches the preset back to "custom").
const PRESET_DEFS: Record<string, { extensions: string[]; ini: Record<string, string> }> = {
  wordpress: { extensions: ['mbstring', 'exif', 'imagick'], ini: { upload_max_filesize: '64M', post_max_size: '64M', memory_limit: '256M' } },
  laravel: { extensions: ['mbstring', 'pcntl', 'redis'], ini: { memory_limit: '256M', max_execution_time: '120' } },
  symfony: { extensions: ['mbstring', 'xsl'], ini: { memory_limit: '256M' } },
};
const PHP_INI_FIELDS: { key: string; placeholder: string }[] = [
  { key: 'memory_limit', placeholder: '256M' },
  { key: 'upload_max_filesize', placeholder: '64M' },
  { key: 'post_max_size', placeholder: '64M' },
  { key: 'max_execution_time', placeholder: '120' },
  { key: 'timezone', placeholder: 'Europe/Paris' },
];

interface PhpConfig {
  webServer: 'apache' | 'nginx';
  preset: string;
  extensions: string[];
  ini: Record<string, string>;
}
function emptyPhpConfig(): PhpConfig {
  return { webServer: 'apache', preset: 'none', extensions: [], ini: {} };
}
function phpConfigFromApp(a: ApplicationResponse): PhpConfig {
  return {
    webServer: a?.phpWebServer === 'nginx' ? 'nginx' : 'apache',
    preset: a?.phpPreset || 'none',
    extensions: (a?.phpExtensions || '').split(',').filter(Boolean),
    ini: (a?.phpIni && typeof a.phpIni === 'object') ? a.phpIni : {},
  };
}
/**
 * Body fields for create/PATCH from a PhpConfig. The extension list + ini shown
 * in the dialog are ALWAYS authoritative (the preset was already expanded into
 * them in the UI). We send phpPreset only as an indicative label and never rely
 * on the backend re-expanding it — otherwise un-toggling a preset-provided
 * extension would silently come back. So extensions/ini reflect exactly the
 * toggles the user sees.
 */
function phpConfigBody(c: PhpConfig): Record<string, unknown> {
  return {
    phpWebServer: c.webServer,
    phpExtensions: c.extensions,
    phpIni: Object.fromEntries(Object.entries(c.ini).filter(([, v]) => v && v.trim())),
    // null unless the toggles still EXACTLY match the preset (purely a label).
    phpPreset: c.preset === 'none' ? null : c.preset,
  };
}

interface ProjectOpt { id: string; name: string }
interface DomainOpt { id: string; domain: string; projectId: string; applicationId: string | null }

export default function PhpSitesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [version, setVersion] = useState<string>('8.3');
  const [projectId, setProjectId] = useState('');
  const [domainChoice, setDomainChoice] = useState(''); // '', 'new', or an existing domain id
  const [newDomain, setNewDomain] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  // The PHP site whose database panel is open (null = closed).
  const [manageDbSite, setManageDbSite] = useState<ApplicationResponse | null>(null);
  // Advanced PHP config in the create dialog.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [cfg, setCfg] = useState<PhpConfig>(emptyPhpConfig());
  // The PHP site whose "Configure" dialog is open (null = closed).
  const [configureSite, setConfigureSite] = useState<ApplicationResponse | null>(null);

  // The app list is shared; we just filter to PHP_SITE apps client-side.
  const { data: apps = [], isLoading } = useQuery<ApplicationResponse[]>({
    queryKey: ['applications'],
    queryFn: () => api.get('/applications'),
  });
  const phpSites = apps.filter((a) => a.framework === 'PHP_SITE');

  const { data: projects = [] } = useQuery<ProjectOpt[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });
  const { data: domains = [] } = useQuery<DomainOpt[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
  });
  // Reusable domains: in the chosen project, not yet attached to an app.
  const reusableDomains = domains.filter(
    (d) => d.projectId === projectId && !d.applicationId,
  );

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/applications', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success(t('php.created'));
      closeCreate();
    },
    onError: (err: Error) => toastError(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/applications/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success(t('php.deleted'));
      setDeleteId(null);
    },
    onError: (err: Error) => toastError(err),
  });

  // Change a site's PHP version → PATCH triggers an image rebuild + redeploy.
  const versionMutation = useMutation({
    mutationFn: ({ id, phpVersion }: { id: string; phpVersion: string }) =>
      api.patch(`/applications/${id}`, { phpVersion }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success(t('php.versionChanged'));
    },
    onError: (err: Error) => toastError(err),
  });

  // Configure an existing site (web server / extensions / php.ini) → PATCH +
  // redeploy.
  const configureMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api.patch(`/applications/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success(t('php.configSaved'));
      setConfigureSite(null);
    },
    onError: (err: Error) => toastError(err),
  });

  // Open the create dialog from a CLEAN slate. The `cfg` state is shared with
  // the per-site Configure dialog, so without an explicit reset a brand-new site
  // could inherit the last-Configured site's web server / extensions / php.ini
  // (those values are sent even if the Advanced panel stays collapsed).
  function openCreate() {
    setName('');
    setVersion('8.3');
    setProjectId('');
    setDomainChoice('');
    setNewDomain('');
    setShowAdvanced(false);
    setCfg(emptyPhpConfig());
    setShowCreate(true);
  }

  function closeCreate() {
    setShowCreate(false);
    setName('');
    setVersion('8.3');
    setProjectId('');
    setDomainChoice('');
    setNewDomain('');
    setShowAdvanced(false);
    setCfg(emptyPhpConfig());
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !projectId) return;
    const body: Record<string, unknown> = {
      name: name.trim(),
      projectId,
      framework: 'PHP_SITE',
      phpVersion: version,
      ...phpConfigBody(cfg),
    };
    if (domainChoice === 'new' && newDomain.trim()) body.domain = newDomain.trim();
    else if (domainChoice && domainChoice !== 'new') body.domainId = domainChoice;
    createMutation.mutate(body);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FileCode2 className="text-primary" size={24} />
            {t('php.title')}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{t('php.subtitle')}</p>
        </div>
        <Button onClick={openCreate}>
          <Plus size={16} className="mr-1.5" />
          {t('php.create')}
        </Button>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="animate-spin text-muted-foreground" />
        </div>
      ) : phpSites.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <FileCode2 className="text-muted-foreground/50 mb-3" size={40} />
            <p className="font-medium">{t('php.empty')}</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">{t('php.emptyHint')}</p>
            <Button className="mt-4" onClick={openCreate}>
              <Plus size={16} className="mr-1.5" />
              {t('php.create')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {phpSites.map((site) => {
            const url = publicAppUrl(site);
            return (
              <Card key={site.id} className="group">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusDot status={site.status} />
                        <span className="font-medium truncate">{site.name}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5">
                        {/* Inline PHP-version switcher — changing it rebuilds the image. */}
                        <div className="inline-flex items-center gap-1 rounded bg-indigo-500/20 text-indigo-400 pl-2 pr-1 py-0.5 text-xs">
                          <span>PHP</span>
                          <select
                            value={site.phpVersion || '8.3'}
                            onChange={(e) => versionMutation.mutate({ id: site.id, phpVersion: e.target.value })}
                            disabled={versionMutation.isPending}
                            className="bg-transparent outline-none cursor-pointer font-medium [&>option]:bg-zinc-900 [&>option]:text-foreground"
                            title={t('php.changeVersion')}
                          >
                            {PHP_VERSIONS.map((v) => (
                              <option key={v} value={v}>{v}</option>
                            ))}
                          </select>
                        </div>
                        {site.project?.name && (
                          <span className="text-xs text-muted-foreground truncate">
                            {site.project.name}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setDeleteId(site.id)}
                      className="text-muted-foreground hover:text-red-400 transition-colors"
                      title={t('common.delete')}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>

                  {site.domains && site.domains.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-3 text-xs text-muted-foreground">
                      <Globe size={12} />
                      <span className="truncate">{site.domains[0].domain}</span>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-3 mt-3 text-xs">
                    {url && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        <ExternalLink size={12} />
                        {t('php.openSite')}
                      </a>
                    )}
                    <button
                      onClick={() => setManageDbSite(site)}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      <DatabaseIcon size={12} />
                      {t('php.databases')}
                    </button>
                    <Link
                      href="/dashboard/sftp"
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      <FolderOpen size={12} />
                      {t('php.manageFiles')}
                    </Link>
                    <button
                      type="button"
                      onClick={() => { setCfg(phpConfigFromApp(site)); setConfigureSite(site); }}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      <Settings2 size={12} />
                      {t('php.configure')}
                    </button>
                    {/* The generic app-detail page gives PHP sites logs,
                        deployments history, terminal and start/stop/restart. */}
                    <Link
                      href={`/dashboard/applications/${site.id}`}
                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                    >
                      <Settings2 size={12} />
                      {t('php.details')}
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* SFTP hint */}
      {phpSites.length > 0 && (
        <div className="flex items-start gap-2 text-xs text-muted-foreground border border-zinc-800 rounded-lg p-3">
          <KeyRound size={14} className="mt-0.5 shrink-0" />
          <span>{t('php.uploadHint')}</span>
        </div>
      )}

      {/* Create dialog */}
      {showCreate && (
        <Dialog open={showCreate} onClose={closeCreate}>
          <form onSubmit={handleCreate}>
            <DialogHeader>
              <DialogTitle>{t('php.create')}</DialogTitle>
              <DialogDescription>{t('php.subtitle')}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              <div>
                <Label htmlFor="php-name">{t('php.name')}</Label>
                <Input
                  id="php-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="my-php-site"
                  autoFocus
                />
              </div>

              <div>
                <Label htmlFor="php-version">{t('php.version')}</Label>
                <Select id="php-version" value={version} onChange={(e) => setVersion(e.target.value)}>
                  {PHP_VERSIONS.map((v) => (
                    <option key={v} value={v}>PHP {v}</option>
                  ))}
                </Select>
              </div>

              <div>
                <Label htmlFor="php-project">{t('php.project')}</Label>
                <Select
                  id="php-project"
                  value={projectId}
                  onChange={(e) => { setProjectId(e.target.value); setDomainChoice(''); }}
                >
                  <option value="">—</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </div>

              <div>
                <Label htmlFor="php-domain">{t('php.domain')}</Label>
                <Select
                  id="php-domain"
                  value={domainChoice}
                  onChange={(e) => setDomainChoice(e.target.value)}
                  disabled={!projectId}
                >
                  <option value="">{t('php.domainNone')}</option>
                  <option value="new">+ {t('php.domain')}…</option>
                  {reusableDomains.map((d) => (
                    <option key={d.id} value={d.id}>{d.domain}</option>
                  ))}
                </Select>
                {domainChoice === 'new' && (
                  <Input
                    className="mt-2"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    placeholder="site.example.com"
                  />
                )}
                <p className="flex items-center gap-1 text-xs text-muted-foreground mt-1.5">
                  <Info size={12} />
                  {t('php.domainHint')}
                </p>
              </div>

              {/* Advanced: web server / extensions / php.ini */}
              <button type="button" className="text-xs text-primary hover:underline"
                onClick={() => setShowAdvanced((v) => !v)}>
                {showAdvanced ? '▾ ' : '▸ '}{t('php.advanced')}
              </button>
              {showAdvanced && <PhpConfigFields t={t} cfg={cfg} onChange={setCfg} />}
            </div>

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={closeCreate}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={!name.trim() || !projectId || createMutation.isPending}>
                {createMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                {t('common.create')}
              </Button>
            </DialogFooter>
          </form>
        </Dialog>
      )}

      {/* Configure an existing site (server / extensions / php.ini) */}
      {configureSite && (
        <Dialog open onClose={() => setConfigureSite(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Settings2 size={18} /> {t('php.configure')} — {configureSite.name}</DialogTitle>
            <DialogDescription>{t('php.configureDesc')}</DialogDescription>
          </DialogHeader>
          <div className="py-1"><PhpConfigFields t={t} cfg={cfg} onChange={setCfg} /></div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfigureSite(null)}>{t('common.cancel')}</Button>
            <Button
              onClick={() => configureMutation.mutate({ id: configureSite.id, body: phpConfigBody(cfg) })}
              disabled={configureMutation.isPending}
            >
              {configureMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {t('php.saveRedeploy')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {/* Delete confirm */}
      {deleteId && (
        <Dialog open={!!deleteId} onClose={() => setDeleteId(null)}>
          <DialogHeader>
            <DialogTitle>{t('common.delete')}</DialogTitle>
            <DialogDescription>{t('php.deleteConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </Dialog>
      )}

      {/* Per-site database manager */}
      {manageDbSite && (
        <PhpDatabaseDialog site={manageDbSite} onClose={() => setManageDbSite(null)} />
      )}
    </div>
  );
}

// ─── Database manager for a PHP site ──────────────────────────────────
//
// Lists the managed databases attached to the site (with the DB_* env vars
// that were injected into the container), lets the user attach an existing
// project database, or create+attach a new one in one shot.
function PhpDatabaseDialog({ site, onClose }: { site: ApplicationResponse; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [attachId, setAttachId] = useState('');
  const [newDbName, setNewDbName] = useState('');
  const [newDbType, setNewDbType] = useState('MYSQL');

  // DBs already attached to this site.
  const { data: attached = [], isLoading } = useQuery<DatabaseResponse[]>({
    queryKey: ['app-databases', site.id],
    queryFn: () => api.get(`/applications/${site.id}/databases`),
  });
  // Candidate DBs in the same project, not auto-imported, not already on this app.
  const { data: projectDbs = [] } = useQuery<DatabaseResponse[]>({
    queryKey: ['databases', 'project', site.projectId],
    queryFn: () => api.get(`/databases?projectId=${site.projectId}`),
  });
  const candidates = projectDbs.filter(
    (d) => !d.autoImported && d.applicationId !== site.id,
  );

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['app-databases', site.id] });
    queryClient.invalidateQueries({ queryKey: ['databases'] });
    queryClient.invalidateQueries({ queryKey: ['applications'] });
  };

  const attachMutation = useMutation({
    mutationFn: (databaseId: string) => api.post(`/applications/${site.id}/databases/${databaseId}`, {}),
    onSuccess: () => { invalidate(); setAttachId(''); toast.success(t('php.dbAttached')); },
    onError: (err: Error) => toastError(err),
  });
  const detachMutation = useMutation({
    mutationFn: (databaseId: string) => api.delete(`/applications/${site.id}/databases/${databaseId}`),
    onSuccess: () => { invalidate(); toast.success(t('php.dbDetached')); },
    onError: (err: Error) => toastError(err),
  });
  // Create a DB pre-attached to this site, then inject its creds (attach).
  const createMutation = useMutation({
    mutationFn: async () => {
      const created: any = await api.post('/databases', {
        name: newDbName.trim(),
        type: newDbType,
        projectId: site.projectId,
        applicationId: site.id,
      });
      // Inject its connection env into the site + redeploy.
      if (created?.id) await api.post(`/applications/${site.id}/databases/${created.id}`, {});
      return created;
    },
    onSuccess: () => { invalidate(); setNewDbName(''); toast.success(t('php.dbCreated')); },
    onError: (err: Error) => toastError(err),
  });

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <DatabaseIcon size={18} />
          {t('php.databases')} — {site.name}
        </DialogTitle>
        <DialogDescription>{t('php.dbHint')}</DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        {/* Attached list */}
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="animate-spin text-muted-foreground" size={18} /></div>
        ) : attached.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('php.dbNone')}</p>
        ) : (
          <div className="space-y-2">
            {attached.map((db) => (
              <div key={db.id} className="rounded-lg border border-zinc-800 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Badge className="bg-teal-500/20 text-teal-400 border-transparent">{db.type}</Badge>
                    <span className="font-medium truncate">{db.name}</span>
                  </div>
                  <button
                    onClick={() => detachMutation.mutate(db.id)}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-red-400"
                    disabled={detachMutation.isPending}
                  >
                    <Unlink size={12} />
                    {t('php.dbDetach')}
                  </button>
                </div>
                {/* Injected env var names (values stay server-side / in the container) */}
                <div className="mt-2 flex flex-wrap gap-1">
                  {['DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'DATABASE_URL'].map((k) => (
                    <code key={k} className="px-1.5 py-0.5 rounded bg-zinc-900 text-[11px] text-foreground/70">{k}</code>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-muted-foreground">{t('php.dbEnvHint')}</p>
              </div>
            ))}
          </div>
        )}

        {/* Attach existing */}
        <div className="border-t border-zinc-800 pt-3">
          <Label>{t('php.dbAttachExisting')}</Label>
          <div className="flex gap-2 mt-1">
            <Select value={attachId} onChange={(e) => setAttachId(e.target.value)}>
              <option value="">—</option>
              {candidates.map((d) => (
                <option key={d.id} value={d.id}>{d.name} ({d.type})</option>
              ))}
            </Select>
            <Button
              type="button"
              onClick={() => attachId && attachMutation.mutate(attachId)}
              disabled={!attachId || attachMutation.isPending}
            >
              {attachMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : t('php.dbAttach')}
            </Button>
          </div>
        </div>

        {/* Create + attach */}
        <div className="border-t border-zinc-800 pt-3">
          <Label>{t('php.dbCreateNew')}</Label>
          <div className="flex gap-2 mt-1">
            <Input
              value={newDbName}
              onChange={(e) => setNewDbName(e.target.value)}
              placeholder="my-db"
            />
            <Select value={newDbType} onChange={(e) => setNewDbType(e.target.value)} className="max-w-[10rem]">
              <option value="MYSQL">MySQL</option>
              <option value="MARIADB">MariaDB</option>
              <option value="POSTGRESQL">PostgreSQL</option>
            </Select>
            <Button
              type="button"
              onClick={() => newDbName.trim() && createMutation.mutate()}
              disabled={!newDbName.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : t('common.create')}
            </Button>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>{t('common.close')}</Button>
      </DialogFooter>
    </Dialog>
  );
}

// ─── Shared PHP advanced config (preset / web server / extensions / php.ini) ──
function PhpConfigFields({
  t,
  cfg,
  onChange,
}: {
  t: (k: string, v?: Record<string, string | number>) => string;
  cfg: PhpConfig;
  onChange: (c: PhpConfig) => void;
}) {
  const set = (patch: Partial<PhpConfig>) => onChange({ ...cfg, ...patch });
  // Picking a preset expands it into the visible toggles + ini ONCE. From then
  // on the toggles are authoritative; touching any of them flips preset→'none'
  // ('custom') so the user can freely remove a preset-provided extension.
  const pickPreset = (preset: string) => {
    const def = PRESET_DEFS[preset];
    if (!def) { set({ preset: 'none' }); return; }
    set({
      preset,
      extensions: [...new Set([...cfg.extensions, ...def.extensions])],
      ini: { ...def.ini, ...cfg.ini },
    });
  };
  const toggleExt = (ext: string) =>
    set({
      preset: 'none',
      extensions: cfg.extensions.includes(ext) ? cfg.extensions.filter((e) => e !== ext) : [...cfg.extensions, ext],
    });
  const setIni = (key: string, value: string) => set({ preset: 'none', ini: { ...cfg.ini, [key]: value } });

  return (
    <div className="space-y-4 rounded-lg border border-border p-3 mt-2">
      {/* Preset + web server */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>{t('php.preset')}</Label>
          <Select value={cfg.preset} onChange={(e) => pickPreset(e.target.value)}>
            {PHP_PRESETS.map((p) => (
              <option key={p} value={p}>{t(`php.preset.${p}`)}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>{t('php.webServer')}</Label>
          <Select value={cfg.webServer} onChange={(e) => set({ webServer: e.target.value as 'apache' | 'nginx' })}>
            <option value="apache">{t('php.apache')}</option>
            <option value="nginx">{t('php.nginx')}</option>
          </Select>
          {cfg.webServer === 'nginx' && <p className="text-[11px] text-orange-400">{t('php.nginxHint')}</p>}
        </div>
      </div>

      {/* Extensions */}
      <div className="space-y-1.5">
        <Label>{t('php.extensions')}</Label>
        <p className="text-[11px] text-muted-foreground">{t('php.extensionsBase')}</p>
        <div className="flex flex-wrap gap-2">
          {PHP_EXTENSIONS.map((ext) => (
            <button
              key={ext}
              type="button"
              onClick={() => toggleExt(ext)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs font-mono transition-colors',
                cfg.extensions.includes(ext) ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-accent/40',
              )}
            >
              {cfg.extensions.includes(ext) ? '✓ ' : ''}{ext}
            </button>
          ))}
        </div>
      </div>

      {/* php.ini */}
      <div className="space-y-1.5">
        <Label>{t('php.iniTitle')}</Label>
        <div className="grid sm:grid-cols-2 gap-2">
          {PHP_INI_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <span className="text-[11px] text-muted-foreground font-mono">{f.key}</span>
              <Input
                value={cfg.ini[f.key] || ''}
                placeholder={f.placeholder}
                onChange={(e) => setIni(f.key, e.target.value)}
                className="font-mono h-9"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
