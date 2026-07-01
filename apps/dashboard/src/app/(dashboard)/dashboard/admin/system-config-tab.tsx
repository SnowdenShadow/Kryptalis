'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save, Send, KeyRound, Mail, Globe2, Clock, CloudUpload } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { useTranslation } from '@/lib/i18n';

/**
 * Runtime config tab inside Admin. Reads /admin/config (secrets are
 * returned as booleans — true means "set"), patches /admin/config with
 * only the fields the user actually edited. Empty secret inputs are
 * preserved as 'leave alone'. An explicit clear via the "Clear" button
 * sends `null` so the backend deletes the override.
 */
type Snapshot = Record<string, any>;

export function SystemConfigTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: snapshot, isLoading } = useQuery<Snapshot>({
    queryKey: ['admin-config'],
    queryFn: () => api.get<Snapshot>('/admin/config'),
  });

  // Local form state. Secrets stay '' on load; the boolean from the API
  // is shown as a hint instead of populating the input.
  const [form, setForm] = useState<Record<string, any>>({});
  useEffect(() => {
    if (!snapshot) return;
    setForm({
      // Non-secret values get echoed back from the API.
      smtp_host: snapshot.smtp_host || '',
      smtp_port: snapshot.smtp_port || '',
      smtp_user: snapshot.smtp_user || '',
      smtp_from: snapshot.smtp_from || '',
      // Secrets: blank input = keep existing.
      smtp_pass: '',
      backup_encryption_key: '',
      s3_secret_key: '',
      // Whole-server backup storage (non-secret parts).
      s3_endpoint: snapshot.s3_endpoint || '',
      s3_bucket: snapshot.s3_bucket || '',
      s3_region: snapshot.s3_region || '',
      s3_access_key: snapshot.s3_access_key || '',
      // Public URLs.
      public_dashboard_url: snapshot.public_dashboard_url || '',
      public_api_url: snapshot.public_api_url || '',
      // Gitea/Forgejo OAuth app (self-hosted). client_secret is a secret → blank.
      gitea_oauth_base_url: snapshot.gitea_oauth_base_url || '',
      gitea_oauth_provider: snapshot.gitea_oauth_provider || 'GITEA',
      gitea_oauth_client_id: snapshot.gitea_oauth_client_id || '',
      gitea_oauth_client_secret: '',
      // Retention windows (days).
      metric_retention_days: snapshot.metric_retention_days ?? '',
      deployment_retention_days: snapshot.deployment_retention_days ?? '',
      audit_log_retention_days: snapshot.audit_log_retention_days ?? '',
      // Toggles.
      registration_enabled:
        snapshot.registration_enabled === undefined ? true : !!snapshot.registration_enabled,
    });
  }, [snapshot]);

  const saveMutation = useMutation({
    mutationFn: (payload: Record<string, any>) =>
      api.patch<{ updated: number; removed: number }>('/admin/config', payload),
    onSuccess: (res) => {
      toast.success(t('admin.sys.saved', { n: res.updated }));
      qc.invalidateQueries({ queryKey: ['admin-config'] });
    },
    onError: (err) => toastError(err, t('admin.sys.saveError')),
  });

  const testSmtpMutation = useMutation({
    mutationFn: (to?: string) =>
      api.post<{ ok: true; sentTo: string }>('/admin/config/test-smtp', { to }),
    onSuccess: (res) => toast.success(t('admin.sys.smtpTestSent', { to: res.sentTo })),
    onError: (err) => toastError(err, t('admin.sys.smtpTestError')),
  });

  if (isLoading || !snapshot) {
    return <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">{t('admin.sys.loading')}</CardContent></Card>;
  }

  // Build the diff: only fields whose value changed get sent.
  const handleSave = () => {
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(form)) {
      const stored = snapshot[k];
      // For secrets, blank means "no change", anything else is a new value.
      if (k === 'smtp_pass' || k === 'backup_encryption_key' || k === 's3_secret_key' || k === 'gitea_oauth_client_secret') {
        if (v !== '' && v !== undefined) payload[k] = v;
        continue;
      }
      // For numbers, coerce empty string → null (delete override).
      if (k.endsWith('_days')) {
        if (v === '' || v === null) {
          if (stored !== undefined && stored !== null) payload[k] = null;
        } else if (Number(v) !== Number(stored)) {
          payload[k] = Number(v);
        }
        continue;
      }
      if (typeof v === 'boolean') {
        if (v !== !!stored) payload[k] = v;
        continue;
      }
      if (String(v ?? '') !== String(stored ?? '')) payload[k] = v;
    }
    if (Object.keys(payload).length === 0) {
      toast.message(t('admin.sys.noChanges'));
      return;
    }
    saveMutation.mutate(payload);
  };

  const set = (key: string, value: any) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const SmtpHint = ({ active }: { active: boolean }) =>
    active ? (
      <span className="text-[11px] text-muted-foreground">{t('admin.sys.secretStored')}</span>
    ) : null;

  return (
    <div className="space-y-6">
      {/* ─── SMTP ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Mail size={18} /> {t('admin.sys.smtpTitle')}
          </CardTitle>
          <CardDescription>{t('admin.sys.smtpDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="smtp_host">{t('admin.sys.smtpHost')}</Label>
              <Input
                id="smtp_host"
                placeholder="smtp.gmail.com"
                value={form.smtp_host || ''}
                onChange={(e) => set('smtp_host', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_port">{t('admin.sys.smtpPort')}</Label>
              <Input
                id="smtp_port"
                type="number"
                placeholder="587"
                value={form.smtp_port || ''}
                onChange={(e) => set('smtp_port', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_user">{t('admin.sys.smtpUser')}</Label>
              <Input
                id="smtp_user"
                placeholder="noreply@your-domain.com"
                value={form.smtp_user || ''}
                onChange={(e) => set('smtp_user', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_pass">{t('admin.sys.smtpPass')}</Label>
              <Input
                id="smtp_pass"
                type="password"
                placeholder="••••••••"
                value={form.smtp_pass || ''}
                onChange={(e) => set('smtp_pass', e.target.value)}
              />
              <SmtpHint active={!!snapshot.smtp_pass} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="smtp_from">{t('admin.sys.smtpFrom')}</Label>
              <Input
                id="smtp_from"
                placeholder='"DockControl" <noreply@your-domain.com>'
                value={form.smtp_from || ''}
                onChange={(e) => set('smtp_from', e.target.value)}
              />
            </div>
          </div>
          <Button
            variant="outline"
            disabled={testSmtpMutation.isPending || !snapshot.smtp_host}
            onClick={() => testSmtpMutation.mutate(undefined)}
            className="gap-2"
          >
            <Send size={14} /> {t('admin.sys.smtpTest')}
          </Button>
        </CardContent>
      </Card>

      {/* ─── Public URLs ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Globe2 size={18} /> {t('admin.sys.urlsTitle')}
          </CardTitle>
          <CardDescription>{t('admin.sys.urlsDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="public_dashboard_url">{t('admin.sys.dashboardUrl')}</Label>
            <Input
              id="public_dashboard_url"
              placeholder="https://your-domain.com"
              value={form.public_dashboard_url || ''}
              onChange={(e) => set('public_dashboard_url', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="public_api_url">{t('admin.sys.apiUrl')}</Label>
            <Input
              id="public_api_url"
              placeholder="https://api.your-domain.com"
              value={form.public_api_url || ''}
              onChange={(e) => set('public_api_url', e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {/* ─── Retention ────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Clock size={18} /> {t('admin.sys.retentionTitle')}
          </CardTitle>
          <CardDescription>{t('admin.sys.retentionDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="metric_retention_days">{t('admin.sys.metricDays')}</Label>
              <Input
                id="metric_retention_days"
                type="number"
                placeholder="30"
                value={form.metric_retention_days || ''}
                onChange={(e) => set('metric_retention_days', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deployment_retention_days">{t('admin.sys.deployDays')}</Label>
              <Input
                id="deployment_retention_days"
                type="number"
                placeholder="90"
                value={form.deployment_retention_days || ''}
                onChange={(e) => set('deployment_retention_days', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit_log_retention_days">{t('admin.sys.auditDays')}</Label>
              <Input
                id="audit_log_retention_days"
                type="number"
                placeholder="365"
                value={form.audit_log_retention_days || ''}
                onChange={(e) => set('audit_log_retention_days', e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Security keys ────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound size={18} /> {t('admin.sys.encTitle')}
          </CardTitle>
          <CardDescription>{t('admin.sys.encDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="backup_encryption_key">{t('admin.sys.encKey')}</Label>
            <Input
              id="backup_encryption_key"
              type="password"
              placeholder="••••••••••••"
              value={form.backup_encryption_key || ''}
              onChange={(e) => set('backup_encryption_key', e.target.value)}
            />
            <SmtpHint active={!!snapshot.backup_encryption_key} />
          </div>
        </CardContent>
      </Card>

      {/* ─── Whole-server backup storage (admin) ──────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <CloudUpload size={18} /> {t('admin.sys.s3Title')}
          </CardTitle>
          <CardDescription>
            {t('admin.sys.s3Desc')}{' '}
            <code className="text-xs">dockcontrol-backups/&lt;backupId&gt;/</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="s3_endpoint">{t('admin.sys.s3Endpoint')}</Label>
              <Input
                id="s3_endpoint"
                placeholder="https://<accountid>.r2.cloudflarestorage.com"
                value={form.s3_endpoint || ''}
                onChange={(e) => set('s3_endpoint', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s3_bucket">{t('admin.sys.s3Bucket')}</Label>
              <Input
                id="s3_bucket"
                placeholder="dockcontrol-backups"
                value={form.s3_bucket || ''}
                onChange={(e) => set('s3_bucket', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s3_region">{t('admin.sys.s3Region')}</Label>
              <Input
                id="s3_region"
                placeholder="auto"
                value={form.s3_region || ''}
                onChange={(e) => set('s3_region', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s3_access_key">{t('admin.sys.s3AccessKey')}</Label>
              <Input
                id="s3_access_key"
                placeholder="AKIA…"
                value={form.s3_access_key || ''}
                onChange={(e) => set('s3_access_key', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="s3_secret_key">{t('admin.sys.s3SecretKey')}</Label>
              <Input
                id="s3_secret_key"
                type="password"
                placeholder="••••••••"
                value={form.s3_secret_key || ''}
                onChange={(e) => set('s3_secret_key', e.target.value)}
              />
              <SmtpHint active={!!snapshot.s3_secret_key} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Gitea / Forgejo OAuth ────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <KeyRound size={18} /> {t('admin.sys.giteaTitle')}
          </CardTitle>
          <CardDescription>{t('admin.sys.giteaDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="gitea_oauth_provider">{t('admin.sys.giteaProvider')}</Label>
              <select
                id="gitea_oauth_provider"
                className="flex h-10 w-full rounded-lg border border-zinc-700/70 bg-zinc-950/40 px-3 text-sm"
                value={form.gitea_oauth_provider || 'GITEA'}
                onChange={(e) => set('gitea_oauth_provider', e.target.value)}
              >
                <option value="GITEA">Gitea</option>
                <option value="FORGEJO">Forgejo</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gitea_oauth_base_url">{t('admin.sys.giteaBaseUrl')}</Label>
              <Input
                id="gitea_oauth_base_url"
                placeholder="https://git.example.com"
                value={form.gitea_oauth_base_url || ''}
                onChange={(e) => set('gitea_oauth_base_url', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gitea_oauth_client_id">{t('admin.sys.giteaClientId')}</Label>
              <Input
                id="gitea_oauth_client_id"
                placeholder="abcdef12-3456-…"
                value={form.gitea_oauth_client_id || ''}
                onChange={(e) => set('gitea_oauth_client_id', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="gitea_oauth_client_secret">{t('admin.sys.giteaClientSecret')}</Label>
              <Input
                id="gitea_oauth_client_secret"
                type="password"
                placeholder="••••••••"
                value={form.gitea_oauth_client_secret || ''}
                onChange={(e) => set('gitea_oauth_client_secret', e.target.value)}
              />
              <SmtpHint active={!!snapshot.gitea_oauth_client_secret} />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('admin.sys.giteaHint')}</p>
        </CardContent>
      </Card>

      {/* ─── Save bar ─────────────────────────────────────────── */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saveMutation.isPending} className="gap-2">
          <Save size={14} /> {saveMutation.isPending ? t('admin.sys.saving') : t('admin.sys.save')}
        </Button>
      </div>
    </div>
  );
}
