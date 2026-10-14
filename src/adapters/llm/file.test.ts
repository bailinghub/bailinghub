import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFileContext } from './file';

const TINY_PDF = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT /F1 12 Tf 10 100 Td (Hello PDF) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000334 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
404
%%EOF`;

async function withMockFetch<T>(
  handler: (url: string) => Response,
  fn: () => Promise<T>,
): Promise<T> {
  const old = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => handler(String(url))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = old;
  }
}

test('buildFileContext: 文本文件抽取后注入上下文', async () => {
  const got = await withMockFetch(
    () => new Response('hello text', { headers: { 'content-type': 'text/plain' } }),
    () => buildFileContext({
      files: [{ url: 'https://cdn.example.com/a.txt', name: 'a.txt' }],
      config: { mode: 'extract' },
    }),
  );

  assert.match(got, /a\.txt/);
  assert.match(got, /hello text/);
});

test('buildFileContext: PDF 文本型文档可本地抽取并审计 parser/pages', async () => {
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const got = await withMockFetch(
    () => new Response(Buffer.from(TINY_PDF), { headers: { 'content-type': 'application/pdf' } }),
    () => buildFileContext({
      files: [{ url: 'https://cdn.example.com/contract.pdf', name: 'contract.pdf' }],
      config: { mode: 'extract' },
      audit: (event, detail) => audits.push({ event, detail }),
    }),
  );

  assert.match(got, /contract\.pdf/);
  assert.match(got, /Hello PDF/);
  assert.equal(audits[0]?.event, 'file_input');
  assert.equal(audits[0]?.detail['ok'], true);
  assert.equal(audits[0]?.detail['parser'], 'pdf');
  assert.equal(audits[0]?.detail['pages'], 1);
});

test('buildFileContext: 超限声明不读取正文，不运行解析器', async () => {
  let pulls = 0;
  let cancels = 0;
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const got = await withMockFetch(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancels++; },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/plain', 'content-length': '1025' } }),
  () => buildFileContext({ files: [{ url: 'https://synthetic.invalid/a.txt' }],
    config: { mode: 'extract', max_bytes: 1024 }, audit: (event, detail) => audits.push({ event, detail }) }));
  assert.match(got, /文件过大/);
  assert.equal(pulls, 0);
  assert.equal(cancels, 1);
  assert.equal(audits[0]!.detail.ok, false);
  assert.equal(audits[0]!.detail.parser, undefined);
  assert.equal(audits[0]!.detail.bytes, undefined, 'declared length is not consumed bytes');
});

test('buildFileContext: 无长度/低报长度均流式停止，半截文件不注入', async () => {
  for (const declared of [false, true]) {
    let pulls = 0;
    let cancels = 0;
    const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const got = await withMockFetch(() => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(pulls === 1 ? 1024 : 1).fill(65)); },
      cancel() { cancels++; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/plain', ...(declared ? { 'content-length': '1' } : {}) } }),
    () => buildFileContext({ files: [{ url: 'https://synthetic.invalid/a.txt' }],
      config: { mode: 'extract', max_bytes: 1024 }, audit: (event, detail) => audits.push({ event, detail }) }));
    assert.match(got, /文件过大/);
    assert.equal(got.includes('AAAA'), false);
    assert.equal(pulls, 2);
    assert.equal(cancels, 1);
    assert.equal(audits[0]!.detail.ok, false);
    assert.equal(audits[0]!.detail.parser, undefined);
    assert.equal(audits[0]!.detail.bytes, 1025);
  }
});

test('buildFileContext: 恰好达到预算的文件仍正常抽取', async () => {
  const got = await withMockFetch(() => new Response('a'.repeat(1024)),
    () => buildFileContext({ files: [{ url: 'https://synthetic.invalid/a.txt' }], config: { mode: 'extract', max_bytes: 1024 } }));
  assert.equal(got.includes('a'.repeat(1024)), true);
  assert.equal(got.includes('文件过大'), false);
});

test('buildFileContext: HTTP 错误取消正文而不读取', async () => {
  let cancels = 0;
  let pulls = 0;
  const got = await withMockFetch(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024)); },
    cancel() { cancels++; return new Promise<void>(() => undefined); },
  }, { highWaterMark: 0 }), { status: 500 }),
  () => buildFileContext({ files: [{ url: 'https://synthetic.invalid/a.txt' }], config: { mode: 'extract' } }));
  assert.match(got, /文件下载失败（HTTP 500）/);
  assert.equal(cancels, 1);
  assert.equal(pulls, 0);
});
