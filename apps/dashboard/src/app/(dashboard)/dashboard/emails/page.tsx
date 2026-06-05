'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Mail, AtSign, Globe, Plus, Trash2, Loader2, Eye, EyeOff,
  Shield, ShieldCheck, Copy, Check, RefreshCw, AlertTriangle,
  FolderKanban, KeyRound, Inbox,
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
import { cn } from '@/lib/utils';

type Tab = 'mailboxes' | 'aliases' | 'dns';
type MailboxStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';

interface Project { id: string; name: string }
interface DomainOpt {
  id: string;
  domain: string;
  projectId?: string | null;
  project?: { id: string; name: string } | null;
  application?: { project?: { id: string; name: string } } | null;
}
interface Mailbox {
  id: string;
  address: string;
  localPart: string;
  domainId: string;
  projectId: string | null;
  quotaMb: number;
  usedMb: number;
  status: MailboxStatus;
  forwardTo: string | null;
  catchAll: boolean;
  createdAt: string;
  domain: { id: string; domain: string };
  project: { id: string; name: string } | null;
  _count?: { aliases: number };
}
interface Alias {
  id: string;
  address: string;
  domainId: string;
  targetMailboxId: string | null;
  forwardTo: string | null;
  createdAt: string;
  mailbox: { id: string; address: string } | null;
}
interface DnsHints {
  mx: { host: string; value: string; priority: number }[];
  spf: { host: string; type: string; value: string };
  dmarc: { host: string; type: string; value: string };
  dkim: { host: string; type: string; value: string; ready: boolean };
  autodiscover: { host: string; type: string; value: string };
  mailServer: {
    status: 'STOPPED' | 'DEPLOYING' | 'RUNNING' | 'ERROR';
    ports: { smtp: number; submission: number; smtps: number; imap: number; imaps: number };
    hostname: string | null;
    lastError: string | null;
    mailboxCount: number;
  } | null;
}

function fmtSize(mb: number) {
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export default function EmailsPage() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>('mailboxes');
  const [filterProjectId, setFilterProjectId] = useState('');
  const [selectedDomainId, setSelectedDomainId] = useState('');

  // create mailbox dialog
  const [showCreateMb, setShowCreateMb] = useState(false);
  const [newMb, setNewMb] = useState({
    localPart: '', domainId: '', projectId: '', password: '', quotaMb: 2048,
    forwardTo: '', catchAll: false,
  });
  const [showPw, setShowPw] = useState(false);

  // create alias dialog
  const [showCreateAlias, setShowCreateAlias] = useState(false);
  const [newAlias, setNewAlias] = useState({ localPart: '', domainId: '', targetMailboxId: '', forwardTo: '' });

  // delete state
  const [deleteMbId, setDeleteMbId] = useState<string | null>(null);
  const [deleteAliasId, setDeleteAliasId] = useState<string | null>(null);
  const [copied, setCopied] = useState('');

  // ── queries ──────────────────────────────────────────────────────
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });

  const { data: domains = [] } = useQuery<DomainOpt[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
  });

  // a domain is mail-eligible as soon as it has a project (with or without web app)
  const projectIdOf = (d: DomainOpt) => d.project?.id || d.application?.project?.id;
  const eligibleDomains = filterProjectId
    ? domains.filter(d => projectIdOf(d) === filterProjectId)
    : domains.filter(d => !!projectIdOf(d));

  const { data: mailboxes = [], isLoading: mbLoading } = useQuery<Mailbox[]>({
    queryKey: ['mailboxes', filterProjectId],
    queryFn: () => api.get(`/email/mailboxes${filterProjectId ? `?projectId=${filterProjectId}` : ''}`),
  });

  const { data: aliases = [] } = useQuery<Alias[]>({
    queryKey: ['email-aliases', selectedDomainId],
    queryFn: () => api.get(`/email/aliases?domainId=${selectedDomainId}`),
    enabled: !!selectedDomainId && activeTab === 'aliases',
  });

  const { data: dnsHints, refetch: refetchDns } = useQuery<DnsHints>({
    queryKey: ['email-dns', selectedDomainId],
    queryFn: () => api.get(`/email/dns/${selectedDomainId}`),
    enabled: !!selectedDomainId && activeTab === 'dns',
    refetchInterval: (q) => {
      const status = (q.state.data as DnsHints | undefined)?.mailServer?.status;
      return status === 'DEPLOYING' ? 3000 : false;
    },
  });

  const deployMailMutation = useMutation({
    mutationFn: () => api.post(`/email/server/${selectedDomainId}/deploy`),
    onSuccess: () => { toast.success('Mail server deploying...'); refetchDns(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const stopMailMutation = useMutation({
    mutationFn: () => api.post(`/email/server/${selectedDomainId}/stop`),
    onSuccess: () => { toast.success('Mail server stopped'); refetchDns(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeMailMutation = useMutation({
    mutationFn: () => api.delete(`/email/server/${selectedDomainId}`),
    onSuccess: () => { toast.success('Mail server removed'); refetchDns(); },
    onError: (e: Error) => toast.error(e.message),
  });

  // mailboxes of the selected domain (for alias target selector)
  const { data: domainMailboxes = [] } = useQuery<Mailbox[]>({
    queryKey: ['mailboxes-of-domain', newAlias.domainId],
    queryFn: () => api.get(`/email/mailboxes?domainId=${newAlias.domainId}`),
    enabled: !!newAlias.domainId,
  });

  // ── mutations ────────────────────────────────────────────────────
  const createMbMutation = useMutation({
    mutationFn: (body: any) => api.post('/email/mailboxes', body),
    onSuccess: () => {
      toast.success('Mailbox created');
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      closeCreateMb();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMbMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/email/mailboxes/${id}`),
    onSuccess: () => {
      toast.success('Mailbox deleted');
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
      setDeleteMbId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusMbMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: MailboxStatus }) =>
      api.patch(`/email/mailboxes/${id}`, { status }),
    onSuccess: () => {
      toast.success('Status updated');
      queryClient.invalidateQueries({ queryKey: ['mailboxes'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createAliasMutation = useMutation({
    mutationFn: (body: any) => api.post('/email/aliases', body),
    onSuccess: () => {
      toast.success('Alias created');
      queryClient.invalidateQueries({ queryKey: ['email-aliases'] });
      closeCreateAlias();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteAliasMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/email/aliases/${id}`),
    onSuccess: () => {
      toast.success('Alias deleted');
      queryClient.invalidateQueries({ queryKey: ['email-aliases'] });
      setDeleteAliasId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── helpers ───────────────────────────────────────────────────────
  function closeCreateMb() {
    setShowCreateMb(false);
    setNewMb({ localPart: '', domainId: '', projectId: '', password: '', quotaMb: 2048, forwardTo: '', catchAll: false });
    setShowPw(false);
  }
  function closeCreateAlias() {
    setShowCreateAlias(false);
    setNewAlias({ localPart: '', domainId: '', targetMailboxId: '', forwardTo: '' });
  }
  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(''), 1500);
  }
  function genPassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
    let out = '';
    for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
    setNewMb((s) => ({ ...s, password: out }));
    setShowPw(true);
  }

  const tabs: { key: Tab; label: string; icon: typeof Mail }[] = [
    { key: 'mailboxes', label: 'Mailboxes', icon: Mail },
    { key: 'aliases', label: 'Aliases', icon: AtSign },
    { key: 'dns', label: 'DNS Records', icon: Globe },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">Email Hosting</h1>
          <p className="text-muted-foreground">
            Manage mailboxes, aliases and DNS for your domains.
          </p>
        </div>
      </div>

      {/* Project filter */}
      {projects.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant={filterProjectId === '' ? 'default' : 'outline'} onClick={() => setFilterProjectId('')}>
            All projects
          </Button>
          {projects.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant={filterProjectId === p.id ? 'default' : 'outline'}
              onClick={() => setFilterProjectId(filterProjectId === p.id ? '' : p.id)}
            >
              <FolderKanban size={12} /> {p.name}
            </Button>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
                activeTab === tab.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={14} /> {tab.label}
            </button>
          );
        })}
      </div>

      {/* Domain selector for aliases/DNS */}
      {(activeTab === 'aliases' || activeTab === 'dns') && (
        <div className="flex items-center gap-3 flex-wrap">
          <Label className="text-xs">Domain:</Label>
          <Select value={selectedDomainId} onChange={(e) => setSelectedDomainId(e.target.value)} className="w-72">
            <option value="">— Select a domain —</option>
            {eligibleDomains.map((d) => {
              const projName = d.project?.name || d.application?.project?.name;
              return (
                <option key={d.id} value={d.id}>
                  {d.domain}{projName ? ` · ${projName}` : ''}
                </option>
              );
            })}
          </Select>
          {activeTab === 'aliases' && selectedDomainId && (
            <Button size="sm" onClick={() => {
              setNewAlias((s) => ({ ...s, domainId: selectedDomainId }));
              setShowCreateAlias(true);
            }}>
              <Plus size={14} /> Add Alias
            </Button>
          )}
        </div>
      )}

      {/* ─── Mailboxes ─────────────────────────────────────────── */}
      {activeTab === 'mailboxes' && (
        <>
          <div className="flex justify-between items-center">
            <p className="text-xs text-muted-foreground">{mailboxes.length} mailbox{mailboxes.length !== 1 ? 'es' : ''}</p>
            <Button onClick={() => setShowCreateMb(true)} disabled={eligibleDomains.length === 0}>
              <Plus size={14} /> Create Mailbox
            </Button>
          </div>

          {eligibleDomains.length === 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-4">
              <AlertTriangle size={18} className="text-orange-500 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-semibold">No usable domain yet</p>
                <p className="text-muted-foreground mt-1">
                  Add a domain in <Link href="/dashboard/domains" className="text-primary hover:underline">Domains</Link>{' '}
                  and link it to an application of a project you have access to.
                </p>
              </div>
            </div>
          )}

          {mbLoading ? (
            <div className="py-12 flex justify-center"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
          ) : mailboxes.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16">
                <Inbox size={48} className="mb-4 text-muted-foreground" />
                <p className="text-lg font-medium">No mailboxes yet</p>
                <p className="mt-1 text-sm text-muted-foreground">Create your first mailbox</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {mailboxes.map((mb) => {
                const usagePct = mb.quotaMb > 0 ? (mb.usedMb / mb.quotaMb) * 100 : 0;
                const statusVariant = mb.status === 'ACTIVE' ? 'success' : mb.status === 'SUSPENDED' ? 'warning' : 'destructive';
                return (
                  <Card key={mb.id}>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Mail size={14} className="text-primary shrink-0" />
                            <p className="font-mono text-sm truncate">{mb.address}</p>
                          </div>
                          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                            <Badge variant={statusVariant} className="text-[10px]">{mb.status}</Badge>
                            {mb.catchAll && <Badge variant="warning" className="text-[10px]">Catch-all</Badge>}
                            {mb.forwardTo && <Badge variant="outline" className="text-[10px]">→ {mb.forwardTo}</Badge>}
                            {mb.project && (
                              <Link href={`/dashboard/projects/${mb.project.id}`}>
                                <Badge variant="outline" className="text-[10px] gap-1 hover:bg-accent">
                                  <FolderKanban size={9} /> {mb.project.name}
                                </Badge>
                              </Link>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          {mb.status === 'ACTIVE' ? (
                            <Button size="icon" variant="ghost" title="Suspend"
                              onClick={() => statusMbMutation.mutate({ id: mb.id, status: 'SUSPENDED' })}>
                              <Shield size={13} />
                            </Button>
                          ) : (
                            <Button size="icon" variant="ghost" title="Reactivate"
                              onClick={() => statusMbMutation.mutate({ id: mb.id, status: 'ACTIVE' })}>
                              <ShieldCheck size={13} />
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" title="Delete"
                            onClick={() => setDeleteMbId(mb.id)}>
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      </div>

                      {/* quota bar */}
                      <div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                          <span>Quota</span>
                          <span className="font-mono">{fmtSize(mb.usedMb)} / {fmtSize(mb.quotaMb)}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              'h-full transition-all',
                              usagePct > 90 ? 'bg-red-500' : usagePct > 70 ? 'bg-orange-500' : 'bg-emerald-500',
                            )}
                            style={{ width: `${Math.min(usagePct, 100)}%` }}
                          />
                        </div>
                      </div>

                      {mb._count && mb._count.aliases > 0 && (
                        <p className="text-[10px] text-muted-foreground">
                          {mb._count.aliases} alias{mb._count.aliases > 1 ? 'es' : ''}
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ─── Aliases ───────────────────────────────────────────── */}
      {activeTab === 'aliases' && (
        <>
          {!selectedDomainId ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16">
                <AtSign size={48} className="mb-4 text-muted-foreground" />
                <p className="text-lg font-medium">Select a domain</p>
                <p className="mt-1 text-sm text-muted-foreground">Pick a domain to manage its aliases.</p>
              </CardContent>
            </Card>
          ) : aliases.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <AtSign size={40} className="mb-3 text-muted-foreground" />
                <p className="font-medium">No aliases yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Create an alias to forward mail to another address or mailbox.
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-muted/30">
                    <tr className="text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">Address</th>
                      <th className="px-4 py-2 font-medium">Target</th>
                      <th className="px-4 py-2 font-medium w-32 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {aliases.map((a) => (
                      <tr key={a.id} className="border-b last:border-0 hover:bg-accent/40">
                        <td className="px-4 py-2 font-mono">{a.address}</td>
                        <td className="px-4 py-2 text-xs">
                          {a.mailbox ? (
                            <span>→ <span className="font-mono">{a.mailbox.address}</span></span>
                          ) : a.forwardTo ? (
                            <span>↗ <span className="font-mono">{a.forwardTo}</span></span>
                          ) : (
                            <span className="text-muted-foreground italic">no target</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Button size="icon" variant="ghost" title="Delete"
                            onClick={() => setDeleteAliasId(a.id)}>
                            <Trash2 size={13} />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ─── DNS records ───────────────────────────────────────── */}
      {activeTab === 'dns' && (
        <>
          {!selectedDomainId ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16">
                <Globe size={48} className="mb-4 text-muted-foreground" />
                <p className="text-lg font-medium">Select a domain</p>
                <p className="mt-1 text-sm text-muted-foreground">Pick a domain to view its email DNS records.</p>
              </CardContent>
            </Card>
          ) : !dnsHints ? (
            <div className="py-12 flex justify-center"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              {/* Mail server control panel */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Mail size={18} /> Mail Server
                  </CardTitle>
                  <CardDescription>
                    Postfix + Dovecot + rspamd stack for {eligibleDomains.find(d => d.id === selectedDomainId)?.domain}.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {!dnsHints.mailServer ? (
                    <div className="rounded-lg border border-dashed border-border p-4 space-y-3">
                      <div className="flex items-start gap-3">
                        <AlertTriangle size={18} className="text-orange-500 shrink-0 mt-0.5" />
                        <div className="text-sm">
                          <p className="font-semibold">No mail server yet</p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            Deploy a docker-mailserver stack to start receiving mail. A 2048-bit DKIM key will be generated.
                          </p>
                        </div>
                      </div>
                      <Button onClick={() => deployMailMutation.mutate()} disabled={deployMailMutation.isPending}>
                        <Plus size={14} /> {deployMailMutation.isPending ? 'Provisioning...' : 'Deploy mail server'}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between rounded-lg border border-border p-3">
                        <div className="flex items-center gap-3">
                          <span className={cn(
                            'h-2.5 w-2.5 rounded-full',
                            dnsHints.mailServer.status === 'RUNNING' ? 'bg-emerald-500' :
                            dnsHints.mailServer.status === 'DEPLOYING' ? 'bg-orange-500 animate-pulse' :
                            dnsHints.mailServer.status === 'ERROR' ? 'bg-red-500' : 'bg-zinc-500',
                          )} />
                          <div>
                            <p className="font-medium text-sm">
                              {dnsHints.mailServer.status === 'DEPLOYING' && 'Deploying...'}
                              {dnsHints.mailServer.status === 'RUNNING' && 'Running'}
                              {dnsHints.mailServer.status === 'STOPPED' && 'Stopped'}
                              {dnsHints.mailServer.status === 'ERROR' && 'Error'}
                            </p>
                            {dnsHints.mailServer.hostname && (
                              <p className="text-xs text-muted-foreground font-mono">{dnsHints.mailServer.hostname}</p>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {dnsHints.mailServer.status === 'RUNNING' && (
                            <Button size="sm" variant="outline" onClick={() => stopMailMutation.mutate()} disabled={stopMailMutation.isPending}>
                              Stop
                            </Button>
                          )}
                          {dnsHints.mailServer.status !== 'DEPLOYING' && (
                            <Button size="sm" onClick={() => deployMailMutation.mutate()} disabled={deployMailMutation.isPending}>
                              <RefreshCw size={12} /> {dnsHints.mailServer.status === 'STOPPED' ? 'Start' : 'Redeploy'}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => { if (confirm('Remove the mail server and all its data?')) removeMailMutation.mutate(); }}
                            disabled={removeMailMutation.isPending}
                          >
                            <Trash2 size={12} />
                          </Button>
                        </div>
                      </div>

                      {dnsHints.mailServer.lastError && (
                        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs">
                          <p className="font-semibold text-red-400 mb-1">Last error</p>
                          <pre className="text-muted-foreground whitespace-pre-wrap break-all">{dnsHints.mailServer.lastError}</pre>
                        </div>
                      )}

                      {dnsHints.mailServer.status === 'RUNNING' && dnsHints.mailServer.mailboxCount === 0 && (
                        <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
                          <AlertTriangle size={16} className="text-orange-500 shrink-0 mt-0.5" />
                          <div className="text-xs flex-1">
                            <p className="font-semibold text-orange-400">Dovecot is not accepting logins yet</p>
                            <p className="text-muted-foreground mt-1">
                              docker-mailserver shuts down IMAP when no mailbox exists.
                              Create at least one mailbox to enable receiving and login.
                            </p>
                          </div>
                          <Button
                            size="sm"
                            onClick={() => {
                              const projId = eligibleDomains.find(d => d.id === selectedDomainId)?.project?.id
                                || eligibleDomains.find(d => d.id === selectedDomainId)?.application?.project?.id
                                || '';
                              setNewMb((s) => ({ ...s, domainId: selectedDomainId, projectId: projId }));
                              setShowCreateMb(true);
                            }}
                          >
                            <Plus size={12} /> Create mailbox
                          </Button>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 text-center">
                        {[
                          { label: 'SMTP', port: dnsHints.mailServer.ports.smtp },
                          { label: 'Submission', port: dnsHints.mailServer.ports.submission },
                          { label: 'SMTPS', port: dnsHints.mailServer.ports.smtps },
                          { label: 'IMAP', port: dnsHints.mailServer.ports.imap },
                          { label: 'IMAPS', port: dnsHints.mailServer.ports.imaps },
                        ].map(p => (
                          <div key={p.label} className="rounded-md border border-border p-2">
                            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{p.label}</p>
                            <p className="font-mono text-sm font-semibold">:{p.port}</p>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
              <CardHeader>
                <CardTitle className="text-lg">DNS records for email</CardTitle>
                <CardDescription>
                  Add these records in your DNS provider for full email deliverability.
                  {!dnsHints.dkim.ready && (
                    <span className="block mt-1 text-orange-500">
                      ⚠ Deploy the mail server above first to generate the real DKIM key.
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { label: 'MX (mail routing)', host: dnsHints.mx[0].host, type: 'MX', value: `${dnsHints.mx[0].priority} ${dnsHints.mx[0].value}` },
                  { label: 'SPF (sender policy)', host: dnsHints.spf.host, type: 'TXT', value: dnsHints.spf.value },
                  { label: 'DMARC (anti-spoof)', host: dnsHints.dmarc.host, type: 'TXT', value: dnsHints.dmarc.value },
                  { label: 'DKIM (signature)', host: dnsHints.dkim.host, type: 'TXT', value: dnsHints.dkim.value },
                  { label: 'Autodiscover', host: dnsHints.autodiscover.host, type: 'CNAME', value: dnsHints.autodiscover.value },
                ].map((r, i) => {
                  const copyKey = `dns-${i}`;
                  return (
                    <div key={r.label} className="rounded-lg border border-border p-3">
                      <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">{r.label}</p>
                      <div className="grid grid-cols-[60px_180px_1fr_auto] gap-2 items-center text-sm">
                        <Badge variant="outline" className="font-mono text-[10px] justify-center">{r.type}</Badge>
                        <span className="font-mono text-xs truncate">{r.host}</span>
                        <code className="font-mono text-xs bg-muted/30 rounded px-2 py-1 truncate">{r.value}</code>
                        <button
                          className="text-muted-foreground hover:text-foreground"
                          onClick={() => copyText(`${r.host}\t${r.type}\t${r.value}`, copyKey)}
                          title="Copy row"
                        >
                          {copied === copyKey ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
            </>
          )}
        </>
      )}

      {/* ─── Create Mailbox dialog ─── */}
      <Dialog open={showCreateMb} onClose={closeCreateMb}>
        <DialogHeader>
          <DialogTitle>Create mailbox</DialogTitle>
          <DialogDescription>The mailbox will be attached to the selected project &amp; domain.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Project *</Label>
            <Select
              value={newMb.projectId}
              onChange={(e) => { setNewMb((s) => ({ ...s, projectId: e.target.value, domainId: '' })); }}
            >
              <option value="">Select a project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Domain *</Label>
            <Select
              value={newMb.domainId}
              onChange={(e) => setNewMb((s) => ({ ...s, domainId: e.target.value }))}
              disabled={!newMb.projectId}
            >
              <option value="">Select a domain</option>
              {domains
                .filter(d => projectIdOf(d) === newMb.projectId)
                .map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Local part *</Label>
            <div className="flex items-center gap-2">
              <Input
                placeholder="contact"
                value={newMb.localPart}
                onChange={(e) => setNewMb((s) => ({ ...s, localPart: e.target.value.toLowerCase() }))}
                className="font-mono"
              />
              <span className="text-muted-foreground font-mono text-sm">
                @{domains.find(d => d.id === newMb.domainId)?.domain || '...'}
              </span>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Password * (min 8 chars)</Label>
            <div className="flex items-center gap-2">
              <Input
                type={showPw ? 'text' : 'password'}
                value={newMb.password}
                onChange={(e) => setNewMb((s) => ({ ...s, password: e.target.value }))}
                className="font-mono"
              />
              <Button size="icon" variant="outline" onClick={() => setShowPw(s => !s)}>
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
              <Button size="icon" variant="outline" onClick={genPassword} title="Generate">
                <KeyRound size={14} />
              </Button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Quota (MB)</Label>
              <Input
                type="number"
                min={64}
                max={102400}
                value={newMb.quotaMb}
                onChange={(e) => setNewMb((s) => ({ ...s, quotaMb: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Forward to (optional)</Label>
              <Input
                type="email"
                placeholder="leave empty to deliver locally"
                value={newMb.forwardTo}
                onChange={(e) => setNewMb((s) => ({ ...s, forwardTo: e.target.value }))}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="catchall"
              checked={newMb.catchAll}
              onChange={(e) => setNewMb((s) => ({ ...s, catchAll: e.target.checked }))}
              className="h-4 w-4"
            />
            <Label htmlFor="catchall" className="cursor-pointer">Catch-all (receives mail sent to any unknown address on this domain)</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeCreateMb}>Cancel</Button>
          <Button
            disabled={
              !newMb.localPart || !newMb.domainId || !newMb.projectId ||
              newMb.password.length < 8 || createMbMutation.isPending
            }
            onClick={() => createMbMutation.mutate({
              localPart: newMb.localPart,
              domainId: newMb.domainId,
              projectId: newMb.projectId,
              password: newMb.password,
              quotaMb: newMb.quotaMb,
              ...(newMb.forwardTo ? { forwardTo: newMb.forwardTo } : {}),
              catchAll: newMb.catchAll,
            })}
          >
            {createMbMutation.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Create Alias dialog ─── */}
      <Dialog open={showCreateAlias} onClose={closeCreateAlias}>
        <DialogHeader>
          <DialogTitle>Create alias</DialogTitle>
          <DialogDescription>Forward emails to another address or mailbox.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>Domain</Label>
            <Select value={newAlias.domainId} onChange={(e) => setNewAlias((s) => ({ ...s, domainId: e.target.value, targetMailboxId: '' }))}>
              <option value="">Select</option>
              {eligibleDomains.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Alias local part</Label>
            <div className="flex items-center gap-2">
              <Input
                placeholder="sales"
                value={newAlias.localPart}
                onChange={(e) => setNewAlias((s) => ({ ...s, localPart: e.target.value.toLowerCase() }))}
                className="font-mono"
              />
              <span className="text-muted-foreground font-mono text-sm">
                @{eligibleDomains.find(d => d.id === newAlias.domainId)?.domain || '...'}
              </span>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Target mailbox (same domain)</Label>
            <Select
              value={newAlias.targetMailboxId}
              onChange={(e) => setNewAlias((s) => ({ ...s, targetMailboxId: e.target.value, forwardTo: '' }))}
            >
              <option value="">— or use external forward below —</option>
              {domainMailboxes.map((mb) => <option key={mb.id} value={mb.id}>{mb.address}</option>)}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Or forward externally</Label>
            <Input
              type="email"
              placeholder="external@example.com"
              value={newAlias.forwardTo}
              disabled={!!newAlias.targetMailboxId}
              onChange={(e) => setNewAlias((s) => ({ ...s, forwardTo: e.target.value }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeCreateAlias}>Cancel</Button>
          <Button
            disabled={
              !newAlias.localPart || !newAlias.domainId ||
              (!newAlias.targetMailboxId && !newAlias.forwardTo) ||
              createAliasMutation.isPending
            }
            onClick={() => createAliasMutation.mutate({
              localPart: newAlias.localPart,
              domainId: newAlias.domainId,
              ...(newAlias.targetMailboxId ? { targetMailboxId: newAlias.targetMailboxId } : {}),
              ...(newAlias.forwardTo ? { forwardTo: newAlias.forwardTo } : {}),
            })}
          >
            {createAliasMutation.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Delete confirm ─── */}
      <Dialog open={!!deleteMbId} onClose={() => setDeleteMbId(null)}>
        <DialogHeader>
          <DialogTitle>Delete mailbox</DialogTitle>
          <DialogDescription>This will remove the mailbox and all its aliases. Action irreversible.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteMbId(null)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={deleteMbMutation.isPending}
            onClick={() => deleteMbId && deleteMbMutation.mutate(deleteMbId)}
          >
            {deleteMbMutation.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={!!deleteAliasId} onClose={() => setDeleteAliasId(null)}>
        <DialogHeader>
          <DialogTitle>Delete alias</DialogTitle>
          <DialogDescription>Action irreversible.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteAliasId(null)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={deleteAliasMutation.isPending}
            onClick={() => deleteAliasId && deleteAliasMutation.mutate(deleteAliasId)}
          >
            {deleteAliasMutation.isPending ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
