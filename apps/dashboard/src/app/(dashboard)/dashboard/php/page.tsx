'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

/**
 * PHP sites are no longer a separate section — a PHP site IS an Application
 * (framework PHP_SITE). This route is kept only so old links/bookmarks don't
 * 404: it redirects to the Applications list pre-filtered to PHP.
 */
export default function PhpSitesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/dashboard/applications?type=php');
  }, [router]);

  return (
    <div className="flex items-center justify-center py-24 text-muted-foreground">
      <Loader2 className="animate-spin" size={20} />
    </div>
  );
}
