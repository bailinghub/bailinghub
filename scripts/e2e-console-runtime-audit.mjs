import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { chromium } from 'playwright';

// Synthetic server and intercepted API only. Never contacts a deployed hub.
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
const now = new Date().toISOString();
const failures = [];
let writes = 0;
async function scenario(readonly = false) {
  const context = await browser.newContext();
  let tokenFails = false, dispatchFails = false, saveFails = false, revealReads = 0, releaseFirstToken;
  const firstTokenGate = new Promise(done => { releaseFirstToken = done; });
  let releaseChannelWrite, releaseRuleWrite;
  const channelWriteGate = new Promise(done => { releaseChannelWrite = done; });
  const ruleWriteGate = new Promise(done => { releaseRuleWrite = done; });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => failures.push(error.message));
  await context.route('**/health', route => route.fulfill({ json: { status: 'ok', configBackend: true, queue: {} } }));
  await context.route('**/admin/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    const json = value => route.fulfill({ json: value });
    const fail = message => route.fulfill({ status: 503, json: { error: message } });
    if (path === '/admin/api/me') return json({ username: readonly ? 'reader' : 'operator', role: readonly ? 'viewer' : 'admin', perms: readonly ? ['runs:read', 'channels:read'] : ['*'] });
    if (path === '/admin/api/executor-tokens') {
      if (method !== 'GET') { writes++; return saveFails ? fail('fixture_save_failed') : json({ token: 'demo-not-a-real-token' }); }
      return tokenFails ? fail('fixture_token_read_failed') : json([{ name: 'fixture-worker', token: '****', enabled: true, allowed_targets: ['fixture-target'], description: '测试令牌' }]);
    }
    if (path === '/admin/api/dispatch-status') return dispatchFails ? fail('fixture_dispatch_read_failed') : json({ now, summary: { queued: 2, running: 0, dispatched: 0, delayed_queued: 0, expired_leases: 0, blocked_threads: 0 }, by_target: [], leases: [], blocked_threads: [] });
    if (path === '/admin/api/executors') return json([{ executor_id: 'fixture-worker-online', online: true, targets: ['fixture-target'], last_seen_at: now, capabilities: {} }]);
    if (path === '/admin/api/channels') {
      if (method !== 'GET') { writes++; await channelWriteGate; return fail('fixture_channel_save_failed'); }
      return json([{ name: 'fixture-channel', kind: 'wecom', route_key: 'fixture-route', enabled: true, config: { corpid: 'fixture', agentid: '1', has_secret: true } }]);
    }
    if (path === '/admin/api/alert-rules') {
      if (method !== 'GET') { writes++; await ruleWriteGate; return fail('fixture_rule_save_failed'); }
      return json([{ id: 1, channel: 'fixture-channel', event_prefix: 'executor_offline', recipients: ['fixture-operator'], enabled: true, cooldown_min: 30 }]);
    }
    if (path === '/admin/api/clients') return json(['a', 'b'].map(id => ({ app_id: `fixture-${id}`, name: `接入方 ${id.toUpperCase()}`, allowed_channels: ['fixture-channel'] })));
    if (/^\/admin\/api\/clients\/fixture-[ab]\/token$/.test(path)) {
      revealReads++;
      if (path.includes('fixture-a/')) await firstTokenGate;
      return json({ token: path.includes('fixture-a/') ? 'demo-token-A' : 'demo-token-B' });
    }
    if (path === '/admin/api/targets') { assert.equal(readonly, false, 'viewer must not request unavailable target directory'); return json([{ name: 'fixture-target', kind: 'executor' }]); }
    if (path.startsWith('/admin/api/config-schemas/')) return json({ required: [], properties: {} });
    if (path === '/admin/api/status') return json({ executors: [] });
    if (path === '/admin/api/capabilities') return json({});
    if (path === '/admin/api/instance-branding') return json({});
    if (method !== 'GET') { writes++; throw new Error(`Unexpected mutation ${method} ${path}`); }
    return json([]);
  });
  const tokens = () => page.locator('#executor-tokens');
  const dispatch = () => page.locator('#dispatch');
  const drawer = () => page.getByRole('dialog', { name: '编辑令牌', exact: true });
  await page.goto(`${base}/console/executors`);
  await tokens().getByText('fixture-worker', { exact: true }).waitFor();
  await dispatch().locator('.dispatchStats').waitFor();
  if (readonly) {
    for (const name of ['签发令牌', '复制完整令牌', '编辑', '注销']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `viewer saw ${name}`);
    await page.goto(`${base}/console/channels`);
    await page.getByText('fixture-channel', { exact: true }).first().waitFor();
    for (const name of ['新建渠道', '新建规则', '编辑', '删']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, `channel reader saw ${name}`);
    await page.getByRole('button', { name: '调用代码', exact: true }).click();
    await page.getByText('当前账号不能读取接入方目录；代码保留 token 占位，请由管理员核对推送授权。', { exact: true }).waitFor();
    assert.equal(await page.getByText('还没有接入方被授权推送', { exact: false }).count(), 0, 'missing directory permission is not no authorization');
    assert.equal(revealReads, 0);
    releaseFirstToken(); await context.close(); return;
  }
  // First-load failure must not be described as an empty registry or a healthy zero queue.
  tokenFails = dispatchFails = true;
  await page.reload();
  await tokens().getByText('令牌读取失败', { exact: true }).waitFor();
  await dispatch().getByText('调度租约读取失败', { exact: true }).waitFor();
  assert.equal(await tokens().getByText('还没有执行器令牌。', { exact: false }).count(), 0);
  assert.equal(await dispatch().locator('.dispatchStats').count(), 0);
  assert.equal(await dispatch().getByText('暂无在途租约', { exact: true }).count(), 0);
  // Retry restores normal data; later failures retain and explicitly label the old snapshot.
  tokenFails = dispatchFails = false;
  await tokens().getByRole('button', { name: '刷新令牌', exact: true }).click();
  await dispatch().getByRole('button', { name: '刷新', exact: true }).click();
  await tokens().getByText('fixture-worker', { exact: true }).waitFor();
  await dispatch().locator('.dispatchStats').waitFor();
  tokenFails = dispatchFails = true;
  await tokens().getByRole('button', { name: '刷新令牌', exact: true }).click();
  await dispatch().getByRole('button', { name: '刷新', exact: true }).click();
  await tokens().getByText('以下为上次读取的旧快照', { exact: false }).waitFor();
  await dispatch().getByText('以下为上次读取的旧快照', { exact: false }).waitFor();
  assert.equal(await tokens().getByRole('button', { name: '编辑', exact: true }).isEnabled(), false);
  tokenFails = dispatchFails = false;
  await tokens().getByRole('button', { name: '刷新令牌', exact: true }).click();
  await tokens().getByRole('button', { name: '编辑', exact: true }).click();
  const description = drawer().getByPlaceholder('如 开发环境 worker / 合作方执行器', { exact: true });
  await description.fill('保留这一段修改');
  await drawer().getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('.el-message-box').getByRole('button', { name: '继续编辑', exact: true }).click();
  assert.equal(await description.inputValue(), '保留这一段修改');
  saveFails = true;
  await drawer().getByRole('button', { name: '保存', exact: true }).click();
  await drawer().getByText('fixture_save_failed', { exact: true }).waitFor();
  assert.equal(await description.inputValue(), '保留这一段修改');
  await drawer().locator('.el-drawer__close-btn').click();
  await page.locator('.el-message-box').getByRole('button', { name: '放弃修改', exact: true }).click();
  await drawer().waitFor({ state: 'hidden' });
  // Channel code must not combine B's selected identity with A's delayed credential.
  await page.goto(`${base}/console/channels`);
  await page.getByRole('button', { name: '调用代码', exact: true }).click();
  const code = page.getByRole('dialog', { name: '调用代码 · 经「fixture-channel」渠道主动推消息', exact: true });
  await code.getByText('正在读取所选接入方凭证，代码暂用占位符。', { exact: true }).waitFor();
  await code.locator('.code-context-select .el-select__wrapper').click();
  await page.getByRole('option', { name: '接入方 B（fixture-b）', exact: true }).click();
  await code.locator('.snippet-code').first().filter({ hasText: 'demo-token-B' }).waitFor();
  const firstTokenResponse = page.waitForResponse(response => response.url().endsWith('/admin/api/clients/fixture-a/token'));
  releaseFirstToken();
  await firstTokenResponse;
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await code.locator('.snippet-code').first().textContent().then(text => text.includes('demo-token-A')), false);
  assert.equal(await code.locator('.snippet-code').first().textContent().then(text => text.includes('demo-token-B')), true);
  assert.equal(revealReads, 2);
  await code.locator('.el-dialog__headerbtn').click();
  await code.waitFor({ state: 'hidden' });
  // Both channel and alert-rule editors keep drafts on cancel/failed saves,
  // and cannot be edited or dismissed (X, backdrop, Escape) while saving.
  for (const isRule of [false, true]) {
    const scope = isRule ? page.locator('#alert-rules') : page.locator('.el-card').first();
    await scope.getByRole('button', { name: '编辑', exact: true }).click();
    const editor = page.getByRole('dialog', { name: isRule ? '编辑告警规则' : '编辑渠道', exact: true });
    if (!isRule) await editor.getByRole('tab', { name: '发布', exact: true }).click();
    const notes = isRule ? editor.getByRole('textbox', { name: '说明（可选）', exact: true }) : editor.getByRole('tabpanel', { name: '发布', exact: true }).getByRole('textbox');
    const draft = isRule ? '保留告警草稿' : '保留渠道草稿';
    await notes.fill(draft);
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.el-message-box').getByRole('button', { name: '继续编辑', exact: true }).click();
    assert.equal(await notes.inputValue(), draft);
    const saveRequest = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(isRule ? '/admin/api/alert-rules' : '/admin/api/channels'));
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await saveRequest;
    assert.equal(await notes.isDisabled(), true, 'saving must lock editor inputs');
    assert.equal(await editor.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
    await editor.locator('.el-drawer__close-btn').click();
    assert.equal(await editor.isVisible(), true, 'saving must block X');
    await page.locator('.el-overlay').filter({ has: editor }).click({ position: { x: 5, y: 5 } });
    assert.equal(await editor.isVisible(), true, 'saving must block backdrop');
    await page.keyboard.press('Escape');
    assert.equal(await editor.isVisible(), true, 'saving must block Escape');
    if (isRule) releaseRuleWrite(); else releaseChannelWrite();
    await editor.getByText(isRule ? 'fixture_rule_save_failed' : 'fixture_channel_save_failed', { exact: true }).waitFor();
    assert.equal(await notes.inputValue(), draft, 'failed save must retain draft');
    assert.equal(await notes.isEnabled(), true, 'failed save must allow retry');
    await editor.locator('.el-drawer__close-btn').click();
    await page.locator('.el-message-box').getByRole('button', { name: '放弃修改', exact: true }).click();
    await editor.waitFor({ state: 'hidden' });
  }
  await context.close();
}
try {
  await scenario(true);
  await scenario(false);
  assert.equal(writes, 3, 'only the three deliberate failed fixture saves should write');
  assert.deepEqual(failures, []);
  console.log('✓ executor final audit: read-only permissions, honest failed reads/retry/stale snapshots, drawer draft protection/save error retention, channel read-only boundaries, credential response ownership and both channel/rule drawer draft/busy/error protections');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
