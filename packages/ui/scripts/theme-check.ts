#!/usr/bin/env tsx
/**
 * Check a theme's colour pairings against WCAG 2.1 AA and print a table.
 *
 *   npm run theme:check -- <slug>        e.g. npm run theme:check -- foresite
 *
 * Exit code 1 when a required pairing fails or the theme does not load, so it
 * can gate CI. Advisory pairings (brand accents, borders, muted chart series)
 * print as "warn" and never fail the run.
 */
import { checkThemeContrast, contrastFailures, formatContrastTable } from '../src/theme/contrast';
import { ThemeError, loadTheme } from '../src/theme/load';

function main(argv: string[]): number {
  const slug = argv[0];
  if (slug === undefined || slug.startsWith('-')) {
    console.error('Usage: npm run theme:check -- <theme-slug>');
    return 2;
  }

  let theme;
  try {
    theme = loadTheme({ slug });
  } catch (error) {
    if (error instanceof ThemeError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const results = checkThemeContrast(theme);
  const failures = contrastFailures(results);
  const warnings = results.filter((r) => r.advisory && !r.pass);

  console.info(`Theme "${theme.slug}" (${theme.appName}) from ${theme.dir}\n`);
  console.info(formatContrastTable(results));
  console.info('');
  console.info(
    `${results.length} pairings checked: ${results.length - failures.length - warnings.length} pass, ` +
      `${warnings.length} advisory warning(s), ${failures.length} required failure(s).`,
  );

  if (failures.length > 0) {
    console.error('\nRequired pairings below WCAG AA:');
    for (const f of failures) {
      console.error(
        `  ${f.mode}: ${f.fg} (${f.fgHex}) on ${f.bg} (${f.bgHex}) is ${f.ratio.toFixed(2)}:1, needs ${f.required}:1`,
      );
    }
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
