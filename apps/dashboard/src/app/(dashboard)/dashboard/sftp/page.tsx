'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Loader2, Server, Copy, Check, RefreshCw, Trash2, Power,
  KeyRound, AlertCircle, Eye, EyeOff, Calendar, Terminal as TerminalIcon,
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
import { cn } from '@/lib/utils';

/**
 * SFTP accounts dashboard.
 *
 * One page to create / rotate / disable / delete SFTP access for any
 * application the user can administer. Designed for the "I want to give
 * a contractor Filezilla access to this WordPress" flow.
 *
 * UX flow:
 *   1. Pick an app (top selector).
 *   2. See the list of existing accounts.
 *   3. "New account" → modal → generated password shown ONCE.
 *   4. Connection-info card with host/port/username/cmd-line snippets
 *      so the user can paste straight into Filezilla.
 */

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

  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SftpAccount | null>(null);

  // Reuse the /files/scopes API — it already returns every app the
  // current user can see, keyed by project + role. We don't need a
  // dedicated /sftp/scopes endpoint just yet.
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
    queryFn: () =>
      api.get(`/sftp?scope=app&scopeId=${selectedAppId}`),
    enabled: !!selectedAppId,
  });

  const createMutation = useMutation({
    mutationFn: (body: any) => api.post<SftpAccount>('/sftp', body),
    onSuccess: (acc) => {
      toast.success(`Account ${acc.username} created`);
      if (acc.plainPassword) {
        // Surface the once-only password in the row so the user can
        // copy it before refreshing.
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
      toast.success('Password rotated');
      setRevealedPasswords((r) => ({ ...r, [id]: res.plainPassword }));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, disabled }: { id: string; disabled: boolean }) =>
      api.patch(`/sftp/${id}`, { disabled }),
    onSuccess: () => {
      toast.success('Account updated');
      refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const shellToggleMutation = useMutation({
    mutationFn: ({ id, allowShell }: { id: string; allowShell: boolean }) =>
      api.patch(`/sftp/${id}`, { allowShell }),
    onSuccess: (_, vars) => {
      toast.success(vars.allowShell ? 'SSH shell enabled' : 'SSH shell disabled');
      refetch();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/sftp/${id}`),
    onSuccess: () => {
      toast.success('Account deleted');
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
            <Server size={26} /> SFTP Access
          </h1>
          <p className="text-muted-foreground">
            Issue Filezilla / WinSCP credentials for your apps. Sessions are
            chrooted to the app's own directory.
          </p>
        </div>
        {selectedAppId && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New account
          </Button>
        )}
      </div>

      {/* App picker */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Application</CardTitle>
          <CardDescription className="text-xs">
            Pick the app whose files should be exposed over SFTP.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={selectedAppId} onChange={(e) => setSelectedAppId(e.target.value)}>
            <option value="">Pick an application…</option>
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
          {/* Connection info card */}
          <ConnectionInfoCard
            appName={selectedApp.name}
            firstUsername={accounts.find((a) => !a.disabled)?.username}
            hasShellAccount={accounts.some((a) => !a.disabled && a.allowShell)}
            copy={copy}
            copied={copied}
          />

          {/* Accounts list */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Accounts</CardTitle>
              <CardDescription>
                Each row is a separate Filezilla login. Disabling preserves
                the row but drops the SSH user; rotating issues a fresh
                password and shows it once.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {accounts.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No accounts yet. Click <span className="font-medium">New account</span> to create one.
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {accounts.map((acc) => {
                    const expired = acc.expiresAt && new Date(acc.expiresAt) < new Date();
                    const pw = revealedPasswords[acc.id];
                    return (
                      <div key={acc.id} className="py-3 flex items-start justify-between gap-3">
                        <div className="space-y-1.5 min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-medium">{acc.username}</span>
                            {acc.disabled && <Badge variant="outline" className="text-[10px]">disabled</Badge>}
                            {expired && <Badge variant="destructive" className="text-[10px]">expired</Badge>}
                            <Badge
                              variant="outline"
                              className={cn(
                                'text-[10px]',
                                acc.permission === 'READ' && 'border-blue-500/40 text-blue-400',
                                acc.permission === 'WRITE' && 'border-emerald-500/40 text-emerald-400',
                                acc.permission === 'ADMIN' && 'border-amber-500/40 text-amber-400',
                              )}
                            >
                              {acc.permission}
                            </Badge>
                            {acc.allowShell && (
                              <Badge variant="outline" className="text-[10px] gap-1 border-purple-500/40 text-purple-400">
                                <TerminalIcon size={9} /> SSH shell
                              </Badge>
                            )}
                            {acc.publicKeys.length > 0 && (
                              <Badge variant="outline" className="text-[10px] gap-1">
                                <KeyRound size={9} /> {acc.publicKeys.length} keys
                              </Badge>
                            )}
                          </div>
                          {pw && (
                            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2 space-y-1">
                              <p className="text-[10px] text-emerald-500 font-medium uppercase tracking-wider flex items-center gap-1">
                                <AlertCircle size={10} /> Password shown once
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
                            <span>created {timeAgo(acc.createdAt)}</span>
                            {acc.lastUsedAt && <span>last used {timeAgo(acc.lastUsedAt)}</span>}
                            {acc.expiresAt && !expired && (
                              <span className="flex items-center gap-1">
                                <Calendar size={10} /> expires {timeAgo(acc.expiresAt)}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={shellToggleMutation.isPending}
                            onClick={() => shellToggleMutation.mutate({ id: acc.id, allowShell: !acc.allowShell })}
                            title={acc.allowShell ? 'Disable SSH shell' : 'Enable SSH shell'}
                          >
                            <TerminalIcon size={12} className={acc.allowShell ? 'text-purple-400' : 'text-muted-foreground'} />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-xs h-7"
                            disabled={rotateMutation.isPending}
                            onClick={() => rotateMutation.mutate(acc.id)}
                            title="Rotate password"
                          >
                            <RefreshCw size={12} /> Rotate
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={toggleMutation.isPending}
                            onClick={() => toggleMutation.mutate({ id: acc.id, disabled: !acc.disabled })}
                            title={acc.disabled ? 'Enable' : 'Disable'}
                          >
                            <Power size={12} className={acc.disabled ? 'text-muted-foreground' : 'text-emerald-500'} />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 hover:text-destructive"
                            onClick={() => setDeleteTarget(acc)}
                            title="Delete"
                          >
                            <Trash2 size={12} />
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
      />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>Delete {deleteTarget?.username}?</DialogTitle>
          <DialogDescription>
            Permanently removes this SFTP account. Any open sessions are
            dropped on the next sync (~3 seconds).
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

// ── Connection info card ─────────────────────────────────────────────
// Shows the host, port, and a ready-to-paste sftp:// URL the user can
// hand to Filezilla. Pulls the hostname from window.location since the
// dashboard is served on the same host as sshd.
function ConnectionInfoCard({
  appName, firstUsername, hasShellAccount, copy, copied,
}: {
  appName: string;
  firstUsername?: string;
  hasShellAccount: boolean;
  copy: (text: string, label: string) => void;
  copied: string | null;
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
        <CardTitle className="text-sm flex items-center gap-2">
          Connection for {appName}
          <Badge variant="outline" className="text-[10px] gap-1">SFTP</Badge>
          {hasShellAccount && (
            <Badge variant="outline" className="text-[10px] gap-1 border-purple-500/40 text-purple-400">
              <TerminalIcon size={9} /> SSH
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          Files land at <code className="px-1 py-0.5 rounded bg-muted font-mono text-[10px]">{root}/</code> inside the chroot.
          {hasShellAccount && ' Shell accounts get bash in the same chroot.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <ConnLine label="Host" value={host} onCopy={() => copy(host, 'host')} copied={copied === 'host'} />
        <ConnLine label="Port" value={String(port)} onCopy={() => copy(String(port), 'port')} copied={copied === 'port'} />
        <ConnLine label="Protocol" value="SFTP / SSH (same port)" />
        <ConnLine label="Filezilla URL" value={sftpUrl} onCopy={() => copy(sftpUrl, 'url')} copied={copied === 'url'} />
        <ConnLine label="SFTP CLI" value={cliExample} onCopy={() => copy(cliExample, 'cli')} copied={copied === 'cli'} />
        {hasShellAccount && (
          <ConnLine label="SSH CLI / Putty" value={sshExample} onCopy={() => copy(sshExample, 'ssh')} copied={copied === 'ssh'} />
        )}
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
    <div className="grid grid-cols-[110px_1fr_32px] items-center gap-2 text-sm">
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
  open, onClose, appId, appName, onCreate, creating,
}: {
  open: boolean;
  onClose: () => void;
  appId: string;
  appName: string | undefined;
  onCreate: (body: any) => void;
  creating: boolean;
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
        <DialogTitle>New SFTP account</DialogTitle>
        <DialogDescription>
          For {appName}. Username + (password or SSH keys). Leave the
          password blank to auto-generate a strong one.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 py-2">
        <div className="space-y-1">
          <Label>Username</Label>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ftp_user"
            className="font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            Lowercase, 3-32 chars, starts with a letter. a-z 0-9 _ -
          </p>
        </div>

        <div className="space-y-1">
          <Label>Password <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <div className="relative">
            <Input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to auto-generate"
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
          <Label>SSH public keys <span className="text-muted-foreground font-normal">(optional, one per line)</span></Label>
          <textarea
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
            placeholder="ssh-ed25519 AAAAC3... user@machine"
            spellCheck={false}
            className="w-full min-h-[80px] rounded-md border border-border bg-background p-2 font-mono text-xs"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Permission</Label>
            <Select value={permission} onChange={(e) => setPermission(e.target.value as any)}>
              <option value="READ">Read-only</option>
              <option value="WRITE">Read &amp; Write</option>
              <option value="ADMIN">Admin</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Expires <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>

        {/* Shell access toggle */}
        <label className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-2.5 cursor-pointer hover:bg-muted/50">
          <input
            type="checkbox"
            checked={allowShell}
            onChange={(e) => setAllowShell(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary cursor-pointer"
          />
          <div className="flex-1 space-y-0.5">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <TerminalIcon size={12} /> Allow SSH shell (Putty)
            </div>
            <p className="text-[11px] text-muted-foreground">
              In addition to SFTP, the user can open a real shell with Putty / <code className="font-mono">ssh</code>.
              They stay chrooted to the app sandbox — no host access. App data is at <code className="font-mono">/app</code>.
            </p>
          </div>
        </label>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={!valid || creating} onClick={submit}>
          {creating && <Loader2 size={14} className="animate-spin" />}
          Create account
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
