/** Small HTTP helpers for the ingest endpoint. */

export const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // Device responses must never be cached by a browser, CDN or the service worker.
  'Cache-Control': 'no-store',
} as const;

export function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

/** `application/json`, optionally with parameters such as `charset=utf-8`. */
export function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const [type, ...params] = header.split(';');
  if (type?.trim().toLowerCase() !== 'application/json') return false;
  // Only a UTF-8 charset (or none) makes sense for JSON.
  return params.every((param) => {
    const [name, value] = param.split('=').map((part) => part.trim().toLowerCase());
    return name !== 'charset' || value === 'utf-8' || value === '"utf-8"';
  });
}

export type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' | 'aborted' };

/**
 * Read a request body, stopping as soon as it exceeds `maxBytes`, so an
 * oversized or never-ending body cannot exhaust memory. Does not trust
 * Content-Length (it may be absent with chunked encoding, or wrong). A stream
 * error (the client closed the connection mid-body) is `aborted`, not a throw.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<BodyReadResult> {
  if (request.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch {
      return { ok: false, reason: 'aborted' };
    }
    const { done, value } = next;
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

/** The first value of a comma-separated forwarding header, lower-cased and trimmed. */
export function firstForwardedValue(header: string | null): string | null {
  if (header === null) return null;
  const first = header.split(',')[0]?.trim().toLowerCase();
  return first === undefined || first === '' ? null : first;
}

/**
 * The client address as reported by the hosting proxy. Used only to slow down
 * repeated failed logins. On Vercel, `x-real-ip` and `x-forwarded-for` are set
 * by Vercel's edge (UNVERIFIED for our deployment until the first deploy);
 * anywhere else they can be spoofed, which only weakens this one limit.
 */
export function clientAddress(headers: Headers): string {
  const candidate =
    firstForwardedValue(headers.get('x-real-ip')) ??
    firstForwardedValue(headers.get('x-forwarded-for'));
  if (candidate !== null && /^[0-9a-f.:]{2,45}$/.test(candidate)) return candidate;
  return 'unknown';
}
