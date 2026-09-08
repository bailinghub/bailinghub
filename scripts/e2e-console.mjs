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
  providers: [{
    name: 'demo-business',
    base_url: 'http://demo-business:19080',
    enabled: true,
    has_spec: true,
    spec_source: 'url',
    spec_url: 'http://demo-business:19080/bailing/tools.json',
    spec_access_policy: 'legacy_unverified',
    spec_access_probe: {
      status: 'protected',
      signed_http: 200,
      unsigned_http: 401,
      invalid_http: 401,
      at: new Date().toISOString(),
    },
    authz_probe: { status: 'pass' },
    auto_refresh_min: 60,
  }],
  clients: [{ app_id: 'demo-app', name: 'Demo 业务系统', token: '****oken', allowed_routes: ['demo_support'], allowed_channels: [], rate_limit_per_min: 60, enabled: true }],
  routes: [{ route_key: 'demo_support', name: 'Demo 售后助手', target: 'demo-agent', enabled: true, tools: { sources: [{ provider: 'demo-business', allow: ['demo.*'] }], max_calls: 5 } }],
  demoStatus: { available: true, imported: true, empty: false },
  chatEntries: [{
    entry_key: 'demo-chat',
    name: 'Demo 在线助手',
    route_key: 'demo_support',
    allowed_origins: ['https://example.com'],
    ticket_client: 'demo-app',
    rate_limit_per_min: 20,
    enabled: true,
  }],
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
  }, {
    thread_id: 2,
    scope_key: 'agent:demo-app:employee-edit',
    channel: 'agent:demo-app',
    client_name: 'Demo 业务系统',
    principal_id: 'uid:tenant-1:user-7',
    route_name: 'Demo 售后助手',
    last_preview: '员工资料已修改',
    last_active_at: new Date().toISOString(),
    message_count: 2,
  }, {
    thread_id: 3,
    scope_key: 'agent:demo-app:incomplete-turn',
    channel: 'agent:demo-app',
    client_name: 'Demo 业务系统',
    principal_id: 'uid:tenant-1:user-7',
    route_name: 'Demo 售后助手',
    last_preview: '等待本地智能体继续处理',
    last_active_at: new Date().toISOString(),
    message_count: 1,
  }],
};

const agentRunId = '123e4567-e89b-42d3-a456-426614174000';
const agentToolJobId = '223e4567-e89b-42d3-a456-426614174000';
const incompleteAgentRunId = '323e4567-e89b-42d3-a456-426614174000';
const incompleteAgentToolJobId = '423e4567-e89b-42d3-a456-426614174000';
const conversationId = '523e4567-e89b-42d3-a456-426614174000';
const conversationTurnId = 'demo-conversation-turn-1';
const conversationUser = '对比演示账户 A、B，只更新 A 的资料。';
const conversationReply = '账户 A 更新成功；账户 B 的审批已通过，仍需客户端继续处理。';
const conversationMembers = ['A', 'B'].map((label, index) => ({
  session_id: `623e4567-e89b-42d3-a456-42661417400${index}`,
  display_label: `演示账户 ${label}`,
  confirmed: true,
  principal: { id: `demo-user-${index}`, tenant: `demo-account-${label}`, roles: ['operator'] },
}));
const conversation = {
  conversation_id: conversationId,
  client_archive_id: '723e4567-e89b-42d3-a456-426614174000',
  client_conversation_id: 'demo-client-conversation',
  client_app_id: 'demo-app',
  route_key: 'demo_support',
  state: 'ready',
  member_count: 2,
  confirmed_count: 2,
  last_sequence: 6,
  message_count: 2,
  turn_count: 1,
  last_turn_status: 'completed',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
const conversationEvents = [
  { kind: 'turn_start' },
  { kind: 'user_message', content: conversationUser },
  { kind: 'run_link', run_id: agentRunId, member_session_id: conversationMembers[0].session_id, thread_id: 2 },
  { kind: 'run_link', run_id: incompleteAgentRunId, member_session_id: conversationMembers[1].session_id, thread_id: 3 },
  { kind: 'assistant_message', content: conversationReply },
  { kind: 'turn_end', status: 'completed' },
].map((event, index) => ({
  event_id: `823e4567-e89b-42d3-a456-42661417400${index}`,
  sequence: index + 1,
  client_turn_id: conversationTurnId,
  created_at: conversation.created_at,
  ...event,
}));

let smokeRequests = 0;

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

function agentRunTracePayload() {
  return {
    kind: 'agent_client_run',
    run: {
      run_id: agentRunId,
      thread_id: 2,
      conversation_audit_id: conversationId,
      client_turn_id: conversationTurnId,
      client_app_id: 'demo-app',
      route_key: 'demo_support',
      status: 'completed',
      model: 'deepseek-chat',
      runtime: 'deepseek-harness',
      usage: { total_tokens: 168 },
      governance: { planner: 'local_agent', execution: 'bailinghub_governed', hidden_reasoning_sync: false },
    },
    trace: {
      summary: { tool_invocations: 1, approvals: 0, warning_count: 0, error_count: 0, duration_ms: 1800 },
      events: [
        { ts: new Date().toISOString(), event: 'agent_client_run_started', source: 'local_agent', stage: 'launch', severity: 'info', title: '本地智能体开始处理', summary: '本轮由本地智能体负责理解、规划和工具选择', detail: { hidden_reasoning_sync: false } },
        { ts: new Date().toISOString(), event: 'tool_call', source: 'hub_governance', tool_job_id: agentToolJobId, stage: 'tool', severity: 'info', title: '工具调用', summary: 'staff_edit', detail: { tool: 'staff_edit', argument_keys: ['id', 'name'] } },
        { ts: new Date().toISOString(), event: 'tool_result', source: 'hub_governance', tool_job_id: agentToolJobId, stage: 'tool', severity: 'info', title: '工具结果', summary: 'staff_edit · HTTP 200', detail: { tool: 'staff_edit', status: 200, ok: true } },
      ],
    },
    invocations: [{
      job_id: agentToolJobId,
      invocation_id: 'a'.repeat(64),
      tool: 'staff_edit',
      status: 'done',
      state: 'executed',
      ok: true,
      business_status: 200,
      approval_status: null,
      approval_id: null,
      event_count: 3,
      duration_ms: 1200,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
  };
}

function incompleteAgentRunTracePayload() {
  return {
    kind: 'agent_client_run',
    run: {
      run_id: incompleteAgentRunId,
      thread_id: 3,
      conversation_audit_id: conversationId,
      client_turn_id: conversationTurnId,
      client_app_id: 'demo-app',
      route_key: 'demo_support',
      status: 'context_ready',
      model: null,
      runtime: 'deepseek-harness',
      usage: null,
      governance: { planner: 'local_agent', execution: 'bailinghub_governed', hidden_reasoning_sync: false },
    },
    trace: {
      summary: { tool_invocations: 1, approvals: 1, warning_count: 1, error_count: 0, duration_ms: 3200, partial: true },
      events: [
        { ts: new Date().toISOString(), event: 'agent_client_run_started', source: 'local_agent', stage: 'launch', severity: 'info', title: '本地智能体开始处理', summary: '本轮由本地智能体负责规划', detail: { hidden_reasoning_sync: false } },
        { ts: new Date().toISOString(), event: 'agent_tool_invocation_state', source: 'hub_governance', tool_job_id: incompleteAgentToolJobId, stage: 'tool', severity: 'warning', title: 'ACC 工具调用状态更新', summary: 'staff_edit · awaiting_approval', detail: { tool: 'staff_edit', state: 'awaiting_approval', ok: false } },
      ],
    },
    invocations: [{
      job_id: incompleteAgentToolJobId,
      invocation_id: 'b'.repeat(64),
      tool: 'staff_edit',
      status: 'done',
      state: 'awaiting_approval',
      ok: false,
      business_status: null,
      approval_status: 'approved',
      approval_id: 9,
      event_count: 2,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }],
  };
}

async function mockApi(context) {
  await context.route('**/health', (route) => route.fulfill({ json: { status: 'ok', paused: false, queue: { running: 0, waiting: 0 }, backend: 'mysql', configBackend: true } }));
  await context.route('**/admin/api/me', (route) => route.fulfill({ json: { username: 'admin', role: 'admin', perms: ['*'] } }));
  await context.route('**/admin/api/status', (route) => route.fulfill({ json: { executors: [{ executor_id: 'demo-exec', online: true, targets: ['demo-agent'] }] } }));
  await context.route('**/admin/api/smoke', (route) => {
    smokeRequests += 1;
    return route.fulfill({ json: {
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
    } });
  });
  await context.route('**/admin/api/config-schemas/*', (route) => route.fulfill({ json: { required: [], properties: {} } }));
  await context.route('**/admin/api/tool-providers/*/tools', (route) => route.fulfill({ json: { tools: [{ name: 'list_demo_orders', scope: 'demo.order.read' }] } }));
  await context.route('**/admin/api/runs/*/trace', (route) => route.fulfill({ json: tracePayload() }));
  await context.route(`**/admin/api/threads/2/agent-runs/${agentRunId}/trace`, (route) => route.fulfill({ json: agentRunTracePayload() }));
  await context.route(`**/admin/api/threads/3/agent-runs/${incompleteAgentRunId}/trace`, (route) => route.fulfill({ json: incompleteAgentRunTracePayload() }));
  await context.route('**/admin/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/admin/api/me') return route.fulfill({ json: { username: 'admin', role: 'admin', perms: ['*'] } });
    if (url.pathname === '/admin/api/smoke') {
      smokeRequests += 1;
      return route.fulfill({ json: {
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
      } });
    }
    if (url.pathname === '/admin/api/credentials') return route.fulfill({ json: fixtures.credentials });
    if (url.pathname === '/admin/api/targets') return route.fulfill({ json: fixtures.targets });
    if (url.pathname === '/admin/api/tool-providers') return route.fulfill({ json: fixtures.providers });
    if (url.pathname === '/admin/api/clients') return route.fulfill({ json: fixtures.clients });
    if (url.pathname === '/admin/api/routes') return route.fulfill({ json: fixtures.routes });
    if (url.pathname === '/admin/api/runs') return route.fulfill({ json: fixtures.runs });
    if (url.pathname === '/admin/api/conversation-audits') return route.fulfill({ json: {
      schema: 'bailing.agent-conversation-audit-list.v1', items: [conversation], has_more: false, next_offset: null,
    } });
    if (url.pathname === `/admin/api/conversation-audits/${conversationId}`) return route.fulfill({ json: {
      schema: 'bailing.agent-conversation-audit-detail.v1', conversation, members: conversationMembers,
      events: conversationEvents, has_more: false, next_after_sequence: null,
    } });
    if (/^\/admin\/api\/runs\/[^/]+\/trace$/.test(url.pathname)) return route.fulfill({ json: tracePayload() });
    if (url.pathname === `/admin/api/threads/2/agent-runs/${agentRunId}/trace`) return route.fulfill({ json: agentRunTracePayload() });
    if (url.pathname === `/admin/api/threads/3/agent-runs/${incompleteAgentRunId}/trace`) return route.fulfill({ json: incompleteAgentRunTracePayload() });
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
    if (url.pathname === '/admin/api/threads/2') return route.fulfill({
      json: {
        thread: fixtures.threads[1],
        messages: [
          { id: 3, direction: 'in', content: '把员工资料改成新的姓名', agent_run_id: agentRunId, created_at: new Date().toISOString() },
          { id: 4, direction: 'out', content: '员工资料已修改', agent_run_id: agentRunId, created_at: new Date().toISOString() },
        ],
      },
    });
    if (url.pathname === '/admin/api/threads/3') return route.fulfill({
      json: {
        thread: fixtures.threads[2],
        messages: [
          { id: 5, direction: 'in', content: '等待本地智能体继续处理', agent_run_id: incompleteAgentRunId, created_at: new Date().toISOString() },
        ],
      },
    });
    if (url.pathname === '/admin/api/executors') return route.fulfill({ json: [{ executor_id: 'demo-exec', online: true, targets: ['demo-agent'] }] });
    if (url.pathname === '/admin/api/projects') return route.fulfill({ json: [] });
    if (url.pathname === '/admin/api/demo-dataset/status') return route.fulfill({ json: fixtures.demoStatus });
    if (url.pathname === '/admin/api/chat-entries') return route.fulfill({ json: fixtures.chatEntries });
    if (url.pathname === '/admin/api/channels') return route.fulfill({ json: [] });
    if (url.pathname === '/admin/api/kb') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: { error: `unmocked ${url.pathname}` } });
  });
}

const server = createServer(serveStatic);
const port = await listen(server);
const browserChannel = String(process.env.PLAYWRIGHT_CHANNEL || '').trim();
const browser = await chromium.launch({
  headless: true,
  ...(browserChannel ? { channel: browserChannel } : {}),
});
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
  await expectVisible(page, '演示数据已导入，运行演示主体 Smoke');
  if (smokeRequests !== 0) throw new Error('导入演示数据后不应自动运行 Smoke');
  const demoSmokeButton = page.getByRole('button', { name: '运行演示主体 Smoke' }).first();
  if (!(await demoSmokeButton.getAttribute('class'))?.includes('el-button--primary')) {
    throw new Error('演示数据已导入时，运行演示主体 Smoke 应是主 CTA');
  }
  await demoSmokeButton.click();
  if (smokeRequests !== 1) throw new Error('Smoke 应只在用户点击后运行一次');
  await expectVisible(page, '通过 3');

  await page.getByRole('menuitem', { name: '聊天入口' }).click();
  await expectVisible(page, '“匿名预览”不会继承中枢后台登录状态');
  await expectVisible(page, '包括只读查询和写操作');
  await expectVisible(page, '支持业务身份票据：demo-app');
  await expectVisible(page, '匿名预览');

  await page.getByRole('menuitem', { name: '触发路由' }).click();
  await expectVisible(page, 'Demo 售后助手');

  await page.getByRole('menuitem', { name: '工具源' }).click();
  await expectVisible(page, '期望：待确认（历史配置）');
  await expectVisible(page, '实测：已保护');
  await page.getByRole('button', { name: '编辑' }).first().click();
  await page.getByRole('tab', { name: '接口清单' }).click();
  await expectVisible(page, '升级后待确认访问方式');
  if (await page.getByText('历史记录未声明', { exact: false }).count()) {
    throw new Error('legacy_unverified 不应渲染为第三个配置选项');
  }
  const signedPolicy = page.getByRole('radio', { name: /签名保护/ }).first();
  const publicPolicy = page.getByRole('radio', { name: '允许公开' }).first();
  if (await signedPolicy.isChecked() || await publicPolicy.isChecked()) {
    throw new Error('历史配置打开时不应默认选择公开策略');
  }
  await page.getByRole('button', { name: '采用实测结果：签名保护' }).click();
  if (!await signedPolicy.isChecked()) throw new Error('采用实测结果后应选择签名保护');
  await page.getByRole('button', { name: '取消' }).click();

  await page.getByRole('menuitem', { name: '任务' }).click();
  const auditRadio = page.getByRole('radio', { name: '客户端完整对话', exact: true });
  if (!await auditRadio.isChecked()) throw new Error('任务会话页应默认展示客户端完整对话');
  const auditList = page.locator('aside[aria-label="客户端对话列表"]');
  await auditList.getByRole('button', { name: /demo-client-conversation/ }).click();
  const auditTurn = page.locator(`section[data-turn-id="${conversationTurnId}"]`);
  await expectVisible(page, conversationReply);
  if (await auditTurn.locator('.userMessage .messageText').innerText() !== conversationUser ||
      await auditTurn.locator('.assistantMessage .messageText').innerText() !== conversationReply) {
    throw new Error('客户端对话必须展示原始可见正文，不能以授权执行摘要替代');
  }
  await expectVisible(page, '已接收 1 轮 / 2 条消息');
  await expectVisible(page, '旧历史或未同步内容可能缺失');
  if (await auditTurn.locator('.authorizationRun').count() !== 2) throw new Error('本轮应保留两项独立授权执行');
  const accountA = auditTurn.locator('.authorizationRun').filter({ hasText: agentRunId });
  const accountB = auditTurn.locator('.authorizationRun').filter({ hasText: incompleteAgentRunId });
  await accountA.getByText('演示账户 A', { exact: true }).waitFor();
  await accountB.getByText('演示账户 B', { exact: true }).waitFor();
  await accountA.getByRole('button', { name: '查看授权轨迹', exact: true }).click();
  await accountA.locator('.invocation').getByText('staff_edit', { exact: true }).waitFor();
  await accountA.getByRole('button', { name: '原授权记录', exact: true }).click();
  await expectVisible(page, '把员工资料改成新的姓名');
  if (!await page.getByRole('radio', { name: '原授权记录', exact: true }).isChecked()) {
    throw new Error('授权执行必须能回到原授权记录');
  }
  await page.locator('.tracetoggle').filter({ hasText: '执行轨迹' }).first().click();
  await page.getByRole('button', { name: '查看客户端完整对话', exact: true }).click();
  await page.waitForURL((url) => url.searchParams.get('conversation') === conversationId &&
    url.searchParams.get('turn') === conversationTurnId);
  await auditTurn.locator('.assistantMessage .messageText').waitFor({ state: 'visible' });
  if (!await auditRadio.isChecked() || await auditTurn.locator('.assistantMessage .messageText').innerText() !== conversationReply) {
    throw new Error('原执行轨迹必须返回同一客户端对话与原始答复');
  }

  // Keep the existing business-entry and authorization-scoped trace checks.
  await page.locator('.conversationViewSwitch').getByText('原授权记录', { exact: true }).click();
  if (!await page.getByRole('radio', { name: '原授权记录', exact: true }).isChecked()) {
    throw new Error('切换后应展示原授权记录');
  }
  await expectVisible(page, '查询订单 SO-1001');
  await page.getByText('查询订单 SO-1001').first().click();
  await expectVisible(page, '订单 SO-1001 已查询完成');
  await page.locator('.tracetoggle').filter({ hasText: '执行轨迹' }).first().click();
  await expectVisible(page, '工具返回');
  await expectVisible(page, '任务完成');

  await page.getByText('员工资料已修改').first().click();
  await expectVisible(page, '把员工资料改成新的姓名');
  await page.locator('.tracetoggle').filter({ hasText: '执行轨迹' }).first().click();
  await expectVisible(page, '本地智能体编排');
  await expectVisible(page, '隐藏推理不会上传');
  await expectVisible(page, '中枢治理');
  await expectVisible(page, 'staff_edit');
  if (await page.getByText('未挂工具', { exact: true }).count()) {
    throw new Error('Agent Client 轨迹不应显示旧 Job 的「未挂工具」提示');
  }
  if (await page.getByText('PRIVATE_REASONING', { exact: false }).count()) {
    throw new Error('Agent Client 会话轨迹不得展示隐藏推理');
  }

  await page.getByText('等待本地智能体继续处理').first().click();
  await page.locator('.tracetoggle').filter({ hasText: '执行轨迹' }).first().click();
  await expectVisible(page, '上下文已就绪');
  await expectVisible(page, '已批准，等待本地智能体续执行');
  await expectVisible(page, '不代表全量');

  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  console.log('✓ console e2e passed');
} finally {
  await browser.close();
  server.close();
}
