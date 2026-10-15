import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { chromium } from 'playwright';
import { makeDocxFixture } from './docx-fixtures.mjs';

const assets = new URL('../web/console/assets/', import.meta.url);
const chunk = name => {
  const found = readdirSync(assets).filter(file => file.startsWith(`vendor-${name}-`) && file.endsWith('.js'));
  assert.equal(found.length, 1, `Build the console before testing ${name}`);
  return found[0];
};
const mammothChunk = chunk('mammoth'), turndownChunk = chunk('turndown');
const server = createServer((request, response) => {
  const name = request.url?.slice(1) ?? '';
  if (!name) { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><title>DOCX compatibility</title>'); return; }
  if (name !== basename(name) || !name.endsWith('.js')) { response.writeHead(404).end(); return; }
  try { response.setHeader('content-type', 'text/javascript'); response.end(readFileSync(new URL(name, assets))); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const values = await page.evaluate(async ({ mammothChunk, turndownChunk, inputs }) => {
    const module = await import(`/${mammothChunk}`);
    const exports = Object.values(module);
    if (exports.length !== 1 || typeof exports[0] !== 'function') throw new Error('Unexpected bundled CommonJS export');
    const mammoth = exports[0]();
    const { default: Turndown } = await import(`/${turndownChunk}`);
    return Promise.all(inputs.map(async input => {
      try {
        const arrayBuffer = Uint8Array.from(atob(input), character => character.charCodeAt(0)).buffer;
        const html = (await mammoth.convertToHtml({ arrayBuffer })).value;
        const markdown = new Turndown({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(html).replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, (_match, alt) => `[图：${alt || '嵌入图片'}（Word 内嵌图片不入库，需要图片请改用图片链接）]`).trim();
        return { html, markdown };
      } catch (error) { return { error: String(error) }; }
    }));
  }, { mammothChunk, turndownChunk, inputs: [(await makeDocxFixture()).toString('base64'), (await makeDocxFixture({ empty: true })).toString('base64'), Buffer.from('broken zip').toString('base64')] });
  assert.match(values[0].markdown, /# 中文核对报告/);
  assert.match(values[0].markdown, /列表项目/);
  assert.match(values[0].markdown, /订单[\s\S]*已核对/);
  assert.match(values[0].markdown, /\[参考链接\]\(https:\/\/example.com\/reference\)/);
  assert.match(values[0].markdown, /\[图：流程图（Word 内嵌图片不入库，需要图片请改用图片链接）\]/);
  assert.doesNotMatch(values[0].markdown, /data:image/);
  assert.equal(values[1].markdown, '');
  assert.match(values[2].error, /zip/i);
  console.log('PASS: built console DOCX conversion preserves Chinese, headings, lists, table text, links and image placeholders; empty and corrupt cases pass.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
