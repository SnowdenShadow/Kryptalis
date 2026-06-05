'use client';

import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Mail, Plus, Loader2, AlertTriangle, ChevronRight, Globe,
  Inbox, AtSign, ExternalLink, Server as ServerIcon, RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/lib/i18n';

type ServerStatus = 'STOPPED' | 'DEPLOYING' | 'RUNNING' | 'ERROR';

interface EmailDomain {
  id: string;
  domain: string;
  project: { id: string; name: string } | null;
  application: { id: string; name: string; port: number | null } | null;
  mailServer: {
    status: ServerStatus;
    hostname: string | null;
    lastError: string | null;
    smtpPort: number; submissionPort: number; smtpsPort: number;
    imapPort: number; imapsPort: number;
  } | null;
  mailboxCount: number;
  aliasCount: number;
  webmail: { id: string; name: string; port: number | null; status: string } | null;
}

const STATUS_COLOR: Record<ServerStatus | 'NONE', string> = {
  RUNNING: 'bg-emerald-500',
  DEPLOYING: 'bg-orange-500 animate-pulse',
  ERROR: 'bg-red-500',
  STOPPED: 'bg-zinc-500',
  NONE: 'bg-zinc-700',
};

export default function EmailsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { data: domains = [], isLoading } = useQuery<EmailDomain[]>({
    queryKey: ['emails-overview'],
    queryFn: () => api.get('/email/overview'),
    refetchInterval: (q) => {
      const list = (q.state.data as EmailDomain[] | undefined) || [];
      // poll while any mail server is mid-deploy
      return list.some((d) => d.mailServer?.status === 'DEPLOYING') ? 3000 : false;
    },
  });

  const deployMutation = useMutation({
    mutationFn: (domainId: string) => api.post(`/email/server/${domainId}/deploy`),
    onSuccess: () => {
      toast.success(t('emails.cardStatusDeploying'));
      queryClient.invalidateQueries({ queryKey: ['emails-overview'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function statusLabel(s: ServerStatus | undefined): string {
    if (!s) return t('emails.cardStatusNone');
    if (s === 'RUNNING') return t('emails.cardStatusRunning');
    if (s === 'DEPLOYING') return t('emails.cardStatusDeploying');
    if (s === 'ERROR') return t('emails.cardStatusError');
    return t('emails.cardStatusStopped');
  }

  function webmailUrl(d: EmailDomain): string | null {
    if (!d.webmail || !d.webmail.port || d.webmail.status !== 'RUNNING') return null;
    return `http://${window.location.hostname}:${d.webmail.port}`;
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Mail size={26} /> {t('emails.title')}
          </h1>
          <p className="text-muted-foreground mt-1">{t('emails.subtitle')}</p>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="py-16 flex justify-center"><Loader2 size={20} className="animate-spin text-muted-foreground" /></div>
      ) : domains.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Inbox size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('emails.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground text-center max-w-md">
              {t('emails.emptyDesc')}
            </p>
            <Link href="/dashboard/domains" className="mt-4">
              <Button size="sm"><Plus size={14} /> {t('emails.addDomain')}</Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {domains.map((d) => {
            const status = d.mailServer?.status;
            const color = STATUS_COLOR[status || 'NONE'];
            const wm = webmailUrl(d);
            const needsMailbox = status === 'RUNNING' && d.mailboxCount === 0;
            return (
              <Card key={d.id} className="overflow-hidden hover:border-primary/50 transition-colors">
                <CardContent className="p-0">
                  {/* Top row: status + domain */}
                  <div className="flex items-start justify-between gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className={cn('h-2.5 w-2.5 rounded-full shrink-0', color)} />
                        <h3 className="font-mono text-base font-semibold truncate">
                          {d.mailServer?.hostname || `mail.${d.domain}`}
                        </h3>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{statusLabel(status)}</p>
                    </div>
                    {d.project && (
                      <Badge variant="outline" className="text-[10px] shrink-0 gap-1">
                        <ServerIcon size={9} /> {d.project.name}
                      </Badge>
                    )}
                  </div>

                  {/* Counts row */}
                  <div className="px-4 pb-3 grid grid-cols-2 gap-2 text-center">
                    <div className="rounded-md bg-muted/30 py-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        <Inbox size={10} className="inline mr-1" />
                        {d.mailboxCount === 1 ? t('emails.cardMailbox') : t('emails.cardMailboxes')}
                      </p>
                      <p className="font-semibold text-sm">{d.mailboxCount}</p>
                    </div>
                    <div className="rounded-md bg-muted/30 py-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        <AtSign size={10} className="inline mr-1" />
                        {d.aliasCount === 1 ? t('emails.cardAlias') : t('emails.cardAliases')}
                      </p>
                      <p className="font-semibold text-sm">{d.aliasCount}</p>
                    </div>
                  </div>

                  {/* Warning band */}
                  {needsMailbox && (
                    <div className="px-4 py-2 bg-orange-500/10 border-t border-b border-orange-500/20 flex items-start gap-2">
                      <AlertTriangle size={13} className="text-orange-500 shrink-0 mt-0.5" />
                      <p className="text-[11px] text-orange-300">{t('emails.warnNoMailbox')}</p>
                    </div>
                  )}

                  {/* Error band */}
                  {status === 'ERROR' && d.mailServer?.lastError && (
                    <div className="px-4 py-2 bg-red-500/10 border-t border-b border-red-500/20">
                      <p className="text-[11px] text-red-300 line-clamp-2 font-mono">
                        {d.mailServer.lastError}
                      </p>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="border-t border-border p-3 flex items-center gap-2">
                    {!d.mailServer ? (
                      <Button
                        size="sm"
                        className="flex-1"
                        onClick={() => deployMutation.mutate(d.id)}
                        disabled={deployMutation.isPending}
                      >
                        <Plus size={13} /> {t('emails.cardDeploy')}
                      </Button>
                    ) : (
                      <>
                        {wm && (
                          <a href={wm} target="_blank" rel="noreferrer" className="shrink-0">
                            <Button size="sm" variant="outline">
                              <ExternalLink size={12} /> {t('emails.cardOpenWebmail')}
                            </Button>
                          </a>
                        )}
                        {status === 'STOPPED' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => deployMutation.mutate(d.id)}
                            disabled={deployMutation.isPending}
                          >
                            <RefreshCw size={12} /> {t('emails.serverStart')}
                          </Button>
                        )}
                        <Link href={`/dashboard/emails/${d.id}`} className="flex-1">
                          <Button size="sm" className="w-full">
                            {t('emails.cardManage')} <ChevronRight size={13} />
                          </Button>
                        </Link>
                      </>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Domain shortcut at the bottom */}
      {domains.length > 0 && (
        <div className="pt-2 flex justify-center">
          <Link href="/dashboard/domains">
            <Button variant="outline" size="sm">
              <Globe size={13} /> {t('emails.addDomain')}
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}
