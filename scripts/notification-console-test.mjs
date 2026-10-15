import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, extname, relative } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';

// Real production-built Runs page, synthetic same-origin API fixtures only.
// Usage: npm --prefix web-admin run build && node scripts/notification-console-test.mjs [--output DIR]
const root = process.cwd();
const built = join(root, 'web/console');
assert.ok(existsSync(join(built, 'index.html')), 'Build web-admin before running the notification console regression');
const outputIndex = process.argv.indexOf('--output');
const retained = outputIndex >= 0;
if (retained && !process.argv[outputIndex + 1]) throw new Error('--output requires a directory');
const output = retained ? resolve(process.argv[outputIndex + 1]) : mkdtempSync(join(tmpdir(), 'notification-console-'));
mkdirSync(output, { recursive: true });
const checks = [], requests = [], pageErrors = [], unexpected = [];
const report = { passed: false, mode: 'production-build-local-synthetic-api', checks, requests, pageErrors, unexpected,
  index_sha256: createHash('sha256').update(readFileSync(join(built, 'index.html'))).digest('hex') };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const rel = decodeURIComponent(url.pathname.replace(/^\/console\/?/, ''));
  let file = resolve(built, rel || 'index.html');
  if (relative(built, file).startsWith('..')) { res.writeHead(404).end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(built, 'index.html');
  res.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, currentPage;
const kinds = [ ['callback', '任务回调'], ['delivery', '结果送达'], ['approval-notification', '审批提示'], ['delivery-dlq', '通知失败留存'] ];
const statuses = ['pending', 'processing', 'completed', 'skipped', 'failed', 'uncertain'];
const seed = () => kinds.flatMap(([kind]) => statuses.map(status => ({ event_id: `synthetic:${kind}:${status}`, kind,
  job_id: `synthetic-business-parent-${kind}`, request_id: 'synthetic-request', status, attempts: 3,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:01:00.000Z', last_error: status === 'failed' ? 'webhook_http_403' : null })));
async function open(role) {
  const context = await browser.newContext({ viewport: { width: 1560, height: 1050 } });
  const rows = seed(); const control = { missing: false, conflict: false, role, rows };
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push({ path: url.pathname, reason: 'external request blocked' }); return route.abort(); }
    if (url.pathname.startsWith('/console/')) return route.continue();
    if (url.pathname === '/health') return route.fulfill({ json: { status: 'ok' } });
    if (url.pathname === '/branding') return route.fulfill({ json: {} });
    if (url.pathname === '/admin/api/me') return route.fulfill({ json: { username: `synthetic-${role}`, role,
      perms: role === 'writer' ? ['runs:read', 'runs:write'] : ['runs:read'], capabilities: { modules: ['runs'] } } });
    if (url.pathname === '/admin/api/status') return route.fulfill({ json: { executors: [] } });
    if (url.pathname === '/admin/api/runs' || url.pathname === '/admin/api/threads') return route.fulfill({ json: [] });
    if (url.pathname === '/admin/api/conversation-audits') return route.fulfill({ json: { items: [], has_more: false, next_offset: null } });
    if (url.pathname.startsWith('/admin/api/notification-outbox')) {
      const record = { role, method: request.method(), path: url.pathname, query: Object.fromEntries(url.searchParams) };
      requests.push(record);
      if (control.missing) { record.response = 503; return route.fulfill({ status: 503, json: { error: 'notification_durability_unavailable' } }); }
      if (request.method() === 'GET') {
        const kind = url.searchParams.get('kind'); const status = url.searchParams.get('status');
        const available = rows.filter(row => row.kind === kind); const filtered = available.filter(row => !status || row.status === status);
        const counts = Object.fromEntries(statuses.map(value => [value, available.filter(row => row.status === value).length]));
        record.response = 200;
        return route.fulfill({ json: { capability: 'durable', items: filtered.slice(Number(url.searchParams.get('offset') ?? 0), 20),
          total: filtered.length, snapshot: { counts, oldestPendingAgeSeconds: 60, expiredLeases: 0 } } });
      }
      record.body = request.postDataJSON();
      if (role !== 'writer') { record.response = 403; return route.fulfill({ status: 403, json: { error: 'forbidden' } }); }
      const id = decodeURIComponent(url.pathname.split('/').at(-2)); const row = rows.find(value => value.event_id === id);
      if (control.conflict || !row || row.status !== record.body.expected_status) {
        record.response = 409; return route.fulfill({ status: 409, json: { error: 'notification_status_changed' } });
      }
      if (row.status === 'uncertain' && record.body.allow_uncertain !== true) {
        record.response = 409; return route.fulfill({ status: 409, json: { error: 'notification_uncertain_requires_confirmation' } });
      }
      row.status = 'pending'; record.response = 200;
      return route.fulfill({ json: { queued: true, event_id: id } });
    }
    unexpected.push({ method: request.method(), path: url.pathname });
    return route.fulfill({ status: 404, json: { error: 'unmocked_synthetic_request' } });
  });
  const page = await context.newPage(); currentPage = page;
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/console/runs`, { waitUntil: 'networkidle' });
  // Keep screenshots and successive confirmation dialogs deterministic without
  // changing the production component, its permission checks or its API calls.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await page.getByRole('tab', { name: '通知送达', exact: true }).click();
  await page.locator('.notification-panel .el-table').waitFor({ state: 'visible' });
  return { context, page, control, panel: page.locator('.notification-panel') };
}
async function choose(page, panel, index, label) {
  const before = requests.length;
  await panel.locator('.filters .el-select').nth(index).click();
  await page.getByRole('option', { name: label, exact: true }).filter({ visible: true }).click();
  await page.waitForFunction(() => !document.querySelector('.notification-panel .el-loading-mask') || getComputedStyle(document.querySelector('.notification-panel .el-loading-mask')).display === 'none');
  assert.ok(requests.length > before, `Filter ${label} did not request new data`);
}
const posts = () => requests.filter(request => request.method === 'POST');
try {
  const channel = process.env.PLAYWRIGHT_CHANNEL?.trim();
  browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  const read = await open('reader');
  assert.equal(await read.panel.getByRole('button', { name: /重新处理通知|核对后重新发送/ }).count(), 0);
  assert.equal(await read.panel.getByRole('columnheader', { name: '操作', exact: true }).count(), 0);
  assert.equal(await read.panel.locator('.totals').innerText(), '等待补发 1\n正在处理 1\n处理失败 1\n需核对 1');
  checks.push('runs:read can inspect summaries and cannot see mutation controls');
  await read.page.screenshot({ path: join(output, 'notification-reader.png'), fullPage: true, animations: 'disabled' });
  for (const [, label] of kinds.slice(1)) await choose(read.page, read.panel, 0, label);
  assert.deepEqual(requests.filter(request => request.role === 'reader').map(request => request.query.kind), kinds.map(([kind]) => kind));
  await choose(read.page, read.panel, 1, '需核对');
  assert.equal(await read.panel.locator('.el-table__body tbody tr').count(), 1);
  assert.equal(requests.at(-1).query.status, 'uncertain'); assert.equal(requests.at(-1).query.offset, '0');
  checks.push('all four kind filters and status filter request the correct summaries');
  assert.equal(posts().length, 0); await read.context.close();

  const write = await open('writer'); const { page, panel, control } = write;
  const failed = panel.getByRole('row').filter({ hasText: 'synthetic:callback:failed' });
  await failed.getByRole('button', { name: '重新处理通知', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '重新处理通知', exact: true });
  await dialog.getByText('原业务任务不会再次执行。', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: '重新处理', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('已加入通知处理队列', { exact: true }).waitFor();
  await failed.getByText('等待补发', { exact: true }).waitFor();
  assert.deepEqual(posts().at(-1).body, { kind: 'callback', expected_status: 'failed', allow_uncertain: false });
  checks.push('writer failed retry submits notification ID, expected status and no business rerun');

  const uncertain = panel.getByRole('row').filter({ hasText: 'synthetic:callback:uncertain' });
  await uncertain.getByRole('button', { name: '核对后重新发送', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '重新处理通知', exact: true });
  await dialog.getByText('继续可能产生重复消息。', { exact: false }).waitFor();
  await page.screenshot({ path: join(output, 'notification-uncertain-confirmation.png'), fullPage: true, animations: 'disabled' });
  const beforeCancel = posts().length;
  await dialog.getByRole('button', { name: '取消', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  assert.equal(posts().length, beforeCancel); checks.push('uncertain cancellation sends no POST');
  await uncertain.getByRole('button', { name: '核对后重新发送', exact: true }).click();
  await page.getByRole('dialog', { name: '重新处理通知', exact: true }).getByRole('button', { name: '已核对，仍需发送', exact: true }).click();
  await uncertain.getByText('等待补发', { exact: true }).waitFor();
  assert.deepEqual(posts().at(-1).body, { kind: 'callback', expected_status: 'uncertain', allow_uncertain: true });
  checks.push('uncertain retry requires explicit acknowledgement and sends allow_uncertain=true');

  await choose(page, panel, 0, '结果送达'); control.conflict = true;
  await panel.getByRole('row').filter({ hasText: 'synthetic:delivery:failed' }).getByRole('button', { name: '重新处理通知', exact: true }).click();
  await page.getByRole('dialog', { name: '重新处理通知', exact: true }).getByRole('button', { name: '重新处理', exact: true }).click();
  await page.getByText('未能加入队列，通知状态可能已变化，请刷新核对。', { exact: true }).waitFor();
  assert.equal(posts().at(-1).response, 409);
  assert.equal(control.rows.find(row => row.event_id === 'synthetic:delivery:failed').status, 'failed');
  checks.push('409 conflict displays failure without claiming successful replay');
  control.conflict = false; control.missing = true;
  await panel.getByRole('button', { name: '刷新通知', exact: true }).click();
  await panel.getByText('当前存储实现未提供这类通知的持久化能力。', { exact: true }).waitFor();
  assert.equal(await panel.locator('.el-table').count(), 0);
  await page.screenshot({ path: join(output, 'notification-capability-unavailable.png'), fullPage: true, animations: 'disabled' });
  checks.push('503 missing capability removes stale rows and displays the explicit capability boundary');
  control.missing = false;
  await panel.getByRole('button', { name: '刷新通知', exact: true }).click();
  await panel.locator('.el-table').waitFor({ state: 'visible' });
  await page.screenshot({ path: join(output, 'notification-writer.png'), fullPage: true, animations: 'disabled' });
  assert.ok(posts().every(request => /^\/admin\/api\/notification-outbox\/[^/]+\/retry$/.test(request.path)));
  assert.equal(posts().length, 3); assert.deepEqual(pageErrors, []); assert.deepEqual(unexpected, []);
  checks.push('all three mutations target only notification retry; no parent task endpoint, browser error or external request');
  await write.context.close(); report.passed = true;
  console.log(`Notification console regression passed (${checks.length} checks, ${posts().length} synthetic notification retries)`);
} catch (error) {
  report.error = String(error?.stack ?? error); process.exitCode = 1;
  if (currentPage && !currentPage.isClosed()) await currentPage.screenshot({ path: join(output, 'notification-failure.png'), fullPage: true, animations: 'disabled' }).catch(() => undefined);
  console.error(report.error);
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  writeFileSync(join(output, 'notification-console-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (!retained) rmSync(output, { recursive: true, force: true });
}
