import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Liveness check for uptime monitors and the Playwright web server. */
export function GET() {
  return NextResponse.json({ status: 'ok' }, { headers: { 'Cache-Control': 'no-store' } });
}
