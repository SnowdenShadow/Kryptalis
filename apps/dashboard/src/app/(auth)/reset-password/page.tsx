'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { useTranslation } from '@/lib/i18n';

// Same Next 15 constraint as verify-email: useSearchParams() needs a
// Suspense boundary and the page can't be statically prerendered (the
// token arrives live in the URL).
export const dynamic = 'force-dynamic';

function ResetPasswordInner() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useSearchParams();
  const token = params?.get('token') || '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  // Accounts with 2FA enabled must also present a TOTP/backup code — the
  // API answers 400 'Two-factor code required' on the first attempt.
  const [twoFactorRequired, setTwoFactorRequired] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [useBackup, setUseBackup] = useState(false);

  const passwordsMatch = confirmPassword === '' || password === confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) return;
    setLoading(true);
    try {
      const body: any = { token, newPassword: password };
      if (twoFactorRequired && totpCode) {
        if (useBackup) body.backupCode = totpCode.replace(/\s+/g, '');
        else body.totpCode = totpCode.replace(/\s+/g, '');
      }
      await api.post('/auth/reset-password', body);
      toast.success(t('auth.resetSuccess'));
      router.push('/login');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Reset failed';
      if (/two[- ]?factor/i.test(msg) && !twoFactorRequired) {
        setTwoFactorRequired(true);
        setLoading(false);
        return;
      }
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle>{t('auth.resetTitle')}</CardTitle>
          <CardDescription>{t('auth.missingResetToken')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/forgot-password" className="block">
            <Button type="button" className="w-full">{t('auth.forgotTitle')}</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound className="h-6 w-6" />
        </div>
        <CardTitle>{t('auth.resetTitle')}</CardTitle>
        <CardDescription>{t('auth.resetDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">{t('auth.newPassword')}</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
              autoFocus
            />
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
              minLength={12}
              autoComplete="new-password"
            />
            {!passwordsMatch && (
              <p className="text-xs text-destructive">{t('auth.passwordsDontMatch')}</p>
            )}
          </div>
          {twoFactorRequired && (
            <div className="space-y-2">
              <Label htmlFor="totp">
                {useBackup ? t('auth.backupCode') : t('auth.totpCode')}
              </Label>
              <Input
                id="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                placeholder={useBackup ? 'aaaaa-aaaaa-aaaaa-aaaaa' : '123 456'}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                required
              />
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline"
                onClick={() => { setUseBackup((v) => !v); setTotpCode(''); }}
              >
                {useBackup ? t('auth.useAuthenticator') : t('auth.useBackup')}
              </button>
            </div>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={loading || password !== confirmPassword}
          >
            {loading ? t('auth.resetting') : t('auth.resetPassword')}
          </Button>
          <div className="text-center text-sm text-muted-foreground">
            <Link href="/login" className="text-primary hover:underline">
              {t('auth.backToLogin')}
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Suspense fallback={null}>
        <ResetPasswordInner />
      </Suspense>
    </div>
  );
}
