'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

/**
 * Root error boundary. Next.js mounts this whenever a render-time
 * exception escapes a Client Component anywhere under the (dashboard) /
 * (auth) route groups. Without it a single thrown error blanks the whole
 * page and the user can't navigate.
 *
 * `reset` re-mounts the failed sub-tree; we provide a 'Go home' escape
 * too so the user can leave a permanently broken page instead of
 * thrashing reset.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Dashboard render-time exception:', error);
  }, [error]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-xl border border-destructive/40 bg-card p-6 shadow-lg">
        <div className="mb-4 flex items-center gap-3">
          <AlertTriangle className="h-6 w-6 text-destructive" />
          <h1 className="text-lg font-semibold">Something went wrong</h1>
        </div>
        <p className="mb-2 text-sm text-muted-foreground">
          We hit an unexpected error. The dashboard is still alive — pick
          one of the options below.
        </p>
        {error?.message && (
          <pre className="mb-4 max-h-40 overflow-auto rounded-md bg-muted/60 p-3 text-xs">
            {error.message}
          </pre>
        )}
        {error?.digest && (
          <p className="mb-4 text-xs text-muted-foreground">
            Error ref: <code className="font-mono">{error.digest}</code>
          </p>
        )}
        <div className="flex gap-2">
          <Button onClick={() => reset()} className="flex items-center gap-2">
            <RefreshCw size={16} /> Try again
          </Button>
          <Button
            variant="outline"
            onClick={() => { window.location.href = '/dashboard'; }}
            className="flex items-center gap-2"
          >
            <Home size={16} /> Go home
          </Button>
        </div>
      </div>
    </div>
  );
}
