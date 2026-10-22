import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

// Synthetic console/API only. No deployed hub, business writes or approval decisions are used.
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
const pageErrors = [];
let mutations = 0;
const created = '2026-10-21T01:00:00.000Z';
const fullArgs = JSON.stringify({ source: { html: '<p>合成完整页面</p>' + 'x'.repeat(256 * 1024), css: 'body{}' } });
function row(id, hash = 'a'.repeat(64)) {
  return { id, job_id: `fixture-job-${id}`, provider: 'fixture-business', tool: 'shop_ai_decoration_save',
    summary: `合成审批 ${id}`, status: 'pending', risk: 'high', args_hash: hash,
    args_preview: '{"source":{"html":"仅为预览，不可当全文', args_bytes: Buffer.byteLength(fullArgs),
    args_truncated: true, details_available: true, created_at: created, continuation_mode: 'manual' };
}
function detail(value) {
  return { ...value, args_json: fullArgs, intent: { args: JSON.parse(fullArgs), scope: 'fixture.write' },
    args_truncated: false, details_available: false };
}
async function scenario(viewer = false) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.clock.install();
  let firstDetailFails = !viewer, listReads = 0;
  let hash = 'a'.repeat(64), detailReads = 0, releaseDelayed;
  const delayed = new Promise(done => { releaseDelayed = done; });
  const rows = () => [row(101, hash), row(102), { ...row(103), summary: '小快照兼容', args_json: '{}',
    args_preview: undefined, args_truncated: false, args_bytes: 2, details_available: false }];
  await context.route('**/health', route => route.fulfill({ json: { status: 'ok' } }));
  await context.route('**/admin/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (route.request().method() !== 'GET') { mutations++; throw new Error('No mutation expected'); }
    if (path === '/admin/api/me') return route.fulfill({ json: { username: 'fixture-reader',
      perms: viewer ? ['runs:read'] : ['*'], role: viewer ? 'viewer' : 'admin' } });
    if (path === '/admin/api/tool-approvals') { listReads++; return route.fulfill({ json: rows() }); }
    const match = path.match(/^\/admin\/api\/tool-approvals\/(\d+)\/details$/);
    if (match) {
      detailReads++;
      const id = Number(match[1]), snapshot = rows().find(item => item.id === id);
      if (id === 102) await delayed;
      if (firstDetailFails) { firstDetailFails = false; return route.fulfill({ status: 503, json: { error: 'fixture_read_failure' } }); }
      return route.fulfill({ json: detail(snapshot) });
    }
    if (path === '/admin/api/instance-branding') return route.fulfill({ json: {} });
    return route.fulfill({ json: [] });
  });
  const tableRow = id => page.locator('.el-table__row').filter({ hasText: `合成审批 ${id}` });
  const expand = id => tableRow(id).locator('.el-table__expand-icon').click();
  const pane = () => page.locator('.el-table__expanded-cell .intent').filter({ visible: true });
  await page.goto(`${base}/console/approvals`);
  await tableRow(101).waitFor();
  assert.equal(detailReads, 0, 'list load must not fetch full snapshots');
  if (viewer) {
    assert.equal(await page.getByRole('button', { name: '兜底批准', exact: true }).count(), 0);
    await expand(101);
    await pane().getByText('完整参数快照', { exact: false }).first().waitFor();
    assert.equal(detailReads, 1, 'runs:read permits one explicit detail read');
    releaseDelayed(); await context.close(); return;
  }
  assert.equal(await tableRow(101).getByRole('button', { name: '兜底批准', exact: true }).isDisabled(), true);
  const small = page.locator('.el-table__row').filter({ hasText: '小快照兼容' });
  assert.equal(await small.getByRole('button', { name: '兜底批准', exact: true }).isEnabled(), true);
  await expand(101);
  await pane().getByText('完整快照读取失败，当前仅显示预览；请重试。', { exact: true }).waitFor();
  assert.equal(detailReads, 1);
  assert.equal(await pane().getByText('完整参数快照', { exact: false }).count(), 0);
  assert.equal(await tableRow(101).getByRole('button', { name: '兜底批准', exact: true }).isDisabled(), true);
  await pane().getByRole('button', { name: '重试读取完整快照', exact: true }).click();
  await pane().getByText('完整参数快照', { exact: false }).first().waitFor();
  assert.equal(detailReads, 2);
  assert.equal(await tableRow(101).getByRole('button', { name: '兜底批准', exact: true }).isEnabled(), true);
  const beforePoll = listReads;
  const pollResponse = page.waitForResponse(response => response.url().includes('/admin/api/tool-approvals?'));
  await page.clock.fastForward(30_100);
  await pollResponse;
  assert.ok(listReads > beforePoll, 'light polling remains active');
  assert.equal(detailReads, 2, 'polling must not redownload the expanded full snapshot');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await pane().getByText('完整参数快照', { exact: false }).first().waitFor();
  assert.equal(detailReads, 2, 'manual list refresh also reuses the same immutable snapshot');
  // Switching to a different expanded row invalidates the previous owner.
  const delayedRequest = page.waitForRequest(request => request.url().endsWith('/102/details'));
  await expand(102);
  await pane().getByText('参数预览', { exact: false }).waitFor();
  await delayedRequest;
  await expand(101);
  await pane().getByText('完整参数快照', { exact: false }).first().waitFor();
  const lateResponse = page.waitForResponse(response => response.url().endsWith('/102/details'));
  releaseDelayed(); await lateResponse;
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(await tableRow(101).getByRole('button', { name: '兜底批准', exact: true }).isEnabled(), true);
  assert.equal(await tableRow(102).getByRole('button', { name: '兜底批准', exact: true }).isDisabled(), true);
  assert.equal(await pane().count(), 1, 'only one full payload is retained/rendered at a time');
  const beforeHashChange = detailReads;
  hash = 'b'.repeat(64);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await pane().getByText('参数预览', { exact: false }).waitFor();
  assert.equal(detailReads, beforeHashChange, 'changed snapshot must not auto-fetch full detail');
  assert.equal(await tableRow(101).getByRole('button', { name: '兜底批准', exact: true }).isDisabled(), true);
  await pane().getByRole('button', { name: '读取完整快照', exact: true }).click();
  await pane().getByText('完整参数快照', { exact: false }).first().waitFor();
  assert.equal(detailReads, beforeHashChange + 1);
  await page.locator('.el-radio-group').getByText('全部', { exact: true }).click();
  await tableRow(101).waitFor();
  assert.equal(await pane().count(), 0, 'filter change discards expanded full content');
  assert.equal(detailReads, beforeHashChange + 1);
  await context.close();
}
try {
  await scenario(false);
  await scenario(true);
  assert.equal(mutations, 0);
  assert.deepEqual(pageErrors, []);
  console.log('✓ approval details: bounded preview labels, explicit full read, retry, no full polling, single expanded owner, late response/hash/filter protection, viewer permissions and small-snapshot compatibility');
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}
