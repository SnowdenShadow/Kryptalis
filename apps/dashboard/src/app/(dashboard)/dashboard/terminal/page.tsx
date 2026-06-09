'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Terminal as TerminalIcon, Power, Loader2, AlertTriangle,
  Rocket, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Web terminal.
 *
 * Lets a project admin pop a shell into one of their app containers
 * straight from the browser. Backed by `/terminal/*` endpoints that
 * proxy keystrokes/output through `docker exec` — no SSH bridge, no
 * port to expose, no extra credentials.
 *
 * UI is a deliberately minimal VT100-style renderer (monospace pre +
 * onKeyDown) instead of pulling in xterm.js (~500 KB gz). That covers
 * 95% of the "I want to peek at PHP logs / clear cache / run migrate"
 * flow well; full-screen TUI programs (vim, htop) degrade since we
 * don't have a real PTY, but ed/nano/less work fine.
 */

interface ScopeApp { id: string; name: string; status: string; containerName?: string | null }
interface ProjectScope {
  id: string; name: string; role: string;
  applications: ScopeApp[];
}

interface OpenResp { id: string; containerName: string }
interface OutputResp { cursor: number; data: string; closed: boolean; closedReason?: string }

const ROLE_RANK: Record<string, number> = { OWNER: 100, ADMIN: 80, DEVELOPER: 50, VIEWER: 10 };

export default function TerminalPage() {
  const { data: scopes = [] } = useQuery<ProjectScope[]>({
    queryKey: ['file-scopes'],
    queryFn: () => api.get('/files/scopes'),
  });

  // Filter to apps whose project role gives ADMIN+ access — that's the
  // backend gate. Showing read-only apps in the picker would just lead
  // to a 403 on Open.
  const adminApps = useMemo(() => {
    const out: Array<ScopeApp & { projectName: string }> = [];
    for (const p of scopes) {
      if (!ROLE_RANK[p.role] || ROLE_RANK[p.role] < ROLE_RANK.ADMIN) continue;
      for (const a of p.applications) {
        out.push({ ...a, projectName: p.name });
      }
    }
    return out;
  }, [scopes]);

  const [appId, setAppId] = useState('');
  const [session, setSession] = useState<OpenResp | null>(null);
  const [output, setOutput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [opening, setOpening] = useState(false);
  const [closed, setClosed] = useState(false);
  const [closedReason, setClosedReason] = useState<string | undefined>();
  const [input, setInput] = useState('');

  const preRef = useRef<HTMLPreElement>(null);
  const cursorRef = useRef(0);
  // Polling can finish AFTER session is closed by user — guard with a
  // ref instead of a state read so the effect doesn't capture stale.
  const activeRef = useRef(false);

  const openSession = async () => {
    if (!appId) return;
    setOpening(true);
    setOutput('');
    setCursor(0);
    cursorRef.current = 0;
    setClosed(false);
    setClosedReason(undefined);
    try {
      const res = await api.post<OpenResp>('/terminal', { appId });
      setSession(res);
      activeRef.current = true;
      toast.success(`Attached to ${res.containerName}`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to open terminal');
    } finally {
      setOpening(false);
    }
  };

  const closeSession = useCallback(async () => {
    if (!session) return;
    activeRef.current = false;
    try {
      await api.post(`/terminal/${session.id}/close`);
    } catch {}
    setSession(null);
    setClosed(true);
  }, [session]);

  // Long-poll output. We restart the loop on every (session, cursor)
  // change but use cursorRef.current as the SOURCE OF TRUTH so the
  // request URL always carries the latest known cursor.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    activeRef.current = true;

    const loop = async () => {
      while (!cancelled && activeRef.current) {
        try {
          const res = await api.get<OutputResp>(
            `/terminal/${session.id}/output?cursor=${cursorRef.current}`,
          );
          if (cancelled) return;
          if (res.data) {
            setOutput((prev) => prev + res.data);
            cursorRef.current = res.cursor;
            setCursor(res.cursor);
          } else if (res.cursor !== cursorRef.current) {
            cursorRef.current = res.cursor;
            setCursor(res.cursor);
          }
          if (res.closed) {
            setClosed(true);
            setClosedReason(res.closedReason);
            activeRef.current = false;
            break;
          }
        } catch (err: any) {
          if (cancelled) return;
          // Burn a tiny backoff so a 5xx blip doesn't pin the CPU.
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    loop();
    return () => { cancelled = true; };
  }, [session]);

  // Auto-scroll the pre to the bottom whenever new output lands —
  // unless the user has scrolled up to read history. We detect that by
  // comparing scrollTop+clientHeight against scrollHeight before the
  // append.
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    // 30 px lee-way so a few pixels of accidental scroll don't pin us.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [output]);

  const sendKey = async (data: string) => {
    if (!session || closed) return;
    try {
      await api.post(`/terminal/${session.id}/input`, { data });
    } catch (err: any) {
      toast.error(err?.message || 'Send failed');
    }
  };

  // The visible <input> mirrors what the user is typing on the current
  // line; Enter flushes it (plus \n) to the server. Ctrl-C / Ctrl-D
  // and arrow keys go straight to the shell as their byte equivalents.
  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!session || closed) return;
    // Ctrl-C → ETX (0x03)
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      setInput('');
      await sendKey('\x03');
      return;
    }
    // Ctrl-D → EOT (0x04)
    if (e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      setInput('');
      await sendKey('\x04');
      return;
    }
    // Ctrl-L → ANSI clear (\x1b[H\x1b[2J). We render plain text so do
    // the visual clear on the client too.
    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      setOutput('');
      return;
    }
    // Arrow up/down for history — let the remote shell handle it.
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      await sendKey('\x1b[A');
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      await sendKey('\x1b[B');
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      // Send the buffered text as-is plus Tab so the shell can
      // complete on whatever the user has typed locally.
      await sendKey(input + '\t');
      // Don't clear the local buffer — the server response will
      // overwrite it via the echoed completion.
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      await sendKey(input + '\n');
      setInput('');
      return;
    }
  };

  const selectedApp = adminApps.find((a) => a.id === appId);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <TerminalIcon size={26} /> Terminal
        </h1>
        <p className="text-muted-foreground">
          Web shell into your application containers. Sessions are sandboxed to
          the container and capped at 30 minutes of idle time, 4 hours total.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Application</CardTitle>
          <CardDescription className="text-xs">
            Only apps you can ADMIN are listed. The app must be running
            (a live container is required).
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Select value={appId} onChange={(e) => setAppId(e.target.value)} disabled={!!session}>
            <option value="">Pick an application…</option>
            {scopes
              .filter((p) => ROLE_RANK[p.role] >= ROLE_RANK.ADMIN)
              .map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {p.applications.map((a) => (
                    <option key={a.id} value={a.id} disabled={a.status !== 'RUNNING'}>
                      {a.name} {a.status !== 'RUNNING' && `· ${a.status.toLowerCase()}`}
                    </option>
                  ))}
                </optgroup>
              ))}
          </Select>
          {!session ? (
            <Button onClick={openSession} disabled={!appId || opening}>
              {opening ? <Loader2 size={14} className="animate-spin" /> : <Power size={14} />}
              Connect
            </Button>
          ) : (
            <Button variant="destructive" onClick={closeSession}>
              <Trash2 size={14} /> Disconnect
            </Button>
          )}
        </CardContent>
      </Card>

      {session && (
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-sm flex items-center gap-2">
                <Badge variant="outline" className="gap-1">
                  <Rocket size={9} /> {selectedApp?.name}
                </Badge>
                <code className="font-mono text-xs text-muted-foreground">
                  {session.containerName}
                </code>
                {closed && <Badge variant="destructive" className="text-[10px]">closed</Badge>}
              </CardTitle>
              {closedReason && (
                <p className="text-[11px] text-muted-foreground mt-1 flex items-center gap-1">
                  <AlertTriangle size={10} /> {closedReason}
                </p>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div
              className="rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden"
              onClick={() => {
                // Click anywhere in the pane focuses the input — same
                // habit users have with real terminals.
                document.getElementById('term-input')?.focus();
              }}
            >
              <pre
                ref={preRef}
                className={cn(
                  'p-3 font-mono text-xs text-green-300 whitespace-pre-wrap break-all',
                  'h-[60vh] overflow-y-auto',
                )}
              >
                {output || (closed ? '(session ended)' : '(connecting…)')}
              </pre>
              <div className="border-t border-zinc-800 px-3 py-2 flex items-center gap-2">
                <span className="text-green-400 font-mono text-xs select-none">$</span>
                <input
                  id="term-input"
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={closed}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  className="flex-1 bg-transparent font-mono text-xs text-green-300 outline-none placeholder:text-zinc-700"
                  placeholder={closed ? 'Session closed' : 'Type a command and press Enter — Ctrl-C to interrupt, Ctrl-L to clear'}
                />
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">
              Tip: arrows ↑↓ for shell history, Tab for completion, Ctrl-D to exit the shell.
            </p>
          </CardContent>
        </Card>
      )}

      {!session && adminApps.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            <TerminalIcon size={32} className="mx-auto mb-2 opacity-50" />
            <p>No apps available — you need ADMIN role on a project with running apps.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
