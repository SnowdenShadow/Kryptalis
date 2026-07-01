'use client';

import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /**
   * Classes for the wrapper <div> — use this for SIZING (width) so the chevron,
   * which is absolutely-positioned inside the wrapper, stays glued to the
   * select's right edge. Passing a `w-*` on `className` (the inner select)
   * instead detaches the chevron: the select shrinks but the wrapper stays
   * `w-full`, leaving the chevron floating at the far right. Defaults to
   * `w-full`.
   */
  wrapperClassName?: string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, wrapperClassName, children, ...props }, ref) => (
    <div className={cn('relative', wrapperClassName ?? 'w-full')}>
      <select
        ref={ref}
        className={cn(
          'flex h-10 w-full appearance-none rounded-lg border bg-zinc-950/40 pl-3 pr-9 py-2 text-sm text-foreground',
          'border-zinc-700/70 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.03)]',
          'hover:border-zinc-600 transition-colors duration-150',
          'focus-visible:outline-none focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:bg-zinc-950/60',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted/30',
          // safari fix
          '[&>option]:bg-zinc-900 [&>option]:text-foreground',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/70"
      />
    </div>
  ),
);
Select.displayName = 'Select';

export { Select };
