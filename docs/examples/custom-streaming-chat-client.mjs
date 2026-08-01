/**
 * Minimal transport lifecycle for a custom BailingHub streaming client.
 *
 * This example intentionally leaves Markdown parsing and chart rendering to the
 * host application. Only advertise renderer types that the host has installed
 * and secured.
 */
export async function runBailingChat({
  hub,
  entryKey,
  message,
  visitorId,
  ticket,
  threadId,
  supportedRenderers = [],
  maxWaitMs = 5 * 60 * 1000,
  onProvisional = () => {},
  onReset = () => {},
  onFinal = () => {},
  onIncomplete = () => {},
  onFailure = () => {},
}) {
  const base = String(hub).replace(/\/+$/, '');
  const renderers = Array.from(new Set(supportedRenderers
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^[a-z][a-z0-9._+-]{0,63}$/.test(item))))
    .slice(0, 16);

  const response = await fetch(`${base}/chat/${encodeURIComponent(entryKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      message,
      visitor_id: visitorId,
      ...(renderers.length ? { client_capabilities: { renderers } } : {}),
      ...(ticket ? { ticket } : {}),
      ...(threadId ? { thread_id: threadId } : {}),
    }),
  });
  const submitted = await response.json();
  if (!response.ok || !submitted.job_id) {
    throw new Error(submitted.error || submitted.reply || `chat submit failed (${response.status})`);
  }

  return await new Promise((resolve, reject) => {
    let provisional = '';
    let lastSeq = 0;
    let settled = false;
    const events = new EventSource(
      `${base}/chat/${encodeURIComponent(entryKey)}/events/${encodeURIComponent(submitted.job_id)}?max_wait=${maxWaitMs}`,
    );
    const parse = (event) => JSON.parse(event.data);
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      events.close();
      resolve(value);
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      events.close();
      reject(new Error('chat event stream exceeded the client wait deadline'));
    }, maxWaitMs + 10_000);

    events.addEventListener('delta', (event) => {
      const data = parse(event);
      const seq = Number(data.seq) || 0;
      if (seq && seq <= lastSeq) return;
      if (seq) lastSeq = seq;
      provisional += typeof data.text === 'string' ? data.text : '';
      onProvisional(provisional, data);
    });
    events.addEventListener('reset', (event) => {
      const data = parse(event);
      provisional = '';
      onReset(data);
    });
    events.addEventListener('done', (event) => {
      const data = parse(event);
      // done.reply replaces provisional output and is the only final truth.
      onFinal(data.reply || '', data);
      finish(data);
    });
    events.addEventListener('failed', (event) => {
      const data = parse(event);
      onFailure(data);
      finish(data);
    });
    events.addEventListener('timeout', (event) => {
      const data = parse(event);
      // The bounded SSE wait ended, but the job may still be running. Query
      // task history/status before deciding whether to reconnect or surface it.
      onIncomplete(data);
      finish(data);
    });
    events.onerror = () => {
      // Native EventSource reconnects automatically and resumes from the
      // server-provided event id. Only fail when the browser marks it closed.
      if (events.readyState !== EventSource.CLOSED || settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error('chat event stream closed before a terminal event'));
    };
  });
}
