'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock, Mail, Sparkles } from 'lucide-react';

// Next 15 refuses to statically prerender a page that calls
// useSearchParams() without an enclosing <Suspense>. Same fix as
// verify-email — opt the page out of static rendering and wrap the
// body in Suspense.
export const dynamic = 'force-dynamic';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { useAuthStore } from '@/lib/store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { useTranslation } from '@/lib/i18n';

// Wrapper — keeps Next.js happy about useSearchParams() needing a
// Suspense boundary. The real body lives in RegisterPageInner.
export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <RegisterPageInner />
    </Suspense>
  );
}

function RegisterPageInner() {
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
  const [resending, setResending] = useState(false);
  const { setAuth } = useAuthStore();
  const router = useRouter();
  const searchParams = useSearchParams();
  // `?setup=1` is appended by the landing page when the API reports
  // `needsSetup`. We use it ONLY to show a welcome banner — the actual
  // "becomes SUPERADMIN" decision is server-side at register time, so a
  // stale link or hand-typed query can't escalate privileges.
  const isSetup = searchParams.get('setup') === '1';

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
        refreshToken?: string;
        message?: string;
      }>('/auth/register', { name, email, password });
      if (res.accessToken && res.refreshToken && res.user.role) {
        setAuth(
          { id: res.user.id, name: res.user.name, email: res.user.email, role: res.user.role },
          res.accessToken,
          res.refreshToken,
        );
        router.push('/dashboard');
        toast.success('Account created!');
      } else {
        setPendingVerification(true);
        toast.success(res.message || 'Check your email to verify your account');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setResending(true);
    try {
      const res = await api.post<{ message: string }>('/auth/resend-verification', { email });
      toast.success(res.message || 'Verification email resent');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to resend');
    } finally {
      setResending(false);
    }
  };

  if (pendingVerification) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Mail className="h-6 w-6" />
            </div>
            <CardTitle>Check your email</CardTitle>
            <CardDescription>
              We sent a verification link to <strong>{email}</strong>. Click it to activate your account.
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
              {resending ? 'Sending...' : 'Resend verification email'}
            </Button>
            <Link href="/login" className="block">
              <Button type="button" variant="ghost" className="w-full">
                Back to sign in
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (regEnabled === false) {
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
            {isSetup ? 'Create your Kryptalis admin' : t('auth.registerTitle')}
          </CardTitle>
          <CardDescription>
            {isSetup
              ? 'Welcome — this is the first account on this install. It will be promoted to SUPERADMIN automatically.'
              : t('auth.registerDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isSetup && (
            <div className="mb-4 rounded-md border border-primary/30 bg-primary/5 p-3 flex items-start gap-2">
              <Sparkles size={16} className="text-primary mt-0.5 shrink-0" />
              <div className="text-xs space-y-1">
                <p className="font-medium">First-install bootstrap</p>
                <p className="text-muted-foreground">
                  After this account is created, the setup wizard goes away
                  and every later signup becomes a regular USER. Pick a
                  strong password — you can't downgrade or rotate this
                  account without root DB access.
                </p>
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
