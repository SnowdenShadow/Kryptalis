'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Shield, Plus, Trash2, Loader2, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/toast-error';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';

/**
 * Custom-role manager for a project. Lets ADMIN+ create reusable named roles
 * with a fine-grained permission grid, capped to the chosen base role. The
 * grid comes from GET /projects/rbac-catalog (resources → actions).
 */

type BaseRole = 'ADMIN' | 'DEVELOPER' | 'VIEWER';

interface CustomRole {
  id: string;
  name: string;
  baseRole: BaseRole;
  permissions: string[];
  _count?: { members: number };
}
interface Catalog {
  resources: Record<string, string[]>;
  all: string[];
}

// Which permissions each base role is allowed to grant — mirrors the API's
// permissionsForRole so the UI disables (greys) perms above the base role.
function presetFor(base: BaseRole, catalog: Catalog): Set<string> {
  if (base === 'ADMIN') return new Set(catalog.all);
  if (base === 'VIEWER') return new Set(catalog.all.filter((p) => p.endsWith(':view')));
  // DEVELOPER: everything except the admin-only surfaces (none in the grid) —
  // in practice the full catalog minus nothing, but we mirror the API subset by
  // allowing every catalog perm (the API caps precisely on write anyway).
  return new Set(catalog.all);
}

export function CustomRolesManager({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data: roles = [] } = useQuery<CustomRole[]>({
    queryKey: ['project-custom-roles', projectId],
    queryFn: () => api.get(`/projects/${projectId}/roles`),
  });
  const { data: catalog } = useQuery<Catalog>({
    queryKey: ['rbac-catalog'],
    queryFn: () => api.get('/projects/rbac-catalog'),
    staleTime: 5 * 60_000,
  });

  // ── Create/edit form state ──
  const [editing, setEditing] = useState<CustomRole | null>(null);
  const [name, setName] = useState('');
  const [baseRole, setBaseRole] = useState<BaseRole>('DEVELOPER');
  const [perms, setPerms] = useState<Set<string>>(new Set());

  const allowed = useMemo(() => (catalog ? presetFor(baseRole, catalog) : new Set<string>()), [baseRole, catalog]);

  function startCreate() {
    setEditing(null);
    setName('');
    setBaseRole('DEVELOPER');
    setPerms(new Set());
    setOpen(true);
  }
  function startEdit(r: CustomRole) {
    setEditing(r);
    setName(r.name);
    setBaseRole(r.baseRole);
    setPerms(new Set(r.permissions));
    setOpen(true);
  }

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), baseRole, permissions: [...perms] };
      return editing
        ? api.patch(`/projects/${projectId}/roles/${editing.id}`, body)
        : api.post(`/projects/${projectId}/roles`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-custom-roles', projectId] });
      qc.invalidateQueries({ queryKey: ['project-members', projectId] });
      toast.success(editing ? t('roles.updated') : t('roles.created'));
      setOpen(false);
    },
    onError: (e: Error) => toastError(e),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/roles/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-custom-roles', projectId] });
      qc.invalidateQueries({ queryKey: ['project-members', projectId] });
      toast.success(t('roles.deleted'));
    },
    onError: (e: Error) => toastError(e),
  });

  const togglePerm = (p: string) => {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  if (!canManage && roles.length === 0) return null;

  return (
    <div className="mt-6 rounded-md border border-border p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={15} className="text-primary" />
          <span className="text-sm font-semibold">{t('roles.title')}</span>
          {roles.length > 0 && <Badge variant="secondary" className="text-[10px]">{roles.length}</Badge>}
        </div>
        {canManage && (
          <Button size="sm" variant="outline" onClick={startCreate}>
            <Plus size={13} /> {t('roles.new')}
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('roles.subtitle')}</p>

      {/* Existing roles */}
      {roles.length > 0 && (
        <div className="mt-3 space-y-2">
          {roles.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{r.name}</span>
                  <Badge variant="outline" className="text-[9px]">{t('roles.base')}: {r.baseRole}</Badge>
                  <span className="text-[11px] text-muted-foreground">
                    {t('roles.permCount', { n: r.permissions.length })}
                    {r._count ? ` · ${t('roles.memberCount', { n: r._count.members })}` : ''}
                  </span>
                </div>
              </div>
              {canManage && (
                <>
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => startEdit(r)}>
                    {t('common.edit')}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => del.mutate(r.id)}>
                    <Trash2 size={13} />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create/edit editor */}
      {open && catalog && (
        <div className="mt-3 space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('roles.name')}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="DBA, Deployer…" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('roles.baseRole')}</Label>
              <Select value={baseRole} onChange={(e) => setBaseRole(e.target.value as BaseRole)}>
                <option value="VIEWER">VIEWER</option>
                <option value="DEVELOPER">DEVELOPER</option>
                <option value="ADMIN">ADMIN</option>
              </Select>
            </div>
          </div>

          {/* Permission grid, grouped by resource */}
          <div className="space-y-2">
            {Object.entries(catalog.resources).map(([resource, actions]) => (
              <PermGroup
                key={resource}
                resource={resource}
                actions={actions}
                perms={perms}
                allowed={allowed}
                onToggle={togglePerm}
                t={t}
              />
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
            <Button size="sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
              {save.isPending && <Loader2 size={13} className="animate-spin" />}
              {editing ? t('common.save') : t('common.create')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PermGroup({
  resource, actions, perms, allowed, onToggle, t,
}: {
  resource: string;
  actions: string[];
  perms: Set<string>;
  allowed: Set<string>;
  onToggle: (p: string) => void;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const [expanded, setExpanded] = useState(true);
  const label = t(`roles.resource.${resource}`) || resource;
  return (
    <div className="rounded-md border border-border">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium"
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="capitalize">{label}</span>
      </button>
      {expanded && (
        <div className="flex flex-wrap gap-1.5 px-2.5 pb-2">
          {actions.map((action) => {
            const p = `${resource}:${action}`;
            const on = perms.has(p);
            const grantable = allowed.has(p);
            return (
              <button
                key={p}
                type="button"
                disabled={!grantable}
                onClick={() => onToggle(p)}
                className={[
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                  !grantable
                    ? 'cursor-not-allowed border-border text-muted-foreground/40'
                    : on
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent/40',
                ].join(' ')}
                title={p}
              >
                {on && grantable && <Check size={10} />}
                {action}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
