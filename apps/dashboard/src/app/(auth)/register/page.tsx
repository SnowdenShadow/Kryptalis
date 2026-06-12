'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Lock, Mail, Sparkles } from 'lucide-react';

export const dynamic = 'force-dynamic';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { useAuthStore } from '@/lib/store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { useTranslation } from '@/lib/i18n';

export default function RegisterPage() {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [regEnabled, setRegEnabled] = useState<boolean | null>(null);
  const [platformName, setPlatformName] = useState('Kryptalis');
  // After a successful non-bootstrap register the server doesn't issue
  // tokens — it asks the user to verify by email. We flip into this state
  // to show the "check your inbox" view + a "Resend" button instead of
  // redirecting to /dashboard with no session.
  const [pendingVerification, setPendingVerification] = useState(false);
  // When the `require_admin_approval` setting is on, the API returns
  // { pendingApproval: true } — no email round-trip, the account waits
  // for an admin. Show a dedicated screen instead of "check your inbox".
  const [pendingApproval, setPendingApproval] = useState(false);
  const [resending, setResending] = useState(false);
  const { setAuth } = useAuthStore();
  const router = useRouter();
  // Bootstrap banner driven by the SERVER's setup-status — not a query
  // param. The old `?setup=1` approach showed the "you'll become
  // SUPERADMIN" banner on stale/hand-typed links long after bootstrap,
  // and HID it when someone landed on /register directly during a fresh
  // install. null = still loading (banner hidden until resolved).
  const [isSetup, setIsSetup] = useState<boolean | null>(null);

  const strengthScore = (pw: string) => {
    let s = 0;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw)) s++;
    if (/[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    return s;
  };
  const score = strengthScore(password);
  const strengthLabelKey =
    score <= 1 ? 'auth.passwordStrength.weak'
    : score === 2 ? 'auth.passwordStrength.fair'
    : score === 3 ? 'auth.passwordStrength.good'
    : 'auth.passwordStrength.strong';
  const strengthBarColor =
    score <= 1 ? 'bg-destructive'
    : score === 2 ? 'bg-yellow-500'
    : score === 3 ? 'bg-blue-500'
    : 'bg-green-500';
  const passwordsMatch = confirmPassword === '' || password === confirmPassword;

  useEffect(() => {
    api.get<{ registration_enabled?: boolean; platform_name?: string }>('/settings/public')
      .then(s => {
        setRegEnabled(s.registration_enabled ?? true);
        if (s.platform_name) setPlatformName(s.platform_name);
      })
      .catch(() => setRegEnabled(true));
    // Server-authoritative bootstrap detection (see isSetup comment above).
    api.get<{ needsSetup: boolean }>('/auth/setup-status')
      .then((r) => setIsSetup(r.needsSetup))
      .catch(() => setIsSetup(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) return;
    setLoading(true);
    try {
      // Two possible shapes: bootstrap path returns tokens (first install
      // → SUPERADMIN, no email round-trip possible), everyone else gets
      // { message, user } and must verify by email before logging in.
      const res = await api.post<{
        user: { id: string; name: string; email: string; role?: string };
        accessToken?: string;
        message?: string;
        pendingApproval?: boolean;
        active?: boolean;
      }>('/auth/register', { name, email, password });
      if (res.accessToken && res.user.role) {
        setAuth(
          { id: res.user.id, name: res.user.name, email: res.user.email, role: res.user.role },
          res.accessToken,
        );
        router.push('/dashboard');
        toast.success(t('auth.accountCreated'));
      } else if (res.pendingApproval) {
        setPendingApproval(true);
        toast.success(res.message || t('auth.pendingApprovalDesc'));
      } else if (res.active) {
        // No SMTP on this install → the account is immediately ACTIVE,
        // no verification email exists. Straight to login.
        toast.success(res.message || t('auth.accountCreated'));
        router.push('/login');
      } else {
        setPendingVerification(true);
        toast.success(res.message || t('auth.checkEmailToast'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('auth.registrationFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    try {
      const res = await api.post<{ message: string }>('/auth/resend-verification', { email });
      toast.success(res.message || t('auth.resendOk'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('auth.resendFail'));
    } finally {
      setResending(false);
    }
  };

  if (pendingApproval) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Lock className="h-6 w-6" />
            </div>
            <CardTitle>{t('auth.pendingApprovalTitle')}</CardTitle>
            <CardDescription>{t('auth.pendingApprovalDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login" className="block">
              <Button type="button" variant="ghost" className="w-full">
                {t('auth.backToLogin')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (pendingVerification) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Mail className="h-6 w-6" />
            </div>
            <CardTitle>{t('auth.checkEmailTitle')}</CardTitle>
            <CardDescription>
              {(() => {
                const parts = t('auth.checkEmailDesc', { email: '__EMAIL__' }).split('__EMAIL__');
                return (
                  <>
                    {parts[0]}
                    <strong>{email}</strong>
                    {parts[1] || ''}
                  </>
                );
              })()}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              type="button"
              className="w-full"
              variant="outline"
              onClick={handleResend}
              disabled={resending}
            >
              {resending ? t('auth.resending') : t('auth.resendBtn')}
            </Button>
            <Link href="/login" className="block">
              <Button type="button" variant="ghost" className="w-full">
                {t('auth.backToLogin')}
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  // "Registration disabled" never applies to the bootstrap path — the
  // server lets the FIRST account through regardless of the setting (it
  // has to, or a fresh install with registration_enabled=false would be
  // unusable). Mirror that here instead of dead-ending the operator.
  if (regEnabled === false && isSetup !== true) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <CardTitle>{t('auth.regDisabled')}</CardTitle>
            <CardDescription>
              {platformName} — {t('auth.regDisabledDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/login">
              <Button className="w-full">{t('auth.signIn')}</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground text-xl font-bold">
            K
          </div>
          <CardTitle>
            {isSetup ? t('auth.setupTitle') : t('auth.registerTitle')}
          </CardTitle>
          <CardDescription>
            {isSetup ? t('auth.setupDesc') : t('auth.registerDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isSetup && (
            <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 p-3 flex items-start gap-2">
              <Sparkles size={16} className="text-primary mt-0.5 shrink-0" />
              <div className="text-xs space-y-1">
                <p className="font-medium">{t('auth.setupBootstrapTitle')}</p>
                <p className="text-muted-foreground">{t('auth.setupBootstrapDesc')}</p>
              </div>
            </div>
          )}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('auth.name')}</Label>
              <Input
                id="name"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder="john@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
              />
              {password.length > 0 && (
                <div className="space-y-1">
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full ${i < score ? strengthBarColor : 'bg-muted'}`}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">{t(strengthLabelKey)}</p>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">{t('auth.confirmPassword')}</Label>
              <Input
                id="confirmPassword"
                type="password"
                placeholder="••••••••"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
              />
              {!passwordsMatch && (
                <p className="text-xs text-destructive">{t('auth.passwordsDontMatch')}</p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={loading || password !== confirmPassword}>
              {loading ? t('auth.creatingAccount') : t('auth.register')}
            </Button>
          </form>
          <div className="mt-4 text-center text-sm text-muted-foreground">
            {t('auth.hasAccount')}{' '}
            <Link href="/login" className="text-primary hover:underline">
              {t('auth.signIn')}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
