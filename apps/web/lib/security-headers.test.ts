import { describe, expect, it } from 'vitest';
import {
  buildContentSecurityPolicy,
  serviceWorkerHeaders,
  staticSecurityHeaders,
} from './security-headers';

describe('buildContentSecurityPolicy', () => {
  const csp = buildContentSecurityPolicy({ nonce: 'abc123' });
  const directive = (name: string) =>
    csp
      .split('; ')
      .find((part) => part.startsWith(`${name} `) || part === name)
      ?.slice(name.length)
      .trim();

  it('locks the page down to its own origin', () => {
    expect(directive('default-src')).toBe("'self'");
    expect(directive('connect-src')).toBe("'self'");
    expect(directive('font-src')).toBe("'self'");
    expect(directive('object-src')).toBe("'none'");
    expect(directive('base-uri')).toBe("'self'");
    expect(directive('form-action')).toBe("'self'");
  });

  it('forbids framing', () => {
    expect(directive('frame-ancestors')).toBe("'none'");
  });

  it('allows scripts and styles only by nonce in production', () => {
    expect(directive('script-src')).toBe("'self' 'nonce-abc123' 'strict-dynamic'");
    expect(directive('style-src')).toBe("'self' 'nonce-abc123'");
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain('upgrade-insecure-requests');
  });

  it('relaxes only what Fast Refresh needs in development', () => {
    const dev = buildContentSecurityPolicy({ nonce: 'n', dev: true });
    expect(dev).toContain("script-src 'self' 'nonce-n' 'strict-dynamic' 'unsafe-eval'");
    expect(dev).toContain("style-src 'self' 'nonce-n' 'unsafe-inline'");
    expect(dev).not.toContain('upgrade-insecure-requests');
  });
});

describe('static headers', () => {
  const get = (key: string) => staticSecurityHeaders.find((h) => h.key === key)?.value;

  it('sets the standard hardening headers', () => {
    expect(get('X-Content-Type-Options')).toBe('nosniff');
    expect(get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(get('X-Frame-Options')).toBe('DENY');
    expect(get('Permissions-Policy')).toContain('camera=()');
    expect(get('Permissions-Policy')).toContain('geolocation=()');
    expect(get('Strict-Transport-Security')).toMatch(/max-age=\d+/);
  });

  it('keeps the service worker fresh', () => {
    expect(serviceWorkerHeaders.find((h) => h.key === 'Cache-Control')?.value).toContain(
      'no-cache',
    );
  });
});
