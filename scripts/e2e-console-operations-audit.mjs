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

const failures = [];
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(8000);
page.on('pageerror', e => failures.push(e.message));
let adminWrites = 0, adminReadFail = false, costFail = true;
let pendingCost, pendingSummary, pendingRequests, pendingMember;
let deferCost = false, deferSummary = false, deferRequests = false, deferMember = false;
const account = id => ({id, label: `账户-${id}`, kind: 'organization', state: 'active'});
const summary = id => ({ accountId: id, grant: null, plan: null, availableUsd: 0, consumedUsd: 0, currentPeriodConsumedUsd: 0, overageUsd: 0, pendingRequests: 0, resetAt: null, expiresAt: null });
const cost = days => ({ days, total: { jobs: days, cost_usd: days, tokens: days }, by_day: [], by_target: [], by_route: [] });
await context.route('**/health', r => r.fulfill({json: {status:'ok', configBackend:true, queue:{}}}));
await context.route('**/branding', r => r.fulfill({status:404, json:{}}));
await context.route('**/admin/api/**', async r => {
  const u = new URL(r.request().url()), path = u.pathname, method = r.request().method();
  const json = v => r.fulfill({json:v});
  const fail = v => r.fulfill({status:503,json:{error:v}});
  if (path.endsWith('/me')) return json({username:'fixture-admin',role:'admin',perms:['*']});
  if (path === '/admin/api/admins') {
    if(method === 'POST') { adminWrites++;adminReadFail = true;return json({username:'fixture-new',generated_password:'fixture-generated-only-once'}); }
    return adminReadFail ? fail('fixture_refresh_failed') : json({list:[],roles:['admin','viewer']});
  }
  if (path === '/admin/api/cost') {
    if(costFail) return fail('fixture_cost_failed');
    if(deferCost && u.searchParams.get('days') === '7') { pendingCost = () => json(cost(7));return; }
    return json(cost(Number(u.searchParams.get('days'))));
  }
  if(path === '/admin/api/usage/accounts') return json({items:['a','b'].map(account), next_cursor:null});
  if(path === '/admin/api/usage/billing/plans') return json({items:[],billing_ready:true,period_allowance_supported:true});
  if(path === '/admin/api/usage/services' || path === '/admin/api/usage/issuers') return json({items:[]});
  const s = path.match(/\/billing\/accounts\/(a|b)\/summary$/);
  if(s) {
    if(deferSummary && s[1] === 'a') {pendingSummary = () => fail('STALE_SUMMARY_FAILURE');return;}
    return json(summary(s[1]));
  }
  const q = path.match(/\/billing\/accounts\/(a|b)\/requests$/);
  if(q) {
    if(deferRequests && q[1] === 'a') {pendingRequests = () => fail('STALE_REQUEST_FAILURE');return;}
    return json({items:[],next_cursor:null});
  }
  const m = path.match(/\/usage\/accounts\/(a|b)$/);
  if(m) {
    if(deferMember && m[1] === 'a') {pendingMember = () => fail('STALE_MEMBER_FAILURE');return;}
    return json({account:account(m[1]),members:[]});
  }
  if(path.endsWith('/capabilities'))return json({});
  if(path.endsWith('/status'))return json({executors:[]});
  if(path.startsWith('/admin/api/config-schemas/'))return json({required:[],properties:{}});
  assert.equal(method,'GET',`Unexpected mutation ${method} ${path}`);
  return json([]);
});
async function until(check) {
  for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}
  throw new Error('Fixture request not reached');
}
async function closeDrawer() {
  await page.locator('.el-drawer__close-btn:visible').click();
  await page.locator('.el-drawer:visible').waitFor({state:'hidden'});
  await page.locator('.el-overlay:visible').first().waitFor({state:'hidden'});
}
try {
  await page.goto(`${base}/console/accounts`);
  await page.getByRole('button',{name:'新建账号',exact:true}).click();
  let drawer = page.getByRole('dialog',{name:'新建账号',exact:true});
  await drawer.getByPlaceholder('如 ops-admin').fill('fixture-new');
  await drawer.getByRole('button',{name:'取消',exact:true}).click();
  await page.locator('.el-message-box').getByRole('button',{name:'继续编辑',exact:true}).click();
  assert.equal(await drawer.getByPlaceholder('如 ops-admin').inputValue(),'fixture-new');
  await drawer.getByRole('button',{name:'保存',exact:true}).click();
  await page.locator('.el-message-box').getByText('fixture-generated-only-once',{exact:false}).waitFor();
  await page.getByText('fixture_refresh_failed',{exact:true}).waitFor();
  assert.equal(adminWrites,1);
  await page.locator('.el-message-box__headerbtn').click();
  await page.locator('.el-overlay:visible').first().waitFor({state:'hidden'});

  await page.goto(`${base}/console/cost`);
  await page.getByText('成本数据读取失败',{exact:true}).waitFor();
  assert.equal(await page.locator('.overview').count(),0,'failed read must not show zero cost');
  costFail=false;
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.locator('.metric.primary').getByText('30 天窗口',{exact:true}).waitFor();
  deferCost=true;
  await page.locator('.head .el-select').click();
  await page.getByRole('option',{name:'近 7 天',exact:true}).click();
  await until(()=>pendingCost);
  await page.locator('.head .el-select').click();
  await page.getByRole('option',{name:'近 90 天',exact:true}).click();
  await page.locator('.metric.primary').getByText('90 天窗口',{exact:true}).waitFor();
  await pendingCost();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.locator('.metric.primary em').innerText(),'90 天窗口');
  costFail=true;
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('以下为上次读取的 90 天旧快照',{exact:false}).waitFor();

  await page.goto(`${base}/console/usage`);
  await page.getByRole('tab',{name:'账户用量',exact:true}).click();
  deferSummary=true;
  await page.getByRole('button',{name:'账户-a',exact:true}).click();
  await until(()=>pendingSummary);
  await closeDrawer();
  await page.getByRole('button',{name:'账户-b',exact:true}).click();
  await page.getByRole('dialog',{name:'账户-b',exact:true}).getByRole('heading',{name:'尚未开通套餐',exact:true}).waitFor();
  await pendingSummary();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.getByText('STALE_SUMMARY_FAILURE',{exact:false}).count(),0);
  await closeDrawer();
  deferSummary=false;deferRequests=true;
  await page.getByRole('button',{name:'账户-a',exact:true}).click();
  await until(()=>pendingRequests);
  await closeDrawer();
  await page.getByRole('button',{name:'账户-b',exact:true}).click();
  await page.getByRole('dialog',{name:'账户-b',exact:true}).getByRole('heading',{name:'尚未开通套餐',exact:true}).waitFor();
  await pendingRequests();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.getByText('STALE_REQUEST_FAILURE',{exact:false}).count(),0);

  await page.goto(`${base}/console/usage-access?tab=accounts`);
  deferMember=true;
  await page.getByRole('button',{name:'账户-a',exact:true}).click();
  await until(()=>pendingMember);
  await closeDrawer();
  await page.getByRole('button',{name:'账户-b',exact:true}).click();
  await page.getByRole('dialog',{name:'账户-b',exact:true}).waitFor();
  await pendingMember();
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await page.getByText('STALE_MEMBER_FAILURE',{exact:false}).count(),0);
  assert.deepEqual(failures,[]);
  console.log('✓ admin password survives failed refresh; draft protection; cost failures/race; account detail ownership');
} finally {
  await browser.close(); await new Promise(r=>server.close(r));
}
