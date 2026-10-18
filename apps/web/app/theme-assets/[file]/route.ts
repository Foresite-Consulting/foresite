import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { themeAssetContentType } from '@foresite/ui/theme';
import { getTheme } from '@/lib/theme';
import { THEME_ASSET_HEADERS } from '@/lib/theme-assets';

function notFound() {
  return new NextResponse('Not found', {
    status: 404,
    headers: { ...THEME_ASSET_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Serves the active theme's logo, icons and favicon from `themes/<slug>/`.
 * Only files the theme declares are served, so a request can never reach
 * anything else on disk.
 */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const theme = getTheme();
  const allowed = new Set(
    [
      theme.assets.logo,
      theme.assets.logoOnDark,
      theme.assets.favicon,
      ...theme.assets.icons,
    ].filter((name): name is string => name !== null),
  );
  if (!allowed.has(file)) return notFound();
  // The theme schema already restricts extensions; checked again here so the
  // route never serves a type it has no Content-Type for.
  const contentType = themeAssetContentType(file);
  if (contentType === undefined) return notFound();

  let body: Buffer;
  try {
    body = await readFile(join(theme.dir, file));
  } catch {
    return notFound();
  }

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      ...THEME_ASSET_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  });
}
