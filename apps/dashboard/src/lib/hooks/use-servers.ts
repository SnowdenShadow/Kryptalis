'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';

export function useServers() {
  return useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<{ data: unknown[] }>('/servers').then((r) => r.data),
  });
}

export function useServer(id: string) {
  return useQuery({
    queryKey: ['servers', id],
    queryFn: () => api.get<{ data: unknown }>(`/servers/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; host: string; port: number; username: string }) =>
      api.post('/servers', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast.success('Server added');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeleteServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/servers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['servers'] });
      toast.success('Server removed');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
