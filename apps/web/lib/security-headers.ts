/**
 * Security headers for every response.
 *
 * The Content-Security-Policy is built per request in `middleware.ts` because
 * it carries a nonce; the rest are static and set from `next.config.ts`.
 * No third-party origins are allowed: fonts are self-hosted by next/font and
 * data comes from this app's own API routes.
 */

export interface CspOptions {
  /** Base64 nonce for this response's inline scripts and styles. */
  nonce: string;
  /** Development needs eval for React Fast Refresh. Never true in production. */
  dev?: boolean;
}

export function buildContentSecurityPolicy({ nonce, dev = false }: CspOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(dev ? ["'unsafe-eval'"] : []),
    ],
    'style-src': ["'self'", `'nonce-${nonce}'`, ...(dev ? ["'unsafe-inline'"] : [])],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'"],
    'manifest-src': ["'self'"],
    'worker-src': ["'self'"],
    'media-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
    ...(dev ? {} : { 'upgrade-insecure-requests': [] }),
  };

  return Object.entries(directives)
    .map(([name, values]) => (values.length > 0 ? `${name} ${values.join(' ')}` : name))
    .join('; ');
}

export interface Header {
  key: string;
  value: string;
}

/** Headers that do not change per request. */
export const staticSecurityHeaders: Header[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Belt and braces alongside CSP frame-ancestors for older browsers.
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value:
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), ' +
      'magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  // Two years, as recommended for preload lists. Vercel also sets HSTS; identical values are harmless.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

/** The service worker must not be cached for long or updates take a day to arrive. */
export const serviceWorkerHeaders: Header[] = [
  { key: 'Cache-Control', value: 'no-cache, max-age=0, must-revalidate' },
  { key: 'Service-Worker-Allowed', value: '/' },
];
