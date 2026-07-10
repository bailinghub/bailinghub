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
