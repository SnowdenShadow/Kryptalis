import { toast } from 'sonner';
import { ApiError } from './api';

/**
 * Toast helper that knows about ApiError. Produces consistent messages:
 *
 *   - 4xx with a string message → show it verbatim (user-actionable)
 *   - 4xx with field array       → join with ' • ' for legibility
 *   - 401                        → "Session expired" + (api.ts already
 *                                   triggers the /login redirect)
 *   - 5xx                        → generic 'Server error — try again'
 *                                   (the user can't fix it; no point
 *                                   leaking the backend's raw 500 body)
 *   - Anything else / network    → fall back to err.message
 *
 * The optional `prefix` lets callers add a contextual label that survives
 * the message rewriting, e.g. `toastError(err, 'Domain create')`.
 */
export function toastError(err: unknown, prefix?: string): void {
  const tag = prefix ? `${prefix}: ` : '';

  if (err instanceof ApiError) {
    if (err.fields.length) {
      toast.error(tag + err.fields.join(' • '));
      return;
    }
    if (err.status === 401) {
      toast.error(tag + (err.message || 'Session expired'));
      return;
    }
    if (err.status >= 500) {
      toast.error(tag + 'Server error — please try again in a moment.');
      return;
    }
    toast.error(tag + err.message);
    return;
  }

  if (err instanceof Error) {
    toast.error(tag + err.message);
    return;
  }

  toast.error(tag + 'Something went wrong.');
}
