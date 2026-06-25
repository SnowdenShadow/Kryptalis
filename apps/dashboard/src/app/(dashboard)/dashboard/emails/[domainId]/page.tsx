'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Mail, AtSign, Globe, Plus, Trash2, Loader2, Eye, EyeOff,
  Shield, ShieldCheck, Copy, Check, RefreshCw, AlertTriangle,
  KeyRound, Inbox, ArrowLeft, ExternalLink, Server as ServerIcon,
  Power, AlertCircle, Send,
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

type Tab = 'overview' | 'mailboxes' | 'aliases' | 'security' | 'dns' | 'webmail';
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
type DnsCheckStatus = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';
interface DnsCheck { status: DnsCheckStatus; message: string }
interface DnsHealth {
  domain: string;
  serverIp: string | null;
  ptrHostnames: string[];
  mxRecords: string[];
  checks: {
    a: DnsCheck; mx: DnsCheck; ptr: DnsCheck; spf: DnsCheck;
    dkim: DnsCheck; dmarc: DnsCheck; autodiscover: DnsCheck; apexA: DnsCheck;
    outboundSmtp?: DnsCheck;
  };
  counts: { ok: number; warn: number; fail: number; unknown: number };
  overall: 'OK' | 'PARTIAL' | 'FAIL';
  checkedAt: string;
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
  const [showTestEmail, setShowTestEmail] = useState(false);
  const [testEmail, setTestEmail] = useState({ fromMailboxId: '', to: '' });
  const [testResult, setTestResult] = useState<{ success: boolean; summary: string; transcript: string[]; durationMs: number } | null>(null);
  const [showPw, setShowPw] = useState(false);
  const [showCreateAlias, setShowCreateAlias] = useState(false);
  const [newAlias, setNewAlias] = useState({ localPart: '', targetMailboxId: '', forwardTo: '' });
  const [deleteMbId, setDeleteMbId] = useState<string | null>(null);
  const [deleteAliasId, setDeleteAliasId] = useState<string | null>(null);
  const [showRemoveServer, setShowRemoveServer] = useState(false);
  const [copied, setCopied] = useState('');
  // Edit-mailbox dialog (password / quota / forward / catch-all).
  const [editMb, setEditMb] = useState<Mailbox | null>(null);
  const [editForm, setEditForm] = useState({ password: '', quotaMb: 2048, forwardTo: '', catchAll: false });
  const [editShowPw, setEditShowPw] = useState(false);
  // Security tab: which log service to tail.
  const [logService, setLogService] = useState<'all' | 'postfix' | 'dovecot' | 'rspamd' | 'fail2ban'>('rspamd');
  // Antispam config form.
  const [spamAdvanced, setSpamAdvanced] = useState(false);
  const [spamForm, setSpamForm] = useState<any | null>(null);

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

  // Live DNS health probe — only fetched when DNS tab is opened, refetched
  // on demand. Public DNS resolution is slow (~1-3s) so we don't poll it.
  const {
    data: dnsHealth,
    refetch: refetchHealth,
    isFetching: healthLoading,
  } = useQuery<DnsHealth>({
    queryKey: ['email-dns-health', domainId],
    queryFn: () => api.get(`/email/dns/${domainId}/health`),
    enabled: !!domainId && activeTab === 'dns',
    staleTime: 30_000,
  });

  // Security tab — fail2ban bans + log tail (only when the tab is active).
  const { data: bansData, refetch: refetchBans, isFetching: bansLoading } = useQuery<{ jails: { name: string; banned: string[] }[] }>({
    queryKey: ['email-bans', domainId],
    queryFn: () => api.get(`/email/server/${domainId}/bans`),
    enabled: !!domainId && activeTab === 'security',
  });
  const { data: logsData, refetch: refetchLogs, isFetching: logsLoading } = useQuery<{ logs: string }>({
    queryKey: ['email-logs', domainId, logService],
    queryFn: () => api.get(`/email/server/${domainId}/logs?service=${logService}&lines=200`),
    enabled: !!domainId && activeTab === 'security',
  });
  const { data: antispam } = useQuery<any>({
    queryKey: ['email-antispam', domainId],
    queryFn: () => api.get(`/email/server/${domainId}/antispam`),
    enabled: !!domainId && activeTab === 'security',
  });
  // Seed the editable form once the config loads (never overwrite edits).
  useEffect(() => {
    if (antispam && spamForm === null) {
      setSpamForm({
        preset: antispam.preset, greylisting: antispam.greylisting, antivirus: antispam.antivirus,
        spamAction: antispam.spamAction, spamThreshold: antispam.spamThreshold,
        whitelist: antispam.whitelist || '', blacklist: antispam.blacklist || '',
      });
    }
  }, [antispam, spamForm]);
  const saveAntispam = useMutation({
    mutationFn: (body: any) => api.put(`/email/server/${domainId}/antispam`, body),
    onSuccess: () => {
      toast.success(t('emails.antispamSaved'));
      qc.invalidateQueries({ queryKey: ['email-antispam', domainId] });
      refetchDns();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Webmail status comes from the overview row (webmail: {id,port,status} | null).
  const { data: overviewRows = [] } = useQuery<any[]>({
    queryKey: ['emails-overview'],
    queryFn: () => api.get('/email/overview'),
    enabled: !!domainId,
  });
  const webmail = overviewRows.find((r) => r.id === domainId)?.webmail || null;

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
  const updateMb = useMutation({
    mutationFn: (body: any) => api.patch(`/email/mailboxes/${editMb!.id}`, body),
    onSuccess: () => {
      toast.success(t('emails.mailboxUpdated'));
      qc.invalidateQueries({ queryKey: ['mailboxes-domain', domainId] });
      setEditMb(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const unbanMut = useMutation({
    mutationFn: (ip: string) => api.post(`/email/server/${domainId}/unban`, { ip }),
    onSuccess: () => { toast.success(t('emails.unbanned')); refetchBans(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const deployWebmailMut = useMutation({
    mutationFn: () => api.post<{ applicationId: string; alreadyInstalled: boolean }>(`/email/server/${domainId}/webmail`, {}),
    onSuccess: (r) => {
      toast.success(r.alreadyInstalled ? t('emails.webmailAlready') : t('emails.webmailInstalling'));
      qc.invalidateQueries({ queryKey: ['emails-overview'] });
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

  const sendTestEmail = useMutation({
    mutationFn: (body: { fromMailboxId: string; to: string }) =>
      api.post<{ success: boolean; summary: string; transcript: string[]; durationMs: number }>(
        `/email/server/${domainId}/test`,
        body,
      ),
    onSuccess: (r) => {
      setTestResult(r);
      if (r.success) toast.success('Test email accepted by mail server');
      else toast.error(r.summary);
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
  function randomPw() {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
    let out = '';
    for (let i = 0; i < 16; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }
  function openEdit(mb: Mailbox) {
    setEditMb(mb);
    setEditForm({ password: '', quotaMb: mb.quotaMb, forwardTo: mb.forwardTo || '', catchAll: mb.catchAll });
    setEditShowPw(false);
  }
  function saveEdit() {
    const body: any = { quotaMb: editForm.quotaMb, catchAll: editForm.catchAll };
    if (editForm.password.trim()) body.password = editForm.password.trim();
    body.forwardTo = editForm.forwardTo.trim() || null;
    updateMb.mutate(body);
  }
  const webmailUrl = webmail && webmail.port && webmail.status === 'RUNNING'
    ? `http://${typeof window !== 'undefined' ? window.location.hostname : ''}:${webmail.port}`
    : null;

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
    { key: 'security', label: t('emails.tab.security'), icon: Shield },
    { key: 'dns', label: t('emails.tab.dns'), icon: Globe },
    { key: 'webmail', label: t('emails.tab.webmail'), icon: Inbox },
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
          <div className="flex justify-between items-center gap-2 flex-wrap">
            <p className="text-xs text-muted-foreground">
              {mailboxes.length} {mailboxes.length === 1 ? t('emails.cardMailbox') : t('emails.cardMailboxes')}
            </p>
            <div className="flex gap-2">
              {mailboxes.length > 0 && (
                <Button size="sm" variant="outline" onClick={() => setShowTestEmail(true)}>
                  <Send size={14} /> Send test email
                </Button>
              )}
              <Button size="sm" onClick={() => setShowCreateMb(true)} disabled={!dnsHints?.mailServer}>
                <Plus size={14} /> {t('emails.mailboxCreate')}
              </Button>
            </div>
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
                          <Button size="icon" variant="ghost" title={t('emails.mailboxEdit')}
                            onClick={() => openEdit(mb)}>
                            <KeyRound size={13} />
                          </Button>
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

      {/* ─── Security / Antispam ─────────────────────────────── */}
      {activeTab === 'security' && (
        <div className="space-y-3">
          {status !== 'RUNNING' ? (
            <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">
              {t('emails.securityNeedsServer')}
            </CardContent></Card>
          ) : (
            <>
              {/* Antispam — configurable: preset + advanced */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <ShieldCheck size={16} className="text-emerald-500" /> {t('emails.antispamTitle')}
                  </CardTitle>
                  <CardDescription>{t('emails.antispamDesc')}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {!spamForm ? (
                    <div className="py-4 flex justify-center"><Loader2 size={18} className="animate-spin text-muted-foreground" /></div>
                  ) : (
                    <>
                      {/* Preset selector */}
                      <div className="grid sm:grid-cols-3 gap-2">
                        {([
                          ['standard', t('emails.presetStandard'), t('emails.presetStandardDesc')],
                          ['strict', t('emails.presetStrict'), t('emails.presetStrictDesc')],
                          ['maximum', t('emails.presetMaximum'), t('emails.presetMaximumDesc')],
                        ] as const).map(([key, label, desc]) => (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setSpamForm((s: any) => ({ ...s, preset: key }))}
                            className={cn(
                              'text-left rounded-lg border p-3 transition-colors',
                              spamForm.preset === key ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
                            )}
                          >
                            <p className="font-medium text-sm flex items-center gap-1.5">
                              {spamForm.preset === key && <Check size={13} className="text-primary" />}
                              {label}
                            </p>
                            <p className="text-[11px] text-muted-foreground mt-0.5">{desc}</p>
                          </button>
                        ))}
                      </div>

                      <button type="button" className="text-xs text-primary hover:underline"
                        onClick={() => setSpamAdvanced((v) => !v)}>
                        {spamAdvanced ? '▾ ' : '▸ '}{t('emails.advanced')}
                      </button>

                      {spamAdvanced && (
                        <div className="space-y-3 rounded-lg border border-border p-3">
                          {/* Toggles */}
                          <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" className="mt-0.5" checked={spamForm.greylisting}
                              onChange={(e) => setSpamForm((s: any) => ({ ...s, greylisting: e.target.checked, preset: 'custom' }))} />
                            <span>{t('emails.greylisting')}<br /><span className="text-[11px] text-muted-foreground">{t('emails.greylistingHint')}</span></span>
                          </label>
                          <label className="flex items-start gap-2 text-sm">
                            <input type="checkbox" className="mt-0.5" checked={spamForm.antivirus}
                              onChange={(e) => setSpamForm((s: any) => ({ ...s, antivirus: e.target.checked, preset: 'custom' }))} />
                            <span>{t('emails.antivirus')}<br /><span className="text-[11px] text-orange-400">{t('emails.antivirusHint')}</span></span>
                          </label>
                          {/* Threshold + action */}
                          <div className="grid sm:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label htmlFor="spam-th">{t('emails.spamThreshold')}</Label>
                              <Input id="spam-th" type="number" min={1} max={15} step={0.5}
                                value={spamForm.spamThreshold}
                                onChange={(e) => setSpamForm((s: any) => ({ ...s, spamThreshold: parseFloat(e.target.value) || 6, preset: 'custom' }))} />
                              <p className="text-[11px] text-muted-foreground">{t('emails.spamThresholdHint')}</p>
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="spam-act">{t('emails.spamAction')}</Label>
                              <Select id="spam-act" value={spamForm.spamAction}
                                onChange={(e) => setSpamForm((s: any) => ({ ...s, spamAction: e.target.value, preset: 'custom' }))}>
                                <option value="add_header">{t('emails.spamActionMark')}</option>
                                <option value="reject">{t('emails.spamActionReject')}</option>
                              </Select>
                            </div>
                          </div>
                          {/* White / black lists */}
                          <div className="grid sm:grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                              <Label htmlFor="spam-wl">{t('emails.whitelist')}</Label>
                              <textarea id="spam-wl" rows={4}
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
                                placeholder={'friend@example.com\ntrusted-domain.com'}
                                value={spamForm.whitelist}
                                onChange={(e) => setSpamForm((s: any) => ({ ...s, whitelist: e.target.value, preset: 'custom' }))} />
                            </div>
                            <div className="space-y-1.5">
                              <Label htmlFor="spam-bl">{t('emails.blacklist')}</Label>
                              <textarea id="spam-bl" rows={4}
                                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
                                placeholder={'spammer@bad.com\nspam-domain.biz'}
                                value={spamForm.blacklist}
                                onChange={(e) => setSpamForm((s: any) => ({ ...s, blacklist: e.target.value, preset: 'custom' }))} />
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground">{t('emails.listHint')}</p>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-[11px] text-muted-foreground">{t('emails.antispamApplyNote')}</p>
                        <Button onClick={() => saveAntispam.mutate(spamForm)} disabled={saveAntispam.isPending}>
                          {saveAntispam.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
                          {t('emails.antispamSave')}
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              {/* fail2ban bans */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <CardTitle className="text-base flex items-center gap-2">
                        <Shield size={16} /> {t('emails.bansTitle')}
                      </CardTitle>
                      <CardDescription>{t('emails.bansDesc')}</CardDescription>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => refetchBans()} disabled={bansLoading}>
                      {bansLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      {t('common.refresh')}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {(() => {
                    const ips = (bansData?.jails || []).flatMap((j) => j.banned.map((ip) => ({ jail: j.name, ip })));
                    if (ips.length === 0) {
                      return <p className="text-sm text-emerald-500 flex items-center gap-1.5"><Check size={14} /> {t('emails.bansNone')}</p>;
                    }
                    return (
                      <div className="space-y-1.5">
                        {ips.map(({ jail, ip }) => (
                          <div key={`${jail}-${ip}`} className="flex items-center justify-between rounded-md border border-border p-2 text-xs">
                            <span className="font-mono">{ip} <span className="text-muted-foreground">· {jail}</span></span>
                            <Button size="sm" variant="ghost" onClick={() => unbanMut.mutate(ip)} disabled={unbanMut.isPending}>
                              {t('emails.unban')}
                            </Button>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>

              {/* Logs */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Inbox size={16} /> {t('emails.logsTitle')}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <div className="w-36">
                        <Select value={logService} onChange={(e) => setLogService(e.target.value as any)}>
                          <option value="rspamd">rspamd</option>
                          <option value="postfix">postfix</option>
                          <option value="dovecot">dovecot</option>
                          <option value="fail2ban">fail2ban</option>
                          <option value="all">all</option>
                        </Select>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => refetchLogs()} disabled={logsLoading}>
                        {logsLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <pre className="font-mono text-[11px] bg-muted/30 rounded p-3 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                    {logsData?.logs?.trim() || t('emails.logsEmpty')}
                  </pre>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}

      {/* ─── Webmail ─────────────────────────────────────────── */}
      {activeTab === 'webmail' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Inbox size={16} /> {t('emails.webmailTitle')}
            </CardTitle>
            <CardDescription>{t('emails.webmailDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {status !== 'RUNNING' ? (
              <p className="text-sm text-muted-foreground">{t('emails.webmailNeedsServer')}</p>
            ) : webmailUrl ? (
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="success" className="gap-1"><Check size={11} /> Roundcube</Badge>
                <a href={webmailUrl} target="_blank" rel="noreferrer">
                  <Button size="sm"><ExternalLink size={13} /> {t('emails.cardOpenWebmail')}</Button>
                </a>
              </div>
            ) : webmail ? (
              <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                <Loader2 size={13} className="animate-spin" /> {t('emails.webmailDeploying')}
              </p>
            ) : (
              <Button onClick={() => deployWebmailMut.mutate()} disabled={deployWebmailMut.isPending}>
                {deployWebmailMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                {t('emails.webmailInstall')}
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* ─── DNS ─────────────────────────────────────────────── */}
      {activeTab === 'dns' && dnsHints && (
        <div className="space-y-3">
          {/* Health check — live DNS probe */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    DNS health check
                    {dnsHealth && (
                      <Badge
                        variant={
                          dnsHealth.overall === 'OK' ? 'success' :
                          dnsHealth.overall === 'PARTIAL' ? 'warning' : 'destructive'
                        }
                        className="text-[10px]"
                      >
                        {dnsHealth.overall === 'OK' ? 'All good' :
                         dnsHealth.overall === 'PARTIAL' ? `${dnsHealth.counts.warn} warning${dnsHealth.counts.warn !== 1 ? 's' : ''}` :
                         `${dnsHealth.counts.fail} blocker${dnsHealth.counts.fail !== 1 ? 's' : ''}`}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Live probe of public DNS (1.1.1.1). Fix everything red below before sending real mail.
                  </CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={() => refetchHealth()} disabled={healthLoading}>
                  {healthLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Recheck
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {!dnsHealth && healthLoading && (
                <div className="py-6 flex justify-center"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
              )}
              {/* PTR / rDNS — highlighted: it's the #1 deliverability blocker and
                  can ONLY be set at the VPS provider (not by DockControl). */}
              {dnsHealth && dnsHealth.checks.ptr.status !== 'OK' && (
                <div className="rounded-lg border border-orange-500/40 bg-orange-500/10 p-3 space-y-2">
                  <p className="text-sm font-semibold text-orange-300 flex items-center gap-1.5">
                    <AlertTriangle size={14} /> {t('emails.ptrTitle')}
                  </p>
                  <p className="text-xs text-muted-foreground">{t('emails.ptrExplain')}</p>
                  {dnsHealth.serverIp && (
                    <div className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1 text-xs items-center">
                      <span className="text-muted-foreground">IP</span>
                      <button className="font-mono text-left hover:text-primary inline-flex items-center gap-1.5"
                        onClick={() => copyText(dnsHealth.serverIp!, 'ptr-ip')}>
                        {dnsHealth.serverIp} {copied === 'ptr-ip' ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                      </button>
                      <span className="text-muted-foreground">{t('emails.ptrValue')}</span>
                      <button className="font-mono text-left hover:text-primary inline-flex items-center gap-1.5"
                        onClick={() => copyText(`mail.${dnsHealth.domain}`, 'ptr-val')}>
                        mail.{dnsHealth.domain} {copied === 'ptr-val' ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {dnsHealth && (
                <>
                  {([
                    ['A (mail host)', dnsHealth.checks.a],
                    ['MX', dnsHealth.checks.mx],
                    ['PTR / rDNS', dnsHealth.checks.ptr],
                    ['SPF', dnsHealth.checks.spf],
                    ['DKIM', dnsHealth.checks.dkim],
                    ['DMARC', dnsHealth.checks.dmarc],
                    ['Autodiscover', dnsHealth.checks.autodiscover],
                    ['A (apex)', dnsHealth.checks.apexA],
                    ...(dnsHealth.checks.outboundSmtp ? [['Outbound tcp/25', dnsHealth.checks.outboundSmtp] as const] : []),
                  ] as const).map(([label, check]) => {
                    const colorRing =
                      check.status === 'OK' ? 'border-emerald-500/40 bg-emerald-500/5' :
                      check.status === 'WARN' ? 'border-orange-500/40 bg-orange-500/5' :
                      check.status === 'FAIL' ? 'border-red-500/40 bg-red-500/5' :
                      'border-zinc-500/30 bg-zinc-500/5';
                    const Icon =
                      check.status === 'OK' ? Check :
                      check.status === 'WARN' ? AlertTriangle :
                      check.status === 'FAIL' ? AlertCircle :
                      Loader2;
                    const iconColor =
                      check.status === 'OK' ? 'text-emerald-500' :
                      check.status === 'WARN' ? 'text-orange-500' :
                      check.status === 'FAIL' ? 'text-red-500' :
                      'text-zinc-400';
                    return (
                      <div key={label} className={cn('flex items-start gap-3 rounded-lg border p-3', colorRing)}>
                        <Icon size={14} className={cn('shrink-0 mt-0.5', iconColor)} />
                        <div className="flex-1 min-w-0 text-xs">
                          <p className="font-semibold">{label}</p>
                          <p className="text-muted-foreground mt-0.5 break-words font-mono text-[11px]">{check.message}</p>
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-[10px] text-muted-foreground pt-2">
                    Checked {new Date(dnsHealth.checkedAt).toLocaleTimeString()}
                    {dnsHealth.serverIp && <> · server IP: <span className="font-mono">{dnsHealth.serverIp}</span></>}
                  </p>
                </>
              )}
            </CardContent>
          </Card>

          {/* Records to add */}
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
              <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 text-xs space-y-1">
                <p className="font-semibold text-orange-400 flex items-center gap-1"><AlertTriangle size={12} /> Not in DNS, but required for inbox placement:</p>
                <p className="text-muted-foreground">
                  <span className="font-mono">PTR / rDNS</span> — set at your VPS provider (OVH/Hetzner/AWS console), point the server IP back to <span className="font-mono">mail.{domain.domain}</span>. Without it, Gmail and Outlook send your mail straight to spam.
                </p>
                <p className="text-muted-foreground">
                  <span className="font-mono">A record</span> for <span className="font-mono">mail.{domain.domain}</span> — point to the server IP. The MX record above only works once this exists.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
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

      {/* ─── Send test email ─── */}
      <Dialog
        open={showTestEmail}
        onClose={() => { setShowTestEmail(false); setTestResult(null); setTestEmail({ fromMailboxId: '', to: '' }); }}
        className="max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Send size={16} /> Send a test email</DialogTitle>
          <DialogDescription>
            Sends a message through your mail server to verify the entire send path
            (local Postfix → recipient's MX). If outbound tcp/25 is blocked or DKIM/SPF/DMARC
            are misconfigured, this catches it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">From mailbox</Label>
            <Select
              value={testEmail.fromMailboxId}
              onChange={(e) => setTestEmail((t) => ({ ...t, fromMailboxId: e.target.value }))}
            >
              <option value="">Select mailbox…</option>
              {mailboxes.filter(m => m.status === 'ACTIVE').map(m => (
                <option key={m.id} value={m.id}>{m.address}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label className="text-xs">Send to</Label>
            <Input
              type="email"
              placeholder="you@gmail.com"
              value={testEmail.to}
              onChange={(e) => setTestEmail((t) => ({ ...t, to: e.target.value }))}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Tip: send to mail-tester.com to get a deliverability score.
            </p>
          </div>

          {testResult && (
            <div className={cn(
              'rounded-md border p-3 space-y-2',
              testResult.success ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-red-500/40 bg-red-500/5',
            )}>
              <p className={cn('text-sm font-semibold', testResult.success ? 'text-emerald-600' : 'text-red-600')}>
                {testResult.success ? '✓ Accepted' : '✗ Failed'} <span className="text-muted-foreground font-normal">({testResult.durationMs}ms)</span>
              </p>
              <p className="text-xs">{testResult.summary}</p>
              <details className="mt-2">
                <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">SMTP transcript ({testResult.transcript.length} lines)</summary>
                <pre className="mt-2 text-[10px] font-mono bg-muted/40 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap">
                  {testResult.transcript.join('\n')}
                </pre>
              </details>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => { setShowTestEmail(false); setTestResult(null); setTestEmail({ fromMailboxId: '', to: '' }); }}>
            Close
          </Button>
          <Button
            disabled={!testEmail.fromMailboxId || !testEmail.to.trim() || sendTestEmail.isPending}
            onClick={() => sendTestEmail.mutate(testEmail)}
          >
            {sendTestEmail.isPending && <Loader2 size={12} className="animate-spin" />}
            <Send size={12} /> Send
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ─── Edit mailbox (password / quota / forward / catch-all) ─── */}
      <Dialog open={!!editMb} onClose={() => setEditMb(null)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={18} /> {t('emails.mailboxEdit')}
          </DialogTitle>
          <DialogDescription className="font-mono">{editMb?.address}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-pw">{t('emails.mailboxNewPassword')}</Label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Input
                  id="edit-pw"
                  type={editShowPw ? 'text' : 'password'}
                  value={editForm.password}
                  onChange={(e) => setEditForm((s) => ({ ...s, password: e.target.value }))}
                  placeholder={t('emails.mailboxPwUnchanged')}
                  className="font-mono pr-9"
                />
                <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                  onClick={() => setEditShowPw((v) => !v)}>
                  {editShowPw ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <Button type="button" variant="outline" className="shrink-0"
                onClick={() => { setEditForm((s) => ({ ...s, password: randomPw() })); setEditShowPw(true); }}>
                {t('emails.generate')}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-quota">{t('emails.mailboxQuota')} (MB)</Label>
            <Input id="edit-quota" type="number" min={64} max={102400}
              value={editForm.quotaMb}
              onChange={(e) => setEditForm((s) => ({ ...s, quotaMb: parseInt(e.target.value, 10) || 0 }))} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-fwd">{t('emails.mailboxForward')}</Label>
            <Input id="edit-fwd" type="email" value={editForm.forwardTo}
              onChange={(e) => setEditForm((s) => ({ ...s, forwardTo: e.target.value }))}
              placeholder="alias@autre-domaine.com" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={editForm.catchAll}
              onChange={(e) => setEditForm((s) => ({ ...s, catchAll: e.target.checked }))} />
            {t('emails.mailboxCatchAll')}
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setEditMb(null)}>{t('common.cancel')}</Button>
          <Button onClick={saveEdit} disabled={updateMb.isPending}>
            {updateMb.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {t('common.save')}
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
