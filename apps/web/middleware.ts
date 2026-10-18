import { NextResponse, type NextRequest } from 'next/server';
import { buildContentSecurityPolicy } from './lib/security-headers';

/**
 * Sets a per-request Content-Security-Policy with a nonce. Next.js reads the
 * nonce from the request's CSP header and applies it to its own inline
 * scripts; our root layout reads `x-nonce` for the inline theme stylesheet.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildContentSecurityPolicy({
    nonce,
    dev: process.env.NODE_ENV === 'development',
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only. Static assets, the service worker, the manifest and
      // theme assets are not HTML and need no nonce. Device ingest
      // (`/api/ingest/`) is machine-to-machine JSON: it skips the middleware
      // entirely and sets its own no-store headers.
      source:
        '/((?!_next/static|_next/image|sw\\.js|manifest\\.webmanifest|theme-assets/|api/ingest/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
