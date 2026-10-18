import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedTheme } from '@foresite/ui/theme';

// next/font only works inside the Next compiler; stand in for it here.
vi.mock('next/font/google', () => ({
  IBM_Plex_Sans: () => ({ variable: 'plex-sans-var' }),
  IBM_Plex_Mono: () => ({ variable: 'plex-mono-var' }),
}));

function theme(sans: string, mono: string): ResolvedTheme {
  return { slug: 'acme', type: { sans, mono } } as unknown as ResolvedTheme;
}

async function freshFonts() {
  vi.resetModules();
  return import('./fonts');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fontClassNames', () => {
  it('returns the registered font variables and does not warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fontClassNames } = await freshFonts();
    expect(fontClassNames(theme('IBM Plex Sans', 'IBM Plex Mono'))).toBe(
      'plex-sans-var plex-mono-var',
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back for an unregistered family and warns once per family, not per render', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fontClassNames } = await freshFonts();
    for (let i = 0; i < 5; i += 1) {
      expect(fontClassNames(theme('Comic Sans', 'IBM Plex Mono'))).toBe('plex-mono-var');
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/"Comic Sans", which is not registered/);

    fontClassNames(theme('Comic Sans', 'Courier Prime'));
    fontClassNames(theme('Comic Sans', 'Courier Prime'));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]?.[0]).toMatch(/"Courier Prime"/);
  });
});
