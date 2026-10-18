import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextResponse } from 'next/server';
import { getTheme } from '@/lib/theme';

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
};

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
  if (!allowed.has(file)) {
    return new NextResponse('Not found', { status: 404 });
  }
  const extension = file.split('.').pop()?.toLowerCase() ?? '';
  const contentType = CONTENT_TYPES[extension];
  if (contentType === undefined) {
    return new NextResponse('Not found', { status: 404 });
  }

  let body: Buffer;
  try {
    body = await readFile(join(theme.dir, file));
  } catch {
    return new NextResponse('Not found', { status: 404 });
  }

  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
