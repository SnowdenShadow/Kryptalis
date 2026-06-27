import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException, HttpStatus, BadRequestException } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';

/**
 * The filter must (a) preserve the client contract for 4xx — pass the framework
 * body through verbatim so ValidationPipe's message[] and custom fields like
 * `code: 'TOTP_REQUIRED'` survive — and (b) for 5xx / unhandled errors, return
 * a generic body with a correlation id and never leak the raw error/stack.
 */
function makeHost(method = 'GET', url = '/api/x', user?: any) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const response = { status, json };
  const request = { method, originalUrl: url, url, user };
  const host: any = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  };
  return { host, status, json };
}

beforeEach(() => vi.clearAllMocks());

describe('GlobalExceptionFilter', () => {
  it('passes a 4xx HttpException body through VERBATIM (preserves message[] + code)', () => {
    const { host, status, json } = makeHost();
    const exc = new HttpException(
      { message: ['email must be an email', 'password too short'], code: 'TOTP_REQUIRED' },
      HttpStatus.BAD_REQUEST,
    );
    new GlobalExceptionFilter().catch(exc, host);
    expect(status).toHaveBeenCalledWith(400);
    // Exact body — no re-flattening, no added fields for 4xx.
    expect(json).toHaveBeenCalledWith({
      message: ['email must be an email', 'password too short'],
      code: 'TOTP_REQUIRED',
    });
  });

  it('BadRequestException (string message) passes through as the framework shaped it', () => {
    const { host, status, json } = makeHost();
    new GlobalExceptionFilter().catch(new BadRequestException('Name required'), host);
    expect(status).toHaveBeenCalledWith(400);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe('Name required');
    expect(body.statusCode).toBe(400);
  });

  it('a NON-HttpException becomes a generic 500 with an errorId and NO stack leak', () => {
    const { host, status, json } = makeHost('POST', '/api/applications');
    new GlobalExceptionFilter().catch(new Error('ECONNREFUSED secret-internal-host:5432'), host);
    expect(status).toHaveBeenCalledWith(500);
    const body = json.mock.calls[0][0];
    expect(body.statusCode).toBe(500);
    expect(body.errorId).toMatch(/^[0-9a-f-]{36}$/);
    // The raw internal error text must NOT reach the client.
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(body)).not.toContain('secret-internal-host');
  });

  it('a 5xx HttpException is logged and stamped with errorId but keeps its body', () => {
    const { host, status, json } = makeHost();
    const exc = new HttpException({ message: 'upstream down', detail: 'x' }, HttpStatus.BAD_GATEWAY);
    new GlobalExceptionFilter().catch(exc, host);
    expect(status).toHaveBeenCalledWith(502);
    const body = json.mock.calls[0][0];
    expect(body.message).toBe('upstream down');
    expect(body.detail).toBe('x');
    expect(body.errorId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
