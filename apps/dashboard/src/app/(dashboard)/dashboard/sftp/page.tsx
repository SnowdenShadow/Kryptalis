'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Loader2, Server, Copy, Check, RefreshCw, Trash2, Power,
  KeyRound, AlertCircle, Eye, EyeOff, Calendar, Terminal as TerminalIcon,
  Lightbulb,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import {
  Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface ScopeApp { id: string; name: string; projectId: string; framework: string; status: string }
interface ProjectScope {
  id: string; name: string; role: string;
  applications: ScopeApp[];
}

interface SftpAccount {
  id: string;
  username: string;
  applicationId: string | null;
  projectId: string | null;
  permission: 'READ' | 'WRITE' | 'ADMIN';
  disabled: boolean;
  allowShell: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  publicKeys: string[];
  createdAt: string;
  plainPassword?: string;
}

export default function SftpPage() {
  const qc = useQueryClient();
  const { t } = useTranslation();

  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SftpAccount | null>(null);

  const { data: scopes = [] } = useQuery<ProjectScope[]>({
    queryKey: ['file-scopes'],
    queryFn: () => api.get('/files/scopes'),
  });

  const allApps = useMemo(
    () => scopes.flatMap((p) => p.applications.map((a) => ({ ...a, projectName: p.name, role: p.role }))),
    [scopes],
  );
  const selectedApp = allApps.find((a) => a.id === selectedAppId);

  const { data: accounts = [], refetch } = useQuery<SftpAccount[]>({
    queryKey: ['sftp-accounts', selectedAppId],
    queryFn: () => api.get(`/sftp?scope=app&scopeId=${selectedAppId}`),
    enabled: !!selectedAppId,
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => api.post<SftpAccount>('/sftp', body),
    onSuccess: (acc) => {
      toast.success(t('sftp.toastCreated', { username: acc.username }));
      if (acc.plainPassword) {
        setRevealedPasswords((r) => ({ ...r, [acc.id]: acc.plainPassword! }));
      }
      setShowCreate(false);
      refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => api.post<{ plainPassword: string }>(`/sftp/${id}/rotate`),
    onSuccess: (res, id) => {
      toast.success(t('sftp.toastRotated'));
      setRevealedPasswords((r) => ({ ...r, [id]: res.plainPassword }));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      api.patch(`/sftp/${id}`, { disabled }),
    onSuccess: () => {
      toast.success(t('sftp.toastUpdated'));
      refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const shellToggleMutation = useMutation({
    mutationFn: ({ id, allowShell }: { id: string; allowShell: boolean }) =>
      api.patch(`/sftp/${id}`, { allowShell }),
    onSuccess: (_, vars) => {
      toast.success(vars.allowShell ? t('sftp.toastShellOn') : t('sftp.toastShellOff'));
      refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/sftp/${id}`),
    onSuccess: () => {
      toast.success(t('sftp.toastDeleted'));
      setDeleteTarget(null);
      refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Server size={26} /> {t('sftp.title')}
          </h1>
          <p className="text-muted-foreground max-w-2xl">{t('sftp.subtitle')}</p>
        </div>
        {selectedAppId && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={14} /> {t('sftp.newAccount')}
          </Button>
        )}
      </div>

      {/* Step 1 — App picker */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('sftp.step1')}</CardTitle>
          <CardDescription className="text-xs">{t('sftp.step1Desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={selectedAppId} onChange={(e) => setSelectedAppId(e.target.value)}>
            <option value="">{t('sftp.step1Pick')}</option>
            {scopes.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.applications.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </optgroup>
            ))}
          </Select>
        </CardContent>
      </Card>

      {selectedApp && (
        <>
          {/* Step 2 — Connection info */}
          <ConnectionInfoCard
            appName={selectedApp.name}
            firstUsername={accounts.find((a) => !a.disabled)?.username}
            hasShellAccount={accounts.some((a) => !a.disabled && a.allowShell)}
            copy={copy}
            copied={copied}
            t={t}
          />

          {/* Step 3 — Accounts list */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('sftp.step3')}</CardTitle>
              <CardDescription>{t('sftp.step3Desc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {accounts.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  <p>{t('sftp.noAccounts')}</p>
                  <p className="mt-1">
                    {t('sftp.noAccountsCta', { label: t('sftp.newAccount') })}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {accounts.map((acc) => {
                    const expired = acc.expiresAt && new Date(acc.expiresAt) < new Date();
                    const pw = revealedPasswords[acc.id];
                    return (
                      <div
                        key={acc.id}
                        className="py-3 flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4"
                      >
                        {/* Left: identity & metadata */}
                        <div className="space-y-1.5 min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-medium">{acc.username}</span>
                            {acc.disabled && <Badge variant="outline" className="text-[10px]">{t('sftp.disabled')}</Badge>}
                            {expired && <Badge variant="destructive" className="text-[10px]">{t('sftp.expired')}</Badge>}
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px]',
                                acc.permission === 'READ' && 'border-blue-500/40 text-blue-400',
                                acc.permission === 'WRITE' && 'border-emerald-500/40 text-emerald-400',
                                acc.permission === 'ADMIN' && 'border-amber-500/40 text-amber-400',
                              )}
                            >
                              {t(`sftp.perm${acc.permission}`)}
                            </Badge>
                            {acc.allowShell && (
                              <Badge variant="outline" className="text-[10px] gap-1 border-purple-500/40 text-purple-400">
                                <TerminalIcon size={9} /> {t('sftp.shellOn')}
                              </Badge>
                            )}
                            {acc.publicKeys.length > 0 && (
                              <Badge variant="outline" className="text-[10px] gap-1">
                                <KeyRound size={9} /> {t('sftp.keysCount', { n: acc.publicKeys.length })}
                              </Badge>
                            )}
                          </div>
                          {pw && (
                            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 space-y-1">
                              <p className="text-[10px] text-emerald-500 font-medium uppercase tracking-wider flex items-center gap-1">
                                <AlertCircle size={10} /> {t('sftp.passwordShownOnce')}
                              </p>
                              <div className="flex items-center gap-2">
                                <code className="font-mono text-xs flex-1 truncate">{pw}</code>
                                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copy(pw, `pw-${acc.id}`)}>
                                  {copied === `pw-${acc.id}` ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                                </Button>
                              </div>
                            </div>
                          )}
                          <div className="text-[11px] text-muted-foreground flex items-center gap-3 flex-wrap">
                            <span>{t('sftp.created', { ago: timeAgo(acc.createdAt, t) })}</span>
                            {acc.lastUsedAt && <span>{t('sftp.lastUsed', { ago: timeAgo(acc.lastUsedAt, t) })}</span>}
                            {acc.expiresAt && !expired && (
                              <span className="flex items-center gap-1">
                                <Calendar size={10} /> {t('sftp.expires', { ago: timeAgo(acc.expiresAt, t) })}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Right: labelled action buttons */}
                        <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs gap-1.5"
                            disabled={shellToggleMutation.isPending}
                            onClick={() => shellToggleMutation.mutate({ id: acc.id, allowShell: !acc.allowShell })}
                            title={acc.allowShell ? t('sftp.actionShellDisable') : t('sftp.actionShellEnable')}
                          >
                            <TerminalIcon size={12} className={acc.allowShell ? 'text-purple-400' : 'text-muted-foreground'} />
                            {acc.allowShell ? t('sftp.actionShellDisable') : t('sftp.actionShellEnable')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs gap-1.5"
                            disabled={rotateMutation.isPending}
                            onClick={() => rotateMutation.mutate(acc.id)}
                            title={t('sftp.actionRotate')}
                          >
                            {rotateMutation.isPending && rotateMutation.variables === acc.id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <RefreshCw size={12} />
                            )}
                            {t('sftp.actionRotate')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs gap-1.5"
                            disabled={toggleMutation.isPending}
                            onClick={() => toggleMutation.mutate({ id: acc.id, disabled: !acc.disabled })}
                            title={acc.disabled ? t('sftp.actionEnable') : t('sftp.actionDisable')}
                          >
                            <Power size={12} className={acc.disabled ? 'text-muted-foreground' : 'text-emerald-500'} />
                            {acc.disabled ? t('sftp.actionEnable') : t('sftp.actionDisable')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs gap-1.5 hover:border-destructive/60 hover:text-destructive"
                            onClick={() => setDeleteTarget(acc)}
                            title={t('sftp.actionDelete')}
                          >
                            <Trash2 size={12} />
                            {t('common.delete')}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <CreateAccountDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        appId={selectedAppId}
        appName={selectedApp?.name}
        onCreate={(body) => createMutation.mutate(body)}
        creating={createMutation.isPending}
        t={t}
      />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('sftp.deleteTitle', { username: deleteTarget?.username || '' })}</DialogTitle>
          <DialogDescription>{t('sftp.deleteDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
          >
            {deleteMutation.isPending ? t('common.deleting') : t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ── Connection info card ─────────────────────────────────────────────
function ConnectionInfoCard({
  appName, firstUsername, hasShellAccount, copy, copied, t,
}: {
  appName: string;
  firstUsername?: string;
  hasShellAccount: boolean;
  copy: (text: string, label: string) => void;
  copied: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const host = typeof window !== 'undefined' ? window.location.hostname : 'your-server';
  const port = 2222;
  const username = firstUsername || '<username>';
  const sftpUrl = `sftp://${username}@${host}:${port}`;
  const cliExample = `sftp -P ${port} ${username}@${host}`;
  const sshExample = `ssh -p ${port} ${username}@${host}`;
  const root = '/app';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
          <span>{t('sftp.step2')} — {appName}</span>
          <Badge variant="outline" className="text-[10px] gap-1">SFTP</Badge>
          {hasShellAccount && (
            <Badge variant="outline" className="text-[10px] gap-1 border-purple-500/40 text-purple-400">
              <TerminalIcon size={9} /> SSH
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          {t('sftp.step2Desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ConnLine label={t('sftp.host')} value={host} onCopy={() => copy(host, 'host')} copied={copied === 'host'} />
        <ConnLine label={t('sftp.port')} value={String(port)} onCopy={() => copy(String(port), 'port')} copied={copied === 'port'} />
        <ConnLine label={t('sftp.protocol')} value={t('sftp.protocolValue')} />
        <ConnLine label={t('sftp.filezillaUrl')} value={sftpUrl} onCopy={() => copy(sftpUrl, 'url')} copied={copied === 'url'} />
        <ConnLine label={t('sftp.cliExample')} value={cliExample} onCopy={() => copy(cliExample, 'cli')} copied={copied === 'cli'} />
        {hasShellAccount && (
          <ConnLine label={t('sftp.sshExample')} value={sshExample} onCopy={() => copy(sshExample, 'ssh')} copied={copied === 'ssh'} />
        )}
        <div className="mt-3 flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 p-2.5 text-xs text-blue-300/90">
          <Lightbulb size={14} className="mt-0.5 shrink-0 text-blue-400" />
          <p>
            {t('sftp.filesAt')}{' '}
            <code className="px-1 py-0.5 rounded bg-blue-500/15 font-mono text-[11px]">{root}/</code>
            {hasShellAccount && <> · {t('sftp.shellNote')}</>}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ConnLine({
  label, value, onCopy, copied,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <div className="grid grid-cols-[150px_1fr_32px] items-center gap-2 text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      <code className="font-mono text-xs truncate">{value}</code>
      {onCopy && (
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onCopy}>
          {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
        </Button>
      )}
    </div>
  );
}

// ── Create dialog ─────────────────────────────────────────────────────
function CreateAccountDialog({
  open, onClose, appId, appName, onCreate, creating, t,
}: {
  open: boolean;
  onClose: () => void;
  appId: string;
  appName: string | undefined;
  onCreate: (body: any) => void;
  creating: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [keys, setKeys] = useState('');
  const [permission, setPermission] = useState<'READ' | 'WRITE' | 'ADMIN'>('WRITE');
  const [expiresAt, setExpiresAt] = useState('');
  const [allowShell, setAllowShell] = useState(false);

  function submit() {
    onCreate({
      scope: 'app',
      scopeId: appId,
      username: username.trim().toLowerCase(),
      ...(password.trim() ? { password: password.trim() } : {}),
      publicKeys: keys.split('\n').map((l) => l.trim()).filter(Boolean),
      permission,
      allowShell,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    });
  }

  const valid = /^[a-z][a-z0-9_-]{2,31}$/.test(username.trim().toLowerCase());

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('sftp.dialogTitle')}</DialogTitle>
        <DialogDescription>{t('sftp.dialogDesc', { appName: appName || '' })}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-2">
        <div className="space-y-1">
          <Label>{t('sftp.fldUsername')}</Label>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ftp_user"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground">{t('sftp.fldUsernameHint')}</p>
        </div>

        <div className="space-y-1">
          <Label>
            {t('sftp.fldPassword')}{' '}
            <span className="text-muted-foreground font-normal">({t('common.optional')})</span>
          </Label>
          <div className="relative">
            <Input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('sftp.fldPasswordPlaceholder')}
              className="pr-9"
            />
            <button
              type="button"
              onClick={() => setShowPw((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        <div className="space-y-1">
          <Label>
            {t('sftp.fldKeys')}{' '}
            <span className="text-muted-foreground font-normal">({t('common.optional')})</span>
          </Label>
          <textarea
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
            placeholder="ssh-ed25519 AAAAC3... user@machine"
            spellCheck={false}
            className="w-full min-h-[80px] rounded-md border border-border bg-background p-2 font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">{t('sftp.fldKeysHint')}</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t('sftp.fldPermission')}</Label>
            <Select value={permission} onChange={(e) => setPermission(e.target.value as any)}>
              <option value="READ">{t('sftp.permREAD')}</option>
              <option value="WRITE">{t('sftp.permWRITE')}</option>
              <option value="ADMIN">{t('sftp.permADMIN')}</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>
              {t('sftp.fldExpires')}{' '}
              <span className="text-muted-foreground font-normal">({t('common.optional')})</span>
            </Label>
            <Input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>

        <label className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 cursor-pointer hover:bg-muted/50">
          <input
            type="checkbox"
            checked={allowShell}
            onChange={(e) => setAllowShell(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
          />
          <div className="flex-1 space-y-0.5">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <TerminalIcon size={12} /> {t('sftp.fldShell')}
            </div>
            <p className="text-[11px] text-muted-foreground">{t('sftp.fldShellHint')}</p>
          </div>
        </label>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
        <Button disabled={!valid || creating} onClick={submit}>
          {creating && <Loader2 size={14} className="animate-spin" />}
          {creating ? t('sftp.createBtnLoading') : t('sftp.createBtn')}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function timeAgo(iso: string, t: (key: string, vars?: Record<string, string | number>) => string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return t('sftp.justNow');
  if (s < 3600) return t('sftp.minAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('sftp.hourAgo', { n: Math.floor(s / 3600) });
  return t('sftp.dayAgo', { n: Math.floor(s / 86400) });
}
