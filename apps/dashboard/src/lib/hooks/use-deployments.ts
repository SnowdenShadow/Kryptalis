'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';

export function useDeployments(applicationId?: string) {
  return useQuery({
    queryKey: ['deployments', applicationId],
    queryFn: () => {
      const params = applicationId ? `?applicationId=${applicationId}` : '';
      return api.get<{ data: unknown[] }>(`/deployments${params}`).then((r) => r.data);
    },
  });
}

export function useDeployment(id: string) {
  return useQuery({
    queryKey: ['deployments', 'detail', id],
    queryFn: () => api.get<{ data: unknown }>(`/deployments/${id}`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: 5000,
  });
}

export function useTriggerDeployment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { applicationId: string; commitSha?: string; force?: boolean }) =>
      api.post('/deployments', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deployments'] });
      toast.success('Deployment triggered');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
