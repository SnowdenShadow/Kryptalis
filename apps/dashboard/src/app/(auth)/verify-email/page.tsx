'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { useAuthStore } from '@/lib/store';
import { api } from '@/lib/api';
import { toast } from 'sonner';

type State = 'pending' | 'success' | 'error';

/**
 * Lands here from the verification email link: ?token=... → POST to
 * /auth/verify-email, store the returned token pair, redirect to /dashboard.
 *
 * StrictMode double-mounts effects in dev, which would consume the
 * single-use token on the very first render. We guard with a ref so the
 * second mount no-ops.
 */
export default function VerifyEmailPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { setAuth } = useAuthStore();
  const [state, setState] = useState<State>('pending');
  const [error, setError] = useState<string>('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const token = params.get('token');
    if (!token) {
      setState('error');
      setError('Missing verification token');
      return;
    }
    (async () => {
      try {
        const res = await api.post<{
          user: { id: string; name: string; email: string; role: string };
          accessToken: string;
          refreshToken: string;
        }>('/auth/verify-email', { token });
        setAuth(res.user, res.accessToken, res.refreshToken);
        setState('success');
        toast.success('Email verified!');
        // Small delay so the user actually sees the success card.
        setTimeout(() => router.push('/dashboard'), 800);
      } catch (err) {
        setState('error');
        setError(err instanceof Error ? err.message : 'Verification failed');
      }
    })();
  }, [params, router, setAuth]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
            {state === 'pending' && <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
            {state === 'success' && <CheckCircle2 className="h-6 w-6 text-green-500" />}
            {state === 'error' && <XCircle className="h-6 w-6 text-destructive" />}
          </div>
          <CardTitle>
            {state === 'pending' && 'Verifying your email'}
            {state === 'success' && 'Email verified'}
            {state === 'error' && 'Verification failed'}
          </CardTitle>
          <CardDescription>
            {state === 'pending' && 'One moment while we confirm your account.'}
            {state === 'success' && 'Redirecting you to your dashboard...'}
            {state === 'error' && (error || 'Your verification link is invalid or expired.')}
          </CardDescription>
        </CardHeader>
        {state === 'error' && (
          <CardContent className="space-y-3">
            <Link href="/register" className="block">
              <Button type="button" variant="outline" className="w-full">
                Request a new link
              </Button>
            </Link>
            <Link href="/login" className="block">
              <Button type="button" variant="ghost" className="w-full">
                Back to sign in
              </Button>
            </Link>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
