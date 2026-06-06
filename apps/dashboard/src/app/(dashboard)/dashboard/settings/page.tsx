'use client';

import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/lib/i18n';
import {
  User,
  Shield,
  Users,
  Bell,
  Palette,
  Save,
  Plus,
  Key,
  Smartphone,
  Mail,
  MessageSquare,
  Webhook,
  Moon,
  Globe,
  Check,
  HardDrive,
  Share2,
  GitBranch,
  Trash2,
  Loader2,
  RefreshCw,
  Download,
  AlertCircle,
  CheckCircle2,
  GitCommit,
  Power,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

type Tab = 'profile' | 'security' | 'git' | 'notifications' | 'appearance' | 'infrastructure' | 'updates';

const tabDefs: { key: Tab; labelKey: string; icon: React.ElementType }[] = [
  { key: 'profile', labelKey: 'settings.profile', icon: User },
  { key: 'security', labelKey: 'settings.security', icon: Shield },
  { key: 'git', labelKey: 'settings.git', icon: GitBranch },
  { key: 'notifications', labelKey: 'settings.notifications', icon: Bell },
  { key: 'appearance', labelKey: 'settings.appearance', icon: Palette },
  { key: 'infrastructure', labelKey: 'settings.infrastructure', icon: Share2 },
  { key: 'updates', labelKey: 'settings.updates', icon: Download },
];

interface UpdateStatus {
  state: 'UP_TO_DATE' | 'UPDATE_AVAILABLE' | 'UPDATING' | 'ERROR' | 'UNKNOWN';
  message: string;
  currentSha: string | null;
  latestSha: string | null;
  branch: string | null;
  updatedAt: string | null;
  autoUpdateEnabled: boolean | null;
  manualTriggerAvailable: boolean;
  hasUpdateLog: boolean;
  webhook: {
    url: string;
    secret: string;
    fired: boolean;
    lastFiredAt: string | null;
  };
}

const notificationEvents = [
  'Deployment completed',
  'Deployment failed',
  'Server offline',
  'SSL certificate expiring',
  'Backup completed',
  'Backup failed',
];

const notificationChannels = [
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'discord', label: 'Discord', icon: MessageSquare },
  { key: 'slack', label: 'Slack', icon: MessageSquare },
  { key: 'webhook', label: 'Webhook', icon: Webhook },
];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('profile');
  const [profileName, setProfileName] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const { locale, setLocale, t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const [serverMode, setServerModeState] = useState<'local' | 'multi'>('local');
  const [notifications, setNotifications] = useState<Record<string, Record<string, boolean>>>({});
  const queryClient = useQueryClient();

  // Git Providers
  const [showAddGit, setShowAddGit] = useState(false);
  const [gitForm, setGitForm] = useState({ provider: 'GITHUB', name: '', token: '' });

  const { data: gitProviders = [] } = useQuery<any[]>({
    queryKey: ['git-providers'],
    queryFn: () => api.get('/git-providers'),
  });

  const addGitMutation = useMutation({
    mutationFn: (data: any) => api.post('/git-providers', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['git-providers'] });
      toast.success('Git provider connected');
      setShowAddGit(false);
      setGitForm({ provider: 'GITHUB', name: '', token: '' });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteGitMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/git-providers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['git-providers'] });
      toast.success('Git provider disconnected');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── system updates ───────────────────────────────────────────────
  const {
    data: updateStatus,
    refetch: refetchUpdate,
    isFetching: updateFetching,
  } = useQuery<UpdateStatus>({
    queryKey: ['system-updates'],
    queryFn: () => api.get('/system/updates'),
    enabled: activeTab === 'updates',
    // poll faster while an update is running so the UI flips to "done" quickly
    refetchInterval: (q) => {
      const s = (q.state.data as UpdateStatus | undefined)?.state;
      return s === 'UPDATING' ? 3000 : false;
    },
  });
  const [updateLog, setUpdateLog] = useState('');
  const fetchLog = useMutation({
    mutationFn: () => api.get('/system/updates/log') as Promise<{ log: string }>,
    onSuccess: (d) => setUpdateLog(d.log || '(empty)'),
    onError: (e: Error) => toast.error(e.message),
  });
  const checkUpdate = useMutation({
    mutationFn: () => api.post('/system/updates/check'),
    onSuccess: () => { toast.success('Check complete'); refetchUpdate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const applyUpdate = useMutation({
    mutationFn: () => api.post('/system/updates/apply') as Promise<{ message: string }>,
    onSuccess: (d) => { toast.success(d.message); refetchUpdate(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const toggleAuto = useMutation({
    mutationFn: (enabled: boolean) =>
      api.post('/system/updates/auto', { enabled }) as Promise<{ enabled: boolean; message: string }>,
    onSuccess: (d) => { toast.success(d.message); refetchUpdate(); },
    onError: (e: Error) => toast.error(e.message),
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Read deployment mode from public-settings (single source of truth, platform-wide)
  const { data: publicSettings } = useQuery<{ deployment_mode?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
  });
  useEffect(() => {
    if (publicSettings?.deployment_mode) {
      setServerModeState(publicSettings.deployment_mode === 'MULTI' ? 'multi' : 'local');
    }
  }, [publicSettings]);

  const saveProfile = useMutation({
    mutationFn: () => api.patch('/auth/profile', { name: profileName }),
    onSuccess: () => toast.success('Profile updated'),
    onError: (error: Error) => toast.error(error.message),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', {
        currentPassword,
        newPassword,
      }),
    onSuccess: () => {
      toast.success('Password changed');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggleNotification = (event: string, channel: string) => {
    setNotifications((prev) => ({
      ...prev,
      [event]: {
        ...prev[event],
        [channel]: !prev[event]?.[channel],
      },
    }));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account and preferences
        </p>
      </div>

      <div className="flex gap-1 rounded-lg border border-border bg-muted/50 p-1 overflow-x-auto">
        {tabDefs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap',
              activeTab === tab.key
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <tab.icon size={16} />
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Profile Tab */}
      {activeTab === 'profile' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Profile Information</CardTitle>
            <CardDescription>Update your personal details</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                placeholder="Your name"
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                placeholder="your@email.com"
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
                disabled
              />
              <p className="text-xs text-muted-foreground">
                Email cannot be changed
              </p>
            </div>
            <Button
              onClick={() => saveProfile.mutate()}
              disabled={saveProfile.isPending}
            >
              <Save size={14} />
              Save Changes
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Security Tab */}
      {activeTab === 'security' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Change Password</CardTitle>
              <CardDescription>
                Update your password to keep your account secure
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="current-password">Current Password</Label>
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">Confirm New Password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
              </div>
              <Button
                onClick={() => changePassword.mutate()}
                disabled={
                  changePassword.isPending ||
                  !currentPassword ||
                  !newPassword ||
                  newPassword !== confirmPassword
                }
              >
                <Key size={14} />
                Change Password
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Two-Factor Authentication</CardTitle>
              <CardDescription>
                Add an extra layer of security to your account
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Smartphone size={20} className="text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Authenticator App</p>
                    <p className="text-xs text-muted-foreground">
                      {twoFactorEnabled ? 'Enabled' : 'Not configured'}
                    </p>
                  </div>
                </div>
                <Button
                  variant={twoFactorEnabled ? 'destructive' : 'default'}
                  size="sm"
                  onClick={() => setTwoFactorEnabled(!twoFactorEnabled)}
                >
                  {twoFactorEnabled ? 'Disable' : 'Enable'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}


      {/* Notifications Tab */}
      {activeTab === 'notifications' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Notification Preferences</CardTitle>
            <CardDescription>
              Choose how you want to be notified about events
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border text-left text-sm text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Event</th>
                    {notificationChannels.map((channel) => (
                      <th
                        key={channel.key}
                        className="px-4 py-3 text-center font-medium"
                      >
                        <div className="flex items-center justify-center gap-1">
                          <channel.icon size={14} />
                          {channel.label}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {notificationEvents.map((event) => (
                    <tr
                      key={event}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-4 py-3 text-sm font-medium">{event}</td>
                      {notificationChannels.map((channel) => (
                        <td key={channel.key} className="px-4 py-3 text-center">
                          <button
                            onClick={() =>
                              toggleNotification(event, channel.key)
                            }
                            className={cn(
                              'h-5 w-9 rounded-full transition-colors',
                              notifications[event]?.[channel.key]
                                ? 'bg-primary'
                                : 'bg-muted'
                            )}
                          >
                            <div
                              className={cn(
                                'h-4 w-4 rounded-full bg-white transition-transform',
                                notifications[event]?.[channel.key]
                                  ? 'translate-x-4'
                                  : 'translate-x-0.5'
                              )}
                            />
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Appearance Tab */}
      {activeTab === 'appearance' && mounted && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('settings.theme')}</CardTitle>
              <CardDescription>{t('settings.themeDarkOnly')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3 rounded-lg border border-border p-4">
                <div className="h-16 w-24 rounded-md border bg-zinc-900 border-zinc-700 flex items-center justify-center">
                  <Moon size={24} className="text-zinc-500" />
                </div>
                <div>
                  <p className="font-medium">{t('settings.darkMode')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('settings.darkOnlyHint')}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('settings.language')}</CardTitle>
              <CardDescription>{t('settings.languageDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-3">
                {[
                  { key: 'en' as const, label: 'English', flag: '🇬🇧' },
                  { key: 'fr' as const, label: 'Français', flag: '🇫🇷' },
                ].map((lang) => (
                  <button
                    key={lang.key}
                    onClick={() => setLocale(lang.key)}
                    className={cn(
                      'flex items-center gap-3 rounded-lg border-2 px-6 py-3 text-sm font-medium transition-colors relative',
                      locale === lang.key
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    {locale === lang.key && (
                      <div className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                        <Check size={12} className="text-primary-foreground" />
                      </div>
                    )}
                    <Globe size={16} />
                    <span>{lang.flag} {lang.label}</span>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Git Providers Tab */}
      {activeTab === 'git' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-lg">Git Providers</CardTitle>
                  <CardDescription>Connect your Git accounts to deploy from private repositories</CardDescription>
                </div>
                <Button onClick={() => setShowAddGit(true)}>
                  <Plus size={14} /> Connect Provider
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {gitProviders.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <GitBranch size={36} className="mb-2" />
                  <p>No Git providers connected</p>
                  <p className="text-xs mt-1">Connect GitHub, GitLab or Bitbucket to deploy private repos</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {gitProviders.map((gp: any) => {
                    const icon = gp.provider === 'GITHUB' ? '🐙' : gp.provider === 'GITLAB' ? '🦊' : '🪣';
                    return (
                      <div key={gp.id} className="flex items-center justify-between rounded-lg border border-border p-4">
                        <div className="flex items-center gap-3">
                          <span className="text-2xl">{icon}</span>
                          <div>
                            <p className="font-semibold">{gp.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {gp.provider} · @{gp.username}
                            </p>
                          </div>
                          <Badge variant="success" className="ml-2">Connected</Badge>
                        </div>
                        <Button size="sm" variant="ghost" className="text-destructive"
                          onClick={() => deleteGitMutation.mutate(gp.id)}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">How to create a token</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <div>
                <p className="font-semibold text-foreground">GitHub</p>
                <p>Settings → Developer settings → Personal access tokens → Generate new token (classic). Scopes: <code className="text-xs bg-muted px-1 rounded">repo</code></p>
              </div>
              <div>
                <p className="font-semibold text-foreground">GitLab</p>
                <p>User Settings → Access Tokens → Create token. Scopes: <code className="text-xs bg-muted px-1 rounded">read_repository, read_api</code></p>
              </div>
              <div>
                <p className="font-semibold text-foreground">Bitbucket</p>
                <p>Personal settings → App passwords → Create app password. Permissions: <code className="text-xs bg-muted px-1 rounded">Repositories: Read</code></p>
              </div>
            </CardContent>
          </Card>

          <Dialog open={showAddGit} onClose={() => setShowAddGit(false)}>
            <DialogHeader>
              <DialogTitle>Connect Git Provider</DialogTitle>
              <DialogDescription>Paste your personal access token to list your repos</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select value={gitForm.provider} onChange={(e) => setGitForm({ ...gitForm, provider: e.target.value })}>
                  <option value="GITHUB">🐙 GitHub</option>
                  <option value="GITLAB">🦊 GitLab</option>
                  <option value="BITBUCKET">🪣 Bitbucket</option>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input placeholder="e.g. My GitHub" value={gitForm.name}
                  onChange={(e) => setGitForm({ ...gitForm, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>Personal Access Token</Label>
                <Input type="password" placeholder="ghp_..." value={gitForm.token}
                  onChange={(e) => setGitForm({ ...gitForm, token: e.target.value })} className="font-mono" />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAddGit(false)}>Cancel</Button>
              <Button disabled={!gitForm.name || !gitForm.token || addGitMutation.isPending}
                onClick={() => addGitMutation.mutate(gitForm)}>
                {addGitMutation.isPending ? <><Loader2 size={14} className="animate-spin" /> Connecting...</> : 'Connect'}
              </Button>
            </DialogFooter>
          </Dialog>
        </div>
      )}

      {/* Infrastructure Tab */}
      {activeTab === 'infrastructure' && mounted && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('settings.serverMode')}</CardTitle>
              <CardDescription>
                This is a platform-level setting managed by administrators.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3 rounded-lg border border-border p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  {serverMode === 'local' ? (
                    <HardDrive size={20} className="text-primary" />
                  ) : (
                    <Share2 size={20} className="text-primary" />
                  )}
                </div>
                <div className="flex-1">
                  <p className="font-medium">
                    {serverMode === 'local' ? t('settings.localMode') : t('settings.multiMode')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {serverMode === 'local' ? t('settings.localModeDesc') : t('settings.multiModeDesc')}
                  </p>
                </div>
                <Badge variant="outline" className="text-[10px]">
                  Platform-wide
                </Badge>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                To change this, an admin must update it from{' '}
                <a href="/dashboard/admin" className="text-primary hover:underline">Admin → Settings</a>.
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'updates' && (
        <div className="space-y-6">
          {/* ─── Status card ─────────────────────────────────────── */}
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <CardTitle className="text-lg flex items-center gap-2">
                    System updates
                    {updateStatus && (() => {
                      const s = updateStatus.state;
                      const variant =
                        s === 'UP_TO_DATE' ? 'success' :
                        s === 'UPDATE_AVAILABLE' ? 'warning' :
                        s === 'UPDATING' ? 'outline' :
                        s === 'ERROR' ? 'destructive' : 'outline';
                      const label =
                        s === 'UP_TO_DATE' ? 'Up to date' :
                        s === 'UPDATE_AVAILABLE' ? 'Update available' :
                        s === 'UPDATING' ? 'Updating…' :
                        s === 'ERROR' ? 'Error' : 'Unknown';
                      return <Badge variant={variant as any} className="text-[10px]">{label}</Badge>;
                    })()}
                  </CardTitle>
                  <CardDescription>
                    Your installation automatically pulls the latest version from{' '}
                    <span className="font-mono">{updateStatus?.branch || 'main'}</span> every 10 minutes.
                  </CardDescription>
                </div>
                <Button size="sm" variant="outline" onClick={() => refetchUpdate()} disabled={updateFetching}>
                  {updateFetching ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* status message */}
              {updateStatus && (
                <div className={cn(
                  'rounded-lg border p-3 flex items-start gap-3',
                  updateStatus.state === 'UP_TO_DATE' ? 'border-emerald-500/30 bg-emerald-500/5' :
                  updateStatus.state === 'UPDATE_AVAILABLE' ? 'border-orange-500/30 bg-orange-500/5' :
                  updateStatus.state === 'UPDATING' ? 'border-blue-500/30 bg-blue-500/5' :
                  updateStatus.state === 'ERROR' ? 'border-red-500/30 bg-red-500/5' :
                  'border-border bg-muted/30',
                )}>
                  {updateStatus.state === 'UP_TO_DATE' && <CheckCircle2 size={16} className="text-emerald-500 shrink-0 mt-0.5" />}
                  {updateStatus.state === 'UPDATE_AVAILABLE' && <Download size={16} className="text-orange-500 shrink-0 mt-0.5" />}
                  {updateStatus.state === 'UPDATING' && <Loader2 size={16} className="text-blue-500 animate-spin shrink-0 mt-0.5" />}
                  {updateStatus.state === 'ERROR' && <AlertCircle size={16} className="text-red-500 shrink-0 mt-0.5" />}
                  {updateStatus.state === 'UNKNOWN' && <AlertCircle size={16} className="text-muted-foreground shrink-0 mt-0.5" />}
                  <div className="flex-1 min-w-0 text-xs">
                    <p className="font-medium">{updateStatus.message}</p>
                    {updateStatus.updatedAt && (
                      <p className="text-muted-foreground mt-0.5">
                        Last check: {new Date(updateStatus.updatedAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* SHAs */}
              {updateStatus && (updateStatus.currentSha || updateStatus.latestSha) && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <GitCommit size={10} /> Installed
                    </p>
                    <p className="font-mono text-xs mt-1 truncate">
                      {updateStatus.currentSha ? updateStatus.currentSha.slice(0, 12) : '—'}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border p-3">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                      <GitCommit size={10} /> Latest on {updateStatus.branch || 'main'}
                    </p>
                    <p className="font-mono text-xs mt-1 truncate">
                      {updateStatus.latestSha ? updateStatus.latestSha.slice(0, 12) : '—'}
                    </p>
                  </div>
                </div>
              )}

              {/* action buttons */}
              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => checkUpdate.mutate()}
                  disabled={checkUpdate.isPending || !updateStatus?.manualTriggerAvailable}
                >
                  {checkUpdate.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                  Check for updates
                </Button>
                <Button
                  size="sm"
                  onClick={() => applyUpdate.mutate()}
                  disabled={
                    applyUpdate.isPending ||
                    !updateStatus?.manualTriggerAvailable ||
                    updateStatus?.state === 'UPDATING'
                  }
                >
                  {applyUpdate.isPending ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                  Update now
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { fetchLog.mutate(); }}
                  disabled={fetchLog.isPending || !updateStatus?.hasUpdateLog}
                >
                  {fetchLog.isPending ? <Loader2 size={12} className="animate-spin" /> : null}
                  View log
                </Button>
              </div>

              {!updateStatus?.manualTriggerAvailable && (
                <p className="text-[11px] text-muted-foreground">
                  Manual trigger unavailable in this deployment — the timer runs every 10 min automatically.
                </p>
              )}
            </CardContent>
          </Card>

          {/* ─── Auto-update toggle ───────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Power size={16} /> Auto-update
              </CardTitle>
              <CardDescription>
                When enabled, the platform pulls and applies updates every 10 minutes. Disable if you want full manual control.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-4">
                <div className="flex-1">
                  <p className="font-medium text-sm">
                    {updateStatus?.autoUpdateEnabled === false ? 'Disabled' : 'Enabled'}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {updateStatus?.autoUpdateEnabled === false
                      ? 'Updates will not be applied automatically. Use "Update now" when ready.'
                      : 'New commits on origin will land on your instance within 10 minutes.'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={updateStatus?.autoUpdateEnabled === false ? 'default' : 'destructive'}
                  onClick={() => toggleAuto.mutate(updateStatus?.autoUpdateEnabled === false)}
                  disabled={toggleAuto.isPending}
                >
                  {toggleAuto.isPending && <Loader2 size={12} className="animate-spin" />}
                  {updateStatus?.autoUpdateEnabled === false ? 'Enable' : 'Disable'}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ─── Log viewer ───────────────────────────────────────── */}
          {updateLog && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent update log</CardTitle>
                <CardDescription className="text-xs">
                  Last 200 lines of <span className="font-mono">.kryptalis/update.log</span>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="font-mono text-[11px] bg-muted/30 rounded p-3 overflow-x-auto max-h-96 whitespace-pre-wrap break-all">
                  {updateLog}
                </pre>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
