'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { useAuthStore } from '@/lib/store';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { useTranslation } from '@/lib/i18n';

// Next 15 refuses to statically prerender a page that calls
// useSearchParams() without an enclosing <Suspense>. The verification
// link is hit live (token comes from the URL the user just clicked) so
// there's nothing to prerender — opt out explicitly and wrap the
// stateful body in Suspense to satisfy the Next.js build constraint.
export const dynamic = 'force-dynamic';

type State = 'pending' | 'success' | 'error';

/**
 * Lands here from the verification email link: ?token=... → POST to
 * /auth/verify-email, store the returned token pair, redirect to /dashboard.
 *
 * StrictMode double-mounts effects in dev, which would consume the
 * single-use token on the very first render. We guard with a ref so the
 * second mount no-ops.
 */
function VerifyEmailInner() {
  const { t } = useTranslation();
  const router = useRouter();
  const params = useSearchParams();
  const { setAuth } = useAuthStore();
  const [state, setState] = useState<State>('pending');
  // 'missing' → no token in URL; otherwise the raw API error message
  // (server-provided, shown as-is) or '' for the generic fallback.
  const [error, setError] = useState<string>('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = params?.get('token');
    if (!token) {
      setState('error');
      setError('missing');
      return;
    }
    (async () => {
      try {
        const res = await api.post<{
          user: { id: string; name: string; email: string; role: string };
          accessToken: string;
        }>('/auth/verify-email', { token });
        setAuth(res.user, res.accessToken);
        setState('success');
        toast.success(t('auth.verifySuccessToast'));
        setTimeout(() => router.push('/dashboard'), 800);
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err.message : '');
      }
    })();
  }, [params, router, setAuth, t]);

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
          {state === 'pending' && <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
          {state === 'success' && <CheckCircle2 className="h-6 w-6 text-green-500" />}
          {state === 'error' && <XCircle className="h-6 w-6 text-destructive" />}
        </div>
        <CardTitle>
          {state === 'pending' && t('auth.verifyTitle')}
          {state === 'success' && t('auth.verifySuccessTitle')}
          {state === 'error' && t('auth.verifyFailTitle')}
        </CardTitle>
        <CardDescription>
          {state === 'pending' && t('auth.verifyPendingDesc')}
          {state === 'success' && t('auth.verifySuccessDesc')}
          {state === 'error' && (
            error === 'missing'
              ? t('auth.verifyMissingToken')
              : error || t('auth.verifyFailDesc')
          )}
        </CardDescription>
      </CardHeader>
      {state === 'error' && (
        <CardContent className="space-y-3">
          <Link href="/register" className="block">
            <Button type="button" variant="outline" className="w-full">
              {t('auth.verifyRequestNew')}
            </Button>
          </Link>
          <Link href="/login" className="block">
            <Button type="button" variant="ghost" className="w-full">
              {t('auth.backToLogin')}
            </Button>
          </Link>
        </CardContent>
      )}
    </Card>
  );
}

export default function VerifyEmailPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Suspense
        fallback={
          <Card className="w-full max-w-md">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
              <CardTitle>{t('auth.verifyTitle')}</CardTitle>
            </CardHeader>
          </Card>
        }
      >
        <VerifyEmailInner />
      </Suspense>
    </div>
  );
}
