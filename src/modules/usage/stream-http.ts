import type { ServerResponse } from 'node:http';

/** A disconnected viewer never cancels/replays the separately recorded provider operation. */
export class UsageStreamWriter {
  private sequence = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(private readonly res: ServerResponse, private readonly operationId: string) {}
  get open() { return this.res.headersSent; }
  async emit(type: 'started' | 'provider' | 'operation', payload: Record<string, unknown> = {}) {
    const res = this.res;
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      this.heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded && res.writableLength < 65536) res.write(': keep-alive\n\n');
      }, 15000);
      this.heartbeat.unref();
      res.once('close', () => this.stop());
    }
    const data = JSON.stringify({ schema: 'bailing.model-stream.v1', operation_id: this.operationId,
      seq: ++this.sequence, type, ...payload });
    if (res.write(`data: ${data}\n\n`)) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); res.off('drain', finish); res.off('close', finish); resolve(); };
      const timer = setTimeout(() => { res.destroy(); finish(); }, 5000); timer.unref();
      res.once('drain', finish); res.once('close', finish);
    });
  }
  stop() { if (this.heartbeat) clearInterval(this.heartbeat); }
  end() { this.stop(); if (!this.res.destroyed && !this.res.writableEnded) this.res.end(); }
}
