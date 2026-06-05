'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Mail, AtSign, Globe, Plus, Trash2, Loader2, Eye, EyeOff,
  Shield, ShieldCheck, Copy, Check, RefreshCw, AlertTriangle,
  KeyRound, Inbox, ArrowLeft, ExternalLink, Server as ServerIcon,
  Power, AlertCircle,
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

type Tab = 'overview' | 'mailboxes' | 'aliases' | 'dns';
type MailboxStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';
type ServerStatus = 'STOPPED' | 'DEPLOYING' | 'RUNNING' | 'ERROR';

interface Mailbox {
  id: string; address: string; localPart: string; domainId: string;
  quotaMb: number; usedMb: number; status: MailboxStatus;
  forwardTo: string | null; catchAll: boolean; createdAt: string;
  _count?: { aliases: number };
}
interface Alias {
  id: string; address: string; domainId: string;
  targetMailboxId: string | null; forwardTo: string | null; createdAt: string;
  mailbox: { id: string; address: string } | null;
}
interface DnsHints {
  mx: { host: string; value: string; priority: number }[];
  spf: { host: string; type: string; value: string };
  dmarc: { host: string; type: string; value: string };
  dkim: { host: string; type: string; value: string; ready: boolean };
  autodiscover: { host: string; type: string; value: string };
  mailServer: {
    status: ServerStatus;
    ports: { smtp: number; submission: number; smtps: number; imap: number; imaps: number };
    hostname: string | null;
    lastError: string | null;
    mailboxCount: number;
  } | null;
}
interface DomainDetail {
  id: string; domain: string;
  project: { id: string; name: string } | null;
}

function fmtSize(mb: number) {
  if (mb < 1024) return `${mb} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

export default function EmailDomainPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useParams();
  const domainId = params.domainId as string;
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState<Tab>('overview');

  // dialogs
  const [showCreateMb, setShowCreateMb] = useState(false);
  const [newMb, setNewMb] = useState({ localPart: '', password: '', quotaMb: 2048, forwardTo: '', catchAll: false });
  const [showPw, setShowPw] = useState(false);
  const [showCreateAlias, setShowCreateAlias] = useState(false);
  const [newAlias, setNewAlias] = useState({ localPart: '', targetMailboxId: '', forwardTo: '' });
  const [deleteMbId, setDeleteMbId] = useState<string | null>(null);
  const [deleteAliasId, setDeleteAliasId] = useState<string | null>(null);
  const [showRemoveServer, setShowRemoveServer] = useState(false);
  const [copied, setCopied] = useState('');

  // ── queries ──────────────────────────────────────────────────────
  const { data: domain } = useQuery<DomainDetail>({
    queryKey: ['domain', domainId],
    queryFn: () => api.get(`/domains/${domainId}`),
    enabled: !!domainId,
  });

  const { data: dnsHints, refetch: refetchDns } = useQuery<DnsHints>({
    queryKey: ['email-dns', domainId],
    queryFn: () => api.get(`/email/dns/${domainId}`),
    enabled: !!domainId,
    refetchInterval: (q) => {
      const status = (q.state.data as DnsHints | undefined)?.mailServer?.status;
      return status === 'DEPLOYING' ? 3000 : false;
    },
  });

  const { data: mailboxes = [], isLoading: mbLoading } = useQuery<Mailbox[]>({
    queryKey: ['mailboxes-domain', domainId],
    queryFn: () => api.get(`/email/mailboxes?domainId=${domainId}`),
    enabled: !!domainId,
  });

  const { data: aliases = [] } = useQuery<Alias[]>({
    queryKey: ['email-aliases', domainId],
    queryFn: () => api.get(`/email/aliases?domainId=${domainId}`),
    enabled: !!domainId,
  });

  // ── mutations ────────────────────────────────────────────────────
  const deployMail = useMutation({
    mutationFn: () => api.post(`/email/server/${domainId}/deploy`),
    onSuccess: () => { toast.success(t('emails.cardStatusDeploying')); refetchDns(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const stopMail = useMutation({
    mutationFn: () => api.post(`/email/server/${domainId}/stop`),
    onSuccess: () => { toast.success(t('emails.cardStatusStopped')); refetchDns(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeMail = useMutation({
    mutationFn: () => api.delete(`/email/server/${domainId}`),
    onSuccess: () => {
      toast.success(t('common.deleting'));
      qc.invalidateQueries({ queryKey: ['emails-overview'] });
      refetchDns();
      setShowRemoveServer(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const createMb = useMutation({
    mutationFn: (body: any) => api.post('/email/mailboxes', body),
    onSuccess: () => {
      toast.success(t('emails.mailboxCreate'));
      qc.invalidateQueries({ queryKey: ['mailboxes-domain', domainId] });
      qc.invalidateQueries({ queryKey: ['email-dns', domainId] });
      qc.invalidateQueries({ queryKey: ['emails-overview'] });
      closeCreateMb();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteMb = useMutation({
    mutationFn: (id: string) => api.delete(`/email/mailboxes/${id}`),
    onSuccess: () => {
      toast.success(t('common.deleting'));
      qc.invalidateQueries({ queryKey: ['mailboxes-domain', domainId] });
      qc.invalidateQueries({ queryKey: ['email-dns', domainId] });
      qc.invalidateQueries({ queryKey: ['emails-overview'] });
      setDeleteMbId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const statusMb = useMutation({
    mutationFn: ({ id, status }: { id: string; status: MailboxStatus }) =>
      api.patch(`/email/mailboxes/${id}`, { status }),
    onSuccess: () => {
      toast.success(t('common.update'));
      qc.invalidateQueries({ queryKey: ['mailboxes-domain', domainId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const createAlias = useMutation({
    mutationFn: (body: any) => api.post('/email/aliases', body),
    onSuccess: () => {
      toast.success(t('emails.aliasCreate'));
      qc.invalidateQueries({ queryKey: ['email-aliases', domainId] });
      qc.invalidateQueries({ queryKey: ['emails-overview'] });
      closeCreateAlias();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const deleteAlias = useMutation({
    mutationFn: (id: string) => api.delete(`/email/aliases/${id}`),
    onSuccess: () => {
      toast.success(t('common.deleting'));
      qc.invalidateQueries({ queryKey: ['email-aliases', domainId] });
      qc.invalidateQueries({ queryKey: ['emails-overview'] });
      setDeleteAliasId(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── helpers ──────────────────────────────────────────────────────
  function closeCreateMb() {
    setShowCreateMb(false);
    setNewMb({ localPart: '', password: '', quotaMb: 2048, forwardTo: '', catchAll: false });
    setShowPw(false);
  }
  function closeCreateAlias() {
    setShowCreateAlias(false);
    setNewAlias({ localPart: '', targetMailboxId: '', forwardTo: '' });
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

  const status = dnsHints?.mailServer?.status;
  const statusColor =
    status === 'RUNNING' ? 'bg-emerald-500' :
    status === 'DEPLOYING' ? 'bg-orange-500 animate-pulse' :
    status === 'ERROR' ? 'bg-red-500' : 'bg-zinc-500';
  const statusLabel =
    status === 'RUNNING' ? t('emails.cardStatusRunning') :
    status === 'DEPLOYING' ? t('emails.cardStatusDeploying') :
    status === 'ERROR' ? t('emails.cardStatusError') :
    status === 'STOPPED' ? t('emails.cardStatusStopped') :
    t('emails.cardStatusNone');
  const needsMailbox = status === 'RUNNING' && (dnsHints?.mailServer?.mailboxCount || 0) === 0;

  const tabs: { key: Tab; label: string; icon: typeof Mail; badge?: number }[] = [
    { key: 'overview', label: t('emails.tab.overview'), icon: ServerIcon },
    { key: 'mailboxes', label: t('emails.tab.mailboxes'), icon: Mail, badge: mailboxes.length },
    { key: 'aliases', label: t('emails.tab.aliases'), icon: AtSign, badge: aliases.length },
    { key: 'dns', label: t('emails.tab.dns'), icon: Globe },
  ];

  if (!domain) {
    return <div className="py-16 flex justify-center"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-5">
      {/* Back + header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <button
            onClick={() => router.push('/dashboard/emails')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-1"
          >
            <ArrowLeft size={12} /> {t('emails.title')}
          </button>
          <h1 className="text-2xl sm:text-3xl font-bold font-mono truncate flex items-center gap-3">
            <span className={cn('h-3 w-3 rounded-full shrink-0', statusColor)} />
            mail.{domain.domain}
          </h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <span className="text-sm text-muted-foreground">{statusLabel}</span>
            {domain.project && (
              <Link href={`/dashboard/projects/${domain.project.id}`}>
                <Badge variant="outline" className="text-[10px] gap-1 hover:bg-accent">
                  <ServerIcon size={9} /> {domain.project.name}
                </Badge>
              </Link>
            )}
          </div>
        </div>

        {/* Server actions */}
        <div className="flex items-center gap-2 flex-wrap">
          {!dnsHints?.mailServer ? (
            <Button onClick={() => deployMail.mutate()} disabled={deployMail.isPending}>
              <Plus size={14} /> {t('emails.cardDeploy')}
            </Button>
          ) : (
            <>
              {status === 'RUNNING' && (
                <Button size="sm" variant="outline" onClick={() => stopMail.mutate()} disabled={stopMail.isPending}>
                  <Power size={12} /> {t('emails.serverStop')}
                </Button>
              )}
              {status !== 'DEPLOYING' && (
                <Button size="sm" onClick={() => deployMail.mutate()} disabled={deployMail.isPending}>
                  <RefreshCw size={12} /> {status === 'STOPPED' ? t('emails.serverStart') : t('emails.serverRedeploy')}
                </Button>
              )}
              <Button size="sm" variant="destructive" onClick={() => setShowRemoveServer(true)}>
                <Trash2 size={12} /> {t('emails.serverRemove')}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Warning banner — mail server up but no mailbox */}
      {needsMailbox && (
        <div className="flex items-start gap-3 rounded-lg border border-orange-500/30 bg-orange-500/5 p-3">
          <AlertTriangle size={16} className="text-orange-500 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm">
            <p className="font-semibold text-orange-400">Dovecot is not accepting logins yet</p>
            <p className="text-muted-foreground text-xs mt-0.5">{t('emails.warnNoMailbox')}</p>
          </div>
          <Button size="sm" onClick={() => setShowCreateMb(true)}>
            <Plus size={12} /> {t('emails.mailboxCreate')}
          </Button>
        </div>
      )}

      {/* Error banner */}
      {status === 'ERROR' && dnsHints?.mailServer?.lastError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 text-xs">
              <p className="font-semibold text-red-400 mb-1">{t('emails.lastError')}</p>
              <pre className="text-muted-foreground whitespace-pre-wrap break-all font-mono">
                {dnsHints.mailServer.lastError}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap',
                activeTab === tab.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon size={14} /> {tab.label}
              {tab.badge !== undefined && tab.badge > 0 && (
                <Badge variant="outline" className="text-[10px] h-4 px-1.5">{tab.badge}</Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* ─── Overview ───────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <div className="grid gap-3 md:grid-cols-2">
          {/* Ports */}
          {dnsHints?.mailServer ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t('emails.portsTitle')}</CardTitle>
                <CardDescription className="text-xs">
                  {dnsHints.mailServer.hostname}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-5 gap-2 text-center">
                  {[
                    { label: 'SMTP', port: dnsHints.mailServer.ports.smtp },
                    { label: 'SUB', port: dnsHints.mailServer.ports.submission },
                    { label: 'SMTPS', port: dnsHints.mailServer.ports.smtps },
                    { label: 'IMAP', port: dnsHints.mailServer.ports.imap },
                    { label: 'IMAPS', port: dnsHints.mailServer.ports.imaps },
                  ].map((p) => (
                    <button
                      key={p.label}
                      onClick={() => copyText(String(p.port), `port-${p.label}`)}
                      className="rounded-md border border-border p-2 hover:bg-accent transition-colors"
                      title="Copy port"
                    >
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{p.label}</p>
                      <p className="font-mono text-sm font-semibold flex items-center justify-center gap-1">
                        :{p.port}
                        {copied === `port-${p.label}` && <Check size={10} className="text-emerald-500" />}
                      </p>
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-10">
                <ServerIcon size={36} className="mb-3 text-muted-foreground" />
                <p className="font-medium text-sm">{t('emails.cardStatusNone')}</p>
                <p className="text-xs text-muted-foreground mt-1 text-center max-w-xs">
                  {t('emails.serverDesc')}
                </p>
                <Button size="sm" className="mt-3" onClick={() => deployMail.mutate()} disabled={deployMail.isPending}>
                  <Plus size={12} /> {t('emails.cardDeploy')}
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Counts */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('emails.serverTitle')}</CardTitle>
              <CardDescription className="text-xs">{t('emails.serverDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setActiveTab('mailboxes')}
                  className="rounded-md border border-border p-3 text-left hover:bg-accent transition-colors"
                >
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    <Inbox size={10} className="inline mr-1" />
                    {t('emails.tab.mailboxes')}
                  </p>
                  <p className="font-bold text-xl mt-0.5">{mailboxes.length}</p>
                </button>
                <button
                  onClick={() => setActiveTab('aliases')}
                  className="rounded-md border border-border p-3 text-left hover:bg-accent transition-colors"
                >
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    <AtSign size={10} className="inline mr-1" />
                    {t('emails.tab.aliases')}
                  </p>
                  <p className="font-bold text-xl mt-0.5">{aliases.length}</p>
                </button>
              </div>
              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowCreateMb(true)}
                  disabled={!dnsHints?.mailServer}>
                  <Plus size={12} /> {t('emails.mailboxCreate')}
                </Button>
                <Button size="sm" variant="outline" className="flex-1" onClick={() => setShowCreateAlias(true)}
                  disabled={!dnsHints?.mailServer || mailboxes.length === 0}>
                  <Plus size={12} /> {t('emails.aliasCreate')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* ─── Mailboxes ───────────────────────────────────────── */}
      {activeTab === 'mailboxes' && (
        <>
          <div className="flex justify-between items-center">
            <p className="text-xs text-muted-foreground">
              {mailboxes.length} {mailboxes.length === 1 ? t('emails.cardMailbox') : t('emails.cardMailboxes')}
            </p>
            <Button size="sm" onClick={() => setShowCreateMb(true)} disabled={!dnsHints?.mailServer}>
              <Plus size={14} /> {t('emails.mailboxCreate')}
            </Button>
          </div>
          {mbLoading ? (
            <div className="py-12 flex justify-center"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
          ) : mailboxes.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <Inbox size={40} className="mb-3 text-muted-foreground" />
                <p className="font-medium">{t('emails.mailboxNone')}</p>
                <p className="mt-1 text-sm text-muted-foreground text-center">{t('emails.mailboxNoneDesc')}</p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {mailboxes.map((mb) => {
                const pct = mb.quotaMb > 0 ? (mb.usedMb / mb.quotaMb) * 100 : 0;
                const statusVar = mb.status === 'ACTIVE' ? 'success' : mb.status === 'SUSPENDED' ? 'warning' : 'destructive';
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
                            <Badge variant={statusVar} className="text-[10px]">{mb.status}</Badge>
                            {mb.catchAll && <Badge variant="warning" className="text-[10px]">Catch-all</Badge>}
                            {mb.forwardTo && <Badge variant="outline" className="text-[10px]">→ {mb.forwardTo}</Badge>}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          {mb.status === 'ACTIVE' ? (
                            <Button size="icon" variant="ghost" title={t('emails.mailboxSuspend')}
                              onClick={() => statusMb.mutate({ id: mb.id, status: 'SUSPENDED' })}>
                              <Shield size={13} />
                            </Button>
                          ) : (
                            <Button size="icon" variant="ghost" title={t('emails.mailboxReactivate')}
                              onClick={() => statusMb.mutate({ id: mb.id, status: 'ACTIVE' })}>
                              <ShieldCheck size={13} />
                            </Button>
                          )}
                          <Button size="icon" variant="ghost" title={t('common.delete')}
                            onClick={() => setDeleteMbId(mb.id)}>
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                          <span>{t('emails.mailboxQuota')}</span>
                          <span className="font-mono">{fmtSize(mb.usedMb)} / {fmtSize(mb.quotaMb)}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className={cn(
                              'h-full transition-all',
                              pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-orange-500' : 'bg-emerald-500',
                            )}
                            style={{ width: `${Math.min(pct, 100)}%` }}
                          />
                        </div>
                      </div>
                      {mb._count && mb._count.aliases > 0 && (
                        <p className="text-[10px] text-muted-foreground">
                          {mb._count.aliases} {mb._count.aliases === 1 ? t('emails.cardAlias') : t('emails.cardAliases')}
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

      {/* ─── Aliases ─────────────────────────────────────────── */}
      {activeTab === 'aliases' && (
        <>
          <div className="flex justify-between items-center">
            <p className="text-xs text-muted-foreground">
              {aliases.length} {aliases.length === 1 ? t('emails.cardAlias') : t('emails.cardAliases')}
            </p>
            <Button size="sm" onClick={() => setShowCreateAlias(true)}
              disabled={!dnsHints?.mailServer || mailboxes.length === 0}>
              <Plus size={14} /> {t('emails.aliasCreate')}
            </Button>
          </div>
          {aliases.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <AtSign size={40} className="mb-3 text-muted-foreground" />
                <p className="font-medium">{t('emails.aliasNone')}</p>
                <p className="mt-1 text-sm text-muted-foreground text-center">{t('emails.aliasNoneDesc')}</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-border bg-muted/30">
                    <tr className="text-left text-muted-foreground">
                      <th className="px-4 py-2 font-medium">{t('common.email')}</th>
                      <th className="px-4 py-2 font-medium">{t('emails.aliasTarget')}</th>
                      <th className="px-4 py-2 font-medium w-32 text-right">{t('common.actions')}</th>
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
                            <span className="text-muted-foreground italic">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <Button size="icon" variant="ghost" title={t('common.delete')}
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

      {/* ─── DNS ─────────────────────────────────────────────── */}
      {activeTab === 'dns' && dnsHints && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('emails.dnsTitle')}</CardTitle>
            <CardDescription className="text-xs">
              {t('emails.dnsDesc')}
              {!dnsHints.dkim.ready && (
                <span className="block mt-1 text-orange-500">⚠ {t('emails.dkimNotReady')}</span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: t('emails.dns.mx'), host: dnsHints.mx[0].host, type: 'MX', value: `${dnsHints.mx[0].priority} ${dnsHints.mx[0].value}` },
              { label: t('emails.dns.spf'), host: dnsHints.spf.host, type: 'TXT', value: dnsHints.spf.value },
              { label: t('emails.dns.dmarc'), host: dnsHints.dmarc.host, type: 'TXT', value: dnsHints.dmarc.value },
              { label: t('emails.dns.dkim'), host: dnsHints.dkim.host, type: 'TXT', value: dnsHints.dkim.value },
              { label: t('emails.dns.autodiscover'), host: dnsHints.autodiscover.host, type: 'CNAME', value: dnsHints.autodiscover.value },
            ].map((r, i) => {
              const k = `dns-${i}`;
              return (
                <div key={r.label} className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">{r.label}</p>
                  <div className="grid grid-cols-[60px_180px_1fr_auto] gap-2 items-center text-sm">
                    <Badge variant="outline" className="font-mono text-[10px] justify-center">{r.type}</Badge>
                    <span className="font-mono text-xs truncate">{r.host}</span>
                    <code className="font-mono text-xs bg-muted/30 rounded px-2 py-1 truncate">{r.value}</code>
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => copyText(`${r.host}\t${r.type}\t${r.value}`, k)}
                      title={t('common.copy')}
                    >
                      {copied === k ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      {/* ─── Create mailbox dialog ─── */}
      <Dialog open={showCreateMb} onClose={closeCreateMb}>
        <DialogHeader>
          <DialogTitle>{t('emails.mailboxCreate')}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">@{domain.domain}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>{t('emails.mailboxLocalPart')} *</Label>
            <div className="flex items-center gap-2">
              <Input
                placeholder="contact"
                value={newMb.localPart}
                onChange={(e) => setNewMb((s) => ({ ...s, localPart: e.target.value.toLowerCase() }))}
                className="font-mono"
              />
              <span className="text-muted-foreground font-mono text-sm">@{domain.domain}</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('emails.mailboxPassword')} *</Label>
            <div className="flex items-center gap-2">
              <Input
                type={showPw ? 'text' : 'password'}
                value={newMb.password}
                onChange={(e) => setNewMb((s) => ({ ...s, password: e.target.value }))}
                className="font-mono"
              />
              <Button size="icon" variant="outline" onClick={() => setShowPw((s) => !s)}>
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
              <Button size="icon" variant="outline" onClick={genPassword} title="Generate">
                <KeyRound size={14} />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('emails.mailboxPasswordHint')}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>{t('emails.mailboxQuota')}</Label>
              <Input
                type="number"
                min={64}
                max={102400}
                value={newMb.quotaMb}
                onChange={(e) => setNewMb((s) => ({ ...s, quotaMb: Number(e.target.value) }))}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('emails.mailboxForward')}</Label>
              <Input
                type="email"
                placeholder="external@example.com"
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
            <Label htmlFor="catchall" className="cursor-pointer text-xs">
              {t('emails.mailboxCatchAll')}
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeCreateMb}>{t('common.cancel')}</Button>
          <Button
            disabled={!newMb.localPart || newMb.password.length < 8 || createMb.isPending}
            onClick={() => {
              if (!domain.project) {
                toast.error('Domain has no project');
                return;
              }
              createMb.mutate({
                localPart: newMb.localPart,
                domainId,
                projectId: domain.project.id,
                password: newMb.password,
                quotaMb: newMb.quotaMb,
                ...(newMb.forwardTo ? { forwardTo: newMb.forwardTo } : {}),
                catchAll: newMb.catchAll,
              });
            }}
          >
            {createMb.isPending ? t('emails.mailboxCreating') : t('common.create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Create alias dialog ─── */}
      <Dialog open={showCreateAlias} onClose={closeCreateAlias}>
        <DialogHeader>
          <DialogTitle>{t('emails.aliasCreate')}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">@{domain.domain}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>{t('emails.aliasLocalPart')} *</Label>
            <div className="flex items-center gap-2">
              <Input
                placeholder="sales"
                value={newAlias.localPart}
                onChange={(e) => setNewAlias((s) => ({ ...s, localPart: e.target.value.toLowerCase() }))}
                className="font-mono"
              />
              <span className="text-muted-foreground font-mono text-sm">@{domain.domain}</span>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('emails.aliasTarget')}</Label>
            <Select
              value={newAlias.targetMailboxId}
              onChange={(e) => setNewAlias((s) => ({ ...s, targetMailboxId: e.target.value, forwardTo: '' }))}
            >
              <option value="">— {t('emails.aliasTargetOrForward')} —</option>
              {mailboxes.filter((m) => m.status === 'ACTIVE').map((m) => (
                <option key={m.id} value={m.id}>{m.address}</option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{t('emails.aliasForward')}</Label>
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
          <Button variant="outline" onClick={closeCreateAlias}>{t('common.cancel')}</Button>
          <Button
            disabled={!newAlias.localPart || (!newAlias.targetMailboxId && !newAlias.forwardTo) || createAlias.isPending}
            onClick={() => createAlias.mutate({
              localPart: newAlias.localPart,
              domainId,
              ...(newAlias.targetMailboxId ? { targetMailboxId: newAlias.targetMailboxId } : {}),
              ...(newAlias.forwardTo ? { forwardTo: newAlias.forwardTo } : {}),
            })}
          >
            {createAlias.isPending ? t('emails.mailboxCreating') : t('common.create')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Delete confirms ─── */}
      <Dialog open={!!deleteMbId} onClose={() => setDeleteMbId(null)}>
        <DialogHeader>
          <DialogTitle>{t('emails.mailboxDelete')}</DialogTitle>
          <DialogDescription>{t('emails.mailboxDeleteConfirm')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteMbId(null)}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={deleteMb.isPending}
            onClick={() => deleteMbId && deleteMb.mutate(deleteMbId)}>
            {deleteMb.isPending ? t('common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={!!deleteAliasId} onClose={() => setDeleteAliasId(null)}>
        <DialogHeader>
          <DialogTitle>{t('emails.aliasDelete')}</DialogTitle>
          <DialogDescription>{t('emails.aliasDeleteConfirm')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteAliasId(null)}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={deleteAlias.isPending}
            onClick={() => deleteAliasId && deleteAlias.mutate(deleteAliasId)}>
            {deleteAlias.isPending ? t('common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={showRemoveServer} onClose={() => setShowRemoveServer(false)}>
        <DialogHeader>
          <DialogTitle>{t('emails.serverRemove')}</DialogTitle>
          <DialogDescription>{t('emails.serverRemoveConfirm')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setShowRemoveServer(false)}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={removeMail.isPending}
            onClick={() => removeMail.mutate()}>
            {removeMail.isPending ? t('common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
