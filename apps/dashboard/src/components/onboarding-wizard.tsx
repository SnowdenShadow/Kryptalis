'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Loader2, ShieldCheck, FolderPlus, Sparkles, Server, Globe2, Store,
  Copy, Check, Terminal, Network,
} from 'lucide-react';

import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type DeploymentMode = 'LOCAL' | 'MULTI';

interface LocalPublicServer {
  id: string;
  name: string;
}

/**
 * First-run onboarding wizard for SUPERADMIN. Mounted by the dashboard
 * layout when:
 *
 *   user.role === 'SUPERADMIN'
 *   AND /auth/me/onboarding -> completed === false
 *   AND /projects -> []
 *
 * Step flow (dynamic — MULTI inserts a server step):
 *
 *   1. Welcome + deployment mode (LOCAL vs MULTI). Persisted on Next
 *      only when it CHANGED (PATCH /admin/settings/deployment_mode).
 *   2. (MULTI only) Add your first remote server: name -> POST /servers
 *      -> install command with a copy button. Skippable — the Servers
 *      page does the same thing later.
 *   3. Create first project — name only; serverId auto-resolved from
 *      /servers/local-public. Skippable. Re-entering this step after a
 *      successful create shows "created" state instead of re-creating
 *      (Back/Next can't mint duplicates).
 *   4. All set — links to Marketplace and Domains, then
 *      POST /auth/me/onboarding/complete.
 *
 * Esc / clicking outside dismisses for THIS session only; the wizard
 * returns on next login until Finish is clicked.
 */
export function OnboardingWizard({
  open,
  onComplete,
  onDismiss,
}: {
  open: boolean;
  onComplete: () => void;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [mode, setMode] = useState<DeploymentMode>('LOCAL');
  /** Mode actually persisted server-side — avoids re-PATCHing on Back/Next. */
  const [savedMode, setSavedMode] = useState<DeploymentMode | null>(null);

  // Dynamic step list: a panel-domain step always follows mode; MULTI also
  // inserts the add-server step.
  const steps = useMemo(
    () =>
      mode === 'MULTI'
        ? (['mode', 'domain', 'server', 'project', 'done'] as const)
        : (['mode', 'domain', 'project', 'done'] as const),
    [mode],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const step = steps[Math.min(stepIndex, steps.length - 1)];

  // ── step: mode ────────────────────────────────────────────────────
  const setModeMutation = useMutation({
    mutationFn: (next: DeploymentMode) =>
      api.patch('/admin/settings/deployment_mode', { value: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['public-settings'] });
    },
  });

  async function handleNextFromMode() {
    try {
      if (savedMode !== mode) {
        await setModeMutation.mutateAsync(mode);
        setSavedMode(mode);
      }
      setStepIndex(1);
    } catch (err) {
      toastError(err, 'Mode');
    }
  }

  // ── step: domain (panel hosting) ──────────────────────────────────
  // Lets the operator serve THIS dashboard at https://<domain> (Caddy +
  // Let's Encrypt) instead of http://ip:3000. Persists the system_domain
  // setting — same one as Admin → Settings.
  const [panelDomain, setPanelDomain] = useState('');
  /** Domain actually persisted — idempotent on Back/Next. */
  const [savedPanelDomain, setSavedPanelDomain] = useState<string | null>(null);
  const DOMAIN_RE = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;
  const panelDomainValid = panelDomain.trim() === '' || DOMAIN_RE.test(panelDomain.trim().toLowerCase());

  const setDomainMutation = useMutation({
    mutationFn: (value: string) =>
      api.patch('/admin/settings/system_domain', { value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['public-settings'] });
    },
  });

  async function handleNextFromDomain() {
    const value = panelDomain.trim().toLowerCase();
    if (value && !DOMAIN_RE.test(value)) {
      toast.error(t('onboarding.domainInvalid'));
      return;
    }
    try {
      if (value && savedPanelDomain !== value) {
        await setDomainMutation.mutateAsync(value);
        setSavedPanelDomain(value);
        toast.success(t('onboarding.domainSaved'));
      }
      setStepIndex(stepIndex + 1);
    } catch (err) {
      toastError(err, 'Domain');
    }
  }

  // ── step: server (MULTI) ──────────────────────────────────────────
  const [serverName, setServerName] = useState('');
  const [installCommand, setInstallCommand] = useState<string | null>(null);
  const [copiedInstall, setCopiedInstall] = useState(false);

  const createServerMutation = useMutation({
    mutationFn: (body: { name: string }) =>
      api.post<{ id: string; installCommand: string }>('/servers', body),
    onSuccess: (data) => {
      setInstallCommand(data.installCommand);
      qc.invalidateQueries({ queryKey: ['servers'] });
    },
    onError: (err: Error) => toastError(err, 'Server'),
  });

  async function copyInstall() {
    if (!installCommand) return;
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopiedInstall(true);
      setTimeout(() => setCopiedInstall(false), 1500);
    } catch {
      toast.error(t('toast.failedToCopy'));
    }
  }

  // ── step: project ─────────────────────────────────────────────────
  const [projectName, setProjectName] = useState('');
  /** Set after a successful create — Back/Next must NOT create twice. */
  const [createdProjectName, setCreatedProjectName] = useState<string | null>(null);

  const createProjectMutation = useMutation({
    mutationFn: async (name: string) => {
      // local-public is the sanitized bootstrap server row — simplest way
      // to grab the local server id without exposing tokens. In MULTI the
      // local server is also a valid (ONLINE) target for a first project.
      const local = await api.get<LocalPublicServer | null>('/servers/local-public');
      if (!local?.id) {
        throw new Error('No local server available — refresh and try again.');
      }
      return api.post('/projects', { name, serverId: local.id });
    },
    onSuccess: (_data, name) => {
      setCreatedProjectName(name);
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  async function handleNextFromProject() {
    // Already created on a previous pass — just advance.
    if (createdProjectName) {
      setStepIndex(stepIndex + 1);
      return;
    }
    const name = projectName.trim();
    if (!name) {
      toast.error(t('onboarding.projectName'));
      return;
    }
    try {
      await createProjectMutation.mutateAsync(name);
      setStepIndex(stepIndex + 1);
    } catch (err) {
      toastError(err, 'Project');
    }
  }

  // ── step: done ────────────────────────────────────────────────────
  const completeMutation = useMutation({
    mutationFn: () => api.post('/auth/me/onboarding/complete'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      onComplete();
    },
  });

  async function handleFinish() {
    try {
      await completeMutation.mutateAsync();
    } catch (err) {
      toastError(err, 'Onboarding');
    }
  }

  const back = () => setStepIndex(Math.max(0, stepIndex - 1));
  const skip = () => setStepIndex(stepIndex + 1);

  return (
    <Dialog open={open} onClose={() => onDismiss?.()} className="max-w-xl">
      <StepIndicator total={steps.length} current={stepIndex} />

      {step === 'mode' && (
        <>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck size={20} className="text-primary" />
              {t('onboarding.welcome')}
            </DialogTitle>
            <DialogDescription className="mt-2">
              {t('onboarding.welcomeBody')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Label>{t('onboarding.chooseMode')}</Label>
            <div className="grid grid-cols-2 gap-3">
              <ModeCard
                active={mode === 'LOCAL'}
                onClick={() => setMode('LOCAL')}
                icon={<Server size={18} />}
                title={t('settings.localMode')}
                description={t('settings.localModeDesc')}
              />
              <ModeCard
                active={mode === 'MULTI'}
                onClick={() => setMode('MULTI')}
                icon={<Network size={18} />}
                title={t('settings.multiMode')}
                description={t('settings.multiModeDesc')}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">{t('onboarding.modeHint')}</p>
          </div>

          <DialogFooter>
            <Button onClick={handleNextFromMode} disabled={setModeMutation.isPending}>
              {setModeMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('onboarding.next')}
            </Button>
          </DialogFooter>
        </>
      )}

      {step === 'domain' && (
        <>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe2 size={20} className="text-primary" />
              {t('onboarding.panelDomain')}
            </DialogTitle>
            <DialogDescription className="mt-2">
              {t('onboarding.panelDomainBody')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="onboarding-panel-domain">{t('onboarding.panelDomainLabel')}</Label>
            <Input
              id="onboarding-panel-domain"
              value={panelDomain}
              onChange={(e) => setPanelDomain(e.target.value.toLowerCase().trim())}
              placeholder="panel.acme.com"
              autoFocus
            />
            {!panelDomainValid && (
              <p className="text-xs text-destructive">{t('onboarding.domainInvalid')}</p>
            )}
            {savedPanelDomain && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs">
                <Check size={14} className="shrink-0 text-emerald-500" />
                <span>
                  {t('onboarding.domainSavedNote')}{' '}
                  <a
                    href={`https://${savedPanelDomain}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono font-medium text-primary hover:underline"
                  >
                    https://{savedPanelDomain}
                  </a>
                </span>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">{t('onboarding.panelDomainHint')}</p>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={back} disabled={setDomainMutation.isPending}>
              {t('onboarding.back')}
            </Button>
            <Button variant="outline" onClick={skip} disabled={setDomainMutation.isPending}>
              {t('onboarding.skip')}
            </Button>
            <Button
              onClick={handleNextFromDomain}
              disabled={setDomainMutation.isPending || !panelDomainValid || (!panelDomain.trim() && !savedPanelDomain)}
            >
              {setDomainMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('onboarding.next')}
            </Button>
          </DialogFooter>
        </>
      )}

      {step === 'server' && (
        <>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Terminal size={20} className="text-primary" />
              {t('onboarding.addServer')}
            </DialogTitle>
            <DialogDescription className="mt-2">
              {t('onboarding.addServerBody')}
            </DialogDescription>
          </DialogHeader>

          {!installCommand ? (
            <div className="space-y-2">
              <Label htmlFor="onboarding-server-name">{t('onboarding.serverName')}</Label>
              <Input
                id="onboarding-server-name"
                value={serverName}
                onChange={(e) => setServerName(e.target.value)}
                placeholder="vps-1"
                autoFocus
              />
              <Button
                size="sm"
                className="mt-1"
                disabled={!serverName.trim() || createServerMutation.isPending}
                onClick={() => createServerMutation.mutate({ name: serverName.trim() })}
              >
                {createServerMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                {t('onboarding.generateInstall')}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Label>{t('onboarding.installCmdLabel')}</Label>
              <div className="relative">
                <pre className="whitespace-pre-wrap break-all rounded-md border border-border bg-zinc-950 p-3 pr-10 font-mono text-xs text-green-300">
                  {installCommand}
                </pre>
                <button
                  type="button"
                  onClick={copyInstall}
                  className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={t('common.copy')}
                >
                  {copiedInstall ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">{t('onboarding.installCmdHint')}</p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={back}>{t('onboarding.back')}</Button>
            {!installCommand && (
              <Button variant="outline" onClick={skip}>{t('onboarding.skip')}</Button>
            )}
            <Button onClick={skip} disabled={createServerMutation.isPending}>
              {t('onboarding.next')}
            </Button>
          </DialogFooter>
        </>
      )}

      {step === 'project' && (
        <>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderPlus size={20} className="text-primary" />
              {t('onboarding.createProject')}
            </DialogTitle>
            <DialogDescription className="mt-2">
              {t('projects.emptyDesc')}
            </DialogDescription>
          </DialogHeader>

          {createdProjectName ? (
            <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
              <Check size={16} className="shrink-0 text-emerald-500" />
              <span>
                {t('onboarding.projectCreated')}{' '}
                <span className="font-mono font-medium">{createdProjectName}</span>
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="onboarding-project-name">{t('onboarding.projectName')}</Label>
              <Input
                id="onboarding-project-name"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder="my-first-project"
                autoFocus
              />
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={back} disabled={createProjectMutation.isPending}>
              {t('onboarding.back')}
            </Button>
            {!createdProjectName && (
              <Button variant="outline" onClick={skip} disabled={createProjectMutation.isPending}>
                {t('onboarding.skip')}
              </Button>
            )}
            <Button
              onClick={handleNextFromProject}
              disabled={createProjectMutation.isPending || (!createdProjectName && !projectName.trim())}
            >
              {createProjectMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('onboarding.next')}
            </Button>
          </DialogFooter>
        </>
      )}

      {step === 'done' && (
        <>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles size={20} className="text-primary" />
              {t('onboarding.allSet')}
            </DialogTitle>
            <DialogDescription className="mt-2">
              {t('onboarding.allSetBody')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/dashboard/marketplace"
              onClick={handleFinish}
              className="group flex flex-col gap-2 rounded-lg border border-border bg-background p-4 hover:border-primary/50 transition-colors"
            >
              <Store size={20} className="text-primary" />
              <div className="text-sm font-medium">{t('nav.marketplace')}</div>
              <div className="text-xs text-muted-foreground">{t('marketplace.subtitle')}</div>
            </Link>
            <Link
              href="/dashboard/domains"
              onClick={handleFinish}
              className="group flex flex-col gap-2 rounded-lg border border-border bg-background p-4 hover:border-primary/50 transition-colors"
            >
              <Globe2 size={20} className="text-primary" />
              <div className="text-sm font-medium">{t('nav.domains')}</div>
              <div className="text-xs text-muted-foreground">{t('domains.subtitle')}</div>
            </Link>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={back} disabled={completeMutation.isPending}>
              {t('onboarding.back')}
            </Button>
            <Button onClick={handleFinish} disabled={completeMutation.isPending}>
              {completeMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('onboarding.finish')}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

function StepIndicator({ total, current }: { total: number; current: number }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={cn(
            'h-1.5 flex-1 rounded-full transition-colors',
            i <= current ? 'bg-primary' : 'bg-border',
          )}
        />
      ))}
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border bg-background hover:border-primary/50',
      )}
    >
      <span className={cn('text-primary', active ? 'opacity-100' : 'opacity-70')}>{icon}</span>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
}
