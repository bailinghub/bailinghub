import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const consoleDir = join(root, 'web', 'console');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

if (!existsSync(join(consoleDir, 'index.html'))) {
  throw new Error('web/console/index.html 不存在，请先执行：cd web-admin && npm run build');
}

function serveStatic(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const rel = url.pathname.replace(/^\/console\/?/, '');
  let file = resolve(consoleDir, rel || 'index.html');
  if (!file.startsWith(consoleDir)) {
    res.writeHead(404); res.end('not found'); return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(consoleDir, 'index.html');
  res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream' });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function expectVisible(page, text) {
  await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 8000 });
}

const fixtures = {
  credentials: [{ name: 'demo-llm', kind: 'chat', enabled: true }],
  targets: [{ name: 'demo-agent', kind: 'inhub', stateless: true, enabled: true, description: 'demo target' }],
  providers: [{ name: 'demo-business', base_url: 'http://demo-business:19080', enabled: true, has_spec: true, spec_source: 'url', authz_probe: { status: 'pass' } }],
  clients: [{ app_id: 'demo-app', name: 'Demo 业务系统', token: '****oken', allowed_routes: ['demo_support'], allowed_channels: [], rate_limit_per_min: 60, enabled: true }],
  routes: [{ route_key: 'demo_support', name: 'Demo 售后助手', target: 'demo-agent', enabled: true, tools: { sources: [{ provider: 'demo-business', allow: ['demo.*'] }], max_calls: 5 } }],
  runs: [{ job_id: '00000000-0000-4000-8000-000000000001', request_id: 'demo-e2e', status: 'done', route: 'demo_support', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
  threads: [{
    thread_id: 1,
    scope_key: 'client:demo-app:visitor-001',
    channel: 'hub',
    client_name: 'Demo 业务系统',
    principal_id: 'visitor:visitor-001',
    route_name: 'Demo 售后助手',
    last_preview: '查询订单 SO-1001',
    last_active_at: new Date().toISOString(),
    message_count: 2,
  }],
};

function tracePayload() {
  return {
    job: { ...fixtures.runs[0], target: 'demo-agent', usage: { duration_ms: 1200, tokens: 0 }, dispatch: { tools: { sources: [{ provider: 'demo-business', allow: ['demo.*'] }] } } },
    trace: {
      summary: { tool_results: 1, warning_count: 0, error_count: 0 },
      events: [
        { ts: new Date().toISOString(), event: 'tool_result', stage: 'tool', severity: 'info', title: '工具返回', summary: 'list_demo_orders', detail: { tool: 'list_demo_orders' } },
        { ts: new Date().toISOString(), event: 'finished', stage: 'finish', severity: 'info', title: '任务完成', summary: 'done', detail: {} },
      ],
    },
    approvals: [],
    messages: [],
  };
}

async function mockApi(context) {
  await context.route('**/health', (route) => route.fulfill({ json: { status: 'ok', paused: false, queue: { running: 0, waiting: 0 }, backend: 'mysql', configBackend: true } }));
  await context.route('**/admin/api/me', (route) => route.fulfill({ json: { username: 'admin', role: 'admin', perms: ['*'] } }));
  await context.route('**/admin/api/status', (route) => route.fulfill({ json: { executors: [{ executor_id: 'demo-exec', online: true, targets: ['demo-agent'] }] } }));
  await context.route('**/admin/api/smoke', (route) => route.fulfill({
    json: {
      hub: 'http://127.0.0.1',
      pass: 3,
      fail: 0,
      skip: 0,
      checks: [
        { name: '/health', status: 'pass', detail: 'ok' },
        { name: '/run 建单', status: 'pass', detail: 'job done' },
        { name: 'trace', status: 'pass', detail: 'trace ok' },
      ],
      run: { route: 'demo_support', request_id: 'demo-e2e', job_id: fixtures.runs[0].job_id, status: 'done' },
    },
  }));
  await context.route('**/admin/api/config-schemas/*', (route) => route.fulfill({ json: { required: [], properties: {} } }));
  await context.route('**/admin/api/tool-providers/*/tools', (route) => route.fulfill({ json: { tools: [{ name: 'list_demo_orders', scope: 'demo.order.read' }] } }));
  await context.route('**/admin/api/runs/*/trace', (route) => route.fulfill({ json: tracePayload() }));
  await context.route('**/admin/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/admin/api/me') return route.fulfill({ json: { username: 'admin', role: 'admin', perms: ['*'] } });
    if (url.pathname === '/admin/api/smoke') return route.fulfill({
      json: {
        hub: 'http://127.0.0.1',
        pass: 3,
        fail: 0,
        skip: 0,
        checks: [
          { name: '/health', status: 'pass', detail: 'ok' },
          { name: '/run 建单', status: 'pass', detail: 'job done' },
          { name: 'trace', status: 'pass', detail: 'trace ok' },
        ],
        run: { route: 'demo_support', request_id: 'demo-e2e', job_id: fixtures.runs[0].job_id, status: 'done' },
      },
    });
    if (url.pathname === '/admin/api/credentials') return route.fulfill({ json: fixtures.credentials });
    if (url.pathname === '/admin/api/targets') return route.fulfill({ json: fixtures.targets });
    if (url.pathname === '/admin/api/tool-providers') return route.fulfill({ json: fixtures.providers });
    if (url.pathname === '/admin/api/clients') return route.fulfill({ json: fixtures.clients });
    if (url.pathname === '/admin/api/routes') return route.fulfill({ json: fixtures.routes });
    if (url.pathname === '/admin/api/runs') return route.fulfill({ json: fixtures.runs });
    if (/^\/admin\/api\/runs\/[^/]+\/trace$/.test(url.pathname)) return route.fulfill({ json: tracePayload() });
    if (url.pathname === '/admin/api/threads') return route.fulfill({ json: fixtures.threads });
    if (url.pathname === '/admin/api/threads/1') return route.fulfill({
      json: {
        thread: fixtures.threads[0],
        messages: [
          { id: 1, direction: 'in', content: '查询订单 SO-1001', created_at: new Date().toISOString() },
          { id: 2, direction: 'out', content: '订单 SO-1001 已查询完成', job_id: fixtures.runs[0].job_id, created_at: new Date().toISOString() },
        ],
      },
    });
    if (url.pathname === '/admin/api/executors') return route.fulfill({ json: [{ executor_id: 'demo-exec', online: true, targets: ['demo-agent'] }] });
    if (url.pathname === '/admin/api/projects') return route.fulfill({ json: [] });
    if (url.pathname === '/admin/api/chat-entries') return route.fulfill({ json: [] });
    if (url.pathname === '/admin/api/channels') return route.fulfill({ json: [] });
    if (url.pathname === '/admin/api/kb') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: `unmocked ${url.pathname}` } });
  });
}

const server = createServer(serveStatic);
const port = await listen(server);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
await mockApi(context);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(`http://127.0.0.1:${port}/console/`, { waitUntil: 'networkidle' });
  await expectVisible(page, '触发路由');
  await page.locator('.user').click();
  await page.getByRole('menuitem', { name: '上手向导' }).click();
  await expectVisible(page, '配置完成度');
  await expectVisible(page, '模型凭证');
  await expectVisible(page, '触发路由');
  await page.getByRole('button', { name: '运行 smoke' }).first().click();
  await expectVisible(page, '通过 3');

  await page.getByRole('menuitem', { name: '触发路由' }).click();
  await expectVisible(page, 'Demo 售后助手');

  await page.getByRole('menuitem', { name: '任务' }).click();
  await expectVisible(page, '查询订单 SO-1001');
  await page.getByText('查询订单 SO-1001').first().click();
  await expectVisible(page, '订单 SO-1001 已查询完成');
  await page.locator('.tracetoggle').filter({ hasText: '执行轨迹' }).first().click();
  await expectVisible(page, '工具返回');
  await expectVisible(page, '任务完成');

  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  console.log('✓ console e2e passed');
} finally {
  await browser.close();
  server.close();
}
