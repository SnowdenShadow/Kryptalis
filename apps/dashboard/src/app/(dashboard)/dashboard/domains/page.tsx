'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Globe, Plus, Trash2, ShieldCheck, ShieldX, Lock, Loader2, Info,
  ExternalLink, Copy, Check, Search, RefreshCw, AlertCircle, AlertTriangle,
  ChevronDown, ChevronRight, Mail,
} from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/toast-error';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface Domain {
  id: string; domain: string; applicationId: string | null; projectId: string | null;
  status: string; sslStatus: string; sslExpiresAt: string | null; createdAt: string;
  project?: { id: string; name: string } | null;
  application?: { id: string; name: string; project?: { id: string; name: string } } | null;
}

type DnsCheckStatus = 'OK' | 'WARN' | 'FAIL' | 'UNKNOWN';
interface DnsCheck { status: DnsCheckStatus; message: string }
interface RecommendedRecord {
  type: 'A' | 'CNAME' | 'MX' | 'TXT';
  host: string;
  value: string;
  priority?: number;
  note?: string;
}
interface DnsHealth {
  domain: string;
  isSubdomain: boolean;
  apex: string;
  expectedIp: string | null;
  actualIp: string | null;
  hasMail: boolean;
  checks: Record<string, DnsCheck>;
  recommendedRecords: RecommendedRecord[];
  checkedAt: string;
}

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS';
interface ActualRecord { value: string; priority?: number }
interface ExpectedRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';
  host: string;
  value: string;
  priority?: number;
  reason: string;
  status: 'OK' | 'MISSING' | 'WRONG';
  actualValue?: string;
}
interface DnsRecords {
  domain: string;
  apex: string;
  isSubdomain: boolean;
  expectedIp: string | null;
  hasMail: boolean;
  actual: Record<DnsRecordType, ActualRecord[]>;
  expected: ExpectedRecord[];
  checkedAt: string;
}

function timeAgo(d: string) {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function daysUntil(d: string) {
  const diff = new Date(d).getTime() - Date.now();
  return Math.floor(diff / 86400000);
}

/**
 * Apex = the last two labels of a hostname (athexis.xyz).
 * Subdomain = anything with more than 2 labels (api.athexis.xyz → apex athexis.xyz).
 * The "apex" the user manages may not exist as a row — in that case we synthesize
 * a virtual apex node so the subdomains still appear grouped together visually.
 */
function apexOf(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

interface ApexGroup {
  apex: string;
  /** The apex domain row if the user created it, otherwise null. */
  apexDomain: Domain | null;
  /** Any subdomain rows under this apex. */
  subdomains: Domain[];
}

function groupByApex(domains: Domain[]): ApexGroup[] {
  const map = new Map<string, ApexGroup>();
  for (const d of domains) {
    const apex = apexOf(d.domain);
    let g = map.get(apex);
    if (!g) {
      g = { apex, apexDomain: null, subdomains: [] };
      map.set(apex, g);
    }
    if (d.domain === apex) g.apexDomain = d;
    else g.subdomains.push(d);
  }
  // sort: apexes alphabetically, subdomains under each by name
  const out = Array.from(map.values());
  out.sort((a, b) => a.apex.localeCompare(b.apex));
  for (const g of out) g.subdomains.sort((a, b) => a.domain.localeCompare(b.domain));
  return out;
}

// ── DNS Health badge component ────────────────────────────────────────
function HealthBadge({ domainId }: { domainId: string }) {
  const { data: health, refetch, isFetching } = useQuery<DnsHealth>({
    queryKey: ['domain-health', domainId],
    queryFn: () => api.get(`/domains/${domainId}/health`),
    staleTime: 60_000,
  });
  const failCount = health
    ? (Object.values(health.checks) as DnsCheck[]).filter((c) => c.status === 'FAIL').length
    : 0;
  const warnCount = health
    ? (Object.values(health.checks) as DnsCheck[]).filter((c) => c.status === 'WARN').length
    : 0;
  const overall: DnsCheckStatus = failCount > 0 ? 'FAIL' : warnCount > 0 ? 'WARN' : 'OK';
  const variant = overall === 'OK' ? 'success' : overall === 'WARN' ? 'warning' : 'destructive';
  const label = overall === 'OK' ? 'DNS OK' : overall === 'WARN' ? `${warnCount} warn` : `${failCount} fail`;

  return (
    <button
      title={Object.values(health?.checks || {}).map((c: any) => c.message).join('\n')}
      onClick={(e) => { e.stopPropagation(); refetch(); }}
      className="inline-flex items-center"
    >
      <Badge variant={variant as any} className="text-[10px] gap-1">
        {isFetching && <Loader2 size={9} className="animate-spin" />}
        {label}
      </Badge>
    </button>
  );
}

// ── DomainCard ────────────────────────────────────────────────────────
function DomainCard({
  domain,
  serverIp,
  isSubdomain,
  onDelete,
  onAddSubdomain,
  onRenew,
  onCopyDns,
  onOpenDns,
  copiedId,
}: {
  domain: Domain;
  serverIp: string;
  isSubdomain: boolean;
  onDelete: (d: Domain) => void;
  onAddSubdomain: (parent: string) => void;
  onRenew: (id: string) => void;
  onCopyDns: (text: string, id: string) => void;
  onOpenDns: (d: Domain) => void;
  copiedId: string;
}) {
  const sslOk = domain.sslStatus === 'ACTIVE';
  const sslPending = domain.sslStatus === 'PENDING';
  const sslBad = domain.sslStatus === 'EXPIRED' || domain.sslStatus === 'ERROR';
  const sslColor = sslOk ? 'bg-emerald-500' : sslPending ? 'bg-orange-500' : sslBad ? 'bg-red-500' : 'bg-zinc-600';
  const expiryDays = domain.sslExpiresAt ? daysUntil(domain.sslExpiresAt) : null;

  // The DNS record string the user needs to set. Apex → A record. Subdomain → CNAME to apex.
  const apex = apexOf(domain.domain);
  const dnsLine = isSubdomain
    ? `${domain.domain} CNAME ${apex}`
    : `${domain.domain} A ${serverIp}`;

  return (
    <Card className="hover:border-primary/50 transition-colors overflow-hidden">
      <CardContent className="p-0">
        <div className={`h-1 w-full ${sslColor}`} />
        <div className="p-4 space-y-3">
          {/* header */}
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="min-w-0 flex-1">
              <h3 className={cn('font-mono font-bold truncate', isSubdomain ? 'text-base' : 'text-lg')}>
                {domain.domain}
              </h3>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                <Badge
                  variant={domain.status === 'ACTIVE' ? 'success' : domain.status === 'PENDING' ? 'warning' : 'destructive'}
                  className="text-[10px]"
                  title={
                    domain.status === 'ACTIVE'
                      ? 'Domain is live and routing traffic to its app.'
                      : domain.status === 'PENDING'
                      ? 'Domain reserved — SSL is being provisioned. Link an app to start serving traffic.'
                      : 'Domain is not reachable.'
                  }
                >
                  {domain.status === 'PENDING' ? 'RESERVED' : domain.status}
                </Badge>
                <HealthBadge domainId={domain.id} />
                <span className="text-[10px] text-muted-foreground">{timeAgo(domain.createdAt)}</span>
              </div>
            </div>
            <div className="flex gap-1 shrink-0">
              <Button size="sm" variant="outline" title="DNS records & health"
                onClick={() => onOpenDns(domain)}>
                <Info size={12} />
              </Button>
              <Button size="sm" variant="outline" title="Add subdomain"
                onClick={() => onAddSubdomain(domain.domain)}>
                <Plus size={12} />
              </Button>
              <Button size="sm" variant="destructive" onClick={() => onDelete(domain)}>
                <Trash2 size={12} />
              </Button>
            </div>
          </div>

          {/* info row: SSL + app + project */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-md border border-border p-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">SSL</p>
              <div className="flex items-center gap-1 mt-0.5">
                {sslOk && <ShieldCheck size={12} className="text-emerald-500" />}
                {sslPending && <Lock size={12} className="text-orange-500" />}
                {sslBad && <ShieldX size={12} className="text-red-500" />}
                <span className={cn('text-xs font-semibold', sslOk ? 'text-emerald-500' : sslPending ? 'text-orange-500' : sslBad ? 'text-red-500' : '')}>
                  {sslOk ? 'Active' : sslPending ? 'Pending' : domain.sslStatus === 'EXPIRED' ? 'Expired' : 'Error'}
                </span>
              </div>
              {expiryDays !== null && sslOk && (
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {expiryDays}d left
                </p>
              )}
              {(sslBad || (sslOk && expiryDays !== null && expiryDays < 30)) && (
                <Button size="sm" variant="outline" className="mt-1 h-5 text-[10px] px-1.5"
                  onClick={() => onRenew(domain.id)}>
                  <RefreshCw size={9} /> Renew
                </Button>
              )}
            </div>
            <div className="rounded-md border border-border p-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">App</p>
              {domain.application ? (
                <Link href={`/dashboard/applications/${domain.application.id}`} className="text-xs font-medium hover:underline block truncate">
                  {domain.application.name}
                </Link>
              ) : (
                <p className="text-xs text-muted-foreground italic">—</p>
              )}
            </div>
            <div className="rounded-md border border-border p-2">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Project</p>
              {(() => {
                const proj = domain.project || domain.application?.project;
                return proj ? (
                  <Link href={`/dashboard/projects/${proj.id}`} className="text-xs font-medium text-primary hover:underline truncate block">
                    {proj.name}
                  </Link>
                ) : <p className="text-xs text-muted-foreground italic">—</p>;
              })()}
            </div>
          </div>

          {/* DNS hint */}
          <div className="rounded-md border border-border bg-muted/30 p-2 text-xs flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Badge variant="outline" className="font-mono text-[9px] shrink-0">
                {isSubdomain ? 'CNAME' : 'A'}
              </Badge>
              <span className="font-mono text-[11px] truncate">{dnsLine}</span>
            </div>
            <button
              className="text-muted-foreground hover:text-foreground shrink-0"
              onClick={() => onCopyDns(dnsLine, domain.id)}
            >
              {copiedId === domain.id ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── DnsHealthDialog ──────────────────────────────────────────────────
function DnsHealthDialog({
  domain,
  onClose,
  onCopy,
  copiedId,
}: {
  domain: Domain;
  onClose: () => void;
  onCopy: (text: string, id: string) => void;
  copiedId: string;
}) {
  const [tab, setTab] = useState<'health' | 'records'>('health');
  const { data, isLoading, isFetching, refetch } = useQuery<DnsHealth>({
    queryKey: ['domain-health-detail', domain.id],
    queryFn: () => api.get(`/domains/${domain.id}/health`),
    staleTime: 30_000,
  });
  const {
    data: records,
    isLoading: recordsLoading,
    isFetching: recordsFetching,
    refetch: refetchRecords,
  } = useQuery<DnsRecords>({
    queryKey: ['domain-records', domain.id],
    queryFn: () => api.get(`/domains/${domain.id}/records`),
    enabled: tab === 'records',
    staleTime: 30_000,
  });

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Globe size={16} /> {domain.domain}
        </DialogTitle>
        <DialogDescription>
          Live DNS resolution check + the records you should set at your registrar.
        </DialogDescription>
      </DialogHeader>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border mb-2">
        <button
          onClick={() => setTab('health')}
          className={cn(
            'px-3 py-1.5 text-xs font-medium border-b-2 transition-colors',
            tab === 'health' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          Health & recommended
        </button>
        <button
          onClick={() => setTab('records')}
          className={cn(
            'px-3 py-1.5 text-xs font-medium border-b-2 transition-colors',
            tab === 'records' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}
        >
          All records
        </button>
      </div>

      <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
        {tab === 'health' && isLoading && !data && (
          <div className="py-6 flex justify-center">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
          </div>
        )}

        {tab === 'health' && data && (
          <>
            {/* live checks */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Live verification</p>
                <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
                  {isFetching ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  Recheck
                </Button>
              </div>
              {Object.entries(data.checks).map(([key, check]) => {
                const Icon =
                  check.status === 'OK' ? Check :
                  check.status === 'WARN' ? AlertTriangle :
                  check.status === 'FAIL' ? AlertCircle : Info;
                const cls =
                  check.status === 'OK' ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600' :
                  check.status === 'WARN' ? 'border-orange-500/30 bg-orange-500/5 text-orange-600' :
                  check.status === 'FAIL' ? 'border-red-500/30 bg-red-500/5 text-red-600' :
                  'border-border bg-muted/30 text-muted-foreground';
                return (
                  <div key={key} className={cn('flex items-start gap-2 rounded-md border p-2.5 text-xs', cls)}>
                    <Icon size={14} className="shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold uppercase text-[10px] tracking-wider opacity-70">{key}</p>
                      <p className="font-mono text-[11px] break-words mt-0.5">{check.message}</p>
                    </div>
                  </div>
                );
              })}
              <p className="text-[10px] text-muted-foreground">
                Resolved against Cloudflare (1.1.1.1) at {new Date(data.checkedAt).toLocaleTimeString()}.
              </p>
            </div>

            {/* records to set */}
            {data.recommendedRecords.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Records to set at your DNS provider</p>
                {data.recommendedRecords.map((r, i) => {
                  const value = r.priority !== undefined ? `${r.priority} ${r.value}` : r.value;
                  const copyText = `${r.host}\t${r.type}\t${value}`;
                  const cid = `rec-${i}`;
                  return (
                    <div key={cid} className="rounded-md border border-border p-2.5 text-xs space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="font-mono text-[10px]">{r.type}</Badge>
                        <span className="font-mono text-[11px] truncate">{r.host}</span>
                        <span className="text-muted-foreground">→</span>
                        <span className="font-mono text-[11px] font-semibold truncate">{value}</span>
                        <button
                          className="ml-auto text-muted-foreground hover:text-foreground"
                          onClick={() => onCopy(copyText, cid)}
                          title="Copy host / type / value"
                        >
                          {copiedId === cid ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                        </button>
                      </div>
                      {r.note && <p className="text-[10px] text-muted-foreground">{r.note}</p>}
                    </div>
                  );
                })}
                {data.hasMail && (
                  <div className="rounded-md border border-orange-500/30 bg-orange-500/5 p-2.5 text-xs">
                    <p className="font-semibold text-orange-500 flex items-center gap-1">
                      <Mail size={11} /> Mail server attached
                    </p>
                    <p className="text-muted-foreground mt-1">
                      Open the Email tab for the full deliverability check (SPF / DKIM / DMARC / PTR / autodiscover).
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {tab === 'records' && (
          <>
            {recordsLoading && !records && (
              <div className="py-6 flex justify-center">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            )}
            {records && (
              <>
                {/* Reconciliation: expected vs actual */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Expected records</p>
                    <Button size="sm" variant="outline" onClick={() => refetchRecords()} disabled={recordsFetching}>
                      {recordsFetching ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                      Verify now
                    </Button>
                  </div>
                  {records.expected.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">No specific records expected for this domain.</p>
                  ) : (
                    records.expected.map((e, i) => {
                      const cls =
                        e.status === 'OK' ? 'border-emerald-500/30 bg-emerald-500/5' :
                        e.status === 'WRONG' ? 'border-red-500/30 bg-red-500/5' :
                        'border-orange-500/30 bg-orange-500/5';
                      const Icon = e.status === 'OK' ? Check : e.status === 'WRONG' ? AlertCircle : AlertTriangle;
                      const iconCls = e.status === 'OK' ? 'text-emerald-500' : e.status === 'WRONG' ? 'text-red-500' : 'text-orange-500';
                      const copyText = e.priority !== undefined
                        ? `${e.host}\t${e.type}\t${e.priority} ${e.value}`
                        : `${e.host}\t${e.type}\t${e.value}`;
                      const cid = `exp-${i}`;
                      return (
                        <div key={cid} className={cn('rounded-md border p-2.5 text-xs space-y-1', cls)}>
                          <div className="flex items-center gap-2 flex-wrap">
                            <Icon size={12} className={cn('shrink-0', iconCls)} />
                            <Badge variant="outline" className="font-mono text-[10px]">{e.type}</Badge>
                            <span className="font-mono text-[11px] truncate">{e.host}</span>
                            <span className="text-muted-foreground">→</span>
                            <span className="font-mono text-[11px] font-semibold truncate">
                              {e.priority !== undefined && <span className="opacity-60">{e.priority} </span>}{e.value}
                            </span>
                            <button
                              className="ml-auto text-muted-foreground hover:text-foreground"
                              onClick={() => onCopy(copyText, cid)}
                              title="Copy host / type / value"
                            >
                              {copiedId === cid ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
                            </button>
                          </div>
                          <p className="text-[10px] text-muted-foreground">{e.reason}</p>
                          {e.status === 'WRONG' && e.actualValue && (
                            <p className="text-[10px] text-red-500 font-mono">
                              Currently resolves to: {e.actualValue}
                            </p>
                          )}
                          {e.status === 'MISSING' && (
                            <p className="text-[10px] text-orange-500">Not set yet.</p>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* All detected records */}
                <div className="space-y-2 mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Currently detected (live)</p>
                  {(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as DnsRecordType[]).map((type) => {
                    const list = records.actual[type];
                    if (!list || list.length === 0) return null;
                    return (
                      <div key={type} className="rounded-md border border-border p-2.5">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant="outline" className="font-mono text-[10px]">{type}</Badge>
                          <span className="text-[10px] text-muted-foreground">{list.length} record{list.length > 1 ? 's' : ''}</span>
                        </div>
                        {list.map((r, i) => (
                          <p key={i} className="font-mono text-[11px] break-all">
                            {r.priority !== undefined && <span className="text-muted-foreground">{r.priority} </span>}
                            {r.value}
                          </p>
                        ))}
                      </div>
                    );
                  })}
                  {(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as DnsRecordType[]).every((t) => (records.actual[t] || []).length === 0) && (
                    <p className="text-xs text-muted-foreground italic">No records detected. Domain may not be propagated yet.</p>
                  )}
                </div>

                <p className="text-[10px] text-muted-foreground mt-2">
                  Resolved against Cloudflare (1.1.1.1) at {new Date(records.checkedAt).toLocaleTimeString()}.
                </p>
              </>
            )}
          </>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Close</Button>
      </DialogFooter>
    </Dialog>
  );
}

// ── Page ──────────────────────────────────────────────────────────────
export default function DomainsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null);
  const [dnsTarget, setDnsTarget] = useState<Domain | null>(null);
  const [copiedId, setCopiedId] = useState('');
  const [filterProjectId, setFilterProjectId] = useState('');
  const [expandedApex, setExpandedApex] = useState<Set<string>>(new Set());

  const [domainName, setDomainName] = useState('');
  const [applicationId, setApplicationId] = useState('');
  const [createProjectId, setCreateProjectId] = useState('');
  const [autoSsl, setAutoSsl] = useState(true);

  const { data: domains = [], isLoading } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => api.get('/domains'),
  });

  type ProxyStatus = { running: boolean; status: string };
  const { data: proxyStatus, refetch: refetchProxy } = useQuery<ProxyStatus | null>({
    queryKey: ['reverse-proxy-status'],
    queryFn: async () => {
      try { return await api.get<ProxyStatus>('/reverse-proxy/status'); }
      catch { return null; }
    },
    refetchInterval: 15_000,
  });
  const proxySyncMutation = useMutation({
    mutationFn: () => api.post('/reverse-proxy/sync'),
    onSuccess: () => {
      toast.success('Reverse proxy reloaded');
      refetchProxy();
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
    onError: (err: Error) => toastError(err),
  });
  const proxyStartMutation = useMutation({
    mutationFn: () => api.post('/reverse-proxy/start'),
    onSuccess: () => { toast.success('Reverse proxy starting...'); refetchProxy(); },
    onError: (err: Error) => toastError(err),
  });

  const { data: projects = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['projects'],
    queryFn: () => api.get('/projects'),
  });

  const { data: allApps = [] } = useQuery<{ id: string; name: string; projectId: string }[]>({
    queryKey: ['applications'],
    queryFn: () => api.get('/applications'),
  });

  const appsForCreate = createProjectId
    ? allApps.filter((a) => a.projectId === createProjectId)
    : [];

  const { data: server } = useQuery<any>({
    queryKey: ['server-local'],
    queryFn: () => api.get('/servers/local'),
  });
  const { data: publicSettings } = useQuery<{ public_ip?: string }>({
    queryKey: ['public-settings'],
    queryFn: () => api.get('/settings/public'),
  });

  const localFallback = server?.host && server.host !== '127.0.0.1' && server.host !== 'localhost'
    ? server.host : null;
  const serverIp = publicSettings?.public_ip || localFallback || 'YOUR-SERVER-IP';

  // ── filter + group ────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return domains.filter((d) => {
      if (search.trim() && !d.domain.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterProjectId) {
        const pid = d.project?.id || d.application?.project?.id;
        return pid === filterProjectId;
      }
      return true;
    });
  }, [domains, search, filterProjectId]);

  const groups = useMemo(() => groupByApex(filtered), [filtered]);

  function toggleApex(apex: string) {
    setExpandedApex((cur) => {
      const next = new Set(cur);
      if (next.has(apex)) next.delete(apex);
      else next.add(apex);
      return next;
    });
  }

  const createMutation = useMutation({
    mutationFn: (data: { domain: string; projectId: string; applicationId?: string; autoSsl?: boolean }) =>
      api.post('/domains', data),
    onSuccess: (res: any) => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Domain added');
      if (autoSsl && res?.id) {
        api.post('/ssl/issue', { domainId: res.id }).then(() => {
          toast.success('SSL certificate requested');
          queryClient.invalidateQueries({ queryKey: ['domains'] });
        }).catch(() => toast.error('SSL request failed'));
      }
      closeAdd();
    },
    onError: (err: Error) => toastError(err),
  });

  const renewMutation = useMutation({
    mutationFn: (domainId: string) => api.post('/ssl/issue', { domainId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('SSL renewal requested');
    },
    onError: (err: Error) => toastError(err),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/domains/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Domain deleted');
      setDeleteTarget(null);
    },
    onError: (err: Error) => toastError(err),
  });

  function closeAdd() {
    setShowAdd(false); setDomainName(''); setApplicationId('');
    setCreateProjectId(''); setAutoSsl(true);
  }
  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!domainName.trim() || !createProjectId) return;
    createMutation.mutate({
      domain: domainName.trim().toLowerCase(),
      projectId: createProjectId,
      ...(applicationId ? { applicationId } : {}),
      autoSsl,
    });
  }
  function copyDns(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(''), 2000);
  }
  function openAddSubdomain(parent: string) {
    setDomainName(`.${parent}`);
    // try to pre-set the project from the parent's record
    const parentDomain = domains.find((d) => d.domain === parent);
    const projId = parentDomain?.project?.id || parentDomain?.application?.project?.id || '';
    setCreateProjectId(projId);
    setShowAdd(true);
    // focus the prefix
    setTimeout(() => {
      const el = document.querySelector<HTMLInputElement>('input[data-domain-input]');
      el?.focus();
      el?.setSelectionRange(0, 0);
    }, 100);
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold">{t('domains.title')}</h1>
          {domains.length > 0 && <Badge variant="secondary" className="text-sm">{domains.length}</Badge>}
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus size={16} /> {t('domains.add')}
        </Button>
      </div>

      {/* Reverse proxy status banner */}
      {proxyStatus && (
        <div className={cn(
          'flex items-center gap-3 rounded-lg border p-3',
          proxyStatus.running ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-orange-500/30 bg-orange-500/5',
        )}>
          <span className={cn(
            'h-2.5 w-2.5 rounded-full shrink-0',
            proxyStatus.running ? 'bg-emerald-500 animate-pulse' : 'bg-orange-500',
          )} />
          <div className="flex-1">
            <p className="text-sm font-medium">
              Reverse proxy {proxyStatus.running ? 'running' : 'stopped'}
            </p>
            <p className="text-xs text-muted-foreground">
              {proxyStatus.running
                ? 'Caddy is routing traffic from :80/:443 to your linked apps.'
                : 'Apps with linked domains are only reachable via their host port directly.'}
            </p>
          </div>
          {proxyStatus.running ? (
            <Button size="sm" variant="outline" disabled={proxySyncMutation.isPending}
              onClick={() => proxySyncMutation.mutate()}>
              <RefreshCw size={12} /> {proxySyncMutation.isPending ? 'Reloading...' : 'Resync'}
            </Button>
          ) : (
            <Button size="sm" disabled={proxyStartMutation.isPending}
              onClick={() => proxyStartMutation.mutate()}>
              {proxyStartMutation.isPending ? 'Starting...' : 'Start'}
            </Button>
          )}
        </div>
      )}

      {/* Search + project filter */}
      {domains.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search domains..." className="pl-9" value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {projects.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant={filterProjectId === '' ? 'default' : 'outline'} onClick={() => setFilterProjectId('')}>
                All
              </Button>
              {projects.map((p) => (
                <Button
                  key={p.id}
                  size="sm"
                  variant={filterProjectId === p.id ? 'default' : 'outline'}
                  onClick={() => setFilterProjectId(filterProjectId === p.id ? '' : p.id)}
                >
                  {p.name}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Loading */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {[1, 2, 3].map(i => <Card key={i} className="animate-pulse"><CardContent className="h-40" /></Card>)}
        </div>
      ) : groups.length === 0 && !search ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Globe size={48} className="mb-4 text-muted-foreground" />
            <p className="text-lg font-medium">{t('domains.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('domains.emptyDesc')}</p>
            <Button className="mt-4" onClick={() => setShowAdd(true)}><Plus size={16} /> {t('domains.add')}</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
            const expanded = expandedApex.has(g.apex);
            const totalCount = (g.apexDomain ? 1 : 0) + g.subdomains.length;
            return (
              <div key={g.apex} className="space-y-2">
                {/* group header */}
                <div className="flex items-center justify-between gap-2 px-1">
                  <button
                    onClick={() => toggleApex(g.apex)}
                    className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
                  >
                    {g.subdomains.length > 0 ? (
                      expanded
                        ? <ChevronDown size={14} />
                        : <ChevronRight size={14} />
                    ) : (
                      <span className="w-3.5" />
                    )}
                    <Globe size={12} />
                    <span className="font-mono">{g.apex}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {totalCount} record{totalCount !== 1 ? 's' : ''}
                    </Badge>
                  </button>
                  {!g.apexDomain && (
                    <Button size="sm" variant="outline" className="h-7 text-xs"
                      onClick={() => openAddSubdomain(g.apex)}>
                      <Plus size={11} /> Sub
                    </Button>
                  )}
                </div>

                {/* apex card */}
                {g.apexDomain && (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <DomainCard
                      domain={g.apexDomain}
                      serverIp={serverIp}
                      isSubdomain={false}
                      onDelete={setDeleteTarget}
                      onAddSubdomain={openAddSubdomain}
                      onRenew={(id) => renewMutation.mutate(id)}
                      onCopyDns={copyDns}
                      onOpenDns={setDnsTarget}
                      copiedId={copiedId}
                    />
                  </div>
                )}

                {/* subdomains, expandable */}
                {g.subdomains.length > 0 && expanded && (
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 pl-5 border-l-2 border-border ml-1">
                    {g.subdomains.map((s) => (
                      <DomainCard
                        key={s.id}
                        domain={s}
                        serverIp={serverIp}
                        isSubdomain
                        onDelete={setDeleteTarget}
                        onAddSubdomain={openAddSubdomain}
                        onRenew={(id) => renewMutation.mutate(id)}
                        onCopyDns={copyDns}
                        onOpenDns={setDnsTarget}
                        copiedId={copiedId}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add Dialog */}
      <Dialog open={showAdd} onClose={closeAdd}>
        <DialogHeader>
          <DialogTitle>{t('domains.add')}</DialogTitle>
          <DialogDescription>Add an apex domain or a subdomain</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-2">
            <Label>Domain name</Label>
            <Input
              data-domain-input
              placeholder="app.example.com"
              value={domainName}
              onChange={e => setDomainName(e.target.value)}
              required
              className="font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              Apex (athexis.xyz) → A record. Subdomain (api.athexis.xyz) → CNAME to the apex.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Project *</Label>
            <Select value={createProjectId} onChange={(e) => { setCreateProjectId(e.target.value); setApplicationId(''); }} required>
              <option value="">— Select a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </Select>
          </div>

          {createProjectId && appsForCreate.length > 0 && (
            <div className="space-y-2">
              <Label>Application (optional)</Label>
              <Select value={applicationId} onChange={(e) => setApplicationId(e.target.value)}>
                <option value="">— No app —</option>
                {appsForCreate.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                Optional — link to an app to route HTTP traffic to it. Leave empty for mail-only domains.
              </p>
            </div>
          )}
          <div className="flex items-center gap-2">
            <input id="auto-ssl" type="checkbox" checked={autoSsl} onChange={e => setAutoSsl(e.target.checked)} className="h-4 w-4 rounded border-input" />
            <Label htmlFor="auto-ssl">Auto SSL (Let's Encrypt)</Label>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
            <p className="text-xs text-muted-foreground">
              <strong>1.</strong> At your DNS provider, add:{' '}
              {(() => {
                const h = domainName.trim();
                if (!h || h.startsWith('.')) return <span className="font-mono">{h || 'your domain'} → {serverIp}</span>;
                const labels = h.split('.');
                if (labels.length > 2) {
                  return <span className="font-mono">CNAME {h} → {labels.slice(-2).join('.')}</span>;
                }
                return <span className="font-mono">A {h} → {serverIp}</span>;
              })()}
            </p>
            <p className="text-xs text-muted-foreground">
              <strong>2.</strong> Wait ~5 min for propagation. SSL provisions automatically.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeAdd}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={createMutation.isPending || !createProjectId || !domainName.trim()}>
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              {t('common.create')}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      {/* Delete Dialog */}
      {/* DNS Health Dialog */}
      {dnsTarget && (
        <DnsHealthDialog
          domain={dnsTarget}
          onClose={() => setDnsTarget(null)}
          onCopy={copyDns}
          copiedId={copiedId}
        />
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>Delete Domain</DialogTitle>
          <DialogDescription>
            Delete <span className="font-mono font-semibold text-foreground">{deleteTarget?.domain}</span>?
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 px-1 pb-2">
          <p className="text-sm font-medium">This will permanently remove:</p>
          <ul className="text-sm list-disc list-inside text-muted-foreground space-y-1">
            <li>The DNS guide, SSL certificate, and reverse-proxy route</li>
            <li>The mail server stack (if deployed)</li>
            <li>All mailboxes, aliases, stored emails, and the DKIM key</li>
          </ul>
          <p className="text-xs text-orange-500 font-medium pt-1">This action is irreversible.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
          <Button variant="destructive" disabled={deleteMutation.isPending}
            onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}>
            {deleteMutation.isPending && <Loader2 size={14} className="animate-spin" />}
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
