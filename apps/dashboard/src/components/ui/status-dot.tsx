import { cn } from '@/lib/utils';

const statusColors = {
  online: 'bg-success',
  running: 'bg-success',
  active: 'bg-success',
  completed: 'bg-success',
  offline: 'bg-muted-foreground',
  stopped: 'bg-muted-foreground',
  pending: 'bg-warning',
  building: 'bg-warning',
  deploying: 'bg-warning',
  provisioning: 'bg-warning',
  error: 'bg-destructive',
  failed: 'bg-destructive',
  maintenance: 'bg-warning',
} as const;

type StatusType = keyof typeof statusColors;

export function StatusDot({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const color = statusColors[status as StatusType] || 'bg-muted-foreground';

  return (
    <span className={cn('relative flex h-2.5 w-2.5', className)}>
      {(status === 'online' || status === 'running' || status === 'active') && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
            color,
          )}
        />
      )}
      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', color)} />
    </span>
  );
}
