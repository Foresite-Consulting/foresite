import { describe, expect, it } from 'vitest';
import { clientAddress, firstForwardedValue, isJsonContentType, readBodyWithLimit } from './http';

describe('isJsonContentType', () => {
  it('accepts JSON with or without a UTF-8 charset', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/json;charset="UTF-8"')).toBe(true);
  });

  it('rejects everything else', () => {
    for (const value of [
      null,
      '',
      'text/json',
      'application/json-patch+json',
      'application/json; charset=iso-8859-1',
      'multipart/form-data',
    ]) {
      expect(isJsonContentType(value), String(value)).toBe(false);
    }
  });
});

describe('readBodyWithLimit', () => {
  it('reports a stream error (client abort) as aborted instead of throwing', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode('{"partial":'));
        } else {
          controller.error(new Error('aborted'));
        }
      },
    });
    const request = new Request('https://x', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    expect(await readBodyWithLimit(request, 1_000)).toEqual({ ok: false, reason: 'aborted' });
  });

  it('reads a body under the limit', async () => {
    const result = await readBodyWithLimit(
      new Request('https://x', { method: 'POST', body: 'abc' }),
      3,
    );
    expect(result.ok && new TextDecoder().decode(result.bytes)).toBe('abc');
  });

  it('stops at the limit', async () => {
    const result = await readBodyWithLimit(
      new Request('https://x', { method: 'POST', body: 'abcd' }),
      3,
    );
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('treats a missing body as empty', async () => {
    const result = await readBodyWithLimit(new Request('https://x', { method: 'POST' }), 3);
    expect(result.ok && result.bytes.byteLength).toBe(0);
  });
});

describe('forwarding headers', () => {
  it('takes the first forwarded value', () => {
    expect(firstForwardedValue('HTTPS, http')).toBe('https');
    expect(firstForwardedValue(' ')).toBeNull();
    expect(firstForwardedValue(null)).toBeNull();
  });

  it('reads a client address and ignores junk', () => {
    expect(clientAddress(new Headers({ 'x-real-ip': '203.0.113.5' }))).toBe('203.0.113.5');
    expect(clientAddress(new Headers({ 'x-forwarded-for': '2001:db8::1, 10.0.0.1' }))).toBe(
      '2001:db8::1',
    );
    expect(clientAddress(new Headers({ 'x-forwarded-for': '<script>' }))).toBe('unknown');
    expect(clientAddress(new Headers())).toBe('unknown');
  });
});
