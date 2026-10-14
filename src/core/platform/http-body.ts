/** A response that exceeded its byte budget is incomplete evidence, never a partial success. */
export class ResponseBodyLimitError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly observedBytes: number,
    readonly source: 'content-length' | 'stream',
  ) {
    super(`HTTP response exceeds ${maxBytes} byte limit`);
    this.name = 'ResponseBodyLimitError';
  }
}

export function cancelResponseBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Best effort; never wait on an unbounded cancel hook. */ }
}

/** Counts fetch's decoded body bytes before buffering; Content-Length is only an early rejection hint. */
export async function readResponseBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid HTTP response byte limit');
  const declared = response.headers.get('content-length')?.trim();
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    cancelResponseBody(response);
    throw new ResponseBodyLimitError(maxBytes, Number(declared), 'content-length');
  }
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseBodyLimitError(maxBytes, total, 'stream');
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body.buffer;
  } catch (error) {
    try { void reader.cancel().catch(() => undefined); } catch { /* Preserve a limit/timeout/transport error without waiting. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** UTF-8 byte budget without splitting a multibyte character or surrogate pair. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
