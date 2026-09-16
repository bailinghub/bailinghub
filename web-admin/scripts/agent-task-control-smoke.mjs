import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Local synthetic HTTP only. Build into a disposable directory before running this script.
const buildDir = resolve(process.argv[2] || '/tmp/bailinghub-task-control-ui-20260916/build');
const evidenceDir = resolve(process.argv[3] || '/tmp/bailinghub-task-control-ui-20260916/screenshots');
assert.ok(existsSync(join(buildDir, 'index.html')), 'Build the console first');
mkdirSync(evidenceDir, { recursive: true });
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const taskId = '33333333-3333-4333-8333-333333333333';
const sessions = ids.map((session_id, index) => ({ session_id, client_app_id: index ? 'inventory-app' : 'shop-app', device_label: '示例设备',
  allowed_routes: [index ? 'inventory' : 'shop'], subject_display: { name: index ? '示例库存' : '示例商城' }, subject_display_status: 'provided' }));
const members = sessions.map((s, index) => ({ session_id: s.session_id, client_app_id: s.client_app_id, workspace: s.allowed_routes[0],
  client_conversation_id: 'example-conversation', allowed_tools: [index ? 'inventory_read' : 'product_update'] }));
let task = { schema_version: 'bailing.agent-task.v1', task_id: taskId, state: 'active', revision: 1, ledger_sequence: 7, scope_hash: 'a'.repeat(64), members,
  policy: { max_write_calls: 20, max_concurrent: 2, expires_at: null }, counters: { write_reserved: 1, write_consumed: 3, active_permits: 1 },
  created_at: '2026-09-16T01:00:00.000Z', updated_at: '2026-09-16T01:10:00.000Z' };
const invocations = [{ session_id: ids[0], invocation_id: 'b'.repeat(64), run_id: ids[1], job_id: ids[0], tool: 'product_update',
  readonly: false, budget_state: 'reserved', permit_state: 'unknown', outcome: 'unknown', terminal: false, attempt: 1 }];
const requests = [], createBodies = [], controlBodies = [];
let readOnly = false, firstCreate = true, conflict = true;
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  requests.push({ path: url.pathname, method: req.method });
  if (url.pathname === '/branding') return json(res, {}, 404);
  if (url.pathname === '/health') return json(res, { status: 'ok' });
  if (url.pathname === '/admin/api/me') return json(res, { username: 'example-administrator', role: 'admin', perms: readOnly ? ['clients:read'] : ['clients:read', 'clients:write'], capabilities: { modules: ['agent-clients', 'agent-tasks'] } });
  if (url.pathname === '/admin/api/agent-clients/sessions') return json(res, { list: sessions, total: sessions.length });
  if (url.pathname === '/admin/api/agent-clients/overview') return json(res, { workspaces: [{ route: 'shop', name: '商城' }, { route: 'inventory', name: '库存' }], applications: [], summary: {} });
  if (url.pathname === '/admin/api/agent-tasks' && req.method === 'GET') return json(res, { items: [task], next_cursor: null });
  if (url.pathname === '/admin/api/agent-tasks' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    createBodies.push(JSON.parse(body));
    if (firstCreate) { firstCreate = false; return json(res, { error: 'TASK_UNAVAILABLE' }, 503); }
    return json(res, task);
  }
  if (url.pathname === `/admin/api/agent-tasks/${taskId}`) return json(res, { task, invocations, next_cursor: null });
  if (url.pathname === `/admin/api/agent-tasks/${taskId}/control`) {
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body); controlBodies.push(parsed);
    if (conflict) { conflict = false; task = { ...task, revision: 2 }; return json(res, { error: 'TASK_REVISION_CONFLICT' }, 409); }
    assert.equal(parsed.expected_revision, task.revision);
    task = { ...task, state: parsed.action === 'pause' ? 'paused' : parsed.action === 'resume' ? 'active' : 'cancelled', revision: task.revision + 1 };
    return json(res, task);
  }
  if (url.pathname.startsWith('/admin/')) return json(res, {}, 404);
  const relative = url.pathname.replace(/^\/console\/?/, '');
  const requested = resolve(buildDir, relative || 'index.html');
  if (!requested.startsWith(`${buildDir}/`)) return json(res, {}, 404);
  const file = existsSync(requested) ? requested : join(buildDir, 'index.html');
  res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const url = `http://127.0.0.1:${server.address().port}/console/agent-tasks`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1512, height: 1050 } });
  page.setDefaultTimeout(8000);
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(url); await page.getByRole('heading', { name: '任务控制', exact: true }).waitFor();
  await page.getByRole('button', { name: '33333333…3333' }).waitFor();
  await page.getByText('运行可用', { exact: true }).waitFor();
  await page.screenshot({ path: join(evidenceDir, 'task-list.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.getByRole('button', { name: '创建受控任务' }).count(), 1);
  await page.getByRole('button', { name: '创建受控任务' }).click();
  const dialog = page.getByRole('dialog', { name: '创建受控任务' });
  await dialog.getByText('此设置会持续约束所选原授权').waitFor();
  assert.equal(await dialog.getByRole('button', { name: '确认范围并创建' }).isDisabled(), true);
  await dialog.locator('.member-editor .el-select').first().click();
  await page.getByRole('option', { name: /示例商城/ }).click();
  await dialog.locator('.member-editor .el-select').nth(1).click();
  await page.getByRole('option', { name: '商城（shop）', exact: true }).click();
  await dialog.getByLabel('本地会话 ID').fill('example-conversation');
  await dialog.getByLabel('允许的精确工具名称').fill('product_update\ninventory_read');
  await dialog.getByPlaceholder('填写次数').fill('20');
  await dialog.getByText('我已确认客户端支持任务绑定，并理解原授权在其他会话中的持续约束。', { exact: true }).click();
  await page.screenshot({ path: join(evidenceDir, 'task-create.png'), fullPage: true, animations: 'disabled' });
  await dialog.getByRole('button', { name: '确认范围并创建' }).click();
  await dialog.getByText(/原请求已保留，可重试核对结果/).waitFor();
  assert.equal(createBodies.length, 1);
  assert.equal(await dialog.getByLabel('本地会话 ID').isDisabled(), true);
  await page.reload(); await page.getByRole('button', { name: '继续原创建' }).click();
  await page.getByRole('button', { name: '重试原创建请求' }).click();
  await page.getByRole('heading', { name: '受控任务详情' }).waitFor();
  await page.getByText('结果未知，保留占用', { exact: false }).waitFor();
  assert.equal(createBodies.length, 2); assert.deepEqual(createBodies[0], createBodies[1]);
  assert.equal(createBodies[0].members[0].session_id, ids[0]); assert.equal(createBodies[0].policy.max_write_calls, 20);
  await page.locator('.el-message').waitFor({ state: 'hidden' });
  await page.screenshot({ path: join(evidenceDir, 'task-detail.png'), fullPage: true, animations: 'disabled' });
  const drawer = page.getByRole('dialog', { name: '受控任务详情' });
  await drawer.locator('.el-table__expand-icon').click();
  await drawer.locator('.el-drawer__body').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: join(evidenceDir, 'task-invocations.png'), fullPage: true, animations: 'disabled' });
  await drawer.getByRole('button', { name: '暂停', exact: true }).click(); await page.getByRole('button', { name: '确认', exact: true }).click();
  await drawer.getByText(/TASK_REVISION_CONFLICT/).waitFor();
  assert.equal(controlBodies.length, 1, 'A CAS conflict must not auto-resubmit');
  await drawer.getByRole('button', { name: '暂停', exact: true }).click(); await page.getByRole('button', { name: '确认', exact: true }).click();
  await drawer.getByText('已暂停', { exact: true }).waitFor();
  assert.equal(controlBodies[1].expected_revision, 2); assert.notEqual(controlBodies[0].request_id, controlBodies[1].request_id);
  await drawer.getByRole('button', { name: '继续', exact: true }).click(); await page.getByRole('button', { name: '确认', exact: true }).click();
  await drawer.getByText('运行可用', { exact: true }).waitFor();
  assert.equal(controlBodies[2].action, 'resume');
  await drawer.getByRole('button', { name: '取消任务', exact: true }).click(); await page.getByRole('button', { name: '确认', exact: true }).click();
  await drawer.getByText('已取消', { exact: true }).waitFor();
  assert.equal(await drawer.getByRole('button', { name: '继续', exact: true }).isDisabled(), true);
  assert.equal(await drawer.getByRole('button', { name: '取消任务', exact: true }).isDisabled(), true);
  assert.ok(!requests.some((request) => /tool-invocations|\/resume|\/invoke/.test(request.path)), 'Admin observation and controls never resume a business invocation');
  readOnly = true; const observer = await browser.newPage(); await observer.goto(url);
  await observer.getByRole('button', { name: '33333333…3333' }).waitFor();
  assert.equal(await observer.getByRole('button', { name: '创建受控任务' }).count(), 0);
  await observer.getByRole('button', { name: '33333333…3333' }).click(); await observer.getByRole('heading', { name: '受控任务详情' }).waitFor();
  assert.equal(await observer.getByRole('button', { name: '取消任务', exact: true }).count(), 0);
  assert.deepEqual(pageErrors, []);
  console.log('Task UI smoke passed: exact member selection, sticky confirmation, stable create retry after reload, CAS refresh without replay, terminal controls, read-only permissions and zero business dispatch.');
} finally { await browser.close(); await new Promise((done) => server.close(done)); }
