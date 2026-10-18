import { handleCounterIngest } from '@/lib/ingest/handler';
import { jsonResponse } from '@/lib/ingest/http';
import { getIngestDeps } from '@/lib/ingest/runtime';

// scrypt and the database driver need Node, and nothing here may be cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Device ingest for people counters. See `lib/ingest/handler.ts` for the
 * checks and `packages/connectors/src/counters/milesight/RUNBOOK.md` for
 * device set-up. Only POST is exported, so Next.js answers 405 to anything else.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  try {
    return await handleCounterIngest(request, provider, getIngestDeps());
  } catch {
    console.error(
      JSON.stringify({ level: 'error', event: 'counter_ingest', outcome: 'internal_error' }),
    );
    return jsonResponse(500, { error: 'internal_error' });
  }
}
