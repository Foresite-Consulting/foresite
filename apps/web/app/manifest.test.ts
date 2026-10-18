import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedTheme } from '@foresite/ui/theme';

const state: { theme: ResolvedTheme | undefined } = { theme: undefined };

vi.mock('@/lib/theme', () => ({
  getTheme: () => {
    if (state.theme === undefined) throw new Error('theme not set');
    return state.theme;
  },
}));

const { default: manifest } = await import('./manifest');

beforeEach(() => {
  state.theme = {
    appName: 'Acme Live',
    appShortName: 'Acme',
    colours: { light: { bg: '#F4F7F6' }, dark: { bg: '#04282C' } },
    assets: {
      icons: [
        // File names deliberately disagree with the sizes: the manifest must
        // use what the theme declares, not guess from the name.
        { src: 'icon-512.png', sizes: '192x192', purpose: 'any' },
        { src: 'logo.svg', sizes: 'any' },
        { src: 'square.webp', sizes: '512x512', purpose: 'maskable' },
      ],
    },
  } as unknown as ResolvedTheme;
});

describe('manifest', () => {
  it('uses the declared sizes and purpose, and the type from the extension', () => {
    expect(manifest().icons).toEqual([
      { src: '/theme-assets/icon-512.png', sizes: '192x192', purpose: 'any', type: 'image/png' },
      { src: '/theme-assets/logo.svg', sizes: 'any', purpose: 'any', type: 'image/svg+xml' },
      {
        src: '/theme-assets/square.webp',
        sizes: '512x512',
        purpose: 'maskable',
        type: 'image/webp',
      },
    ]);
  });

  it('carries the theme name and colours', () => {
    const m = manifest();
    expect(m.name).toBe('Acme Live');
    expect(m.short_name).toBe('Acme');
    expect(m.theme_color).toBe('#F4F7F6');
  });
});
