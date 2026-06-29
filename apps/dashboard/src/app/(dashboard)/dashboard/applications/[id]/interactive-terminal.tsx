'use client';

import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { API_URL } from '@/lib/api';
import { useAuthStore } from '@/lib/store';
import { useTranslation } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

type Status = 'connecting' | 'connected' | 'closed';

/**
 * Interactive terminal: an xterm.js client wired to the API's `/ws/terminal`
 * WebSocket gateway. The gateway bridges to a real PTY inside the app's
 * container (docker exec locally, SSH to the agent for remote apps), so output
 * STREAMS live — `unzip`, `top`, `nano` all work, with Ctrl-C and colours.
 */
export function InteractiveTerminal({ appId }: { appId: string }) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<XTerm | null>(null);
  // Read t() via a ref inside the effect so a LOCALE change doesn't re-run the
  // effect (which would tear down the live WebSocket/PTY session + scrollback).
  const tRef = useRef(t);
  tRef.current = t;
  const [status, setStatus] = useState<Status>('connecting');
  const [generation, setGeneration] = useState(0); // bump to reconnect

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: '#09090b' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    try { fit.fit(); } catch {}
    termRef.current = term;

    // Build wss://… from the API URL. The access token is NOT placed in the
    // URL (query-string tokens leak into proxy/access logs, browser history and
    // the DevTools network panel) — it is sent in the first 'auth' frame below.
    const token = useAuthStore.getState().accessToken || '';
    const wsBase = API_URL.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsBase}/ws/terminal?appId=${encodeURIComponent(appId)}`);
    wsRef.current = ws;
    setStatus('connecting');

    const sendResize = () => {
      try {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch {}
    };

    ws.onopen = () => {
      // First frame authenticates the session (token kept out of the URL).
      try { ws.send(JSON.stringify({ type: 'auth', token })); } catch {}
      setStatus('connected');
      term.focus();
      sendResize();
    };
    ws.onmessage = (ev) => {
      // Control frames are JSON ({type:'exit'}); everything else is raw output.
      if (typeof ev.data === 'string' && ev.data.startsWith('{')) {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'exit') {
            term.writeln(`\r\n\x1b[90m— ${tRef.current('apps.term.sessionEnded')} —\x1b[0m`);
            return;
          }
        } catch { /* not a control frame → fall through as data */ }
      }
      term.write(typeof ev.data === 'string' ? ev.data : '');
    };
    ws.onclose = () => setStatus('closed');
    ws.onerror = () => setStatus('closed');

    const onData = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'data', data: d }));
    });
    const onResize = () => sendResize();
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      onData.dispose();
      try { ws.close(); } catch {}
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [appId, generation]);

  const statusLabel =
    status === 'connected' ? t('apps.term.connected')
    : status === 'connecting' ? t('apps.term.connecting')
    : t('apps.term.disconnected');
  const statusColor =
    status === 'connected' ? 'text-green-400'
    : status === 'connecting' ? 'text-amber-400'
    : 'text-red-400';

  return (
    <div className="rounded-lg border border-zinc-800 overflow-hidden bg-[#09090b]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900">
        <span className={`text-xs font-mono ${statusColor}`}>● {statusLabel}</span>
        {status === 'closed' && (
          <Button size="sm" variant="ghost" className="h-6 text-xs"
            onClick={() => setGeneration((g) => g + 1)}>
            <RefreshCw size={12} /> {t('apps.term.reconnect')}
          </Button>
        )}
      </div>
      <div ref={containerRef} className="h-[460px] w-full p-2" />
    </div>
  );
}
