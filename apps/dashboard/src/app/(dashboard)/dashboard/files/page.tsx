'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Upload,
  FolderPlus,
  Download,
  Trash2,
  Folder,
  File as FileIcon,
  FileCode,
  FileText,
  FileJson,
  FileImage,
  FileArchive,
  FileAudio,
  FileVideo,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Rocket,
  Database as DbIcon,
  FolderKanban,
  Save,
  X,
  RefreshCw,
  ArrowLeft,
  Loader2,
  Search,
  AlertTriangle,
  Pencil,
  ArrowUpDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useTranslation } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type Role = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER';
const ROLE_RANK: Record<Role, number> = { OWNER: 100, ADMIN: 80, DEVELOPER: 50, VIEWER: 10 };
function has(role: Role | undefined, min: Role) {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min];
}

interface ScopeApp { id: string; name: string; framework: string; status: string; hasFiles: boolean }
interface ScopeDb { id: string; name: string; type: string; applicationId: string | null; hasFiles: boolean }
interface ProjectScope {
  id: string; name: string; role: Role;
  applications: ScopeApp[];
  databases: ScopeDb[];
}

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
  permissions: string;
  isHidden: boolean;
}

interface ListResp {
  scope: 'app' | 'db';
  scopeName: string;
  path: string;
  breadcrumbs: { name: string; path: string }[];
  entries: FileEntry[];
}

interface ReadResp {
  path: string;
  binary: boolean;
  size: number;
  content?: string;
  sha256?: string;
  message?: string;
}

const TYPE_EMOJI: Record<string, string> = {
  POSTGRESQL: '🐘', MYSQL: '🐬', MARIADB: '🦭', REDIS: '🔴', MONGODB: '🍃',
};

// ── per-extension icon + color hint ──────────────────────────────────────
// Keeps the listing scan-able even with hundreds of mixed-type files.
// Group by category rather than mint a unique icon per extension — three
// dozen lucide icons would clash visually and slow the eye down.
function iconForFile(name: string) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  // Code
  if (/^(ts|tsx|js|jsx|mjs|cjs|py|rb|php|go|rs|java|c|cpp|h|hpp|cs|sh|bash|zsh|fish|ps1|vue|svelte|astro|sql|graphql|gql|proto)$/.test(ext)) {
    return { Icon: FileCode, color: 'text-blue-400' };
  }
  if (ext === 'json') return { Icon: FileJson, color: 'text-yellow-500' };
  if (/^(yml|yaml|toml|ini|cfg|conf|config|env|gitignore|gitattributes|dockerignore|editorconfig)$/.test(ext)) {
    return { Icon: FileText, color: 'text-emerald-400' };
  }
  if (/^(md|markdown|txt|rst|readme|license)$/.test(ext)) {
    return { Icon: FileText, color: 'text-zinc-400' };
  }
  if (/^(html|htm|css|scss|sass|less)$/.test(ext)) {
    return { Icon: FileCode, color: 'text-orange-400' };
  }
  if (/^(png|jpg|jpeg|gif|webp|svg|bmp|ico|avif|tiff?)$/.test(ext)) {
    return { Icon: FileImage, color: 'text-pink-400' };
  }
  if (/^(mp3|wav|ogg|flac|m4a|aac|wma)$/.test(ext)) {
    return { Icon: FileAudio, color: 'text-purple-400' };
  }
  if (/^(mp4|mkv|avi|mov|webm|flv|wmv)$/.test(ext)) {
    return { Icon: FileVideo, color: 'text-red-400' };
  }
  if (/^(zip|tar|gz|tgz|bz2|xz|7z|rar)$/.test(ext)) {
    return { Icon: FileArchive, color: 'text-amber-500' };
  }
  if (/^(pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods)$/.test(ext)) {
    return { Icon: FileText, color: 'text-rose-400' };
  }
  return { Icon: FileIcon, color: 'text-muted-foreground' };
}

// ── relative date formatter ──────────────────────────────────────────────
function fmtRelativeDate(iso: string, t: (k: string, v?: Record<string, string | number>) => string) {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return iso;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return t('files.justNow');
  if (s < 60) return t('files.secAgo', { n: s });
  if (s < 3600) return t('files.minAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('files.hourAgo', { n: Math.floor(s / 3600) });
  const d = Math.floor(s / 86400);
  if (d === 1) return t('files.yesterday');
  if (d < 7) return t('files.dayAgo', { n: d });
  if (d < 365) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

type SortKey = 'name' | 'size' | 'modified' | 'type';
type SortDir = 'asc' | 'desc';

function fmtSize(bytes: number) {
  if (bytes === 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString();
}

interface UsageResp {
  used: string;
  quota: string;
}

function fmtGiB(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GiB';
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 10) return `${gib.toFixed(0)} GiB`;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  const mib = bytes / (1024 * 1024);
  if (mib >= 1) return `${mib.toFixed(0)} MiB`;
  const kib = bytes / 1024;
  return `${kib.toFixed(0)} KiB`;
}

export default function FilesPage() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<{ scope: 'app' | 'db'; id: string; role: Role; name: string; projectId: string } | null>(null);
  const [currentPath, setCurrentPath] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ path: string; original: string; draft: string } | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [search, setSearch] = useState('');
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // ── sort state ────────────────────────────────────────────────────
  // Click on a column header cycles through asc → desc → asc. We sort
  // CLIENT-side because we already have the full listing in memory and
  // the API returns at most O(few hundred) entries per dir; pagination
  // would push us to server-side but that's not in scope.
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  // ── multi-selection ────────────────────────────────────────────────
  // We track a Set of paths so "select all", "delete N", "download
  // selected" all become trivial. Reset whenever the user navigates or
  // changes scope.
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  useEffect(() => { setSelectedPaths(new Set()); }, [currentPath, selected?.id]);
  function toggleSelected(p: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }

  // ── drag & drop upload ────────────────────────────────────────────
  // We treat the listing card as a single drop zone. dragOver counts
  // depth — Chrome fires dragleave on every child element traversal so
  // a naive boolean flickers; counting matches React's standard pattern.
  const [dragDepth, setDragDepth] = useState(0);

  // ── bulk delete dialog ────────────────────────────────────────────
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // ── scopes (left panel) ────────────────────────────────────────────
  const { data: scopes = [], isLoading: scopesLoading } = useQuery<ProjectScope[]>({
    queryKey: ['file-scopes'],
    queryFn: () => api.get('/files/scopes'),
  });

  // auto-expand all projects when first loaded
  useEffect(() => {
    if (scopes.length && expandedProjects.size === 0) {
      setExpandedProjects(new Set(scopes.map(p => p.id)));
    }
  }, [scopes]);

  // ── listing (right panel) ──────────────────────────────────────────
  const { data: listing, isLoading: listingLoading, refetch: refetchListing } = useQuery<ListResp>({
    queryKey: ['file-list', selected?.scope, selected?.id, currentPath],
    queryFn: () => api.get(`/files/${selected!.scope}/${selected!.id}?path=${encodeURIComponent(currentPath)}`),
    enabled: !!selected,
  });

  // ── per-project storage usage / quota progress bar ────────────────
  // Server returns bigint-strings; JS numbers are safe up to ~9 PiB so
  // Number() is fine for display purposes. We refetch whenever the user
  // mutates (write/upload/mkdir/remove) — same trigger as listing.
  const { data: usage, refetch: refetchUsage } = useQuery<UsageResp>({
    queryKey: ['file-usage', selected?.projectId],
    queryFn: () => api.get(`/files/project/${selected!.projectId}/usage`),
    enabled: !!selected?.projectId,
  });
  const usedBytes = usage ? Number(usage.used) : 0;
  const quotaBytes = usage ? Number(usage.quota) : 0;
  const pct = quotaBytes > 0 ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;
  const barColor = pct > 95 ? 'bg-red-500' : pct > 80 ? 'bg-orange-500' : 'bg-primary';
  const labelColor = pct > 95 ? 'text-red-500' : pct > 80 ? 'text-orange-500' : 'text-muted-foreground';

  // Filter → sort. We ALWAYS keep folders first regardless of sort key
  // — that's the convention every file manager (Finder, Explorer,
  // Filezilla) follows, and breaking it confuses muscle memory.
  const filteredEntries = (() => {
    const raw = (listing?.entries || []).filter((e) =>
      !search.trim() || e.name.toLowerCase().includes(search.toLowerCase()),
    );
    const mult = sortDir === 'asc' ? 1 : -1;
    const cmp = (a: FileEntry, b: FileEntry) => {
      // Folders → top, regardless of sort key.
      const aDir = a.type === 'directory';
      const bDir = b.type === 'directory';
      if (aDir !== bDir) return aDir ? -1 : 1;
      switch (sortKey) {
        case 'size': {
          // Directories share size=0; tie-break on name so the order is
          // stable when sorting by size with many folders.
          if (a.size !== b.size) return mult * (a.size - b.size);
          return a.name.localeCompare(b.name);
        }
        case 'modified': {
          const at = new Date(a.modifiedAt).getTime();
          const bt = new Date(b.modifiedAt).getTime();
          if (at !== bt) return mult * (at - bt);
          return a.name.localeCompare(b.name);
        }
        case 'type': {
          const ae = (a.name.split('.').pop() || '').toLowerCase();
          const be = (b.name.split('.').pop() || '').toLowerCase();
          if (ae !== be) return mult * ae.localeCompare(be);
          return a.name.localeCompare(b.name);
        }
        case 'name':
        default:
          return mult * a.name.localeCompare(b.name, undefined, { numeric: true });
      }
    };
    return [...raw].sort(cmp);
  })();

  const allSelected =
    filteredEntries.length > 0 &&
    filteredEntries.every((e) => selectedPaths.has(e.path));
  function toggleAll() {
    if (allSelected) {
      setSelectedPaths(new Set());
    } else {
      setSelectedPaths(new Set(filteredEntries.map((e) => e.path)));
    }
  }

  // ── mutations ──────────────────────────────────────────────────────
  const mkdirMutation = useMutation({
    mutationFn: (name: string) => api.post(`/files/${selected!.scope}/${selected!.id}/mkdir`, {
      path: currentPath ? `${currentPath}/${name}` : name,
    }),
    onSuccess: () => {
      toast.success(t('files.toastFolder'));
      setNewFolderOpen(false);
      setNewFolderName('');
      refetchListing();
      refetchUsage();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.patch(`/files/${selected!.scope}/${selected!.id}/rename`, { from, to }),
    onSuccess: () => {
      toast.success(t('files.toastRenamed'));
      setRenameTarget(null);
      setRenameValue('');
      refetchListing();
      refetchUsage();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (p: string) =>
      api.delete(`/files/${selected!.scope}/${selected!.id}/entry?path=${encodeURIComponent(p)}`),
    onSuccess: () => {
      toast.success(t('files.toastDeleted'));
      setDeleteTarget(null);
      refetchListing();
      refetchUsage();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Bulk delete — fan out N parallel DELETEs, then collect outcomes
  // so the user sees a single toast with the count + a list of failures
  // rather than one toast per file.
  const bulkDeleteMutation = useMutation({
    mutationFn: async (paths: string[]) => {
      const results = await Promise.allSettled(
        paths.map((p) =>
          api.delete(`/files/${selected!.scope}/${selected!.id}/entry?path=${encodeURIComponent(p)}`),
        ),
      );
      const fails = results.filter((r) => r.status === 'rejected').length;
      return { total: paths.length, fails };
    },
    onSuccess: ({ total, fails }) => {
      if (fails === 0) toast.success(t('files.toastBulkOk', { n: total }));
      else toast.warning(t('files.toastBulkPartial', { ok: total - fails, fail: fails }));
      setBulkDeleteOpen(false);
      setSelectedPaths(new Set());
      refetchListing();
      refetchUsage();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const writeMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.patch(`/files/${selected!.scope}/${selected!.id}/file`, { path, content }),
    onSuccess: (_, vars) => {
      toast.success(t('files.toastSaved'));
      setEditing((e) => (e ? { ...e, original: vars.content } : e));
      refetchListing();
      refetchUsage();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── read a file (open editor) ──────────────────────────────────────
  const [readingPath, setReadingPath] = useState<string | null>(null);
  const { data: readData } = useQuery<ReadResp>({
    queryKey: ['file-read', selected?.scope, selected?.id, readingPath],
    queryFn: () => api.get(`/files/${selected!.scope}/${selected!.id}/file?path=${encodeURIComponent(readingPath!)}`),
    enabled: !!selected && !!readingPath,
  });

  useEffect(() => {
    if (readData && readingPath) {
      if (readData.binary) {
        toast.message(readData.message || t('files.editorBinary'), {
          description: t('files.editorBinaryDesc', { size: fmtSize(readData.size) }),
        });
        setReadingPath(null);
        return;
      }
      setEditing({ path: readData.path, original: readData.content || '', draft: readData.content || '' });
      setReadingPath(null);
    }
  }, [readData, readingPath]);

  // ── upload ─────────────────────────────────────────────────────────
  // Goes through api.rawFetch so the shared 401→refresh pipeline applies
  // (a bare fetch with the stored token broke 15 min into a session).
  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0 || !selected) return;
    for (const f of Array.from(files)) {
      try {
        const endpoint = `/files/${selected.scope}/${selected.id}/upload?path=${encodeURIComponent(currentPath)}&name=${encodeURIComponent(f.name)}`;
        const res = await api.rawFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: f,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: 'Upload failed' }));
          throw new Error(err.message || 'Upload failed');
        }
        toast.success(t('files.toastUploaded', { name: f.name }));
      } catch (e: any) {
        toast.error(e.message || t('files.toastUploadFail', { name: f.name }));
      }
    }
    if (uploadInputRef.current) uploadInputRef.current.value = '';
    refetchListing();
    refetchUsage();
  }

  function handleDownload(p: string, name: string) {
    if (!selected) return;
    api.rawFetch(`/files/${selected.scope}/${selected.id}/download?path=${encodeURIComponent(p)}`)
      .then(r => r.ok ? r.blob() : Promise.reject(new Error('Download failed')))
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((e: Error) => toast.error(e.message));
  }

  function toggleProject(id: string) {
    setExpandedProjects(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectScope(scope: 'app' | 'db', id: string, role: Role, name: string, projectId: string) {
    setSelected({ scope, id, role, name, projectId });
    setCurrentPath('');
    setEditing(null);
    setReadingPath(null);
    setSearch('');
  }

  const canEdit = has(selected?.role, 'DEVELOPER');
  const canDelete = has(selected?.role, 'ADMIN');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl font-bold">{t('files.title')}</h1>
        <p className="text-muted-foreground max-w-2xl">{t('files.subtitle')}</p>
      </div>

      {/* ── Project storage quota bar ──────────────────────────────── */}
      {selected && usage && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="font-medium">{t('files.quotaTitle')}</span>
              <span className={cn('font-mono', labelColor)}>
                {t('files.quotaUsed', {
                  used: fmtGiB(usedBytes),
                  quota: fmtGiB(quotaBytes),
                  pct: pct.toFixed(0),
                })}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full transition-all', barColor)}
                style={{ width: `${pct}%` }}
              />
            </div>
            {pct > 95 && (
              <p className="mt-1.5 text-xs text-red-500 flex items-center gap-1">
                <AlertTriangle size={11} /> {t('files.quotaWarn')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
        {/* ── Left panel: scopes ───────────────────────────────────── */}
        <Card>
          <CardContent className="p-2 space-y-1 max-h-[calc(100vh-220px)] overflow-y-auto">
            {scopesLoading ? (
              <div className="p-4"><Loader2 className="animate-spin" size={16} /></div>
            ) : scopes.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                <p>{t('files.scopeNone')}</p>
                <Link href="/dashboard/projects" className="text-primary hover:underline text-xs">{t('files.scopeCreate')}</Link>
              </div>
            ) : (
              scopes.map(p => {
                const open = expandedProjects.has(p.id);
                return (
                  <div key={p.id}>
                    <button
                      className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-accent text-left"
                      onClick={() => toggleProject(p.id)}
                    >
                      {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <FolderKanban size={14} className="text-primary" />
                      <span className="flex-1 truncate">{p.name}</span>
                      <Badge variant="outline" className="text-[9px]">{p.role}</Badge>
                    </button>
                    {open && (
                      <div className="ml-3 mt-0.5 border-l border-border pl-2 space-y-0.5">
                        {p.applications.length === 0 && p.databases.length === 0 && (
                          <p className="text-xs text-muted-foreground py-1.5">{t('files.scopeEmpty')}</p>
                        )}
                        {p.applications.map(a => (
                          <button
                            key={a.id}
                            onClick={() => selectScope('app', a.id, p.role, a.name, p.id)}
                            className={cn(
                              'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent text-left',
                              selected?.scope === 'app' && selected.id === a.id && 'bg-primary/10 text-primary',
                            )}
                          >
                            <Rocket size={12} />
                            <span className="flex-1 truncate">{a.name}</span>
                            {!a.hasFiles && (
                              <span className="text-[9px] text-muted-foreground italic">{t('files.scopeEmpty')}</span>
                            )}
                          </button>
                        ))}
                        {p.databases.map(d => (
                          <button
                            key={d.id}
                            onClick={() => selectScope('db', d.id, p.role, d.name, p.id)}
                            className={cn(
                              'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent text-left',
                              selected?.scope === 'db' && selected.id === d.id && 'bg-primary/10 text-primary',
                            )}
                          >
                            <span className="text-[10px]">{TYPE_EMOJI[d.type] || '🗄️'}</span>
                            <DbIcon size={12} />
                            <span className="flex-1 truncate">{d.name}</span>
                            {!d.hasFiles && (
                              <span className="text-[9px] text-muted-foreground italic">empty</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* ── Right panel: file browser ───────────────────────────── */}
        <Card>
          {!selected ? (
            <CardContent className="flex flex-col items-center justify-center py-20 text-center">
              <Folder size={48} className="mb-4 text-muted-foreground" />
              <p className="text-lg font-medium">{t('files.pickScope')}</p>
              <p className="text-sm text-muted-foreground mt-1">{t('files.pickScopeDesc')}</p>
            </CardContent>
          ) : (
            <>
              {/* toolbar */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Badge variant="outline" className="gap-1 shrink-0">
                    {selected.scope === 'app' ? <Rocket size={10} /> : <DbIcon size={10} />}
                    {selected.name}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px] shrink-0">{selected.role}</Badge>
                  <Breadcrumbs
                    crumbs={listing?.breadcrumbs || []}
                    onNavigate={(p) => setCurrentPath(p)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative w-44">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input className="pl-7 h-8 text-xs" placeholder={t('files.filter')} value={search}
                      onChange={(e) => setSearch(e.target.value)} />
                  </div>
                  <Button size="sm" variant="outline" onClick={() => refetchListing()} title={t('files.refresh')}>
                    <RefreshCw size={12} />
                  </Button>
                  {canEdit && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setNewFolderOpen(true)}>
                        <FolderPlus size={12} /> {t('files.newFolder')}
                      </Button>
                      <Button size="sm" onClick={() => uploadInputRef.current?.click()}>
                        <Upload size={12} /> {t('files.upload')}
                      </Button>
                      <input
                        ref={uploadInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => handleUpload(e.target.files)}
                      />
                    </>
                  )}
                </div>
              </div>

              {!canEdit && (
                <div className="flex items-center gap-2 border-b border-border bg-orange-500/5 px-3 py-2 text-xs text-muted-foreground">
                  <AlertTriangle size={12} className="text-orange-500" />
                  {t('files.readonly', { role: selected.role })}
                </div>
              )}

              {/* current path / parent up */}
              {currentPath && (
                <div className="border-b border-border px-3 py-1.5">
                  <button
                    onClick={() => {
                      const parts = currentPath.split('/').filter(Boolean);
                      parts.pop();
                      setCurrentPath(parts.join('/'));
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
                  >
                    <ArrowLeft size={12} /> {t('files.parent')}
                  </button>
                </div>
              )}

              {/* listing or editor */}
              {editing ? (
                <Editor
                  editing={editing}
                  canEdit={canEdit}
                  saving={writeMutation.isPending}
                  onChange={(v) => setEditing((e) => (e ? { ...e, draft: v } : e))}
                  onSave={() => writeMutation.mutate({ path: editing.path, content: editing.draft })}
                  onClose={() => setEditing(null)}
                  t={t}
                />
              ) : (
                <CardContent
                  className={cn(
                    'p-0 relative',
                    dragDepth > 0 && canEdit && 'ring-2 ring-primary ring-inset bg-primary/5',
                  )}
                  onDragEnter={(ev) => {
                    if (!canEdit) return;
                    ev.preventDefault();
                    setDragDepth((d) => d + 1);
                  }}
                  onDragLeave={(ev) => {
                    if (!canEdit) return;
                    ev.preventDefault();
                    setDragDepth((d) => Math.max(0, d - 1));
                  }}
                  onDragOver={(ev) => {
                    if (!canEdit) return;
                    ev.preventDefault();
                  }}
                  onDrop={(ev) => {
                    if (!canEdit) return;
                    ev.preventDefault();
                    setDragDepth(0);
                    if (ev.dataTransfer.files?.length) {
                      void handleUpload(ev.dataTransfer.files);
                    }
                  }}
                >
                  {dragDepth > 0 && canEdit && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                      <div className="bg-primary/90 text-primary-foreground rounded-lg px-6 py-4 shadow-lg flex items-center gap-2 font-medium">
                        <Upload size={18} /> {t('files.dropHere', { path: currentPath || 'root' })}
                      </div>
                    </div>
                  )}

                  {/* Bulk action bar — only when something is selected. */}
                  {selectedPaths.size > 0 && (
                    <div className="border-b border-border bg-primary/5 px-3 py-1.5 flex items-center gap-2 text-xs">
                      <span className="font-medium">
                        {t('files.selectedCount', { n: selectedPaths.size })}
                      </span>
                      <button
                        onClick={() => setSelectedPaths(new Set())}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        {t('files.clear')}
                      </button>
                      <div className="flex-1" />
                      {canDelete && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-xs h-7 text-destructive hover:bg-destructive/10"
                          onClick={() => {
                            const list = filteredEntries.filter((e) => selectedPaths.has(e.path));
                            if (list.length === 1) setDeleteTarget(list[0]);
                            else setBulkDeleteOpen(true);
                          }}
                        >
                          <Trash2 size={12} /> {t('files.delete')}
                        </Button>
                      )}
                    </div>
                  )}

                  {listingLoading ? (
                    <div className="p-8 flex justify-center">
                      <Loader2 size={20} className="animate-spin text-muted-foreground" />
                    </div>
                  ) : filteredEntries.length === 0 ? (
                    <div className="py-16 text-center text-muted-foreground text-sm">
                      {search ? t('files.noMatch', { q: search }) : t('files.empty')}
                      {canEdit && !search && (
                        <p className="mt-2 text-xs">{t('files.emptyHint')}</p>
                      )}
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="border-b border-border bg-muted/30 select-none">
                        <tr className="text-left text-muted-foreground">
                          <th className="w-8 px-3 py-2">
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={toggleAll}
                              className="h-3.5 w-3.5 cursor-pointer accent-primary"
                              title={allSelected ? t('files.deselectAll') : t('files.selectAll')}
                            />
                          </th>
                          <SortableTh
                            label={t('files.colName')}
                            active={sortKey === 'name'}
                            dir={sortDir}
                            onClick={() => toggleSort('name')}
                          />
                          <SortableTh
                            label={t('files.colSize')}
                            active={sortKey === 'size'}
                            dir={sortDir}
                            onClick={() => toggleSort('size')}
                            className="w-24"
                          />
                          <SortableTh
                            label={t('files.colModified')}
                            active={sortKey === 'modified'}
                            dir={sortDir}
                            onClick={() => toggleSort('modified')}
                            className="w-32"
                          />
                          <th className="px-3 py-2 font-medium w-20 font-mono text-[11px]">{t('files.colPerm')}</th>
                          <th className="px-3 py-2 font-medium w-28 text-right">{t('files.colActions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEntries.map((e) => {
                          const isDir = e.type === 'directory';
                          const isSym = e.type === 'symlink';
                          const isSelected = selectedPaths.has(e.path);
                          const { Icon, color } = isDir
                            ? { Icon: Folder, color: 'text-primary' }
                            : iconForFile(e.name);
                          return (
                            <tr
                              key={e.path}
                              className={cn(
                                'border-b last:border-0 hover:bg-accent/40 group',
                                isSelected && 'bg-primary/5',
                              )}
                            >
                              <td className="px-3 py-1.5">
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSelected(e.path)}
                                  className="h-3.5 w-3.5 cursor-pointer accent-primary"
                                  onClick={(ev) => ev.stopPropagation()}
                                />
                              </td>
                              <td className="px-3 py-1.5">
                                <button
                                  onClick={() => {
                                    if (isDir) setCurrentPath(e.path);
                                    else setReadingPath(e.path);
                                  }}
                                  className="flex items-center gap-2 text-left hover:underline w-full"
                                >
                                  <Icon size={15} className={cn(color, 'shrink-0')} />
                                  <span className={cn('truncate', e.isHidden && 'text-muted-foreground italic')}>
                                    {e.name}
                                    {isSym && <span className="text-muted-foreground ml-1">↗</span>}
                                  </span>
                                </button>
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground text-xs tabular-nums">
                                {isDir ? '—' : fmtSize(e.size)}
                              </td>
                              <td
                                className="px-3 py-1.5 text-muted-foreground text-xs"
                                title={new Date(e.modifiedAt).toLocaleString()}
                              >
                                {fmtRelativeDate(e.modifiedAt, t)}
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground font-mono text-[11px]">{e.permissions}</td>
                              <td className="px-3 py-1.5">
                                <div className="flex justify-end gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
                                  {!isDir && (
                                    <Button size="icon" variant="ghost" className="h-7 w-7" title={t('files.actionDownload')}
                                      onClick={() => handleDownload(e.path, e.name)}>
                                      <Download size={13} />
                                    </Button>
                                  )}
                                  {canEdit && (
                                    <Button size="icon" variant="ghost" className="h-7 w-7" title={t('files.actionRename')}
                                      onClick={() => { setRenameTarget(e); setRenameValue(e.name); }}>
                                      <Pencil size={13} />
                                    </Button>
                                  )}
                                  {canDelete && (
                                    <Button size="icon" variant="ghost" className="h-7 w-7 hover:text-destructive" title={t('files.actionDelete')}
                                      onClick={() => setDeleteTarget(e)}>
                                      <Trash2 size={13} />
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </CardContent>
              )}
            </>
          )}
        </Card>
      </div>

      {/* ── new folder dialog ── */}
      <Dialog open={newFolderOpen} onClose={() => setNewFolderOpen(false)}>
        <DialogHeader>
          <DialogTitle>{t('files.dlgNewFolder')}</DialogTitle>
          <DialogDescription>{t('files.dlgNewFolderIn', { path: currentPath || '/' })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>{t('files.dlgName')}</Label>
          <Input value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder={t('files.dlgFolderName')} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setNewFolderOpen(false)}>{t('common.cancel')}</Button>
          <Button
            disabled={!newFolderName.trim() || mkdirMutation.isPending}
            onClick={() => mkdirMutation.mutate(newFolderName.trim())}
          >
            {mkdirMutation.isPending ? t('files.dlgCreating') : t('files.dlgCreate')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ── rename dialog ── */}
      <Dialog open={!!renameTarget} onClose={() => setRenameTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('files.dlgRename')}</DialogTitle>
          <DialogDescription>{renameTarget?.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>{t('files.dlgRenameLabel')}</Label>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRenameTarget(null)}>{t('common.cancel')}</Button>
          <Button
            disabled={!renameValue.trim() || renameMutation.isPending}
            onClick={() => {
              if (!renameTarget) return;
              const parent = renameTarget.path.split('/').slice(0, -1).join('/');
              const to = parent ? `${parent}/${renameValue.trim()}` : renameValue.trim();
              renameMutation.mutate({ from: renameTarget.path, to });
            }}
          >
            {renameMutation.isPending ? t('files.dlgRenaming') : t('files.dlgRename')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ── delete dialog ── */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>{t('files.dlgDeleteOne', { name: deleteTarget?.name || '' })}</DialogTitle>
          <DialogDescription>
            {deleteTarget?.type === 'directory' ? t('files.dlgDeleteFolder') + ' ' : ''}
            {t('files.dlgDeleteIrr')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={removeMutation.isPending}
            onClick={() => deleteTarget && removeMutation.mutate(deleteTarget.path)}
          >
            {removeMutation.isPending ? t('files.dlgDeleting') : t('files.dlgDelete')}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ── bulk delete dialog ── */}
      <Dialog open={bulkDeleteOpen} onClose={() => setBulkDeleteOpen(false)}>
        <DialogHeader>
          <DialogTitle>{t('files.dlgBulkTitle', { n: selectedPaths.size })}</DialogTitle>
          <DialogDescription>{t('files.dlgBulkDesc')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>{t('common.cancel')}</Button>
          <Button
            variant="destructive"
            disabled={bulkDeleteMutation.isPending}
            onClick={() => bulkDeleteMutation.mutate(Array.from(selectedPaths))}
          >
            {bulkDeleteMutation.isPending
              ? t('files.dlgBulkDeleting', { n: selectedPaths.size })
              : t('files.dlgBulkConfirm', { n: selectedPaths.size })}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

function Breadcrumbs({ crumbs, onNavigate }: { crumbs: { name: string; path: string }[]; onNavigate: (path: string) => void }) {
  return (
    <div className="flex items-center gap-1 text-xs min-w-0 overflow-x-auto">
      <button onClick={() => onNavigate('')} className="text-muted-foreground hover:text-foreground">
        root
      </button>
      {crumbs.map((c) => (
        <span key={c.path} className="flex items-center gap-1 text-muted-foreground">
          <ChevronRight size={10} />
          <button onClick={() => onNavigate(c.path)} className="hover:text-foreground truncate">
            {c.name}
          </button>
        </span>
      ))}
    </div>
  );
}

function Editor({
  editing,
  canEdit,
  saving,
  onChange,
  onSave,
  onClose,
  t,
}: {
  editing: { path: string; original: string; draft: string };
  canEdit: boolean;
  saving: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onClose: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const dirty = editing.draft !== editing.original;
  return (
    <>
      <div className="flex items-center justify-between border-b border-border p-3">
        <div className="flex items-center gap-2">
          <FileIcon size={14} />
          <span className="font-mono text-xs">{editing.path}</span>
          {dirty && <Badge variant="warning" className="text-[10px]">{t('files.editorModified')}</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
              <Save size={12} /> {saving ? t('files.editorSaving') : t('files.editorSave')}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => {
            if (dirty && !confirm(t('files.editorDiscard'))) return;
            onClose();
          }}>
            <X size={12} /> {t('files.editorClose')}
          </Button>
        </div>
      </div>
      <CardContent className="p-3">
        <textarea
          value={editing.draft}
          onChange={(e) => onChange(e.target.value)}
          readOnly={!canEdit}
          spellCheck={false}
          className="w-full min-h-[60vh] rounded-md border border-border bg-zinc-950 text-green-300 font-mono text-xs p-3 outline-none focus:ring-2 focus:ring-primary leading-relaxed"
        />
      </CardContent>
    </>
  );
}

// ── Sortable table header cell ────────────────────────────────────────
// Standalone so each header arrow stays in sync with the active sort
// without prop-drilling through every td. The dim ArrowUpDown shows
// which columns ARE sortable (vs read-only ones like Perm / Actions).
function SortableTh({
  label, active, dir, onClick, className,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th
      onClick={onClick}
      className={cn(
        'px-3 py-2 font-medium cursor-pointer select-none hover:text-foreground transition-colors',
        className,
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          dir === 'asc'
            ? <ChevronUp size={12} className="text-primary" />
            : <ChevronDown size={12} className="text-primary" />
        ) : (
          <ArrowUpDown size={11} className="text-muted-foreground/40" />
        )}
      </span>
    </th>
  );
}
