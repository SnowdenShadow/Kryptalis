'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from '@/lib/i18n';
import {
  User,
  Shield,
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
  GitBranch,
  Trash2,
  Loader2,
  Monitor,
  LogOut,
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

// User-scoped settings only. Platform-wide controls (Infrastructure
// mode, Updates, SMTP, registration, retention) live under /admin/system
// where they belong — Settings is for the user's own profile / security
// / preferences. The /admin redirect button below covers admins arriving
// here looking for the old tabs.
type Tab = 'profile' | 'security' | 'git' | 'notifications' | 'appearance';

const tabDefs: { key: Tab; labelKey: string; icon: React.ElementType }[] = [
  { key: 'profile', labelKey: 'settings.profile', icon: User },
  { key: 'security', labelKey: 'settings.security', icon: Shield },
  { key: 'git', labelKey: 'settings.git', icon: GitBranch },
  { key: 'notifications', labelKey: 'settings.notifications', icon: Bell },
  { key: 'appearance', labelKey: 'settings.appearance', icon: Palette },
];

// Tiny UA → "Browser on OS" parser. Heuristic, falls back to raw UA.
function parseUA(ua: string | null | undefined, fallback: string): string {
  if (!ua) return fallback;
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' :
    null;
  const os =
    /Windows NT/.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/.test(ua) ? 'macOS' :
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iOS/.test(ua) ? 'iOS' :
    /Linux/.test(ua) ? 'Linux' :
    null;
  if (browser && os) return `${browser} · ${os}`;
  return ua;
}

function formatRelative(iso: string, t: (k: string, v?: Record<string, string | number>) => string): string {
  const then = new Date(iso).getTime();
  if (!then) return iso;
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return t('settings.timeJustNow');
  const m = Math.floor(s / 60);
  if (m < 60) return t('settings.timeMinute', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('settings.timeHour', { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return t('settings.timeDay', { n: d });
  return new Date(iso).toLocaleDateString();
}

const NOTIF_EVENTS = [
  { key: 'deployOk', labelKey: 'settings.notifEv.deployOk' },
  { key: 'deployFail', labelKey: 'settings.notifEv.deployFail' },
  { key: 'serverOff', labelKey: 'settings.notifEv.serverOff' },
  { key: 'sslExpire', labelKey: 'settings.notifEv.sslExpire' },
  { key: 'backupOk', labelKey: 'settings.notifEv.backupOk' },
  { key: 'backupFail', labelKey: 'settings.notifEv.backupFail' },
];

type NotificationPrefs = Record<string, Record<string, boolean>>;

const notificationChannels = [
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'discord', label: 'Discord', icon: MessageSquare },
  { key: 'slack', label: 'Slack', icon: MessageSquare },
  { key: 'webhook', label: 'Webhook', icon: Webhook },
];

export default function SettingsPage() {
  const searchParams = useSearchParams();
  const initialTab = (searchParams?.get('tab') as Tab | null) || 'profile';
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [profileName, setProfileName] = useState('');
  const [profileEmail, setProfileEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const { locale, setLocale, t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const queryClient = useQueryClient();

  // Settings is user-scoped only now; platform-wide tabs moved to /admin.
  // (Old adminOnly guard removed — no admin-tabs to gate here anymore.)

  // Load the current user so profile fields aren't empty on mount.
  const { data: me } = useQuery<{ id: string; name: string; email: string; twoFactorEnabled?: boolean }>({
    queryKey: ['auth-me'],
    queryFn: () => api.get('/auth/me'),
  });
  useEffect(() => {
    if (me) {
      setProfileName(me.name || '');
      setProfileEmail(me.email || '');
    }
  }, [me]);
  const twoFactorEnabled = !!me?.twoFactorEnabled;

  // 2FA enrollment dialog state.
  const [twoFa, setTwoFa] = useState<{
    step: 'idle' | 'enroll' | 'done' | 'disable';
    secret?: string;
    otpauth?: string;
    code?: string;
    backupCodes?: string[];
    disablePassword?: string;
    disableCode?: string;
  }>({ step: 'idle' });

  const setup2faMutation = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauth: string }>('/auth/2fa/setup'),
    onSuccess: (data) => setTwoFa({ step: 'enroll', secret: data.secret, otpauth: data.otpauth, code: '' }),
    onError: (e: Error) => toast.error(e.message),
  });
  const enable2faMutation = useMutation({
    mutationFn: (code: string) => api.post<{ backupCodes: string[] }>('/auth/2fa/enable', { code }),
    onSuccess: (data) => {
      setTwoFa((prev) => ({ ...prev, step: 'done', backupCodes: data.backupCodes }));
      queryClient.invalidateQueries({ queryKey: ['auth-me'] });
      toast.success(t('settings.twoFaToastEnabled'));
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const disable2faMutation = useMutation({
    mutationFn: (body: { password: string; code: string }) =>
      api.post('/auth/2fa/disable', body),
    onSuccess: () => {
      setTwoFa({ step: 'idle' });
      queryClient.invalidateQueries({ queryKey: ['auth-me'] });
      toast.success(t('settings.twoFaToastDisabled'));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── active sessions ──────────────────────────────────────────────
  type SessionRow = {
    id: string;
    createdAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    isCurrent: boolean;
  };
  const { data: sessions = [], refetch: refetchSessions } = useQuery<SessionRow[]>({
    queryKey: ['auth-sessions'],
    queryFn: () => api.get('/auth/sessions'),
    enabled: activeTab === 'security',
  });
  const revokeSession = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success(t('settings.sessionsToastRevoked'));
      refetchSessions();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.delete('/auth/sessions') as Promise<{ revoked: number }>,
    onSuccess: (d) => {
      toast.success(t('settings.sessionsToastLoggedOut', { n: d.revoked }));
      refetchSessions();
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
      toast.success(t('settings.gitToastAdded'));
      setShowAddGit(false);
      setGitForm({ provider: 'GITHUB', name: '', token: '' });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteGitMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/git-providers/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['git-providers'] });
      toast.success(t('settings.gitToastRemoved'));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Is GitHub OAuth available on this install?
  const { data: githubOAuthStatus } = useQuery<{ configured: boolean }>({
    queryKey: ['oauth-status', 'github'],
    queryFn: () => api.get('/git-providers/oauth/github/status'),
  });

  // GitHub Device Flow state
  type DeviceState = {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete?: string;
    interval: number;
    expiresAt: number;
  };
  const [device, setDevice] = useState<DeviceState | null>(null);

  async function startGithubDeviceFlow() {
    try {
      const r = await api.post<{
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        verificationUriComplete?: string;
        interval: number;
        expiresIn: number;
      }>('/git-providers/oauth/github/device/start');
      setDevice({
        deviceCode: r.deviceCode,
        userCode: r.userCode,
        verificationUri: r.verificationUri,
        verificationUriComplete: r.verificationUriComplete,
        interval: Math.max(5, r.interval),
        expiresAt: Date.now() + r.expiresIn * 1000,
      });
      if (r.verificationUriComplete) {
        window.open(r.verificationUriComplete, '_blank', 'noopener,noreferrer');
      }
    } catch (e: any) {
      toast.error(e.message || t('settings.gitOAuthNotConfigured'));
    }
  }

  // Poll while the user is authorizing
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let intervalMs = device.interval * 1000;
    let timer: ReturnType<typeof setTimeout>;
    async function tick() {
      if (cancelled || !device) return;
      if (Date.now() > device.expiresAt) {
        toast.error(t('settings.gitDeviceExpired'));
        setDevice(null);
        return;
      }
      try {
        const r = await api.post<{ state: string; message?: string }>(
          '/git-providers/oauth/github/device/poll',
          { deviceCode: device.deviceCode },
        );
        if (cancelled) return;
        if (r.state === 'authorized') {
          toast.success(t('settings.gitOAuthOk'));
          queryClient.invalidateQueries({ queryKey: ['git-providers'] });
          setDevice(null);
          return;
        }
        if (r.state === 'slow_down') intervalMs += 5000;
        if (r.state === 'denied') {
          toast.error(t('settings.gitDeviceDenied'));
          setDevice(null);
          return;
        }
        if (r.state === 'expired') {
          toast.error(t('settings.gitDeviceExpired'));
          setDevice(null);
          return;
        }
        if (r.state === 'error') {
          toast.error(t('settings.gitDeviceErr', { err: r.message || 'unknown' }));
          setDevice(null);
          return;
        }
        // pending → keep polling
        timer = setTimeout(tick, intervalMs);
      } catch (e: any) {
        if (cancelled) return;
        // Network blip — keep trying for the whole expires_in window.
        timer = setTimeout(tick, intervalMs);
      }
    }
    timer = setTimeout(tick, intervalMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [device, queryClient, t]);

  const saveProfile = useMutation({
    mutationFn: () => api.patch('/auth/profile', { name: profileName }),
    onSuccess: () => toast.success(t('settings.profileToastSaved')),
    onError: (error: Error) => toast.error(error.message),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api.post('/auth/change-password', {
        currentPassword,
        newPassword,
      }),
    onSuccess: () => {
      toast.success(t('settings.pwToastChanged'));
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    },
    onError: (error: Error) => toast.error(error.message),
  });

  // ── notification preferences (persisted server-side) ─────────────
  const [notifications, setNotifications] = useState<NotificationPrefs>({});
  const { data: notifPrefs, isLoading: notifLoading } = useQuery<{ prefs: NotificationPrefs }>({
    queryKey: ['notification-prefs'],
    queryFn: () => api.get('/users/me/notification-preferences'),
    enabled: activeTab === 'notifications',
  });
  useEffect(() => {
    if (notifPrefs) setNotifications(notifPrefs.prefs || {});
  }, [notifPrefs]);

  const saveNotifPrefs = useMutation({
    mutationFn: (prefs: NotificationPrefs) =>
      api.request<{ prefs: NotificationPrefs }>('/users/me/notification-preferences', {
        method: 'PUT',
        body: { prefs },
      }),
    onSuccess: (d) => {
      queryClient.setQueryData(['notification-prefs'], d);
      toast.success(t('settings.notifToastSaved'));
    },
    onError: (e: Error) => {
      toast.error(e.message);
      queryClient.invalidateQueries({ queryKey: ['notification-prefs'] });
    },
  });

  const toggleNotification = (event: string, channel: string) => {
    const next: NotificationPrefs = {
      ...notifications,
      [event]: {
        ...notifications[event],
        [channel]: !notifications[event]?.[channel],
      },
    };
    setNotifications(next);
    saveNotifPrefs.mutate(next);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('settings.title')}</h1>
        <p className="text-muted-foreground">{t('settings.subtitle')}</p>
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
            <CardTitle className="text-lg">{t('settings.profileInfo')}</CardTitle>
            <CardDescription>{t('settings.profileDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('settings.name')}</Label>
              <Input
                id="name"
                placeholder={t('settings.namePh')}
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t('common.email')}</Label>
              <Input
                id="email"
                placeholder={t('settings.emailPh')}
                value={profileEmail}
                onChange={(e) => setProfileEmail(e.target.value)}
                disabled
              />
              <p className="text-xs text-muted-foreground">{t('settings.emailCantChange')}</p>
            </div>
            <Button
              onClick={() => saveProfile.mutate()}
              disabled={saveProfile.isPending}
            >
              <Save size={14} />
              {t('settings.saveChanges')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Security Tab */}
      {activeTab === 'security' && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('settings.changePassword')}</CardTitle>
              <CardDescription>{t('settings.changePasswordDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="current-password">{t('settings.currentPassword')}</Label>
                <Input
                  id="current-password"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-password">{t('settings.newPassword')}</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="confirm-password">{t('settings.confirmPassword')}</Label>
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
                {t('settings.changePwBtn')}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">{t('settings.twoFactor')}</CardTitle>
              <CardDescription>{t('settings.twoFactorDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Smartphone size={20} className="text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{t('settings.authenticatorApp')}</p>
                    <p className="text-xs text-muted-foreground">
                      {twoFactorEnabled ? t('settings.enabled') : t('settings.notConfigured')}
                    </p>
                  </div>
                </div>
                <Button
                  variant={twoFactorEnabled ? 'destructive' : 'default'}
                  size="sm"
                  disabled={setup2faMutation.isPending}
                  onClick={() => {
                    if (twoFactorEnabled) {
                      setTwoFa({ step: 'disable', disablePassword: '', disableCode: '' });
                    } else {
                      setup2faMutation.mutate();
                    }
                  }}
                >
                  {twoFactorEnabled ? t('settings.disable') : t('settings.enable')}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <CardTitle className="text-lg">{t('settings.sessions')}</CardTitle>
                  <CardDescription>{t('settings.sessionsDesc')}</CardDescription>
                </div>
                {sessions.filter((s) => !s.isCurrent).length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={revokeOthers.isPending}
                    onClick={() => revokeOthers.mutate()}
                  >
                    {revokeOthers.isPending
                      ? <Loader2 size={12} className="animate-spin" />
                      : <LogOut size={12} />}
                    {t('settings.sessionsLogoutAll')}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-sm">
                  <Monitor size={28} className="mb-2" />
                  <p>{t('settings.sessionsNone')}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {sessions.map((s) => (
                    <div
                      key={s.id}
                      className={cn(
                        'flex items-center justify-between gap-3 rounded-lg border p-3',
                        s.isCurrent ? 'border-primary/40 bg-primary/5' : 'border-border',
                      )}
                    >
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <Monitor size={18} className="text-muted-foreground shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium truncate">
                              {parseUA(s.userAgent, t('settings.sessionsUnknownDev'))}
                            </p>
                            {s.isCurrent && (
                              <Badge variant="success" className="text-[10px]">{t('settings.sessionsCurrent')}</Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {s.ipAddress || t('settings.sessionsUnknownIp')} · {t('settings.sessionsSignedIn', { ago: formatRelative(s.createdAt, t) })}
                          </p>
                        </div>
                      </div>
                      {!s.isCurrent && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive shrink-0"
                          disabled={revokeSession.isPending}
                          onClick={() => revokeSession.mutate(s.id)}
                        >
                          {revokeSession.isPending
                            ? <Loader2 size={14} className="animate-spin" />
                            : <Trash2 size={14} />}
                          {t('settings.sessionsRevoke')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}


      {/* Notifications Tab */}
      {activeTab === 'notifications' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">{t('settings.notifPrefs')}</CardTitle>
            <CardDescription>{t('settings.notifPrefsDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {notifLoading ? (
              <div className="flex items-center justify-center py-10 text-muted-foreground">
                <Loader2 size={20} className="animate-spin" />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border text-left text-sm text-muted-foreground">
                      <th className="px-4 py-3 font-medium">{t('settings.notifColEvent')}</th>
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
                    {NOTIF_EVENTS.map((ev) => (
                      <tr
                        key={ev.key}
                        className="border-b border-border last:border-0"
                      >
                        <td className="px-4 py-3 text-sm font-medium">{t(ev.labelKey)}</td>
                        {notificationChannels.map((channel) => (
                          <td key={channel.key} className="px-4 py-3 text-center">
                            <button
                              disabled={saveNotifPrefs.isPending}
                              onClick={() =>
                                toggleNotification(ev.key, channel.key)
                              }
                              className={cn(
                                'h-5 w-9 rounded-full transition-colors',
                                notifications[ev.key]?.[channel.key]
                                  ? 'bg-primary'
                                  : 'bg-muted',
                                saveNotifPrefs.isPending && 'opacity-60'
                              )}
                            >
                              <div
                                className={cn(
                                  'h-4 w-4 rounded-full bg-white transition-transform',
                                  notifications[ev.key]?.[channel.key]
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
            )}
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
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <CardTitle className="text-lg">{t('settings.gitTitle')}</CardTitle>
                  <CardDescription>{t('settings.gitDesc')}</CardDescription>
                </div>
                <Button onClick={() => setShowAddGit(true)}>
                  <Plus size={14} /> {t('settings.gitConnect')}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {gitProviders.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                  <GitBranch size={36} className="mb-2" />
                  <p>{t('settings.gitNone')}</p>
                  <p className="text-xs mt-1">{t('settings.gitNoneHint')}</p>
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
                          <Badge variant="success" className="ml-2">{t('settings.gitConnected')}</Badge>
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
              <CardTitle className="text-lg">{t('settings.gitHowTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <div>
                <p className="font-semibold text-foreground">GitHub</p>
                <p>{t('settings.gitHowGithub', { scope: '' }).split('{scope}')[0]}
                  <code className="text-xs bg-muted px-1 rounded">repo</code>
                </p>
              </div>
              <div>
                <p className="font-semibold text-foreground">GitLab</p>
                <p>{t('settings.gitHowGitlab', { scope: '' }).split('{scope}')[0]}
                  <code className="text-xs bg-muted px-1 rounded">read_repository, read_api</code>
                </p>
              </div>
              <div>
                <p className="font-semibold text-foreground">Bitbucket</p>
                <p>{t('settings.gitHowBitbucket', { scope: '' }).split('{scope}')[0]}
                  <code className="text-xs bg-muted px-1 rounded">Repositories: Read</code>
                </p>
              </div>
            </CardContent>
          </Card>

          <Dialog open={showAddGit} onClose={() => setShowAddGit(false)} className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t('settings.gitDlgTitle')}</DialogTitle>
              <DialogDescription>{t('settings.gitDlgDesc')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {/* OAuth (one-click via Device Flow) */}
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                  {t('settings.gitConnectModeOAuth')}
                </p>
                <Button
                  className="w-full justify-start gap-3 h-11"
                  disabled={!githubOAuthStatus?.configured || !!device}
                  onClick={startGithubDeviceFlow}
                >
                  <span className="text-lg">🐙</span> {t('settings.gitOAuthGithub')}
                </Button>
                {!githubOAuthStatus?.configured && (
                  <p className="text-[11px] text-muted-foreground italic">
                    {t('settings.gitOAuthNotConfigured')}
                  </p>
                )}
              </div>

              <div className="relative">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border" /></div>
                <div className="relative flex justify-center text-[10px] uppercase">
                  <span className="bg-background px-2 text-muted-foreground">{t('settings.gitOrPAT')}</span>
                </div>
              </div>

              {/* PAT fallback (advanced) */}
              <details className="space-y-2 rounded-md border border-border p-3 text-sm">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  {t('settings.gitConnectModePat')}
                </summary>
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    <Label>{t('settings.gitProvider')}</Label>
                    <Select value={gitForm.provider} onChange={(e) => setGitForm({ ...gitForm, provider: e.target.value })}>
                      <option value="GITHUB">🐙 GitHub</option>
                      <option value="GITLAB">🦊 GitLab</option>
                      <option value="BITBUCKET">🪣 Bitbucket</option>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>{t('settings.gitDisplayName')}</Label>
                    <Input placeholder={t('settings.gitDisplayPh')} value={gitForm.name}
                      onChange={(e) => setGitForm({ ...gitForm, name: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <Label>{t('settings.gitToken')}</Label>
                    <Input type="password" placeholder="ghp_..." value={gitForm.token}
                      onChange={(e) => setGitForm({ ...gitForm, token: e.target.value })} className="font-mono" />
                  </div>
                  <Button
                    className="w-full"
                    disabled={!gitForm.name || !gitForm.token || addGitMutation.isPending}
                    onClick={() => addGitMutation.mutate(gitForm)}
                  >
                    {addGitMutation.isPending
                      ? <><Loader2 size={14} className="animate-spin" /> {t('settings.gitConnecting')}</>
                      : t('settings.gitConnectBtn')}
                  </Button>
                </div>
              </details>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowAddGit(false)}>{t('common.cancel')}</Button>
            </DialogFooter>
          </Dialog>
        </div>
      )}


      {/* GitHub Device Flow dialog */}
      <Dialog open={!!device} onClose={() => setDevice(null)} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('settings.gitDeviceTitle')}</DialogTitle>
          <DialogDescription>{t('settings.gitDeviceStep1')}</DialogDescription>
        </DialogHeader>
        {device && (
          <div className="space-y-4 py-2">
            <div className="rounded-md border border-border bg-muted/30 p-4 text-center">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                {t('settings.gitDeviceCode')}
              </p>
              <p className="font-mono text-3xl font-bold tracking-widest select-all">
                {device.userCode}
              </p>
            </div>
            <a
              href={device.verificationUriComplete || device.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <Button className="w-full justify-center gap-2 h-11">
                🐙 {t('settings.gitDeviceOpenBtn')}
              </Button>
            </a>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" />
              {t('settings.gitDeviceStep2')}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setDevice(null)}>{t('common.cancel')}</Button>
        </DialogFooter>
      </Dialog>

      {/* 2FA enrollment dialog */}
      <Dialog open={twoFa.step === 'enroll'} onClose={() => setTwoFa({ step: 'idle' })}>
        <DialogHeader>
          <DialogTitle>{t('settings.twoFaEnrollTitle')}</DialogTitle>
          <DialogDescription>{t('settings.twoFaEnrollDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {twoFa.otpauth && (
            <p className="text-xs font-mono break-all text-muted-foreground">
              {twoFa.otpauth}
            </p>
          )}
          {twoFa.secret && (
            <div className="rounded-md border border-border bg-muted/30 p-2.5">
              <Label className="text-[10px] uppercase text-muted-foreground">{t('settings.twoFaSecret')}</Label>
              <p className="font-mono text-xs select-all break-all mt-1">{twoFa.secret}</p>
            </div>
          )}
          <div>
            <Label className="text-xs">{t('settings.twoFaCode')}</Label>
            <Input
              placeholder="123456"
              value={twoFa.code || ''}
              onChange={(e) => setTwoFa((prev) => ({ ...prev, code: e.target.value }))}
              maxLength={6}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setTwoFa({ step: 'idle' })}>{t('common.cancel')}</Button>
          <Button
            disabled={!twoFa.code || enable2faMutation.isPending}
            onClick={() => twoFa.code && enable2faMutation.mutate(twoFa.code)}
          >
            {t('settings.twoFaConfirm')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* 2FA backup codes shown once */}
      <Dialog open={twoFa.step === 'done'} onClose={() => setTwoFa({ step: 'idle' })}>
        <DialogHeader>
          <DialogTitle>{t('settings.twoFaBackupTitle')}</DialogTitle>
          <DialogDescription>{t('settings.twoFaBackupDesc')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {(twoFa.backupCodes || []).map((c) => (
            <code key={c} className="font-mono text-xs bg-muted/30 rounded p-2 text-center">{c}</code>
          ))}
        </div>
        <DialogFooter>
          <Button onClick={() => setTwoFa({ step: 'idle' })}>{t('settings.twoFaDone')}</Button>
        </DialogFooter>
      </Dialog>

      {/* 2FA disable dialog */}
      <Dialog open={twoFa.step === 'disable'} onClose={() => setTwoFa({ step: 'idle' })}>
        <DialogHeader>
          <DialogTitle>{t('settings.twoFaDisableTitle')}</DialogTitle>
          <DialogDescription>{t('settings.twoFaDisableDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">{t('settings.twoFaPassword')}</Label>
            <Input
              type="password"
              value={twoFa.disablePassword || ''}
              onChange={(e) => setTwoFa((prev) => ({ ...prev, disablePassword: e.target.value }))}
            />
          </div>
          <div>
            <Label className="text-xs">{t('settings.twoFaCurrentCode')}</Label>
            <Input
              maxLength={6}
              value={twoFa.disableCode || ''}
              onChange={(e) => setTwoFa((prev) => ({ ...prev, disableCode: e.target.value }))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setTwoFa({ step: 'idle' })}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={!twoFa.disablePassword || !twoFa.disableCode || disable2faMutation.isPending}
            onClick={() => disable2faMutation.mutate({
              password: twoFa.disablePassword || '',
              code: twoFa.disableCode || '',
            })}
          >
            {t('settings.disable')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
