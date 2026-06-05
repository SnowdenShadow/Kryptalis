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
  ChevronRight,
  ChevronDown,
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
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { api } from '@/lib/api';
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

export default function FilesPage() {
  const [selected, setSelected] = useState<{ scope: 'app' | 'db'; id: string; role: Role; name: string } | null>(null);
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

  const filteredEntries = (listing?.entries || []).filter(e =>
    !search.trim() || e.name.toLowerCase().includes(search.toLowerCase())
  );

  // ── mutations ──────────────────────────────────────────────────────
  const mkdirMutation = useMutation({
    mutationFn: (name: string) => api.post(`/files/${selected!.scope}/${selected!.id}/mkdir`, {
      path: currentPath ? `${currentPath}/${name}` : name,
    }),
    onSuccess: () => {
      toast.success('Folder created');
      setNewFolderOpen(false);
      setNewFolderName('');
      refetchListing();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const renameMutation = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      api.patch(`/files/${selected!.scope}/${selected!.id}/rename`, { from, to }),
    onSuccess: () => {
      toast.success('Renamed');
      setRenameTarget(null);
      setRenameValue('');
      refetchListing();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const removeMutation = useMutation({
    mutationFn: (p: string) =>
      api.delete(`/files/${selected!.scope}/${selected!.id}/entry?path=${encodeURIComponent(p)}`),
    onSuccess: () => {
      toast.success('Deleted');
      setDeleteTarget(null);
      refetchListing();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const writeMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.patch(`/files/${selected!.scope}/${selected!.id}/file`, { path, content }),
    onSuccess: (_, vars) => {
      toast.success('Saved');
      setEditing((e) => (e ? { ...e, original: vars.content } : e));
      refetchListing();
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
        toast.message(readData.message || 'Binary file', { description: `${fmtSize(readData.size)} — use download.` });
        setReadingPath(null);
        return;
      }
      setEditing({ path: readData.path, original: readData.content || '', draft: readData.content || '' });
      setReadingPath(null);
    }
  }, [readData, readingPath]);

  // ── upload ─────────────────────────────────────────────────────────
  async function handleUpload(files: FileList | null) {
    if (!files || files.length === 0 || !selected) return;
    for (const f of Array.from(files)) {
      try {
        const token = localStorage.getItem('accessToken');
        const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
        const url = `${baseUrl}/api/files/${selected.scope}/${selected.id}/upload?path=${encodeURIComponent(currentPath)}&name=${encodeURIComponent(f.name)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: f,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ message: 'Upload failed' }));
          throw new Error(err.message || 'Upload failed');
        }
        toast.success(`Uploaded ${f.name}`);
      } catch (e: any) {
        toast.error(e.message || `Failed to upload ${f.name}`);
      }
    }
    if (uploadInputRef.current) uploadInputRef.current.value = '';
    refetchListing();
  }

  function handleDownload(p: string, name: string) {
    if (!selected) return;
    const token = localStorage.getItem('accessToken');
    const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
    fetch(`${baseUrl}/api/files/${selected.scope}/${selected.id}/download?path=${encodeURIComponent(p)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
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

  function selectScope(scope: 'app' | 'db', id: string, role: Role, name: string) {
    setSelected({ scope, id, role, name });
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
        <h1 className="text-3xl font-bold">File Manager</h1>
        <p className="text-muted-foreground">
          Browse and edit files of your applications and databases. Permissions cascade from project roles.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
        {/* ── Left panel: scopes ───────────────────────────────────── */}
        <Card>
          <CardContent className="p-2 space-y-1 max-h-[calc(100vh-220px)] overflow-y-auto">
            {scopesLoading ? (
              <div className="p-4"><Loader2 className="animate-spin" size={16} /></div>
            ) : scopes.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                <p>No projects accessible.</p>
                <Link href="/dashboard/projects" className="text-primary hover:underline text-xs">Create one</Link>
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
                          <p className="text-xs text-muted-foreground py-1.5">empty</p>
                        )}
                        {p.applications.map(a => (
                          <button
                            key={a.id}
                            onClick={() => selectScope('app', a.id, p.role, a.name)}
                            className={cn(
                              'w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent text-left',
                              selected?.scope === 'app' && selected.id === a.id && 'bg-primary/10 text-primary',
                            )}
                          >
                            <Rocket size={12} />
                            <span className="flex-1 truncate">{a.name}</span>
                            {!a.hasFiles && (
                              <span className="text-[9px] text-muted-foreground italic">empty</span>
                            )}
                          </button>
                        ))}
                        {p.databases.map(d => (
                          <button
                            key={d.id}
                            onClick={() => selectScope('db', d.id, p.role, d.name)}
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
              <p className="text-lg font-medium">Select an application or database</p>
              <p className="text-sm text-muted-foreground mt-1">
                Choose a scope from the left panel to browse its files.
              </p>
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
                    <Input className="pl-7 h-8 text-xs" placeholder="Filter..." value={search}
                      onChange={(e) => setSearch(e.target.value)} />
                  </div>
                  <Button size="sm" variant="outline" onClick={() => refetchListing()}>
                    <RefreshCw size={12} />
                  </Button>
                  {canEdit && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setNewFolderOpen(true)}>
                        <FolderPlus size={12} /> Folder
                      </Button>
                      <Button size="sm" onClick={() => uploadInputRef.current?.click()}>
                        <Upload size={12} /> Upload
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
                  Read-only — your role ({selected.role}) does not allow modifications.
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
                    <ArrowLeft size={12} /> parent directory
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
                />
              ) : (
                <CardContent className="p-0">
                  {listingLoading ? (
                    <div className="p-8 flex justify-center">
                      <Loader2 size={20} className="animate-spin text-muted-foreground" />
                    </div>
                  ) : filteredEntries.length === 0 ? (
                    <div className="py-16 text-center text-muted-foreground text-sm">
                      {search ? `No file matches "${search}"` : 'Empty directory'}
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="border-b border-border bg-muted/30">
                        <tr className="text-left text-muted-foreground">
                          <th className="px-4 py-2 font-medium">Name</th>
                          <th className="px-4 py-2 font-medium w-24">Size</th>
                          <th className="px-4 py-2 font-medium w-44">Modified</th>
                          <th className="px-4 py-2 font-medium w-20 font-mono text-xs">Perm</th>
                          <th className="px-4 py-2 font-medium w-32 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEntries.map((e) => {
                          const isDir = e.type === 'directory';
                          return (
                            <tr key={e.path} className="border-b last:border-0 hover:bg-accent/40">
                              <td className="px-4 py-2">
                                <button
                                  onClick={() => {
                                    if (isDir) setCurrentPath(e.path);
                                    else setReadingPath(e.path);
                                  }}
                                  className="flex items-center gap-2 text-left hover:underline"
                                >
                                  {isDir ? (
                                    <Folder size={14} className="text-primary shrink-0" />
                                  ) : (
                                    <FileIcon size={14} className="text-muted-foreground shrink-0" />
                                  )}
                                  <span className={cn('truncate', e.isHidden && 'text-muted-foreground')}>
                                    {e.name}
                                  </span>
                                </button>
                              </td>
                              <td className="px-4 py-2 text-muted-foreground text-xs">
                                {isDir ? '—' : fmtSize(e.size)}
                              </td>
                              <td className="px-4 py-2 text-muted-foreground text-xs">{fmtDate(e.modifiedAt)}</td>
                              <td className="px-4 py-2 text-muted-foreground font-mono text-xs">{e.permissions}</td>
                              <td className="px-4 py-2">
                                <div className="flex justify-end gap-1">
                                  {!isDir && (
                                    <Button size="icon" variant="ghost" title="Download"
                                      onClick={() => handleDownload(e.path, e.name)}>
                                      <Download size={13} />
                                    </Button>
                                  )}
                                  {canEdit && (
                                    <Button size="icon" variant="ghost" title="Rename"
                                      onClick={() => { setRenameTarget(e); setRenameValue(e.name); }}>
                                      <FolderPlus size={13} />
                                    </Button>
                                  )}
                                  {canDelete && (
                                    <Button size="icon" variant="ghost" title="Delete"
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
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription>In {currentPath || '/'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Name</Label>
          <Input value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="folder-name" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setNewFolderOpen(false)}>Cancel</Button>
          <Button
            disabled={!newFolderName.trim() || mkdirMutation.isPending}
            onClick={() => mkdirMutation.mutate(newFolderName.trim())}
          >
            {mkdirMutation.isPending ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ── rename dialog ── */}
      <Dialog open={!!renameTarget} onClose={() => setRenameTarget(null)}>
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription>{renameTarget?.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>New name</Label>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
          <Button
            disabled={!renameValue.trim() || renameMutation.isPending}
            onClick={() => {
              if (!renameTarget) return;
              const parent = renameTarget.path.split('/').slice(0, -1).join('/');
              const to = parent ? `${parent}/${renameValue.trim()}` : renameValue.trim();
              renameMutation.mutate({ from: renameTarget.path, to });
            }}
          >
            {renameMutation.isPending ? 'Renaming...' : 'Rename'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ── delete dialog ── */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)}>
        <DialogHeader>
          <DialogTitle>Delete</DialogTitle>
          <DialogDescription>
            Delete <strong>{deleteTarget?.name}</strong>?
            {deleteTarget?.type === 'directory' && ' This will remove all contents recursively.'} This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={removeMutation.isPending}
            onClick={() => deleteTarget && removeMutation.mutate(deleteTarget.path)}
          >
            {removeMutation.isPending ? 'Deleting...' : 'Delete'}
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
}: {
  editing: { path: string; original: string; draft: string };
  canEdit: boolean;
  saving: boolean;
  onChange: (v: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const dirty = editing.draft !== editing.original;
  return (
    <>
      <div className="flex items-center justify-between border-b border-border p-3">
        <div className="flex items-center gap-2">
          <FileIcon size={14} />
          <span className="font-mono text-xs">{editing.path}</span>
          {dirty && <Badge variant="warning" className="text-[10px]">modified</Badge>}
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <Button size="sm" disabled={!dirty || saving} onClick={onSave}>
              <Save size={12} /> {saving ? 'Saving...' : 'Save'}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => {
            if (dirty && !confirm('Discard unsaved changes?')) return;
            onClose();
          }}>
            <X size={12} /> Close
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
