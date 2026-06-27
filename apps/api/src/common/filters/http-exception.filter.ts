import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'crypto';

/**
 * Global exception filter — the single 5xx capture point and the boundary that
 * keeps error RESPONSES stable while adding server-side OBSERVABILITY.
 *
 * Two jobs:
 *
 *  1. Preserve the existing client contract. For an HttpException we pass the
 *     framework's own response body through UNCHANGED (status + body). That
 *     matters because the dashboard depends on it: ValidationPipe emits
 *     `message` as a string[] of field errors, and auth flows attach extra
 *     fields like `{ code: 'TOTP_REQUIRED' }`. Re-flattening to a single
 *     `message` string (as the old filter did) would have broken both — so we
 *     don't. We only ADD a non-conflicting `errorId` for correlation.
 *
 *  2. Add observability. Every 5xx (and any non-HttpException) is logged ONCE
 *     here with a correlation id, the route/method, the authenticated user (if
 *     any) and the stack — so an operator can tie a user-reported "Server
 *     error (500) [errorId]" back to the exact failing request and the docker/
 *     agent call underneath it. The client only ever sees a generic message +
 *     the errorId for a 5xx (never the raw error/stack — no internal leakage).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // 4xx are expected client errors — don't log them as server faults.
      // 5xx HttpExceptions are real server faults: log with context.
      if (status >= 500) {
        const errorId = randomUUID();
        this.logError(errorId, status, request, exception);
        // Pass the framework body through, but stamp the correlation id so the
        // operator-facing log and the client response share an id.
        const augmented =
          typeof body === 'string'
            ? { statusCode: status, message: body, errorId }
            : { ...(body as Record<string, unknown>), errorId };
        response.status(status).json(augmented);
        return;
      }
      // 4xx: pass through verbatim (preserves message[] and fields like `code`).
      response.status(status).json(body);
      return;
    }

    // Non-HttpException → an unhandled 500. Log everything; tell the client
    // nothing beyond a generic message + the correlation id.
    const status = HttpStatus.INTERNAL_SERVER_ERROR;
    const errorId = randomUUID();
    this.logError(errorId, status, request, exception);
    response.status(status).json({
      statusCode: status,
      message: `Internal server error (${errorId})`,
      errorId,
      timestamp: new Date().toISOString(),
    });
  }

  private logError(errorId: string, status: number, request: Request, exception: unknown) {
    const method = request?.method ?? '?';
    const url = (request as any)?.originalUrl ?? request?.url ?? '?';
    const userId = (request as any)?.user?.id ?? 'anon';
    const err = exception as { message?: string; stack?: string };
    this.logger.error(
      `[${errorId}] ${status} ${method} ${url} (user=${userId}): ${err?.message ?? exception}`,
      err?.stack,
    );
  }
}
