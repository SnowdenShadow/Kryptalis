'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';

export function useApplications() {
  return useQuery({
    queryKey: ['applications'],
    queryFn: () => api.get<{ data: unknown[] }>('/applications').then((r) => r.data),
  });
}

export function useApplication(id: string) {
  return useQuery({
    queryKey: ['applications', id],
    queryFn: () => api.get<{ data: unknown }>(`/applications/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useDeployApplication() {
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

export function useApplicationAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
      api.post(`/applications/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['applications'] });
      toast.success('Action completed');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
