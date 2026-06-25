'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save, Send, KeyRound, Mail, Globe2, Clock } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';

/**
 * Runtime config tab inside Admin. Reads /admin/config (secrets are
 * returned as booleans — true means "set"), patches /admin/config with
 * only the fields the user actually edited. Empty secret inputs are
 * preserved as 'leave alone'. An explicit clear via the "Clear" button
 * sends `null` so the backend deletes the override.
 */
type Snapshot = Record<string, any>;

export function SystemConfigTab() {
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
      // Public URLs.
      public_dashboard_url: snapshot.public_dashboard_url || '',
      public_api_url: snapshot.public_api_url || '',
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
      toast.success(`Saved — ${res.updated} setting(s) updated.`);
      qc.invalidateQueries({ queryKey: ['admin-config'] });
    },
    onError: (err) => toastError(err, 'Save'),
  });

  const testSmtpMutation = useMutation({
    mutationFn: (to?: string) =>
      api.post<{ ok: true; sentTo: string }>('/admin/config/test-smtp', { to }),
    onSuccess: (res) => toast.success(`Test email sent to ${res.sentTo}.`),
    onError: (err) => toastError(err, 'SMTP test'),
  });

  if (isLoading || !snapshot) {
    return <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">Loading…</CardContent></Card>;
  }

  // Build the diff: only fields whose value changed get sent.
  const handleSave = () => {
    const payload: Record<string, any> = {};
    for (const [k, v] of Object.entries(form)) {
      const stored = snapshot[k];
      // For secrets, blank means "no change", anything else is a new value.
      if (k === 'smtp_pass' || k === 'backup_encryption_key') {
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
      toast.message('No changes to save.');
      return;
    }
    saveMutation.mutate(payload);
  };

  const set = (key: string, value: any) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const SmtpHint = ({ active }: { active: boolean }) =>
    active ? (
      <span className="text-[11px] text-muted-foreground">A value is stored. Leave blank to keep it.</span>
    ) : null;

  return (
    <div className="space-y-6">
      {/* ─── SMTP ─────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Mail size={18} /> SMTP / Email
          </CardTitle>
          <CardDescription>
            Outbound mail config. Used for password reset, email verification,
            project invites, deployment outcomes, and monitoring alerts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="smtp_host">Host</Label>
              <Input
                id="smtp_host"
                placeholder="smtp.gmail.com"
                value={form.smtp_host || ''}
                onChange={(e) => set('smtp_host', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_port">Port</Label>
              <Input
                id="smtp_port"
                type="number"
                placeholder="587"
                value={form.smtp_port || ''}
                onChange={(e) => set('smtp_port', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_user">User</Label>
              <Input
                id="smtp_user"
                placeholder="noreply@your-domain.com"
                value={form.smtp_user || ''}
                onChange={(e) => set('smtp_user', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp_pass">Password</Label>
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
              <Label htmlFor="smtp_from">From address</Label>
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
            <Send size={14} /> Send test email
          </Button>
        </CardContent>
      </Card>

      {/* ─── Public URLs ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Globe2 size={18} /> Public URLs
          </CardTitle>
          <CardDescription>
            Where the dashboard and API are reachable from the public internet.
            Used to build links in outgoing emails.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="public_dashboard_url">Dashboard URL</Label>
            <Input
              id="public_dashboard_url"
              placeholder="https://your-domain.com"
              value={form.public_dashboard_url || ''}
              onChange={(e) => set('public_dashboard_url', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="public_api_url">API URL</Label>
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
            <Clock size={18} /> Data retention
          </CardTitle>
          <CardDescription>
            How long historical data is kept. Empty = use the built-in default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid sm:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="metric_retention_days">Server metrics (days)</Label>
              <Input
                id="metric_retention_days"
                type="number"
                placeholder="30"
                value={form.metric_retention_days || ''}
                onChange={(e) => set('metric_retention_days', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="deployment_retention_days">Deployment history (days)</Label>
              <Input
                id="deployment_retention_days"
                type="number"
                placeholder="90"
                value={form.deployment_retention_days || ''}
                onChange={(e) => set('deployment_retention_days', e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit_log_retention_days">Audit logs (days)</Label>
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
            <KeyRound size={18} /> Backup encryption
          </CardTitle>
          <CardDescription>
            Setting this enables AES-256-GCM at-rest encryption for new backups.
            Existing plaintext backups stay readable. Treat the key as a master
            secret — if you lose it, encrypted backups are unrecoverable.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="backup_encryption_key">Backup encryption key (32+ chars)</Label>
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

      {/* Remote backup storage is configured PER PROJECT (Backups page →
          "Remote storage"), not globally — each project brings its own bucket. */}

      {/* ─── Save bar ─────────────────────────────────────────── */}
      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saveMutation.isPending} className="gap-2">
          <Save size={14} /> {saveMutation.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
