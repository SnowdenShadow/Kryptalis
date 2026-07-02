// Shared data-fetching hooks for the dashboard's reference data.
//
// Several resources (the project list, the application list, the server list,
// and the public settings blob) were fetched with an identical
// `useQuery({ queryKey: [...], queryFn: () => api.get(...) })` block copied
// across ~8-10 page components each. That duplication meant every page
// re-declared the same query key and endpoint, and any change (e.g. adding a
// staleTime) had to be made in every copy.
//
// These hooks centralize the (queryKey, queryFn) pair. The query keys are kept
// EXACTLY as the pages used them (['projects'], ['applications'], ['servers'],
// ['public-settings']) so existing `queryClient.invalidateQueries({ queryKey:
// [...] })` calls scattered across the app keep matching — this is a pure
// de-duplication, not a cache-key change.
//
// Each hook is generic with a permissive default, so a caller that has a
// narrower local row type can still pass it: `useProjects<ProjectOpt[]>()`.
// Per-call options (enabled, staleTime, …) can be forwarded; queryKey/queryFn
// are owned by the hook and cannot be overridden.
import { useQuery, type UseQueryResult, type UseQueryOptions } from '@tanstack/react-query';
import { api } from './api';

type RefQueryOptions<T> = Omit<UseQueryOptions<T, Error, T>, 'queryKey' | 'queryFn'>;

/** Project list — GET /projects. Cache key: ['projects']. */
export function useProjects<T = Array<{ id: string; name: string }>>(
  options?: RefQueryOptions<T>,
): UseQueryResult<T> {
  return useQuery<T, Error, T>({
    queryKey: ['projects'],
    queryFn: () => api.get<T>('/projects'),
    ...options,
  });
}

/** Application list — GET /applications. Cache key: ['applications']. */
export function useApplications<T = Array<{ id: string; name: string; projectId: string }>>(
  options?: RefQueryOptions<T>,
): UseQueryResult<T> {
  return useQuery<T, Error, T>({
    queryKey: ['applications'],
    queryFn: () => api.get<T>('/applications'),
    ...options,
  });
}

/**
 * FULL server list — GET /servers (ADMIN only). Cache key: ['servers'].
 * Use for admin/infrastructure views. For DEPLOY-target pickers (where a
 * non-admin DEVELOPER must also choose a server), use useDeployTargets instead.
 */
export function useServers<T = Array<{ id: string; name: string; host: string; status: string }>>(
  options?: RefQueryOptions<T>,
): UseQueryResult<T> {
  return useQuery<T, Error, T>({
    queryKey: ['servers'],
    queryFn: () => api.get<T>('/servers'),
    ...options,
  });
}

/**
 * Deploy-target server list — GET /servers/mine. Sanitized (no tokens/secrets)
 * and accessible to NON-admins: returns the servers reachable through the
 * caller's project memberships. This is what every deploy-time server picker
 * (apps, databases, mail) should use, so a DEVELOPER can pick a server too.
 * Cache key: ['deploy-targets'].
 */
export function useDeployTargets<T = Array<{ id: string; name: string; host: string; status: string }>>(
  options?: RefQueryOptions<T>,
): UseQueryResult<T> {
  return useQuery<T, Error, T>({
    queryKey: ['deploy-targets'],
    queryFn: () => api.get<T>('/servers/mine'),
    ...options,
  });
}

/** Public (unauthenticated) settings blob — GET /settings/public. Cache key: ['public-settings']. */
export function usePublicSettings<T = { deployment_mode?: string; public_ip?: string }>(
  options?: RefQueryOptions<T>,
): UseQueryResult<T> {
  return useQuery<T, Error, T>({
    queryKey: ['public-settings'],
    queryFn: () => api.get<T>('/settings/public'),
    ...options,
  });
}

/** Caller's effective fine-grained permissions on ONE project. */
export interface ProjectPermissions {
  role: 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'VIEWER';
  isAdmin: boolean;
  permissions: string[];
}

/**
 * The caller's effective permission set on a project — GET
 * /projects/:id/my-permissions. Returns a `can(permission)` helper so pages can
 * hide actions the backend would reject. Admins/owners (`isAdmin`) can do
 * everything, so `can()` short-circuits true for them.
 *
 * Cache key: ['project-my-permissions', projectId] — invalidate this when a
 * member's role/custom-role changes.
 */
export function useProjectPermissions(
  projectId: string | undefined,
  options?: RefQueryOptions<ProjectPermissions>,
): UseQueryResult<ProjectPermissions> & { can: (permission: string) => boolean } {
  const q = useQuery<ProjectPermissions, Error, ProjectPermissions>({
    queryKey: ['project-my-permissions', projectId],
    queryFn: () => api.get<ProjectPermissions>(`/projects/${projectId}/my-permissions`),
    enabled: !!projectId,
    staleTime: 30_000,
    ...options,
  });
  const can = (permission: string): boolean => {
    const data = q.data;
    // While loading (or on error), don't hard-block the UI — the API is the
    // real gate. Optimistically allow so buttons don't flicker/hide on every
    // navigation; a truly unauthorized action still gets a 403 toast.
    if (!data) return true;
    return data.isAdmin || data.permissions.includes(permission);
  };
  return { ...q, can };
}
