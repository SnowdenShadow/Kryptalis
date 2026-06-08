'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { useAuthStore } from '@/lib/store';
import { api, ApiError } from '@/lib/api';
import { toast } from 'sonner';
import { useTranslation } from '@/lib/i18n';

/**
 * Login flow with two-factor support.
 *
 * - First submit sends email + password.
 * - When the user has 2FA enabled, the backend responds 401 with
 *   `Two-factor code required`. We surface a TOTP field and submit again
 *   with `totpCode` (or `backupCode`).
 * - Until that step is reached we don't ask for a TOTP code at all, so
 *   users without 2FA never see the extra input.
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);
  const [loading, setLoading] = useState(false);
  const { setAuth } = useAuthStore();
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const body: any = { email, password };
      if (twoFactorRequired && totpCode) {
        if (useBackup) body.backupCode = totpCode.replace(/\s+/g, '');
        else body.totpCode = totpCode.replace(/\s+/g, '');
      }
      const res = await api.post<{
        user: { id: string; name: string; email: string; role: string };
        accessToken: string;
        refreshToken: string;
      }>('/auth/login', body);
      setAuth(res.user, res.accessToken, res.refreshToken);
      router.push('/dashboard');
      toast.success(t('auth.welcomeBack') || 'Welcome back!');
    } catch (err) {
      // Backend signals 'Two-factor code required' on the first call when 2FA
      // is enabled. Switch into the totp prompt without flashing an error.
      const msg = err instanceof Error ? err.message : 'Login failed';
      if (/two[- ]?factor/i.test(msg)) {
        setTwoFactorRequired(true);
        setTotpCode('');
        setLoading(false);
        return;
      }
      // ApiError keeps the original status, useful to distinguish 401 vs 5xx
      const status = err instanceof ApiError ? err.status : 0;
      toast.error(status >= 500 ? (t('errors.server') || 'Server error — try again') : msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground text-xl font-bold">
            K
          </div>
          <CardTitle>{t('auth.loginTitle')}</CardTitle>
          <CardDescription>{t('auth.loginDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input
                id="email"
                type="email"
                placeholder="john@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={twoFactorRequired}
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
                autoComplete="current-password"
                disabled={twoFactorRequired}
              />
            </div>
            {twoFactorRequired && (
              <div className="space-y-2">
                <Label htmlFor="totp">
                  {useBackup
                    ? t('auth.backupCode') || 'Backup code'
                    : t('auth.totpCode') || 'Two-factor code'}
                </Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  placeholder={useBackup ? 'aaaaaaaaaa' : '123 456'}
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  required
                  maxLength={useBackup ? 10 : 7}
                />
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline"
                  onClick={() => { setUseBackup((v) => !v); setTotpCode(''); }}
                >
                  {useBackup
                    ? t('auth.useAuthenticator') || 'Use authenticator app instead'
                    : t('auth.useBackup') || 'Lost device? Use a backup code'}
                </button>
              </div>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
          </form>
          <div className="mt-4 text-center text-sm text-muted-foreground">
            {t('auth.noAccount')}{' '}
            <Link href="/register" className="text-primary hover:underline">
              {t('auth.signUp')}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
