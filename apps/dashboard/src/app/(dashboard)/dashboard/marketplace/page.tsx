'use client';

import { useState, useMemo } from 'react';
import { Search, Container, Package } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { QuickDeployDialog } from '../applications/quick-deploy';

/**
 * Marketplace page — slimmed down.
 *
 * The whole deploy flow (server / project / domain / env / start) lives
 * in `QuickDeployDialog`. This page is now ONLY a catalog browser:
 * pick a card → opens the dialog in marketplace mode pre-focused on
 * that app. The dialog handles everything else.
 *
 * Replaces the previous 3-dialog mess (install + custom image +
 * progress modal) — all those flows now go through the same screen
 * users already know from /dashboard/applications.
 */

interface MarketplaceApp {
  name: string;
  slug: string;
  description: string;
  category: string;
  icon: string;
  iconUrl?: string;
  ports: number[];
}

const CATEGORIES = [
  'All',
  'DevOps',
  'Automation',
  'Backend',
  'CMS',
  'Collaboration',
  'Storage',
  'Databases',
  'Email',
  'Dev',
];

// Fallback emoji when an app has no iconUrl in the catalog. Keep narrow —
// the catalog itself ships iconUrls for the common cases.
const FALLBACK_ICON: Record<string, string> = {
  portainer: '🐳', grafana: '📊', 'uptime-kuma': '💓', n8n: '🤖',
  supabase: '⚡', wordpress: '✏️', ghost: '👻', minio: '🪣',
  nextcloud: '☁️', postgresql: '🐘', redis: '⚡', appwrite: '🔧',
  prestashop: '🛒', mysql: '🐬', mongodb: '🍃', mariadb: '🦭',
  gitea: '🍵', vaultwarden: '🔐', plausible: '📈', 'code-server': '💻',
  roundcube: '📮', snappymail: '✉️', rainloop: '☔', mailpit: '🧪',
  postal: '📬', mailu: '🛡️',
  // DB management tools
  dbgate: '🗄️', adminer: '🔍', phpmyadmin: '🐬',
  pgadmin: '🐘', 'mongo-express': '🍃', redisinsight: '⚡',
};

export default function MarketplacePage() {
  const { t } = useTranslation();

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState('All');

  // Dialog state — when set, QuickDeployDialog opens pre-focused on
  // that app (marketplace mode) or in docker mode for the custom-image
  // button. `null` keeps it closed.
  const [deployFor, setDeployFor] = useState<
    | { kind: 'marketplace'; slug: string }
    | { kind: 'custom-image' }
    | null
  >(null);

  const { data: apps = [] } = useQuery<MarketplaceApp[]>({
    queryKey: ['marketplace-apps'],
    queryFn: () => api.get('/marketplace'),
  });

  const filteredApps = useMemo(() => {
    const q = search.trim().toLowerCase();
    return apps.filter((app) => {
      const matchesSearch =
        !q ||
        app.name.toLowerCase().includes(q) ||
        app.description.toLowerCase().includes(q) ||
        app.slug.toLowerCase().includes(q);
      const matchesCategory = activeCategory === 'All' || app.category === activeCategory;
      return matchesSearch && matchesCategory;
    });
  }, [apps, search, activeCategory]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">{t('marketplace.title')}</h1>
          <p className="text-muted-foreground">{t('marketplace.subtitle')}</p>
        </div>
        <Button onClick={() => setDeployFor({ kind: 'custom-image' })}>
          <Container size={14} /> {t('marketplace.deployCustom') || 'Deploy custom image'}
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder={t('marketplace.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Categories */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((category) => (
          <Button
            key={category}
            variant={activeCategory === category ? 'default' : 'outline'}
            size="sm"
            onClick={() => setActiveCategory(category)}
          >
            {category}
          </Button>
        ))}
      </div>

      {/* App grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filteredApps.map((app) => (
          <Card
            key={app.slug}
            className="hover:border-primary/50 cursor-pointer transition-colors"
            onClick={() => setDeployFor({ kind: 'marketplace', slug: app.slug })}
          >
            <CardHeader>
              <div className="flex items-center gap-3">
                {app.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={app.iconUrl} alt="" className="h-9 w-9 rounded shrink-0 object-contain" />
                ) : (
                  <span className="text-3xl shrink-0">{FALLBACK_ICON[app.slug] || '📦'}</span>
                )}
                <div className="min-w-0">
                  <CardTitle className="text-lg truncate">{app.name}</CardTitle>
                  <Badge variant="outline" className="mt-1">
                    {app.category}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <CardDescription className="line-clamp-2">
                {app.description}
              </CardDescription>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Empty state */}
      {filteredApps.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Search size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('marketplace.noResults')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('marketplace.noResultsDesc')}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Single unified deploy dialog — same one used on /applications. */}
      <QuickDeployDialog
        open={!!deployFor}
        onClose={() => setDeployFor(null)}
        initialMode={
          deployFor?.kind === 'marketplace'
            ? 'marketplace'
            : deployFor?.kind === 'custom-image'
              ? 'docker'
              : undefined
        }
        initialMarketplaceSlug={
          deployFor?.kind === 'marketplace' ? deployFor.slug : undefined
        }
      />
    </div>
  );
}
