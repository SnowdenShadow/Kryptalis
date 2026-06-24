'use client';

import { useState } from 'react';
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
import type { ApplicationResponse } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { publicAppUrl } from '@/lib/app-format';
import { StatusDot } from '@/components/ui/status-dot';

// PHP versions offered — mirrors SUPPORTED_PHP_VERSIONS on the API
// (apps/api/.../applications/php-site.constants.ts). Newest first.
const PHP_VERSIONS = ['8.3', '8.2', '8.1', '8.0', '7.4'] as const;

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

  function closeCreate() {
    setShowCreate(false);
    setName('');
    setVersion('8.3');
    setProjectId('');
    setDomainChoice('');
    setNewDomain('');
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !projectId) return;
    const body: Record<string, unknown> = {
      name: name.trim(),
      projectId,
      framework: 'PHP_SITE',
      phpVersion: version,
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
        <Button onClick={() => setShowCreate(true)}>
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
            <Button className="mt-4" onClick={() => setShowCreate(true)}>
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
                        <Badge className="bg-indigo-500/20 text-indigo-400 border-transparent">
                          PHP {site.phpVersion || '8.3'}
                        </Badge>
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

                  <div className="flex items-center gap-2 mt-3">
                    {url && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <ExternalLink size={12} />
                        {t('php.openSite')}
                      </a>
                    )}
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
    </div>
  );
}
