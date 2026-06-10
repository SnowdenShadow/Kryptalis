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
  size = 'sm',
  className,
}: {
  status: string;
  size?: 'sm' | 'lg';
  className?: string;
}) {
  // API statuses are UPPERCASE (RUNNING, ERROR, …) — normalize so both
  // casings resolve to the same color.
  const key = status.toLowerCase() as StatusType;
  const color = statusColors[key] || 'bg-muted-foreground';
  const dim = size === 'lg' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';
  const ping = ['online', 'running', 'active', 'building', 'deploying', 'pending'].includes(key);

  return (
    <span className={cn('relative flex', dim, className)}>
      {ping && (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
            color,
          )}
        />
      )}
      <span className={cn('relative inline-flex rounded-full', dim, color)} />
    </span>
  );
}
