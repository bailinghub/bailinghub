import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { chromium } from 'playwright';

// Fully synthetic API and files; never saves branding to an actual hub.
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
  const Reader = window.FileReader;
  window.__pendingBrandingReads = [];
  window.__completedBrandingReads = 0;
  window.FileReader = class extends Reader {
    readAsDataURL(file) {
      this.addEventListener('loadend', () => { window.__completedBrandingReads++; });
      window.__pendingBrandingReads.push(() => super.readAsDataURL(file));
    }
  };
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
const errors = [], writes = [];
page.on('pageerror', error => errors.push(error.message));
let readFails = true, saveFails = false, holdSave = false, releaseSave;
let branding = { site_name: '原实例名称', browser_title: '原浏览器标题', site_description: '', site_keywords: [], login_heading: '原登录标题', login_subheading: '', has_logo: false, has_favicon: false, logo_url: null, favicon_url: null, revision: 'fixture', updated_at: null };
await context.route('**/health', route => route.fulfill({ json: { status: 'ok', configBackend: true, queue: {} } }));
await context.route('**/admin/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  const json = value => route.fulfill({ json: value });
  if (path === '/admin/api/me') return json({ username: 'fixture', role: 'admin', perms: ['*'] });
  if (path === '/admin/api/instance-branding') {
    if (route.request().method() === 'PUT') {
      const payload = route.request().postDataJSON(); writes.push(payload);
      if (holdSave) await new Promise(done => { releaseSave = done; });
      if (saveFails) return route.fulfill({ status: 503, json: { error: 'fixture_save_failed' } });
      branding = { ...branding, ...payload }; delete branding.logo_data_url; delete branding.favicon_data_url;
      return json({ branding, management: { source: 'local', writable: true } });
    }
    if (readFails) return route.fulfill({ status: 503, json: { error: 'fixture_read_failed' } });
    return json({ branding, management: { source: 'local', writable: true } });
  }
  if (path === '/admin/api/status') return json({ executors: [] });
  if (path === '/admin/api/conversation-audits') return json({ items: [], has_more: false, next_offset: null });
  if (path.startsWith('/admin/api/config-schemas/')) return json({ required: [], properties: {} });
  if (route.request().method() !== 'GET') throw new Error(`Unexpected mutation ${path}`);
  return json([]);
});
const form = page.locator('.settings-page');
const name = form.getByRole('textbox', { name: '网站名称', exact: true });
const refresh = form.getByRole('button', { name: '刷新', exact: true });
const save = form.getByRole('button', { name: '保存设置', exact: true });
const prompt = () => page.locator('.el-message-box');
try {
  await page.goto(`${base}/console/settings`);
  await form.getByText('实例外观读取失败', { exact: true }).waitFor();
  assert.equal(await name.isEnabled(), false);
  assert.equal(await save.count(), 0);
  readFails = false;
  await refresh.click();
  await name.waitFor();
  await page.waitForFunction(() => document.querySelector('.settings-page input[placeholder="如：企业智能运营中枢"]')?.value === '原实例名称');
  await name.fill('保留的实例名称草稿');
  await refresh.click();
  await prompt().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await name.inputValue(), '保留的实例名称草稿');
  await page.getByRole('menuitem', { name: '任务', exact: true }).click();
  await prompt().getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/console/settings');
  assert.equal(await name.inputValue(), '保留的实例名称草稿');
  // Failed refresh retains the draft rather than clearing it after confirmation.
  readFails = true;
  await refresh.click();
  await prompt().getByRole('button', { name: '放弃修改', exact: true }).click();
  await form.getByText('当前保留上次读取的内容和未保存修改', { exact: false }).waitFor();
  assert.equal(await name.inputValue(), '保留的实例名称草稿');
  readFails = false;
  saveFails = true;
  await save.click();
  await form.getByText('实例外观保存未完成', { exact: true }).waitFor();
  assert.equal(await name.inputValue(), '保留的实例名称草稿');
  // A pending save freezes editing and refresh; only one mutation is issued.
  saveFails = false; holdSave = true;
  await save.click();
  await page.waitForFunction(() => document.querySelector('.settings-page input[placeholder="如：企业智能运营中枢"]')?.disabled);
  assert.equal(await refresh.isEnabled(), false);
  assert.equal(await form.getByRole('button', { name: '选择图片', exact: true }).isEnabled(), false);
  await save.evaluate(button => button.click());
  assert.equal(writes.length, 2);
  while (!releaseSave) await new Promise(done => setTimeout(done, 10));
  holdSave = false; releaseSave();
  await page.waitForFunction(() => !document.querySelector('.settings-page input[placeholder="如：企业智能运营中枢"]')?.disabled);
  assert.equal(await form.getByText('有未保存修改', { exact: true }).count(), 0);
  // Remove a still-reading image, save the removal, then resolve the old FileReader.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64');
  await form.locator('input[type="file"]').first().setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: png });
  await form.getByText('正在读取图片…', { exact: true }).waitFor();
  assert.equal(await save.isEnabled(), false);
  await form.locator('.asset-grid .el-card').first().getByRole('button', { name: '移除', exact: true }).click();
  await save.click();
  await page.waitForFunction(() => !document.querySelector('.settings-page input[placeholder="如：企业智能运营中枢"]')?.disabled);
  assert.equal(writes.at(-1).logo_data_url, null);
  await page.evaluate(() => window.__pendingBrandingReads.shift()());
  await page.waitForFunction(() => window.__completedBrandingReads === 1);
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await form.locator('.logo-preview img').count(), 0);
  assert.equal(await form.getByText('有未保存修改', { exact: true }).count(), 0);
  assert.equal(writes.length, 3);
  assert.deepEqual(errors, []);
  console.log('✓ instance branding: initial read failure, refresh/route draft protection, retained save errors, busy lock and removed-image late-read isolation');
} finally {
  releaseSave?.();
  await context.close(); await browser.close(); await new Promise(done => server.close(done));
}
