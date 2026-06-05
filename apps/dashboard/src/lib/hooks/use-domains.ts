'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';

export function useDomains() {
  return useQuery({
    queryKey: ['domains'],
    queryFn: () => api.get<{ data: unknown[] }>('/domains').then((r) => r.data),
  });
}

export function useCreateDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { domain: string; applicationId?: string; autoSsl?: boolean }) =>
      api.post('/domains', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Domain added');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeleteDomain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/domains/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['domains'] });
      toast.success('Domain removed');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
