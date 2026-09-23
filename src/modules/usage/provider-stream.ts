import { UsageError } from './errors';
import { object, verifiedUsage, type JsonObject, type ProviderResult } from './provider';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export type ProviderEnvelope = {
  schema: 'bailing.provider-response.v1'; format: 'sse' | 'json'; status: number;
  content_type: 'text/event-stream' | 'application/json'; body: string;
};

/** A passive meter. Parsing failures never alter or suppress provider output. */
class ProviderMeter {
  private buffer = '';
  private data: string[] = [];
  private id: string | null = null;
  private changedId = false;
  private usage?: ProviderResult['usage'];
  private rawUsage?: JsonObject;
  constructor(private readonly sse: boolean) {}
  private observe(text: string) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return; }
    if (!object(value)) return;
    if (typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256) {
      if (this.id !== null && this.id !== value.id) this.changedId = true;
      this.id ??= value.id;
    }
    if (value.usage != null) {
      this.usage = verifiedUsage(value.usage);
      this.rawUsage = this.usage && object(value.usage) ? value.usage : undefined;
    }
  }
  push(text: string) {
    this.buffer += text;
    if (!this.sse) return;
    // SSE permits CRLF, LF and CR. Leave a trailing CR until the next chunk.
    let match: RegExpExecArray | null;
    while ((match = /\r\n|\n|\r(?!$)/.exec(this.buffer))) {
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      if (!line) { this.observe(this.data.join('\n')); this.data = []; }
      else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  finish(): Omit<ProviderResult, 'response'> {
    if (!this.sse) this.observe(this.buffer);
    // Conflicting supplier identities cannot be used for financial evidence.
    // The untouched body still goes to the local adapter.
    return this.changedId ? { executionId: null } : { executionId: this.id,
      ...(this.usage ? { usage: this.usage, rawUsage: this.rawUsage } : {}) };
  }
}

/** Forward the provider body without interpreting choices, tools or finish reasons. */
export async function readProviderExchange(response: Response, onProvider?: (packet: JsonObject) => Promise<void>, signal?: AbortSignal): Promise<ProviderResult> {
  const sse = (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
  const header: Omit<ProviderEnvelope, 'body'> = { schema: 'bailing.provider-response.v1',
    format: sse ? 'sse' : 'json', status: response.status, content_type: sse ? 'text/event-stream' : 'application/json' };
  const meter = new ProviderMeter(sse), decoder = new TextDecoder();
  let body = '', bytes = 0;
  const reader = response.body?.getReader();
  try {
    if (reader) for (;;) {
      signal?.throwIfAborted();
      const next = await reader.read();
      const text = next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      if (!next.done) bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new UsageError('USAGE_PROVIDER_RESPONSE_TOO_LARGE', 'The provider response exceeded the transport byte limit.', 502);
      body += text;
      // Delivery runs before metering, which only observes the same text locally.
      if (text) await onProvider?.({ ...header, data: text });
      meter.push(text);
      if (next.done) break;
    }
    signal?.throwIfAborted();
    return { response: { ...header, body }, ...meter.finish() };
  } finally { await reader?.cancel().catch(() => {}); }
}
