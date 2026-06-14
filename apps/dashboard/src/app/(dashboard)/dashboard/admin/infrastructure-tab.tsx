'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  Share2, HardDrive, Server, Check, AlertCircle, Loader2,
  Trash2, Container, Package, HardDriveDownload, Network,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useAuthStore } from '@/lib/store';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Deployment mode toggle (LOCAL ↔ MULTI) + a summary of registered
 * servers. Moved out of Settings into Admin where platform-wide controls
 * live. SUPERADMIN-only writes (USERs see the read-only state).
 */
export function InfrastructureTab() {
  const qc = useQueryClient();
  const router = useRouter();
  const me = useAuthStore((s) => s.user);
  const isAdmin = me?.role === 'ADMIN' || me?.role === 'SUPERADMIN';

  const [showConfirm, setShowConfirm] = useState<null | 'to-multi' | 'to-local'>(null);
  const [serverMode, setServerMode] = useState<'local' | 'multi'>('local');

  // Load current mode from /admin/settings (single source of truth).
  const { data: publicSettings } = useQuery<{ deployment_mode?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
  });

  useEffect(() => {
    if (publicSettings?.deployment_mode === 'MULTI') setServerMode('multi');
    else setServerMode('local');
  }, [publicSettings]);

  const { data: servers = [] } = useQuery<any[]>({
    queryKey: ['servers'],
    queryFn: () => api.get('/servers'),
  });
  const { data: apps = [] } = useQuery<any[]>({
    queryKey: ['applications'],
    queryFn: () => api.get('/applications'),
  });

  const remoteServers = servers.filter((s) => s.host !== '127.0.0.1');
  const appsOnRemote = apps.filter(
    (a: any) => a.project?.server && a.project.server.host !== '127.0.0.1',
  );

  const switchModeMutation = useMutation({
    mutationFn: (next: 'LOCAL' | 'MULTI') =>
      api.patch('/admin/settings/deployment_mode', { value: next }),
    onSuccess: (_, next) => {
      toast.success(`Mode set to ${next}`);
      qc.invalidateQueries({ queryKey: ['public-settings'] });
      qc.invalidateQueries({ queryKey: ['servers'] });
      setShowConfirm(null);
      setServerMode(next === 'MULTI' ? 'multi' : 'local');
      if (next === 'MULTI' && remoteServers.length === 0) {
        setTimeout(() => router.push('/dashboard/servers'), 400);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function attemptSwitch(target: 'local' | 'multi') {
    if (target === serverMode) return;
    setShowConfirm(target === 'multi' ? 'to-multi' : 'to-local');
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Share2 size={18} /> Deployment mode
          </CardTitle>
          <CardDescription>
            Local = everything on this VPS. Multi = add other VPS as deployment
            targets via the DockControl agent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <button
            onClick={() => isAdmin && attemptSwitch('local')}
            disabled={!isAdmin}
            className={cn(
              'w-full text-left rounded-lg border p-4 transition-colors',
              serverMode === 'local' ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
              !isAdmin && 'opacity-60 cursor-not-allowed',
            )}
          >
            <div className="flex items-start gap-3">
              <HardDrive size={20} className="text-primary mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-sm">Local server</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Single-host setup. All apps run on this VPS. Simplest, no other VPS to manage.
                </p>
              </div>
              {serverMode === 'local' && <Check size={16} className="text-primary shrink-0" />}
            </div>
          </button>

          <button
            onClick={() => isAdmin && attemptSwitch('multi')}
            disabled={!isAdmin}
            className={cn(
              'w-full text-left rounded-lg border p-4 transition-colors',
              serverMode === 'multi' ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
              !isAdmin && 'opacity-60 cursor-not-allowed',
            )}
          >
            <div className="flex items-start gap-3">
              <Share2 size={20} className="text-primary mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-sm">Multi-server</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  This VPS + extra VPS connected via the DockControl agent. Apps
                  can be deployed on any registered server. Add servers from{' '}
                  <Link href="/dashboard/servers" className="text-primary hover:underline">
                    /dashboard/servers
                  </Link>.
                </p>
              </div>
              {serverMode === 'multi' && <Check size={16} className="text-primary shrink-0" />}
            </div>
          </button>

          {!isAdmin && (
            <p className="text-xs text-muted-foreground italic">
              Only platform admins can change the deployment mode.
            </p>
          )}
        </CardContent>
      </Card>

      {serverMode === 'multi' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Server size={16} /> Registered servers ({servers.length})
            </CardTitle>
            <CardDescription>
              <Link href="/dashboard/servers" className="text-primary hover:underline">
                Manage servers
              </Link>{' '}
              to add or remove.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {servers.map((s: any) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between text-xs rounded-md border border-border p-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        'h-2 w-2 rounded-full',
                        s.status === 'ONLINE'
                          ? 'bg-emerald-500'
                          : s.status === 'PENDING_INSTALL'
                            ? 'bg-orange-500'
                            : 'bg-zinc-500',
                      )}
                    />
                    <span className="font-mono">{s.name}</span>
                    <span className="text-muted-foreground">{s.host}</span>
                    {s.host === '127.0.0.1' && (
                      <Badge variant="outline" className="text-[10px]">local</Badge>
                    )}
                  </div>
                  <Badge variant="outline" className="text-[10px]">{s.status}</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!showConfirm} onClose={() => setShowConfirm(null)}>
        <DialogHeader>
          <DialogTitle>
            Switch to {showConfirm === 'to-multi' ? 'Multi-server' : 'Local'} mode?
          </DialogTitle>
          <DialogDescription>
            {showConfirm === 'to-multi'
              ? 'Multi-server lets you add extra VPS as deployment targets. Apps already on this VPS keep running here.'
              : 'Switching back to Local mode hides the multi-server UI. Apps currently deployed on remote VPS will keep running — they just disappear from the dashboard until you switch back.'}
          </DialogDescription>
        </DialogHeader>

        {showConfirm === 'to-local' && appsOnRemote.length > 0 && (
          <div className="rounded-lg border border-orange-500/30 bg-orange-500/5 p-3 space-y-2">
            <p className="text-xs font-semibold text-orange-500 flex items-center gap-1">
              <AlertCircle size={12} /> {appsOnRemote.length} app
              {appsOnRemote.length !== 1 ? 's are' : ' is'} running on remote servers
            </p>
            <ul className="text-xs text-muted-foreground list-disc list-inside">
              {appsOnRemote.slice(0, 5).map((a: any) => (
                <li key={a.id}>
                  <span className="font-mono">{a.name}</span> on {a.project?.server?.name}
                </li>
              ))}
              {appsOnRemote.length > 5 && <li>+ {appsOnRemote.length - 5} more</li>}
            </ul>
            <p className="text-[10px] text-muted-foreground">
              These won't be deleted, but you won't see them in the dashboard
              until Multi mode is re-enabled or the apps are moved to the local
              server.
            </p>
          </div>
        )}

        {showConfirm === 'to-multi' && remoteServers.length === 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            After switching, head to{' '}
            <Link href="/dashboard/servers" className="text-primary hover:underline">
              /dashboard/servers
            </Link>{' '}
            to add your first remote VPS. The dashboard will generate an install
            command you run on the new server.
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowConfirm(null)}>Cancel</Button>
          <Button
            disabled={switchModeMutation.isPending}
            onClick={() =>
              switchModeMutation.mutate(showConfirm === 'to-multi' ? 'MULTI' : 'LOCAL')
            }
          >
            {switchModeMutation.isPending && <Loader2 size={12} className="animate-spin" />}
            Confirm switch
          </Button>
        </DialogFooter>
      </Dialog>

      <DockerReaperCard />
    </div>
  );
}

/**
 * Docker Reaper card.
 *
 * Lists orphan docker artefacts the platform owned but whose DB row is
 * gone (deleted apps that left images / volumes / networks behind, crashes
 * mid-delete, etc.). Two-step UX: Scan = dry-run, Reap = apply. Reap
 * is irreversible — explicit confirm + per-section counts shown first.
 */
function DockerReaperCard() {
  const qc = useQueryClient();
  const [scan, setScan] = useState<any | null>(null);
  const [reaping, setReaping] = useState(false);
  const [confirmReap, setConfirmReap] = useState(false);

  const scanMutation = useMutation({
    mutationFn: () => api.get<any>('/admin/reaper/scan'),
    onSuccess: (r) => setScan(r),
    onError: (e: any) => toast.error(e?.message || 'Scan failed'),
  });

  const reapMutation = useMutation({
    mutationFn: () => api.post<any>('/admin/reaper/reap'),
    onSuccess: (r) => {
      setScan(r);
      setReaping(false);
      setConfirmReap(false);
      const total = r.containers.length + r.images.length + r.volumes.length + r.networks.length;
      toast.success(`Reaped ${total} artefact${total === 1 ? '' : 's'}`);
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (e: any) => {
      setReaping(false);
      toast.error(e?.message || 'Reap failed');
    },
  });

  const total = scan
    ? scan.containers.length + scan.images.length + scan.volumes.length + scan.networks.length
    : 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Trash2 size={18} /> Docker Reaper
            </CardTitle>
            <CardDescription>
              Garbage-collect docker artefacts left behind by deleted apps / databases / projects.
              Identifies orphans by matching the platform's naming conventions against live DB rows.
            </CardDescription>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={() => scanMutation.mutate()}
              disabled={scanMutation.isPending}
            >
              {scanMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              Scan
            </Button>
            <Button
              variant="destructive"
              disabled={!scan || total === 0 || reapMutation.isPending}
              onClick={() => setConfirmReap(true)}
            >
              Reap{total > 0 ? ` (${total})` : ''}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!scan && (
          <p className="text-sm text-muted-foreground">
            Click <span className="font-medium">Scan</span> to inventory orphan artefacts. No changes are made until you click Reap.
          </p>
        )}
        {scan && total === 0 && (
          <div className="flex items-center gap-2 text-sm text-emerald-500">
            <Check size={16} /> Nothing to clean — every docker artefact maps back to a live DB row.
          </div>
        )}
        {scan && total > 0 && (
          <div className="space-y-3">
            <ReaperSection
              icon={Container}
              title="Containers"
              items={scan.containers}
              render={(c: any) => `${c.name} (${c.status})`}
            />
            <ReaperSection
              icon={Package}
              title="Images"
              items={scan.images}
              render={(i: any) => `${i.repo}:${i.tag}${i.size ? ` — ${i.size}` : ''}`}
            />
            <ReaperSection
              icon={HardDriveDownload}
              title="Volumes"
              items={scan.volumes}
              render={(v: any) => v.name}
            />
            <ReaperSection
              icon={Network}
              title="Networks"
              items={scan.networks}
              render={(n: any) => n.name}
            />
          </div>
        )}
      </CardContent>

      <Dialog open={confirmReap} onClose={() => setConfirmReap(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle size={18} /> Confirm Reap
          </DialogTitle>
          <DialogDescription>
            About to permanently delete {total} orphan artefact{total === 1 ? '' : 's'}.
            Volume data is unrecoverable. Container/network/image removals are also irreversible
            but don't carry user data.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmReap(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={reapMutation.isPending}
            onClick={() => { setReaping(true); reapMutation.mutate(); }}
          >
            {reapMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            Reap {total} artefacts
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

function ReaperSection({
  icon: Icon, title, items, render,
}: {
  icon: typeof Container;
  title: string;
  items: any[];
  render: (item: any) => string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon size={14} className="text-muted-foreground" />
        {title}
        <Badge variant="outline" className="text-[10px]">{items.length}</Badge>
      </div>
      <div className="rounded-md border border-border bg-muted/30 divide-y divide-border max-h-48 overflow-y-auto">
        {items.map((item, i) => (
          <div key={i} className="flex items-center justify-between px-3 py-1.5 text-xs">
            <span className="font-mono truncate">{render(item)}</span>
            <span className="text-muted-foreground shrink-0 ml-3">{item.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
