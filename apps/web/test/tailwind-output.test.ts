import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import config from '../tailwind.config';

/**
 * Builds globals.css with the real Tailwind config, the same way `next build`
 * does, and checks the focus styles and the base ring variables are valid CSS
 * that read the theme (finding #1 of the scaffold review).
 */
const webDir = fileURLToPath(new URL('..', import.meta.url));

async function buildCss(): Promise<string> {
  const source = readFileSync(`${webDir}app/globals.css`, 'utf8');
  const result = await postcss([
    tailwindcss({
      ...config,
      content: [
        `${webDir}app/**/*.{ts,tsx}`,
        `${webDir}components/**/*.{ts,tsx}`,
        `${webDir}../../packages/ui/src/**/*.{ts,tsx}`,
      ],
    }),
  ]).process(source, { from: `${webDir}app/globals.css` });
  return result.css;
}

describe('built Tailwind CSS', () => {
  it('has no unresolved <alpha-value> and no Tailwind default blue', async () => {
    const css = await buildCss();
    expect(css).not.toContain('<alpha-value>');
    expect(css).not.toContain('147 197 253');
    expect(css).toMatch(/--tw-ring-color:\s*rgb\(var\(--color-link\)\s*\/\s*1\)/);
    expect(css).toMatch(/--tw-ring-offset-color:\s*rgb\(var\(--color-bg\)\)/);
  });

  it('draws keyboard focus as a 2px outline in the link colour', async () => {
    const css = await buildCss();
    expect(css).toMatch(
      /:focus-visible\s*\{\s*outline:\s*2px solid rgb\(var\(--color-link\)\);\s*outline-offset:\s*2px;?\s*\}/,
    );
    // The Button's own focus utilities, so the component is safe outside this app too.
    expect(css).toContain('.focus-visible\\:outline-link:focus-visible');
  });
});
