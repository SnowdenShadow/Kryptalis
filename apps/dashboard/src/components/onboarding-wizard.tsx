'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, ShieldCheck, FolderPlus, Sparkles, Server, Globe2, Store } from 'lucide-react';

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
 * Three steps:
 *   1. Welcome + choose deployment mode (LOCAL vs MULTI) — persists via
 *      PATCH /admin/settings/deployment_mode (same endpoint settings
 *      page uses, so the platform-wide source of truth stays single).
 *   2. Create first project — name only; serverId auto-resolved from
 *      /servers/local-public (the sanitized bootstrap server row that
 *      was created during the SUPERADMIN bootstrap path).
 *   3. All set — links to /dashboard/marketplace and /dashboard/domains,
 *      then POST /auth/me/onboarding/complete and close.
 *
 * "Don't show after dismissal" is enforced by completing onboarding on
 * the Finish button (the close button on the dialog also marks it
 * complete; otherwise SUPERADMIN gets the wizard on every reload until
 * they finish it, which is the right behavior — we only suppress if
 * they explicitly walked through the flow).
 */
export function OnboardingWizard({
  open,
  onComplete,
}: {
  open: boolean;
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mode, setMode] = useState<DeploymentMode>('LOCAL');
  const [projectName, setProjectName] = useState('');

  const setModeMutation = useMutation({
    mutationFn: (next: DeploymentMode) =>
      api.patch('/admin/settings/deployment_mode', { value: next }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['public-settings'] });
    },
  });

  const createProjectMutation = useMutation({
    mutationFn: async (name: string) => {
      // local-public is unauthenticated-sanitized but the SUPERADMIN
      // we're onboarding has full access — we just use it because it's
      // the simplest way to grab the bootstrap server id without
      // exposing tokens.
      const local = await api.get<LocalPublicServer | null>('/servers/local-public');
      if (!local?.id) {
        throw new Error('No local server available — refresh and try again.');
      }
      return api.post('/projects', { name, serverId: local.id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const completeMutation = useMutation({
    mutationFn: () => api.post('/auth/me/onboarding/complete'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      onComplete();
    },
  });

  async function handleNextFromStep1() {
    try {
      await setModeMutation.mutateAsync(mode);
      setStep(2);
    } catch (err) {
      toastError(err, 'Mode');
    }
  }

  async function handleNextFromStep2() {
    const name = projectName.trim();
    if (!name) {
      toast.error(t('onboarding.projectName'));
      return;
    }
    try {
      await createProjectMutation.mutateAsync(name);
      setStep(3);
    } catch (err) {
      toastError(err, 'Project');
    }
  }

  async function handleFinish() {
    try {
      await completeMutation.mutateAsync();
    } catch (err) {
      toastError(err, 'Onboarding');
    }
  }

  // The "X" / outside-click close shouldn't be possible mid-flow — the
  // user is meant to walk through it. We swallow onClose() entirely
  // (no-op) so the only way out is the Finish button.
  return (
    <Dialog open={open} onClose={() => {}} className="max-w-xl">
      <StepIndicator current={step} />

      {step === 1 && (
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
                icon={<Server size={18} />}
                title={t('settings.multiMode')}
                description={t('settings.multiModeDesc')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              onClick={handleNextFromStep1}
              disabled={setModeMutation.isPending}
            >
              {setModeMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('onboarding.next')}
            </Button>
          </DialogFooter>
        </>
      )}

      {step === 2 && (
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

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setStep(1)}
              disabled={createProjectMutation.isPending}
            >
              {t('onboarding.back')}
            </Button>
            <Button
              onClick={handleNextFromStep2}
              disabled={createProjectMutation.isPending || !projectName.trim()}
            >
              {createProjectMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('onboarding.next')}
            </Button>
          </DialogFooter>
        </>
      )}

      {step === 3 && (
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
            <Button
              variant="ghost"
              onClick={() => setStep(2)}
              disabled={completeMutation.isPending}
            >
              {t('onboarding.back')}
            </Button>
            <Button
              onClick={handleFinish}
              disabled={completeMutation.isPending}
            >
              {completeMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('onboarding.finish')}
            </Button>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  return (
    <div className="mb-4 flex items-center gap-2">
      {[1, 2, 3].map((n) => (
        <div
          key={n}
          className={cn(
            'h-1.5 flex-1 rounded-full transition-colors',
            n <= current ? 'bg-primary' : 'bg-border',
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
