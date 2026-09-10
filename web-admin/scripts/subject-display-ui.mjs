import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const consoleDir = join(root, 'web/console');
const evidence = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (evidence) mkdirSync(evidence, { recursive: true });
const session = (number, display) => ({
  session_id: `11111111-1111-4111-8111-${String(number).padStart(12, '0')}`,
  client_app_id: 'example-app', device_label: `Laptop ${number}`,
  principal: { id: `user-${number}`, tenant: `tenant-${number}` },
  on_behalf_of: `tenant-${number}:user-${number}`, allowed_routes: ['operations'],
  refresh_expires_at: '2030-01-01T00:00:00Z', state: 'active', ...display,
});
const rows = [
  session(1, { subject_display: { name: 'Account A' }, subject_display_status: 'provided' }),
  session(2, { subject_display: { name: 'Account A' }, subject_display_status: 'provided' }),
  session(3, { subject_display: null, subject_display_status: 'missing' }),
  session(4, {}),
  session(5, { subject_display: { name: '<img src=x onerror=alert(1)>' }, subject_display_status: 'provided' }),
];
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const rel = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/console\/?/, '');
  let file = resolve(consoleDir, rel || 'index.html');
  if (!file.startsWith(consoleDir + '/') && file !== consoleDir) { res.writeHead(404); res.end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(consoleDir, 'index.html');
  res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const mutations = [];
  await context.route('**/admin/api/**', route => {
    const request = route.request();
    if (request.method() !== 'GET') mutations.push(request.method());
    const path = new URL(request.url()).pathname;
    if (path === '/admin/api/me') return route.fulfill({ json: { username: 'fixture-admin', role: 'admin', perms: ['*'] } });
    if (path === '/admin/api/agent-clients/sessions') return route.fulfill({ json: { list: rows, total: rows.length } });
    if (path === '/admin/api/agent-clients/overview') return route.fulfill({ json: { applications: [], workspaces: [], setup_workspaces: [], summary: { applications: 1, sessions: { active: 5, total: 5 } } } });
    return route.fulfill({ json: {} });
  });
  await context.route('**/health', route => route.fulfill({ json: { status: 'ok', paused: false, backend: 'mysql' } }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push('unexpected_browser_dialog'); void dialog.dismiss(); });
  await page.goto(`http://127.0.0.1:${server.address().port}/console/agent-clients`, { waitUntil: 'networkidle' });
  await page.getByText('设备与运行', { exact: true }).click();
  await page.getByRole('columnheader', { name: '授权名称', exact: true }).waitFor();
  const tableRows = page.locator('.el-table__body-wrapper tbody tr');
  assert.equal(await tableRows.count(), 5);
  assert.equal(await tableRows.filter({ hasText: 'Account A' }).count(), 2, 'same-name authorizations stay separate');
  for (const n of [3, 4]) assert.match(await tableRows.nth(n - 1).innerText(), /待同步/);
  assert.equal(await tableRows.nth(4).locator('img').count(), 0, 'display metadata remains escaped text');
  assert.match(await tableRows.nth(4).innerText(), /<img src=x onerror=alert\(1\)>/);
  assert.match(await tableRows.nth(0).innerText(), /Account A[\s\S]*Laptop 1/);
  if (evidence) await page.screenshot({ path: join(evidence, 'authorization-list.png'), fullPage: true, animations: 'disabled' });
  await tableRows.nth(0).getByRole('button', { name: '详情', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '业务授权详情' });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Account A[\s\S]*业务系统提供[\s\S]*Laptop 1/);
  assert.match(await dialog.innerText(), /11111111-1111-4111-8111-000000000001/);
  if (evidence) await page.screenshot({ path: join(evidence, 'authorization-detail.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(mutations, [], 'read-only list and details must not send mutations');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'pass', checks: 10, synthetic: true, business_requests: 0, mutation_requests: 0 }));
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
