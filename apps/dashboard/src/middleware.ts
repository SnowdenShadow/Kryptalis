import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Edge middleware — currently a deliberate pass-through.
 *
 * Auth tokens live in localStorage (not cookies), so the edge runtime has
 * no way to verify a session here: route protection is enforced
 * client-side by (dashboard)/layout.tsx + the API's own JWT guards on
 * every endpoint. The earlier version of this file LOOKED like it
 * protected routes (publicPaths allowlist) while actually allowing
 * everything — that false sense of security is worse than an honest
 * pass-through.
 *
 * If/when the refresh token moves to an httpOnly cookie, implement the
 * real check here:
 *   const session = request.cookies.get('kryptalis_session');
 *   if (!session && !isPublicPath) return NextResponse.redirect('/login');
 */
export function middleware(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
