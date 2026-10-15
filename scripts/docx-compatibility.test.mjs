import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeDocxFixture } from './docx-fixtures.mjs';
import { checkVendor } from './vendor-mammoth.mjs';
import { buildFileContext } from '../src/adapters/llm/file.ts';
const require = createRequire(import.meta.url);
const mammoth = require('mammoth');

test('library-only distribution preserves Chinese, whitespace and structured DOCX APIs', async () => {
  checkVendor();
  const buffer = await makeDocxFixture();
  const raw = await mammoth.extractRawText({ buffer });
  assert.match(raw.value, /中文核对报告\n\n第一段  保留空格\t制表符换行 %.101f %.101e %.101g/);
  for (const value of ['列表项目', '订单', '已核对', '参考链接']) assert(raw.value.includes(value));
  const html = await mammoth.convertToHtml({ buffer });
  for (const pattern of [/<h1>中文核对报告<\/h1>/, /<ul><li>列表项目<\/li><\/ul>/, /<table>/, /href="https:\/\/example.com\/reference"/, /data:image\/png;base64,/, /alt="流程图"/]) assert.match(html.value, pattern);
  assert.equal(Object.keys(require.cache).some(path => /node_modules\/(argparse|sprintf-js)\//.test(path)), false);
  assert.equal(require('mammoth/package.json').bin, undefined);
});

test('Core file adapter keeps DOCX extraction and empty/corrupt failures', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [buffer, expected, ok] of [[await makeDocxFixture(), /中文核对报告/, true], [await makeDocxFixture({ empty: true }), /DOCX 未抽取到可用文本/, false], [Buffer.from('broken zip'), /DOCX 文本抽取失败/, false]]) {
      const events = [];
      globalThis.fetch = async () => new Response(buffer, { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } });
      const value = await buildFileContext({ files: [{ url: 'https://example.com/sample.docx' }], config: { mode: 'extract' }, audit: (event, detail) => events.push({ event, detail }) });
      assert.match(value, expected); assert.equal(events[0].detail.ok, ok); assert.equal(events[0].detail.parser, 'docx');
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('empty and corrupt DOCX behavior is unchanged for both library APIs', async () => {
  const buffer = await makeDocxFixture({ empty: true });
  assert.equal((await mammoth.extractRawText({ buffer })).value, '');
  assert.equal((await mammoth.convertToHtml({ buffer })).value, '');
  for (const method of ['extractRawText', 'convertToHtml']) await assert.rejects(mammoth[method]({ buffer: Buffer.from('broken zip') }), /zip/i);
});
