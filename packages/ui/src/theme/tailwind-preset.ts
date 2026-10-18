import type { Config } from 'tailwindcss';
import { SEMANTIC_KEYS } from './schema';

const MAX_SERIES = 8;

function colourVar(key: string): string {
  return `rgb(var(--color-${key}) / <alpha-value>)`;
}

const semanticColours = Object.fromEntries(SEMANTIC_KEYS.map((key) => [key, colourVar(key)]));

const seriesColours = Object.fromEntries(
  Array.from({ length: MAX_SERIES }, (_, index) => [
    String(index + 1),
    colourVar(`series-${index + 1}`),
  ]),
);

/**
 * Tailwind preset for Foresite apps. Every utility that carries colour or type
 * reads a CSS variable set by `themeToCss`, so the same class names render the
 * client's brand. The default Tailwind palette is deliberately absent: a
 * component cannot say `bg-red-500`, only `bg-negative`.
 */
export const foresitePreset: Config = {
  content: [],
  darkMode: [
    'variant',
    [
      '@media (prefers-color-scheme: dark) { &:not(:root[data-theme="light"] *) }',
      ':root[data-theme="dark"] &',
    ],
  ],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',
      ...semanticColours,
      series: seriesColours,
    },
    fontFamily: {
      sans: ['var(--font-sans)'],
      mono: ['var(--font-mono)'],
    },
    extend: {
      fontSize: {
        display: ['var(--text-display)', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        heading: ['var(--text-heading)', { lineHeight: '1.1', letterSpacing: '-0.015em' }],
        subheading: ['var(--text-subheading)', { lineHeight: '1.2' }],
        body: ['var(--text-body)', { lineHeight: '1.5' }],
        label: ['var(--text-label)', { lineHeight: '1.35', letterSpacing: '0.0625em' }],
      },
      minHeight: { tap: '44px' },
      minWidth: { tap: '44px' },
      borderRadius: { tile: '0.75rem' },
      ringColor: { DEFAULT: colourVar('action') },
      ringOffsetColor: { DEFAULT: colourVar('bg') },
    },
  },
};

export default foresitePreset;
