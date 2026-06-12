'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Loader2, ShieldCheck, FolderPlus, Sparkles, Server, Globe2,
  Copy, Check, Terminal, Network, ArrowRight,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';
import { useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type DeploymentMode = 'LOCAL' | 'MULTI';

const DOMAIN_RE = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/;

/**
 * Full-screen first-install setup — THE entry point of a fresh install.
 *
 * The landing page, /login and /register all redirect here while
 * /auth/setup-status reports needsSetup=true; once the admin account is
 * created the flow continues AUTHENTICATED through the remaining steps
 * and ends inside the dashboard. Nothing about this install is usable
 * before this flow: there are no accounts to log into and registration
 * would bootstrap SUPERADMIN anyway — one dedicated page makes that
 * explicit instead of bouncing the operator between auth screens and a
 * dashboard popup.
 *
 * Steps:
 *   1. account  — create the SUPERADMIN (the API's bootstrap path issues
 *                 tokens immediately, no email round-trip)
 *   2. mode     — LOCAL vs MULTI (persisted only when changed)
 *   3. domain   — host the panel on https://<domain> (optional)
 *   4. server   — MULTI only: register the first remote server (optional)
 *   5. project  — create the first project (optional)
 *   6. done     — marks onboarding complete, enters the dashboard
 *
 * Guards: if setup is already done (needsSetup=false) and nobody is
 * logged in, this page bounces to /login — it can't be replayed to mint
 * a second SUPERADMIN (the server refuses anyway; the redirect is UX).
 */
export default function SetupPage() {
  const { t, locale, setLocale } = useTranslation();
  const router = useRouter();
  const { setAuth } = useAuthStore();
  const isAuthed = useAuthStore((s) => !!s.accessToken);

  // ── install-state gate ────────────────────────────────────────────
  // 'setup'           → render the flow
  // 'redirect-login'  → nothing to set up, nobody signed in
  // 'redirect-dash'   → signed in but setup is not theirs to (re)run:
  //                     either onboarding is already completed, or the
  //                     user isn't the SUPERADMIN (steps PATCH admin
  //                     settings — a regular user would only hit 403s).
  const user = useAuthStore((s) => s.user);
  const [gate, setGate] = useState<'loading' | 'setup' | 'redirect-login' | 'redirect-dash'>('loading');
  useEffect(() => {
    api.get<{ needsSetup: boolean }>('/auth/setup-status')
      .then(async (r) => {
        if (r.needsSetup) {
          setGate('setup');
          return;
        }
        if (!isAuthed) {
          setGate('redirect-login');
          return;
        }
        if (user?.role !== 'SUPERADMIN') {
          setGate('redirect-dash');
          return;
        }
        // SUPERADMIN resuming an interrupted setup vs. revisiting after
        // completion — the onboarding flag decides.
        try {
          const ob = await api.get<{ completed: boolean }>('/auth/me/onboarding');
          setGate(ob.completed ? 'redirect-dash' : 'setup');
        } catch {
          setGate('redirect-dash');
        }
      })
      .catch(() => setGate('redirect-login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (gate === 'redirect-login') router.replace('/login');
    if (gate === 'redirect-dash') router.replace('/dashboard');
  }, [gate, router]);

  // ── steps ─────────────────────────────────────────────────────────
  const [mode, setMode] = useState<DeploymentMode>('LOCAL');
  const [savedMode, setSavedMode] = useState<DeploymentMode | null>(null);
  const steps = useMemo(
    () =>
      mode === 'MULTI'
        ? (['account', 'mode', 'domain', 'server', 'project', 'done'] as const)
        : (['account', 'mode', 'domain', 'project', 'done'] as const),
    [mode],
  );
  // Already authed (e.g. interrupted setup, resumed after refresh) →
  // the account exists; start at the mode step.
  const [stepIndex, setStepIndex] = useState(0);
  useEffect(() => {
    if (isAuthed && stepIndex === 0) setStepIndex(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed]);
  const step = steps[Math.min(stepIndex, steps.length - 1)];
  const back = () => setStepIndex(Math.max(isAuthed ? 1 : 0, stepIndex - 1));
  const skip = () => setStepIndex(stepIndex + 1);

  // ── step 1: account ───────────────────────────────────────────────
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const strengthScore = (pw: string) => {
    let s = 0;
    if (pw.length >= 12) s++;
    if (/[a-z]/.test(pw)) s++;
    if (/[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw)) s++;
    if (/[^A-Za-z0-9]/.test(pw)) s++;
    return s;
  };
  const score = strengthScore(password);
  const strengthBarColor =
    score <= 1 ? 'bg-destructive'
    : score === 2 ? 'bg-yellow-500'
    : score === 3 ? 'bg-blue-500'
    : 'bg-green-500';
  const passwordsMatch = confirmPassword === '' || password === confirmPassword;

  const registerMutation = useMutation({
    mutationFn: () =>
      api.post<{
        user: { id: string; name: string; email: string; role?: string };
        accessToken?: string;
      }>('/auth/register', { name, email, password }),
    onSuccess: (res) => {
      // Bootstrap path returns tokens immediately.
      if (res.accessToken && res.user.role) {
        setAuth(
          { id: res.user.id, name: res.user.name, email: res.user.email, role: res.user.role },
          res.accessToken,
        );
        toast.success(t('setup.accountCreated'));
        setStepIndex(1);
      } else {
        // Shouldn't happen on a true bootstrap — but if the server didn't
        // hand tokens back, the install isn't fresh: go through login.
        router.replace('/login');
      }
    },
    onError: (err: Error) => toastError(err, 'Account'),
  });

  function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) return;
    registerMutation.mutate();
  }

  // ── step 2: mode ──────────────────────────────────────────────────
  const setModeMutation = useMutation({
    mutationFn: (next: DeploymentMode) =>
      api.patch('/admin/settings/deployment_mode', { value: next }),
  });
  async function handleNextFromMode() {
    try {
      if (savedMode !== mode) {
        await setModeMutation.mutateAsync(mode);
        setSavedMode(mode);
      }
      setStepIndex(stepIndex + 1);
    } catch (err) {
      toastError(err, 'Mode');
    }
  }

  // ── step 3: panel domain ──────────────────────────────────────────
  const [panelDomain, setPanelDomain] = useState('');
  const [savedPanelDomain, setSavedPanelDomain] = useState<string | null>(null);
  const panelDomainValid = panelDomain.trim() === '' || DOMAIN_RE.test(panelDomain.trim().toLowerCase());
  const setDomainMutation = useMutation({
    mutationFn: (value: string) => api.patch('/admin/settings/system_domain', { value }),
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

  // ── step 4: remote server (MULTI) ─────────────────────────────────
  const [serverName, setServerName] = useState('');
  const [installCommand, setInstallCommand] = useState<string | null>(null);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const createServerMutation = useMutation({
    mutationFn: (body: { name: string }) =>
      api.post<{ id: string; installCommand: string }>('/servers', body),
    onSuccess: (data) => setInstallCommand(data.installCommand),
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

  // ── step 5: project ───────────────────────────────────────────────
  const [projectName, setProjectName] = useState('');
  const [createdProjectName, setCreatedProjectName] = useState<string | null>(null);
  const createProjectMutation = useMutation({
    mutationFn: async (pname: string) => {
      const local = await api.get<{ id: string } | null>('/servers/local-public');
      if (!local?.id) throw new Error('No local server available — refresh and try again.');
      return api.post('/projects', { name: pname, serverId: local.id });
    },
    onSuccess: (_d, pname) => setCreatedProjectName(pname),
  });
  async function handleNextFromProject() {
    if (createdProjectName) {
      setStepIndex(stepIndex + 1);
      return;
    }
    const pname = projectName.trim();
    if (!pname) {
      toast.error(t('onboarding.projectName'));
      return;
    }
    try {
      await createProjectMutation.mutateAsync(pname);
      setStepIndex(stepIndex + 1);
    } catch (err) {
      toastError(err, 'Project');
    }
  }

  // ── step 6: done ──────────────────────────────────────────────────
  // When a panel domain was configured AND we're not already browsing
  // through it, finishing hands over to https://<domain>/dashboard — the
  // clean URL the operator just set up, instead of leaving them on
  // ip:3000. Full page load (not router.push): the session token lives in
  // localStorage which is per-origin, so the domain origin needs its own
  // login — expected, and the login there immediately works.
  const finishesOnDomain =
    !!savedPanelDomain &&
    typeof window !== 'undefined' &&
    window.location.hostname !== savedPanelDomain;

  // TLS readiness probe. Caddy needs 10–60s after the domain is saved to
  // obtain the Let's Encrypt certificate; redirecting before that lands
  // the user on ERR_SSL_PROTOCOL_ERROR. We probe with a no-cors fetch to
  // https://<domain> — when the TLS handshake succeeds the promise
  // resolves (opaque response), when the cert isn't ready it rejects.
  // 'pending' = still probing, 'ready' = handshake OK, 'timeout' = gave
  // up after ~90s (DNS not pointed yet, firewall, …).
  const [domainTls, setDomainTls] = useState<'pending' | 'ready' | 'timeout'>('pending');
  useEffect(() => {
    if (!finishesOnDomain || step !== 'done') return;
    if (domainTls === 'ready') return;
    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 30; // × 3s = ~90s
    setDomainTls('pending');
    const probe = async () => {
      while (!cancelled && attempts < MAX_ATTEMPTS) {
        attempts++;
        try {
          await fetch(`https://${savedPanelDomain}/`, { mode: 'no-cors', cache: 'no-store' });
          if (!cancelled) setDomainTls('ready');
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      if (!cancelled) setDomainTls('timeout');
    };
    void probe();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishesOnDomain, step, savedPanelDomain]);

  // Only redirect to the domain when its TLS actually answers; otherwise
  // (probe timed out / still pending and the user insists) finish locally
  // — the domain keeps working the moment the cert lands, nothing is lost.
  const redirectToDomain = finishesOnDomain && domainTls === 'ready';

  const qc = useQueryClient();
  const finishMutation = useMutation({
    mutationFn: () => api.post('/auth/me/onboarding/complete'),
    onSuccess: () => {
      if (redirectToDomain) {
        window.location.href = `https://${savedPanelDomain}/dashboard`;
        return;
      }
      // Drop the cached onboarding/projects answers BEFORE navigating —
      // a stale `completed:false` in the dashboard layout would bounce
      // the user straight back here (redirect ping-pong until staleTime).
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['public-settings'] });
      router.replace('/dashboard');
    },
    onError: () => router.replace('/dashboard'), // never trap the user here
  });

  if (gate !== 'setup') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header band */}
      <div className="border-b border-border bg-muted/30">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-6 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground text-lg font-bold">
            K
          </div>
          <div>
            <p className="text-sm font-semibold">{t('setup.title')}</p>
            <p className="text-xs text-muted-foreground">{t('setup.subtitle')}</p>
          </div>
          {/* Language picker — auto-detected from the browser on first
              visit; this lets the operator override before anything else. */}
          <div className="ml-auto flex gap-1 rounded-lg border border-border bg-muted/50 p-0.5">
            {(['en', 'fr'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLocale(l)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-medium uppercase transition-colors',
                  locale === l
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-2xl px-6 py-8 space-y-6">
        {/* Step indicator */}
        <div className="flex items-center gap-2">
          {steps.map((s, i) => (
            <div
              key={s}
              className={cn(
                'h-1.5 flex-1 rounded-full transition-colors',
                i <= stepIndex ? 'bg-primary' : 'bg-border',
              )}
            />
          ))}
        </div>

        {/* ── account ── */}
        {step === 'account' && (
          <section className="space-y-5">
            <header className="space-y-1">
              <h1 className="flex items-center gap-2 text-xl font-semibold">
                <ShieldCheck size={20} className="text-primary" />
                {t('auth.setupTitle')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('auth.setupDesc')}</p>
            </header>
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 flex items-start gap-2">
              <Sparkles size={16} className="text-primary mt-0.5 shrink-0" />
              <div className="text-xs space-y-1">
                <p className="font-medium">{t('auth.setupBootstrapTitle')}</p>
                <p className="text-muted-foreground">{t('auth.setupBootstrapDesc')}</p>
              </div>
            </div>
            <form onSubmit={handleCreateAccount} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="setup-name">{t('auth.name')}</Label>
                <Input id="setup-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="John Doe" required autoFocus />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-email">{t('auth.email')}</Label>
                <Input id="setup-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="john@example.com" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-password">{t('auth.password')}</Label>
                <Input id="setup-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
                {password.length > 0 && (
                  <div className="flex gap-1">
                    {[0, 1, 2, 3].map((i) => (
                      <div key={i} className={`h-1 flex-1 rounded-full ${i < score ? strengthBarColor : 'bg-muted'}`} />
                    ))}
                  </div>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-confirm">{t('auth.confirmPassword')}</Label>
                <Input id="setup-confirm" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••" required minLength={8} />
                {!passwordsMatch && <p className="text-xs text-destructive">{t('auth.passwordsDontMatch')}</p>}
              </div>
              <Button type="submit" className="w-full" disabled={registerMutation.isPending || password !== confirmPassword}>
                {registerMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                {t('setup.createAndContinue')} <ArrowRight size={14} />
              </Button>
            </form>
          </section>
        )}

        {/* ── mode ── */}
        {step === 'mode' && (
          <section className="space-y-5">
            <header className="space-y-1">
              <h1 className="flex items-center gap-2 text-xl font-semibold">
                <Server size={20} className="text-primary" />
                {t('onboarding.chooseMode')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('onboarding.modeHint')}</p>
            </header>
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
            <div className="flex justify-end">
              <Button onClick={handleNextFromMode} disabled={setModeMutation.isPending}>
                {setModeMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                {t('onboarding.next')}
              </Button>
            </div>
          </section>
        )}

        {/* ── domain ── */}
        {step === 'domain' && (
          <section className="space-y-5">
            <header className="space-y-1">
              <h1 className="flex items-center gap-2 text-xl font-semibold">
                <Globe2 size={20} className="text-primary" />
                {t('onboarding.panelDomain')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('onboarding.panelDomainBody')}</p>
            </header>
            <div className="space-y-2">
              <Label htmlFor="setup-panel-domain">{t('onboarding.panelDomainLabel')}</Label>
              <Input
                id="setup-panel-domain"
                value={panelDomain}
                onChange={(e) => setPanelDomain(e.target.value.toLowerCase().trim())}
                placeholder="panel.acme.com"
                autoFocus
              />
              {!panelDomainValid && <p className="text-xs text-destructive">{t('onboarding.domainInvalid')}</p>}
              {savedPanelDomain && (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs">
                  <Check size={14} className="shrink-0 text-emerald-500" />
                  <span>
                    {t('onboarding.domainSavedNote')}{' '}
                    <a href={`https://${savedPanelDomain}`} target="_blank" rel="noreferrer" className="font-mono font-medium text-primary hover:underline">
                      https://{savedPanelDomain}
                    </a>
                  </span>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">{t('onboarding.panelDomainHint')}</p>
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={back}>{t('onboarding.back')}</Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={skip} disabled={setDomainMutation.isPending}>{t('onboarding.skip')}</Button>
                <Button
                  onClick={handleNextFromDomain}
                  disabled={setDomainMutation.isPending || !panelDomainValid || (!panelDomain.trim() && !savedPanelDomain)}
                >
                  {setDomainMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                  {t('onboarding.next')}
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* ── server (MULTI) ── */}
        {step === 'server' && (
          <section className="space-y-5">
            <header className="space-y-1">
              <h1 className="flex items-center gap-2 text-xl font-semibold">
                <Terminal size={20} className="text-primary" />
                {t('onboarding.addServer')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('onboarding.addServerBody')}</p>
            </header>
            {!installCommand ? (
              <div className="space-y-2">
                <Label htmlFor="setup-server-name">{t('onboarding.serverName')}</Label>
                <Input id="setup-server-name" value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="vps-1" autoFocus />
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
            <div className="flex justify-between">
              <Button variant="ghost" onClick={back}>{t('onboarding.back')}</Button>
              <div className="flex gap-2">
                {!installCommand && <Button variant="outline" onClick={skip}>{t('onboarding.skip')}</Button>}
                <Button onClick={skip} disabled={createServerMutation.isPending}>{t('onboarding.next')}</Button>
              </div>
            </div>
          </section>
        )}

        {/* ── project ── */}
        {step === 'project' && (
          <section className="space-y-5">
            <header className="space-y-1">
              <h1 className="flex items-center gap-2 text-xl font-semibold">
                <FolderPlus size={20} className="text-primary" />
                {t('onboarding.createProject')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('projects.emptyDesc')}</p>
            </header>
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
                <Label htmlFor="setup-project-name">{t('onboarding.projectName')}</Label>
                <Input id="setup-project-name" value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="my-first-project" autoFocus />
              </div>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={back} disabled={createProjectMutation.isPending}>{t('onboarding.back')}</Button>
              <div className="flex gap-2">
                {!createdProjectName && (
                  <Button variant="outline" onClick={skip} disabled={createProjectMutation.isPending}>{t('onboarding.skip')}</Button>
                )}
                <Button
                  onClick={handleNextFromProject}
                  disabled={createProjectMutation.isPending || (!createdProjectName && !projectName.trim())}
                >
                  {createProjectMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                  {t('onboarding.next')}
                </Button>
              </div>
            </div>
          </section>
        )}

        {/* ── done ── */}
        {step === 'done' && (
          <section className="space-y-5">
            <header className="space-y-1">
              <h1 className="flex items-center gap-2 text-xl font-semibold">
                <Sparkles size={20} className="text-primary" />
                {t('onboarding.allSet')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('onboarding.allSetBody')}</p>
            </header>
            {finishesOnDomain && domainTls === 'pending' && (
              <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
                <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-primary" />
                <div className="space-y-1">
                  <p className="font-medium">{t('setup.tlsWaitingTitle')}</p>
                  <p className="text-muted-foreground">
                    {t('setup.tlsWaitingDesc')}{' '}
                    <span className="font-mono font-medium">https://{savedPanelDomain}</span>
                  </p>
                </div>
              </div>
            )}
            {finishesOnDomain && domainTls === 'ready' && (
              <div className="flex items-start gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
                <Check size={14} className="mt-0.5 shrink-0 text-emerald-500" />
                <div className="space-y-1">
                  <p className="font-medium">{t('setup.domainHandoffTitle')}</p>
                  <p className="text-muted-foreground">
                    {t('setup.domainHandoffDesc')}{' '}
                    <span className="font-mono font-medium">https://{savedPanelDomain}</span>
                  </p>
                </div>
              </div>
            )}
            {finishesOnDomain && domainTls === 'timeout' && (
              <div className="rounded-md border border-orange-500/30 bg-orange-500/5 p-3 text-xs space-y-1">
                <p className="font-medium">{t('setup.tlsTimeoutTitle')}</p>
                <p className="text-muted-foreground">{t('setup.tlsTimeoutDesc')}</p>
              </div>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={back} disabled={finishMutation.isPending}>{t('onboarding.back')}</Button>
              <Button onClick={() => finishMutation.mutate()} disabled={finishMutation.isPending}>
                {finishMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                {redirectToDomain ? t('setup.continueOnDomain') : t('setup.enterDashboard')} <ArrowRight size={14} />
              </Button>
            </div>
          </section>
        )}
      </div>
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
        active ? 'border-primary bg-primary/5' : 'border-border bg-background hover:border-primary/50',
      )}
    >
      <span className={cn('text-primary', active ? 'opacity-100' : 'opacity-70')}>{icon}</span>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{description}</span>
    </button>
  );
}
