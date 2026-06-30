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
