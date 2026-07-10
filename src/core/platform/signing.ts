import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export function signBody(secret: string, ts: string, body: string): string {
  return createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifySignedBody(headers: IncomingHttpHeaders, secret: string, raw: string, nowMs = Date.now()): boolean {
  const ts = String(headers['x-bailing-timestamp'] ?? '');
  const sig = String(headers['x-bailing-signature'] ?? '');
  if (!ts || !sig.startsWith('sha256=')) return false;
  const n = Number(ts);
  if (!Number.isFinite(n) || Math.abs(nowMs - n) > 5 * 60 * 1000) return false;
  const expected = `sha256=${signBody(secret, ts, raw)}`;
  return safeEqualString(sig, expected);
}
