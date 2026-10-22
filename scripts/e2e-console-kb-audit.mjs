import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { chromium } from 'playwright';

// Synthetic knowledge bases and intercepted API only; no real document or database access.
const assets = resolve(process.env.BAILING_CONSOLE_DIR || 'web/console');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let file = resolve(assets, url.pathname.replace(/^\/console\/?/, '') || 'index.html');
  if (!file.startsWith(assets + '/') && file !== assets) { res.writeHead(404).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(assets, 'index.html');
  res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' }).end(readFileSync(file));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await context.addInitScript(() => {
  const text = Blob.prototype.text;
  window.__kbFileReads = [];
  File.prototype.text = function () {
    return new Promise((resolve, reject) => {
      window.__kbFileReads.push(async () => { try { resolve(await text.call(this)); } catch (error) { reject(error); } });
    });
  };
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [], writes = [];
page.on('pageerror', error => errors.push(error.message));
let releaseWrite, holdWrite = false, failWrite = true, releasePreview;
const bases = ['a', 'b'].map(id => ({ kb_id: `kb-${id}`, name: `知识库 ${id.toUpperCase()}`, credential: 'demo-embedding', model: 'demo-model', dim: 1024, enabled: true, writers: [], doc_count: 0, chunk_count: 0 }));
await context.route('**/health', route => route.fulfill({ json: { status: 'ok', configBackend: true, queue: {} } }));
await context.route('**/admin/api/**', async route => {
  const path = new URL(route.request().url()).pathname, method = route.request().method();
  const json = value => route.fulfill({ json: value });
  if (path === '/admin/api/me') return json({ username: 'fixture', role: 'admin', perms: ['*'] });
  if (method === 'POST' && path.endsWith('/datasources/test')) {
    writes.push({ path, body: route.request().postDataJSON() });
    await new Promise(done => { releasePreview = done; });
    return json({ preview: [{ source_key: 'old-a', title: '旧库预览', content: '不能写回新库的结果' }] });
  }
  if (method === 'POST' && (path === '/admin/api/kb' || /^\/admin\/api\/kb\/kb-[ab]\/(docs|datasources)$/.test(path))) {
    writes.push({ path, body: route.request().postDataJSON() });
    if (holdWrite) await new Promise(done => { releaseWrite = done; });
    return failWrite ? route.fulfill({ status: 503, json: { error: 'fixture_kb_save_failed' } }) : json({ ok: true });
  }
  if (path === '/admin/api/kb') return json(bases);
  if (/^\/admin\/api\/kb\/kb-[ab]\/(docs|datasources)$/.test(path)) return json([]);
  if (path === '/admin/api/status') return json({ executors: [] });
  if (path === '/admin/api/instance-branding') return json({});
  if (path === '/admin/api/capabilities') return json({});
  if (path === '/admin/api/credentials') return json([{ name: 'demo-embedding', kind: 'embedding' }]);
  if (method !== 'GET') throw new Error(`Unexpected mutation ${method} ${path}`);
  return json([]);
});
async function answerPrompt(name) {
  await page.locator('.el-message-box').last().getByRole('button', { name, exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.el-message-box'));
}
const doc = () => page.getByRole('dialog', { name: '添加文档', exact: true });
const chooseB = () => page.locator('.kb-item').filter({ hasText: 'kb-b' });
const tick = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
async function discard(editor) {
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await answerPrompt('放弃修改');
  await editor.waitFor({ state: 'hidden' });
}
try {
  await page.goto(`${base}/console/kb?kb=kb-a`);
  await page.getByRole('button', { name: '添加文档', exact: true }).waitFor();
  const cases = [
    { open: '+ 建知识库', title: '建知识库', save: '建知识库', field: '如 产品文档库', draft: '新建草稿' },
    { open: '添加文档', title: '添加文档', save: '添加并向量化', field: '输入或粘贴文档内容', draft: '手工写入的正文，失败也不能丢。' },
    { open: '库设置', title: '库设置', save: '保存', label: '名称', draft: '库设置草稿' },
    { open: '+ 添加数据源', title: '添加数据源', save: '保存', field: '如 产品文档表', draft: '数据源草稿' },
  ];
  for (const item of cases) {
    await page.getByRole('button', { name: item.open, exact: true }).click();
    const editor = page.getByRole('dialog', { name: item.title, exact: true });
    const field = item.field ? editor.getByPlaceholder(item.field, { exact: true }) : editor.getByRole('textbox', { name: item.label, exact: true });
    await field.fill(item.draft);
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await answerPrompt('继续编辑');
    assert.equal(await field.inputValue(), item.draft);
    // Exercise real menu and KB selection handlers behind the drawer: query changes need their own guard.
    await page.getByRole('menuitem', { name: '任务', exact: true }).evaluate(el => el.click());
    await answerPrompt('继续编辑');
    assert.equal(new URL(page.url()).pathname, '/console/kb');
    await chooseB().evaluate(el => el.click());
    await answerPrompt('继续编辑');
    assert.equal(new URL(page.url()).searchParams.get('kb'), 'kb-a');
    holdWrite = true;
    const previousWrites = writes.length;
    const saveRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().includes('/admin/api/kb'));
    await editor.getByRole('button', { name: item.save, exact: true }).click();
    await saveRequest;
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.el-drawer input, .el-drawer textarea')).some(el => el.disabled));
    assert.equal(await field.isDisabled(), true);
    assert.equal(await editor.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    await editor.locator('.el-drawer__close-btn').click();
    await page.locator('.el-overlay').filter({ has: editor }).click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
    assert.equal(await editor.isVisible(), true);
    await chooseB().evaluate(el => el.click());
    await tick();
    assert.equal(new URL(page.url()).searchParams.get('kb'), 'kb-a', 'in-flight save must block KB switch');
    // A second click cannot issue a duplicate mutation.
    await editor.getByRole('button', { name: item.save, exact: true }).evaluate(el => el.click());
    await tick();
    assert.equal(writes.length, previousWrites + 1);
    releaseWrite();
    await editor.getByText('fixture_kb_save_failed', { exact: true }).waitFor();
    assert.equal(await field.inputValue(), item.draft);
    assert.equal(await field.isEnabled(), true);
    if (item.title === '库设置') assert.equal(writes.at(-1).body.kb_id, 'kb-a');
    if (item.title === '添加文档' || item.title === '添加数据源') assert.match(writes.at(-1).path, /\/kb-a\//);
    await discard(editor);
  }
  // A file selection is already a dirty change before asynchronous conversion populates any field.
  await page.getByRole('button', { name: '添加文档', exact: true }).click();
  await doc().locator('input[type=file]').setInputFiles({ name: 'late.txt', mimeType: 'text/plain', buffer: Buffer.from('迟到的旧文件正文') });
  await doc().getByText('文档读取 / 转换中…', { exact: true }).waitFor();
  assert.equal(await doc().getByRole('button', { name: '添加并向量化', exact: true }).isDisabled(), true);
  assert.equal(await doc().getByPlaceholder('输入或粘贴文档内容').inputValue(), '');
  await doc().getByRole('button', { name: '取消', exact: true }).click();
  await answerPrompt('继续编辑');
  assert.equal(await doc().isVisible(), true);
  await discard(doc());
  await page.getByRole('button', { name: '添加文档', exact: true }).click();
  await doc().getByPlaceholder('输入或粘贴文档内容').fill('新开的手工草稿');
  await page.evaluate(async () => { await window.__kbFileReads.shift()(); });
  await tick();
  assert.equal(await doc().getByPlaceholder('输入或粘贴文档内容').inputValue(), '新开的手工草稿', 'discarded file must not overwrite new draft');
  holdWrite = false; failWrite = false;
  await doc().getByRole('button', { name: '添加并向量化', exact: true }).click();
  await doc().waitFor({ state: 'hidden' });
  assert.equal(writes.at(-1).path, '/admin/api/kb/kb-a/docs');
  assert.equal(writes.at(-1).body.content, '新开的手工草稿');
  // Old datasource preview completion is ignored after discard and opening another KB.
  await page.getByRole('button', { name: '+ 添加数据源', exact: true }).click();
  const source = () => page.getByRole('dialog', { name: '添加数据源', exact: true });
  await source().getByPlaceholder('如 产品文档表').fill('A 的数据源');
  const previewRequest = page.waitForRequest(request => request.url().endsWith('/kb-a/datasources/test'));
  await source().getByRole('button', { name: '测试连接并预览', exact: true }).click();
  await previewRequest;
  assert.equal(await source().getByRole('button', { name: '保存', exact: true }).isDisabled(), true);
  await discard(source());
  await chooseB().click();
  await page.waitForURL('**/console/kb?kb=kb-b');
  await page.getByRole('button', { name: '+ 添加数据源', exact: true }).click();
  await source().getByPlaceholder('如 产品文档表').fill('B 的数据源');
  const previewResponse = page.waitForResponse(response => response.url().endsWith('/kb-a/datasources/test'));
  releasePreview(); await previewResponse; await tick();
  assert.equal(await source().locator('.ds-preview').count(), 0);
  assert.equal(await source().getByPlaceholder('如 产品文档表').inputValue(), 'B 的数据源');
  await source().getByRole('button', { name: '保存', exact: true }).click();
  await source().waitFor({ state: 'hidden' });
  assert.equal(writes.at(-1).path, '/admin/api/kb/kb-b/datasources');
  assert.equal(writes.at(-1).body.name, 'B 的数据源');
  assert.equal(writes.length, 7);
  assert.deepEqual(errors, []);
  console.log('✓ KB final audit: all four drawer draft/busy/failure guards, route and same-page KB switching, file-only dirty state, stale file/preview isolation, original-KB writes and successful retries');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
