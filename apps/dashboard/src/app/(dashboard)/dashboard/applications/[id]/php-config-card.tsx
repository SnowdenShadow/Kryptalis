'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileCode, Loader2, Save } from 'lucide-react';
import type { ApplicationResponse } from '@dockcontrol/types';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

// The full php.ini pack we expose. `kind` drives the input control. Mirrors the
// API's PHP_INI_KEYS / sanitizePhpIni (the backend re-validates everything).
const PHP_INI_FIELDS: {
  key: string;
  kind: 'text' | 'toggle';
  placeholder?: string;
}[] = [
  { key: 'memory_limit', kind: 'text', placeholder: '256M' },
  { key: 'upload_max_filesize', kind: 'text', placeholder: '64M' },
  { key: 'post_max_size', kind: 'text', placeholder: '64M' },
  { key: 'max_execution_time', kind: 'text', placeholder: '120' },
  { key: 'timezone', kind: 'text', placeholder: 'Europe/Paris' },
  { key: 'max_input_vars', kind: 'text', placeholder: '10000' },
  { key: 'short_open_tag', kind: 'toggle' },
];

function iniFromApp(app: ApplicationResponse): Record<string, string> {
  return app?.phpIni && typeof app.phpIni === 'object' ? { ...app.phpIni } : {};
}

/**
 * PHP configuration card — edits the per-app php.ini overrides. Shown on the
 * app detail page's Settings tab when `app.phpConfigurable` is true (PHP_SITE
 * apps AND PHP marketplace apps like PrestaShop). Saving PATCHes phpIni, which
 * triggers a redeploy (the container is recreated; data volume is preserved).
 */
export function PhpConfigCard({ app, appId }: { app: ApplicationResponse; appId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const initial = useMemo(() => iniFromApp(app), [app]);
  const [ini, setIni] = useState<Record<string, string>>(initial);

  const dirty = useMemo(
    () => JSON.stringify(ini) !== JSON.stringify(initial),
    [ini, initial],
  );

  const mutation = useMutation({
    mutationFn: () => {
      // Only send non-empty values; the backend sanitizes + drops the rest.
      const phpIni = Object.fromEntries(
        Object.entries(ini).filter(([, v]) => v && String(v).trim()),
      );
      return api.patch(`/applications/${appId}`, { phpIni });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['application', appId] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      toast.success(t('apps.php.toastApplied'));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const setKey = (key: string, value: string) =>
    setIni((prev) => {
      const next = { ...prev };
      if (value) next[key] = value;
      else delete next[key];
      return next;
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileCode size={18} /> {t('apps.php.title')}
        </CardTitle>
        <CardDescription>{t('apps.php.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PHP_INI_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                {t(`apps.php.${f.key}` as never)}
              </label>
              {f.kind === 'toggle' ? (
                <div className="flex items-center gap-2">
                  {(['On', 'Off'] as const).map((opt) => {
                    const active = (ini[f.key] || '').toLowerCase() === opt.toLowerCase();
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setKey(f.key, active ? '' : opt)}
                        className={
                          'px-3 py-1.5 rounded text-xs font-mono border ' +
                          (active
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'border-input hover:bg-muted')
                        }
                      >
                        {opt}
                      </button>
                    );
                  })}
                  {ini[f.key] && (
                    <span className="text-[11px] text-muted-foreground">
                      {t('apps.php.default')}: {ini[f.key]}
                    </span>
                  )}
                </div>
              ) : (
                <input
                  value={ini[f.key] || ''}
                  onChange={(e) => setKey(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className="w-full px-2.5 py-1.5 rounded border border-input bg-background text-sm font-mono"
                />
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('apps.php.applyHint')}</p>
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!dirty || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            {' '}{t('apps.php.apply')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
