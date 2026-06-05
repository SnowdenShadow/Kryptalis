'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Globe, Plus, Trash2, ShieldCheck, ShieldX, Lock, Loader2, Info,
  ExternalLink, Copy, Check, Search, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Domain {
  id: string; domain: string; applicationId: string | null; projectId: string | null;
  status: string; sslStatus: string; sslExpiresAt: string | null; createdAt: string;
  project?: { id: string; name: string } | null;
  application?: { id: string; name: string; project?: { id: string; name: string } } | null;
}

function timeAgo(d: string) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function daysUntil(d: string) {
  const diff = new Date(d).getTime() - Date.now();
  return Math.floor(diff / 86400000);
}

export default function DomainsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null);
  const [copiedId, setCopiedId] = useState('');
  const [filterProjectId, setFilterProjectId] = useState('');

  const [domainName, setDomainName] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [createProjectId, setCreateProjectId] = useState('');
  const [autoSsl, setAutoSsl] = useState(true);

  const { data: domains = [], isLoading } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
  });

  // Reverse proxy status (admin-only endpoint — silently null if forbidden)
  type ProxyStatus = { running: boolean; status: string };
  const { data: proxyStatus, refetch: refetchProxy } = useQuery<ProxyStatus | null>({
    queryKey: ['reverse-proxy-status'],
    queryFn: async () => {
      try {
        return await api.get<ProxyStatus>('/reverse-proxy/status');
      } catch {
        return null;
      }
    },
    refetchInterval: 15_000,
  });
  const proxySyncMutation = useMutation({
    mutationFn: () => api.post('/reverse-proxy/sync'),
    onSuccess: () => {
      toast.success('Reverse proxy reloaded');
      refetchProxy();
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const proxyStartMutation = useMutation({
    mutationFn: () => api.post('/reverse-proxy/start'),
    onSuccess: () => { toast.success('Reverse proxy starting...'); refetchProxy(); },
    onError: (err: Error) => toast.error(err.message),
  });

  const { data: projects = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });

  const { data: allApps = [] } = useQuery<{ id: string; name: string; projectId: string }[]>({
    queryKey: ['applications'],
    queryFn: () => api.get('/applications'),
  });

  const appsForCreate = createProjectId
    ? allApps.filter((a) => a.projectId === createProjectId)
    : [];

  const { data: server } = useQuery<any>({
    queryKey: ['server-local'],
    queryFn: () => api.get('/servers/local'),
  });

  // public IP/hostname users should point their DNS A records at — derived
  // server-side from PUBLIC_API_URL (set by install.sh). NEVER use server.host
  // because that's always 127.0.0.1 for the local server.
  const { data: publicSettings } = useQuery<{ public_ip?: string; deployment_mode?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
  });

  const filtered = domains.filter(d => {
    if (search.trim() && !d.domain.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterProjectId) {
      const pid = d.project?.id || d.application?.project?.id;
      return pid === filterProjectId;
    }
    return true;
  });

  const createMutation = useMutation({
    mutationFn: (data: { domain: string; projectId: string; applicationId?: string; autoSsl?: boolean }) => api.post('/domains', data),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Domain added');
      if (autoSsl && res?.id) {
        api.post('/ssl/issue', { domainId: res.id }).then(() => {
          toast.success('SSL certificate requested');
          queryClient.invalidateQueries({ queryKey: ['domains'] });
        }).catch(() => toast.error('SSL request failed'));
      }
      closeAdd();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const renewMutation = useMutation({
    mutationFn: (domainId: string) => api.post('/ssl/issue', { domainId }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['domains'] }); toast.success('SSL renewal requested'); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/domains/${id}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['domains'] }); toast.success('Domain deleted'); setDeleteTarget(null); },
    onError: (err: Error) => toast.error(err.message),
  });

  function closeAdd() { setShowAdd(false); setDomainName(''); setApplicationId(''); setCreateProjectId(''); setAutoSsl(true); }
  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!domainName.trim() || !createProjectId) return;
    createMutation.mutate({
      domain: domainName.trim(),
      projectId: createProjectId,
      ...(applicationId ? { applicationId } : {}),
      autoSsl,
    });
  }
  function copyDns(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(''), 2000);
  }

  // Prefer the public IP exposed by the API (derived from PUBLIC_API_URL set at
  // install time). Fallback to server.host only if it's actually a public address
  // — never show 127.0.0.1 to a user who needs to point their DNS at it.
  const localFallback = server?.host && server.host !== '127.0.0.1' && server.host !== 'localhost'
    ? server.host
    : null;
  const serverIp = publicSettings?.public_ip || localFallback || 'YOUR-SERVER-IP';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">{t('domains.title')}</h1>
          {domains.length > 0 && <Badge variant="secondary" className="text-sm">{domains.length}</Badge>}
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus size={16} /> {t('domains.add')}
        </Button>
      </div>

      {/* Reverse proxy status banner (admin-only) */}
      {proxyStatus && (
        <div className={cn(
          'flex items-center gap-3 rounded-lg border p-3',
          proxyStatus.running ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-orange-500/30 bg-orange-500/5',
        )}>
          <span className={cn(
            'h-2.5 w-2.5 rounded-full shrink-0',
            proxyStatus.running ? 'bg-emerald-500 animate-pulse' : 'bg-orange-500',
          )} />
          <div className="flex-1">
            <p className="text-sm font-medium">
              Reverse proxy {proxyStatus.running ? 'running' : 'stopped'}
            </p>
            <p className="text-xs text-muted-foreground">
              {proxyStatus.running
                ? 'Caddy is routing traffic from :80/:443 to your linked apps.'
                : 'Apps with linked domains are only reachable via their host port directly.'}
            </p>
          </div>
          {proxyStatus.running ? (
            <Button size="sm" variant="outline" disabled={proxySyncMutation.isPending}
              onClick={() => proxySyncMutation.mutate()}>
              <RefreshCw size={12} /> {proxySyncMutation.isPending ? 'Reloading...' : 'Resync'}
            </Button>
          ) : (
            <Button size="sm" disabled={proxyStartMutation.isPending}
              onClick={() => proxyStartMutation.mutate()}>
              {proxyStartMutation.isPending ? 'Starting...' : 'Start'}
            </Button>
          )}
        </div>
      )}

      {/* Search + project filter */}
      {domains.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search domains..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {projects.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant={filterProjectId === '' ? 'default' : 'outline'} onClick={() => setFilterProjectId('')}>
                All
              </Button>
              {projects.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={filterProjectId === p.id ? 'default' : 'outline'}
                  onClick={() => setFilterProjectId(filterProjectId === p.id ? '' : p.id)}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Loading */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[1, 2, 3].map(i => <Card key={i} className="animate-pulse"><CardContent className="h-40" /></Card>)}
        </div>
      ) : filtered.length === 0 && !search ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Globe size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('domains.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('domains.emptyDesc')}</p>
            <Button className="mt-4" onClick={() => setShowAdd(true)}><Plus size={16} /> {t('domains.add')}</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {filtered.map(domain => {
            const sslOk = domain.sslStatus === 'ACTIVE';
            const sslPending = domain.sslStatus === 'PENDING';
            const sslBad = domain.sslStatus === 'EXPIRED' || domain.sslStatus === 'ERROR';
            const sslColor = sslOk ? 'bg-emerald-500' : sslPending ? 'bg-orange-500' : sslBad ? 'bg-red-500' : 'bg-zinc-600';
            const expiryDays = domain.sslExpiresAt ? daysUntil(domain.sslExpiresAt) : null;

            return (
              <Card key={domain.id} className="hover:border-primary/50 transition-colors overflow-hidden">
                <CardContent className="p-0">
                  <div className={`h-1 w-full ${sslColor}`} />
                  <div className="p-5 space-y-4">
                    {/* Domain name + status */}
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-mono text-lg font-bold">{domain.domain}</h3>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant={domain.status === 'ACTIVE' ? 'success' : domain.status === 'PENDING' ? 'warning' : 'destructive'}>
                            {domain.status}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{timeAgo(domain.createdAt)}</span>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          title="Add subdomain"
                          onClick={() => {
                            setDomainName(`.${domain.domain}`);
                            setCreateProjectId(domain.project?.id || domain.application?.project?.id || '');
                            setShowAdd(true);
                            // place cursor at start so they just type the prefix
                            setTimeout(() => {
                              const el = document.querySelector<HTMLInputElement>('input[placeholder="app.example.com"]');
                              el?.focus();
                              el?.setSelectionRange(0, 0);
                            }, 100);
                          }}
                        >
                          <Plus size={14} />
                        </Button>
                        <Button size="sm" variant="destructive" onClick={() => setDeleteTarget(domain)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>

                    {/* Info grid */}
                    <div className="grid grid-cols-2 gap-3">
                      {/* SSL */}
                      <div className="rounded-lg border border-border p-3">
                        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">SSL Certificate</p>
                        <div className="flex items-center gap-1.5">
                          {sslOk && <ShieldCheck size={16} className="text-emerald-500" />}
                          {sslPending && <Lock size={16} className="text-orange-500" />}
                          {sslBad && <ShieldX size={16} className="text-red-500" />}
                          <span className={cn('font-semibold text-sm', sslOk ? 'text-emerald-500' : sslPending ? 'text-orange-500' : sslBad ? 'text-red-500' : '')}>
                            {sslOk ? 'Active' : sslPending ? 'Pending' : domain.sslStatus === 'EXPIRED' ? 'Expired' : 'Error'}
                          </span>
                        </div>
                        {expiryDays !== null && sslOk && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Expires in {expiryDays} days ({new Date(domain.sslExpiresAt!).toLocaleDateString()})
                          </p>
                        )}
                        {(sslBad || (sslOk && expiryDays !== null && expiryDays < 30)) && (
                          <Button size="sm" variant="outline" className="mt-2 h-7 text-xs" disabled={renewMutation.isPending}
                            onClick={() => renewMutation.mutate(domain.id)}>
                            <RefreshCw size={12} /> Renew
                          </Button>
                        )}
                      </div>

                      {/* Project + optional app */}
                      <div className="rounded-lg border border-border p-3 space-y-1">
                        {(domain.project || domain.application?.project) && (
                          <div>
                            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Project</p>
                            {(() => {
                              const proj = domain.project || domain.application?.project;
                              return proj ? (
                                <Link href={`/dashboard/projects/${proj.id}`} className="font-semibold text-sm text-primary hover:underline">
                                  {proj.name}
                                </Link>
                              ) : null;
                            })()}
                          </div>
                        )}
                        <div className="pt-1">
                          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Application</p>
                          {domain.application ? (
                            <Link href={`/dashboard/applications/${domain.application.id}`} className="font-medium text-sm hover:underline">
                              {domain.application.name}
                            </Link>
                          ) : (
                            <p className="text-xs text-muted-foreground italic">Not linked to a web app</p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* DNS Config */}
                    <div className="rounded-lg border border-border bg-muted/30 p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">DNS Configuration</p>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 text-sm">
                          <Badge variant="outline" className="font-mono text-[10px]">A</Badge>
                          <span className="font-mono">{domain.domain}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="font-mono font-semibold">{serverIp}</span>
                        </div>
                        <button
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => copyDns(`${domain.domain} A ${serverIp}`, domain.id)}
                        >
                          {copiedId === domain.id ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Point this A record to your server's IP in your DNS provider (Cloudflare, Namecheap, etc.)
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Add Dialog */}
      <Dialog open={showAdd} onClose={closeAdd}>
        <DialogHeader>
          <DialogTitle>{t('domains.add')}</DialogTitle>
          <DialogDescription>Add a domain and configure SSL</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label>Domain name</Label>
            <Input placeholder="app.example.com" value={domainName} onChange={e => setDomainName(e.target.value)} required className="font-mono" />
          </div>

          <div className="space-y-2">
            <Label>Project *</Label>
            <Select value={createProjectId} onChange={(e) => { setCreateProjectId(e.target.value); setApplicationId(''); }} required>
              <option value="">— Select a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>

          {createProjectId && appsForCreate.length > 0 && (
            <div className="space-y-2">
              <Label>Application (optional)</Label>
              <Select value={applicationId} onChange={(e) => setApplicationId(e.target.value)}>
                <option value="">— No app —</option>
                {appsForCreate.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Optional — link to a web app to route HTTP traffic to it. Leave empty if the domain is only used for other things (mail, etc.).
              </p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input id="auto-ssl" type="checkbox" checked={autoSsl} onChange={e => setAutoSsl(e.target.checked)} className="h-4 w-4 rounded border-input" />
            <Label htmlFor="auto-ssl">Auto SSL (Let's Encrypt)</Label>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">
              <strong>1.</strong> Add an A record pointing <strong>{domainName || 'your domain'}</strong> → <strong>{serverIp}</strong> in your DNS provider<br />
              <strong>2.</strong> SSL will be automatically provisioned once DNS propagates
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeAdd}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={createMutation.isPending || !createProjectId || !domainName.trim()}>
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>Delete Domain</DialogTitle>
          <DialogDescription>
            Delete <span className="font-mono font-semibold text-foreground">{deleteTarget?.domain}</span>? This will remove the domain and its SSL certificate.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={deleteMutation.isPending}
            onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}>
            {deleteMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
