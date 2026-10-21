import assert from 'node:assert/strict';
import { verifyTroubleshootingExtra } from './e2e-console-troubleshooting-extra.mjs';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(process.cwd());
const consoleDir = resolve(process.env.BAILING_CONSOLE_DIR || join(root, 'web', 'console'));
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
    rate_limit_per_min: 120, timeout_ms: 10000, log_payload: false,
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
    if (url.pathname === '/admin/api/tool-providers') {
      if (route.request().method() === 'POST') {
        const payload = route.request().postDataJSON();
        Object.assign(fixtures.providers[0], payload);
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: fixtures.providers });
    }
    if (/^\/admin\/api\/tool-providers\/[^/]+\/tools$/.test(url.pathname)) return route.fulfill({ json: { tools: [{ name: 'list_demo_orders', scope: 'demo.order.read' }] } });
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

async function verifyCallSnippets(page, base) {
  const disabled = { ...fixtures.clients[0], app_id: 'disabled-app', name: '停用的接入方', enabled: false };
  fixtures.clients.push(disabled);
  try {
    await page.goto(`${base}/console/routes`);
    await page.getByRole('button', { name: '调用代码', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: /调用代码/ });
    await expectVisible(page, '运行前配置完整 Token');
    await expectVisible(page, '1 个接入方可调用');
    for (const language of ['HTTP / cURL', 'Node.js', 'Python', 'PHP', 'Agent 触发']) {
      await dialog.getByRole('tab', { name: language, exact: true }).click();
      const code = await dialog.locator('.snippet-code:visible').innerText();
      assert.match(code, /BAILING_CLIENT_TOKEN/);
      assert.doesNotMatch(code, /\*\*\*\*oken/);
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    await expectVisible(page, '执行行为提示');
    await expectVisible(page, '仅提示词约束；工具授权与审批');
    await page.getByRole('button', { name: '点击查看：执行行为提示', exact: true }).click();
    await expectVisible(page, '此项是提示词约束，不是强制授权或沙箱');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    console.log('✓ snippets: environment token, enabled clients and visible permission boundary passed');
  } finally { fixtures.clients.pop(); }
}

async function verifyRuntimeActions(page, context, base) {
  let approvalUnavailable = true;
  let manual = true;
  let continuationPending = false;
  let decision = 'pending';
  let used = false;
  const row = () => ({ id: 900, job_id: fixtures.runs[0].job_id, status: decision,
    summary: '演示审批', tool: 'example_write', provider: 'demo-business', risk: 'high', args_json: '{}',
    created_at: '2026-01-01T01:02:03.000Z', used_at: used ? '2026-01-01T01:03:00.000Z' : null,
    continuation_mode: manual ? 'manual' : 'rerun', continuation_pending: continuationPending, job_status: manual ? 'error' : 'queued' });
  await context.route('**/admin/api/tool-approvals?**', route => route.fulfill(approvalUnavailable
    ? { status: 503, json: { error: 'test: approvals unavailable' } }
    : { json: new URL(route.request().url()).searchParams.get('status') === 'pending' && decision !== 'pending' ? [] : [row()] }));
  await context.route('**/admin/api/tool-approvals/900/approve', route => {
    decision = 'approved';
    return route.fulfill({ json: { rerun: !manual && !continuationPending,
      continuation_mode: manual ? 'manual' : 'rerun', continuation_pending: continuationPending } });
  });
  await page.goto(`${base}/console/approvals`);
  await expectVisible(page, '暂时无法读取审批列表');
  assert.equal(await page.getByText('没有待审批的调用', { exact: true }).count(), 0);
  approvalUnavailable = false;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '演示审批');
  const approve = async () => {
    await page.getByRole('button', { name: '兜底批准', exact: true }).click();
    await page.locator('.el-popconfirm').getByRole('button', { name: '确定', exact: true }).click();
  };
  await approve();
  await expectVisible(page, '请回原客户端使用同一调用标识继续');
  await page.locator('.el-radio-group').getByText('全部', { exact: true }).click();
  await expectVisible(page, '等待原客户端使用同一调用标识继续');
  used = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '批准已使用');
  assert.equal(await page.getByText('已批准·已执行', { exact: true }).count(), 0);
  approvalUnavailable = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '旧快照');
  approvalUnavailable = false; used = false; manual = false; decision = 'pending';
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await approve();
  await expectVisible(page, '中枢任务已重新入队');
  decision = 'pending'; continuationPending = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await approve();
  await expectVisible(page, '决策已保存，续办处理中');

  let execution = { kind: 'agent_tool', rerun: { available: false, reason: 'original_client' } };
  let detailUnavailable = false;
  const serveDetail = route => {
    const trace = tracePayload(); trace.job.console_execution = execution;
    return route.fulfill(detailUnavailable ? { status: 503, json: { error: 'test: detail unavailable' } } : { json: trace });
  };
  await context.route('**/admin/api/runs/*/trace', serveDetail);
  await context.route('**/admin/api/runs/trace?**', serveDetail);
  const openJob = () => page.goto(`${base}/console/runs?job=${fixtures.runs[0].job_id}`);
  await openJob();
  await expectVisible(page, '请回原客户端查看原调用');
  assert.equal(await page.getByRole('button', { name: '重新执行任务', exact: true }).count(), 0);
  execution = { kind: 'agent_tool', rerun: { available: false, reason: 'outcome_unknown' } };
  await openJob();
  await expectVisible(page, '原调用结果不明');
  assert.equal(await page.getByRole('button', { name: '重新执行任务', exact: true }).count(), 0);
  execution = undefined;
  await openJob();
  await expectVisible(page, '当前快照未提供重跑边界');
  assert.equal(await page.getByRole('button', { name: '重新执行任务', exact: true }).count(), 0);
  execution = { kind: 'hub_task', rerun: { available: true, reason: null } };
  await openJob();
  const rerun = page.getByRole('button', { name: '重新执行任务', exact: true });
  await rerun.waitFor();
  await rerun.click();
  await expectVisible(page, '可能再次调用模型、产生费用或业务写入');
  await page.locator('.el-popconfirm').getByRole('button', { name: '取消', exact: true }).click();
  detailUnavailable = true;
  await page.getByRole('button', { name: '刷新快照', exact: true }).click();
  await expectVisible(page, '旧快照');
  assert.equal(await rerun.isEnabled(), false);
  // A read-only operator should not get decision or rerun actions.
  detailUnavailable = false; decision = 'pending';
  await context.route('**/admin/api/me', route => route.fulfill({ json: { username: 'reader', role: 'viewer', perms: ['runs:read'] } }));
  await page.goto(`${base}/console/approvals`);
  await expectVisible(page, '演示审批');
  assert.equal(await page.getByRole('button', { name: '兜底批准', exact: true }).count(), 0);
  await openJob();
  await expectVisible(page, '任务详情');
  assert.equal(await page.getByRole('button', { name: '重新执行任务', exact: true }).count(), 0);
  console.log('✓ runtime actions: manual/queued/pending/used approvals and guarded rerun passed');
}

// Regression checks exercise the built Vue pages with controlled failures;
// no live configuration, credentials, approvals or model calls are used.
async function verifyStatusFeedback(page, context, base) {
  let unavailable = true;
  const ok = { ok: true, errors: 0, warnings: 0, diagnostics: [] };
  await context.route('**/admin/api/config-diagnostics', route => route.fulfill(unavailable
    ? { status: 503, json: { error: 'test: diagnostics unavailable' } } : { json: ok }));
  await context.route('**/admin/api/config-audit?**', route => route.fulfill(unavailable
    ? { status: 503, json: { error: 'test: audit unavailable' } } : { json: [] }));
  await page.goto(`${base}/console/diagnostics`);
  await expectVisible(page, '体检读取失败');
  assert.equal(await page.getByText('未发现匹配的问题', { exact: true }).count(), 0);
  assert.equal(await page.locator('.summary').getByText('存在问题', { exact: true }).count(), 0);
  assert.equal(await page.locator('.summary').getByText('0', { exact: true }).count(), 0);
  unavailable = false;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '体检完成，未发现问题');
  let actionUnavailable = false;
  await context.route('**/admin/api/smoke', route => route.fulfill(actionUnavailable
    ? { status: 503, json: { error: 'test: smoke unavailable' } }
    : { json: { hub: 'test', pass: 1, fail: 0, skip: 0, checks: [{ name: 'test', status: 'pass', detail: 'ok' }] } }));
  await context.route('**/admin/api/routes/auto-preview', route => route.fulfill(actionUnavailable
    ? { status: 503, json: { error: 'test: preview unavailable' } }
    : { json: { ok: true, selected_route: 'demo_support', rows: [] } }));
  await page.getByRole('button', { name: '运行 smoke', exact: true }).click();
  await expectVisible(page, 'Smoke 结果');
  actionUnavailable = true;
  await page.getByRole('button', { name: '运行 smoke', exact: true }).click();
  await expectVisible(page, 'test: smoke unavailable');
  assert.equal(await page.locator('.smokePanel').count(), 0);
  await page.getByRole('tab', { name: 'route=auto 预演', exact: true }).click();
  await page.getByPlaceholder('输入业务侧将传给 /run 的 input').fill('演示查询');
  actionUnavailable = false;
  await page.getByRole('button', { name: '开始预演', exact: true }).click();
  await expectVisible(page, '可命中');
  actionUnavailable = true;
  await page.getByRole('button', { name: '开始预演', exact: true }).click();
  await expectVisible(page, 'test: preview unavailable');
  assert.equal(await page.locator('.previewResult').count(), 0);
  await page.getByRole('tab', { name: '配置体检', exact: true }).click();
  unavailable = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '旧快照');
  assert.equal(await page.getByText('体检完成，未发现问题', { exact: true }).count(), 0);
  await page.goto(`${base}/console/audit`);
  await expectVisible(page, '审计记录读取失败');
  assert.equal(await page.getByText('暂无配置变更记录', { exact: true }).count(), 0);
  unavailable = false;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '暂无配置变更记录');
  unavailable = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '旧快照');
  assert.equal(await page.getByText('暂无配置变更记录', { exact: true }).count(), 0);

  let readinessUnavailable = false;
  let ready = false;
  let versionUnavailable = false;
  await context.route('**/admin/api/readiness', route => route.fulfill(readinessUnavailable
    ? { status: 503, json: { error: 'test: readiness unavailable' } }
    : { json: { ready, checked_at: '2026-01-01T01:02:03.000Z', checks: {
      database: 'ok', migrations: { status: ready ? 'ok' : 'failed', pending: 0 },
    } } }));
  await context.route('**/admin/api/version', route => route.fulfill(versionUnavailable
    ? { status: 503, json: { error: 'test: ledger unavailable' } }
    : { json: { app: { name: 'test', version: 'test' }, runtime: { node: 'test' }, contracts: {},
      migrations: { applied: 5, total: 5, latest: 'test.sql', latest_applied: 'test.sql', pending: [] } } }));
  unavailable = false;
  await page.goto(`${base}/console/system`);
  await expectVisible(page, '运行检查未通过');
  await expectVisible(page, '服务在线');
  assert.equal(await page.getByText('中枢正常', { exact: true }).count(), 0);
  assert.equal(await page.getByText('数据库结构已匹配当前代码。', { exact: true }).count(), 0);
  assert.equal(await page.getByText('运行检查通过', { exact: true }).count(), 0);
  ready = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '运行检查通过');
  readinessUnavailable = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '运行检查读取失败');
  await expectVisible(page, '不能代表当前状态');
  assert.equal(await page.getByText('运行检查通过', { exact: true }).count(), 0);
  // Failed version/ledger lookup must not prevent displaying the runtime result.
  readinessUnavailable = false; ready = false; versionUnavailable = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expectVisible(page, '运行检查未通过');
  await expectVisible(page, '版本与配置库账本读取失败');
  // An HTTP failure cannot be treated as healthy even when its body says ok.
  await context.route('**/health', route => route.fulfill({ status: 503, json: { status: 'ok' } }));
  await context.route('**/admin/api/status', route => route.fulfill({ status: 503, json: { error: 'test: status unavailable' } }));
  await page.reload();
  await expectVisible(page, '服务连接异常');
  await expectVisible(page, '执行器状态读取失败');
  console.log('✓ status feedback: failed/empty/stale and independent readiness passed');
}

async function verifyOnboardingAndForms(browser, base) {
  const ctx = await browser.newContext();
  await mockApi(ctx);
  const p = await ctx.newPage();
  const failures = [];
  p.on('pageerror', error => failures.push(error.message));
  let routeRows = [];
  let routeReadFails = false;
  let routeSaveFails = false;
  let readonly = false;
  let holdRouteSave;
  let releaseRouteSave;
  let routeWrites = 0;
  let clientWrites = 0;
  await ctx.route('**/admin/api/me', route => route.fulfill({ json: { username: 'operator', role: readonly ? 'viewer' : 'admin', perms: readonly ? ['audit:read', 'routes:read', 'clients:read', 'tools:read', 'runs:read', 'targets:read'] : ['*'] } }));
  await ctx.route('**/admin/api/targets', route => route.fulfill({ json: [{ name: 'orders-notify', kind: 'executor', enabled: true, description: 'Existing execution target' }] }));
  await ctx.route('**/admin/api/demo-dataset/status', route => route.fulfill({ json: { available: true, imported: false, empty: true } }));
  await ctx.route('**/admin/api/routes', async route => {
    if (route.request().method() === 'POST') {
      routeWrites++;
      if (holdRouteSave) await holdRouteSave;
      if (routeSaveFails) return route.fulfill({ status: 503, json: { error: 'test: save unavailable' } });
      const body = route.request().postDataJSON();
      routeRows = [body];
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill(routeReadFails ? { status: 503, json: { error: 'test: config unavailable' } } : { json: routeRows });
  });
  await ctx.route('**/admin/api/clients', route => {
    if (route.request().method() === 'POST') clientWrites++;
    return route.fulfill({ json: [] });
  });
  await ctx.route('**/admin/api/agent-clients/overview*', route => route.fulfill({ json: { applications: [], setup_workspaces: [], workspaces: [], summary: {} } }));
  await ctx.route('**/admin/api/agent-clients/sessions*', route => route.fulfill({ json: { list: [], total: 0 } }));
  try {
    await p.goto(`${base}/console/`);
    await p.waitForURL('**/console/setup');
    await expectVisible(p, '让业务系统调用 AI');
    assert.equal(await p.getByRole('dialog', { name: '导入演示数据' }).count(), 0, 'first entry must not force an import dialog');
    assert.deepEqual(await p.locator('.stepTop > b').allTextContents(), ['选择调度目标', '登记业务工具源', '创建触发路由', '创建接入方并关联路由', '发起一次真实业务调用']);
    await p.getByRole('button', { name: /让本地智能体操作业务系统/ }).click();
    await p.waitForURL('**/setup?flow=agent');
    assert.deepEqual(await p.locator('.stepTop > b').allTextContents(), ['登记业务工具源', '准备工作空间（业务路由）', '创建接入方并关联路由', '配置业务授权与工具范围', '在本地客户端登录并验证']);
    assert.equal(await p.locator('.modelNote').count(), 0);
    await expectVisible(p, '新建时仍需绑定真实调度目标');
    await expectVisible(p, '中枢模型目标（llm）需要模型凭证');
    routeReadFails = true;
    await p.getByRole('button', { name: '刷新', exact: true }).click();
    await expectVisible(p, '读取失败');
    assert.equal(await p.locator('.progressLine > b').innerText(), '业务配置准备 待确认');
    await p.goto(`${base}/console/`);
    await p.waitForURL('**/console/setup');
    assert.equal(await p.locator('.user').innerText(), 'operator', 'network failure must not log the operator out');
    routeReadFails = false;

    // Edit three real drawers: cancellation keeps the same draft and discard closes.
    for (const item of [
      { path: 'routes', name: '新建路由', field: '如 业务助手' },
      { path: 'clients', name: '新建接入方', field: '如 业务系统' },
      { path: 'tools', name: '注册工具源', field: '如 business-api' },
    ]) {
      await p.goto(`${base}/console/${item.path}?create=1`);
      const drawer = p.getByRole('dialog', { name: item.name, exact: true });
      await drawer.waitFor();
      const input = item.path === 'tools' ? drawer.locator('input').first() : drawer.getByPlaceholder(item.field, { exact: true });
      await input.fill('kept-draft');
      await drawer.getByRole('button', { name: '取消', exact: true }).click();
      await p.getByRole('button', { name: '继续编辑', exact: true }).click();
      await p.locator('.el-message-box').waitFor({ state: 'hidden' });
      assert.equal(await input.inputValue(), 'kept-draft');
      const unloadCancelled = await p.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; });
      assert.equal(unloadCancelled, true, 'unsaved form must warn before a browser refresh');
      await p.keyboard.press('Escape');
      await p.getByRole('button', { name: '放弃修改', exact: true }).click();
      await p.locator('.el-message-box').waitFor({ state: 'hidden' });
      await drawer.waitFor({ state: 'hidden' });
      assert.equal(await p.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
    }
    // A dependency detour keeps client fields in memory and never selects wildcard authorization.
    await p.goto(`${base}/console/clients?create=1`);
    let clientDrawer = p.getByRole('dialog', { name: '新建接入方', exact: true });
    await clientDrawer.getByPlaceholder('如 业务系统', { exact: true }).fill('restored-business');
    await expectVisible(p, '还没有可选择的路由');
    await clientDrawer.getByRole('button', { name: '保留草稿，去创建路由' }).click();
    await p.waitForURL('**/routes?create=1&return_to=clients');
    const routeDrawer = p.getByRole('dialog', { name: '新建路由', exact: true });
    await routeDrawer.getByPlaceholder('如 business-assistant', { exact: true }).fill('business-read');
    await routeDrawer.getByPlaceholder('如 业务助手', { exact: true }).fill('Business read');
    await routeDrawer.locator('.el-select__wrapper').first().click();
    await p.getByRole('option', { name: /orders-notify/ }).click();
    routeSaveFails = true;
    await routeDrawer.getByRole('button', { name: '保存并返回接入方', exact: true }).click();
    await expectVisible(p, '未能确认保存成功');
    assert.equal(await routeDrawer.getByPlaceholder('如 业务助手', { exact: true }).inputValue(), 'Business read');
    await p.getByRole('menuitem', { name: '任务', exact: true }).click({ force: true });
    await p.getByRole('button', { name: '继续编辑', exact: true }).click();
      await p.locator('.el-message-box').waitFor({ state: 'hidden' });
    assert.match(p.url(), /routes/);
    routeSaveFails = false;
    holdRouteSave = new Promise(resolve => { releaseRouteSave = resolve; });
    await routeDrawer.getByRole('button', { name: '保存并返回接入方', exact: true }).click();
    await p.waitForFunction(() => [...document.querySelectorAll('.el-drawer input')].some(input => input.placeholder === '如 业务助手' && input.disabled));
    assert.equal(await p.getByPlaceholder('如 business-assistant', { exact: true }).isDisabled(), true, 'route identity must also freeze during save');
    await p.keyboard.press('Escape');
    assert.equal(await routeDrawer.isVisible(), true, 'saving form must not close');
    releaseRouteSave(); holdRouteSave = null;
    await p.waitForURL('**/clients?resume=route-create');
    clientDrawer = p.getByRole('dialog', { name: '新建接入方', exact: true });
    await expectVisible(p, '已恢复尚未保存的接入方配置');
    assert.equal(await clientDrawer.getByPlaceholder('如 业务系统', { exact: true }).inputValue(), 'restored-business');
    await clientDrawer.getByRole('button', { name: '保存', exact: true }).click();
    await expectVisible(p, '请选择至少一个需要授权的具体路由');
    assert.equal(clientWrites, 0, 'new route must not silently expand client authorization');
    assert.equal(await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).includes('restored-business')), false);
    await clientDrawer.getByRole('button', { name: '取消', exact: true }).click();
    await p.getByRole('button', { name: '放弃修改', exact: true }).click();
      await p.locator('.el-message-box').waitFor({ state: 'hidden' });
    assert.equal(routeWrites, 2);

    await p.goto(`${base}/console/`);
    await p.waitForURL('**/console/runs');
    readonly = true;
    for (const item of [{ path: 'routes', button: '新建路由' }, { path: 'clients', button: '新建接入方' }, { path: 'tools', button: '注册工具源' }]) {
      await p.goto(`${base}/console/${item.path}?create=1`);
      await expectVisible(p, 'viewer');
      assert.equal(await p.getByRole('button', { name: item.button, exact: true }).count(), 0);
      assert.equal(await p.getByRole('dialog').count(), 0, 'read-only URL must not open a writable form');
    }
    await ctx.route('**/admin/api/agent-clients/overview*', route => route.fulfill({ status: 503, json: { error: 'test: overview unavailable' } }));
    await p.goto(`${base}/console/agent-clients`);
    await expectVisible(p, '读取接入配置失败');
    assert.equal(await p.getByText('当前没有匹配的接入方', { exact: false }).count(), 0);
    // A late successful snapshot must not erase a newer read failure.
    let overviewReads = 0;
    let releaseOldOverview;
    const oldOverviewGate = new Promise(resolve => { releaseOldOverview = resolve; });
    await ctx.route('**/admin/api/agent-clients/overview*', async route => {
      if (++overviewReads === 1) {
        await oldOverviewGate;
        return route.fulfill({ json: { applications: [], setup_workspaces: [], workspaces: [], summary: {} } });
      }
      return route.fulfill({ status: 503, json: { error: 'newest overview failure' } });
    });
    const firstOverviewRequest = p.waitForRequest('**/admin/api/agent-clients/overview*');
    await p.getByRole('button', { name: '重新读取', exact: true }).click();
    await firstOverviewRequest;
    await p.getByRole('button', { name: '重新读取', exact: true }).click();
    await expectVisible(p, 'newest overview failure');
    const oldOverviewResponse = p.waitForResponse(response => response.url().includes('/agent-clients/overview') && response.status() === 200);
    releaseOldOverview();
    await (await oldOverviewResponse).finished();
    await p.waitForFunction(() => !document.querySelector('.el-loading-mask'));
    await expectVisible(p, 'newest overview failure');
    assert.equal(await p.getByText('当前没有匹配的接入方', { exact: false }).count(), 0);
    assert.deepEqual(failures, []);
    console.log('✓ onboarding and forms: paths, failed reads, dirty exit/refresh, save failure/in-flight, dependency detour and read-only roles passed');
  } catch (error) {
    console.error('onboarding failure state:', (await p.locator('body').innerText()).slice(-7000));
    throw error;
  } finally { if (releaseRouteSave) releaseRouteSave(); await ctx.close(); }
}


async function verifyTroubleshooting(browser, base) {
  const context = await browser.newContext();
  await mockApi(context);
  const p = await context.newPage();
  p.setDefaultTimeout(8000);
  const errors = [];
  p.on('pageerror', error => errors.push(error.message));
  const ds = [
    { area: 'client', id: 'demo-app', severity: 'error', message: '演示接入方配置需检查' },
    { area: 'tool_provider', id: 'demo-business', severity: 'warning', message: '演示工具源需检查' },
    { area: 'runtime_delivery', id: 'delivery_dlq', severity: 'warning', message: '演示送达结果需核对' },
    { area: 'runtime_jobs', id: 'error_burst', severity: 'warning', message: '演示任务失败需检查' },
  ];
  await context.route('**/admin/api/config-diagnostics', r => r.fulfill({ json: { ok: false, errors: 1, warnings: 3, diagnostics: ds } }));
  await context.route('**/admin/api/clients', r => r.fulfill({ json: [...fixtures.clients, { ...fixtures.clients[0], app_id: 'demo-app-extra', name: 'Similar client' }] }));
  await context.route('**/admin/api/runs?*', r => r.fulfill({ json: [{ ...fixtures.runs[0], route_key: 'demo_support', status: 'error' }, { ...fixtures.runs[0], job_id: 'older-job', route_key: 'other_route', status: 'done', created_at: '2020-01-01T00:00:00Z' }] }));
  await context.route('**/admin/api/notification-outbox?*', r => r.fulfill({ json: { items: [{ event_id: 'delivery-unknown', kind: 'delivery-dlq', status: 'uncertain', job_id: fixtures.runs[0].job_id, attempts: 1, updated_at: new Date().toISOString() }], total: 1, snapshot: { counts: { pending: 0, processing: 0, failed: 0, uncertain: 1 } } } }));
  try {
    await p.goto(`${base}/console/diagnostics?severity=error&q=demo`);
    await p.locator('.groups .el-table__row').first().getByRole('button', { name: '打开', exact: true }).click();
    await p.waitForURL(u => u.pathname.endsWith('/clients') && u.searchParams.get('focus') === 'demo-app');
    await expectVisible(p, 'Demo 业务系统');
    assert.equal(await p.locator('.el-table__body .el-table__row').count(), 1, '精确定位不得混入近似名称');
    await p.reload();
    await expectVisible(p, '定位：demo-app');
    await p.getByRole('button', { name: '返回体检', exact: true }).click();
    await p.waitForURL(u => u.pathname.endsWith('/diagnostics') && u.searchParams.get('severity') === 'error' && u.searchParams.get('q') === 'demo');
    await p.locator('.groups .el-table__row').first().waitFor({ state: 'visible' });
    assert.equal(await p.locator('.groups .el-table__row').count(), 1);
    await p.getByRole('tab', { name: 'route=auto 预演' }).click();
    await p.waitForURL(u => u.searchParams.get('tab') === 'auto');
    await p.reload();
    assert.equal(await p.getByRole('tab', { name: 'route=auto 预演' }).getAttribute('aria-selected'), 'true');
    await p.goto(`${base}/console/clients?q=deleted&focus=deleted`);
    await expectVisible(p, '未找到对象「deleted」');
    assert.equal(await p.locator('.el-table__body .el-table__row').count(), 0);
    await p.getByRole('button', { name: '清除筛选', exact: true }).click();
    await p.waitForURL(u => !u.searchParams.has('focus'));
    await expectVisible(p, 'Similar client');
    assert.equal(await p.locator('.el-table__body .el-table__row').count(), 2);
    await p.getByRole('textbox', { name: '搜索名称 / 标识', exact: true }).fill('Similar');
    await p.waitForURL(u => u.searchParams.get('q') === 'Similar');
    await p.reload();
    await expectVisible(p, 'Similar client');
    assert.equal(await p.locator('.el-table__body .el-table__row').count(), 1);
    await p.goto(`${base}/console/diagnostics?q=delivery_dlq`);
    await p.locator('.groups .el-table__row').first().getByRole('button', { name: '打开', exact: true }).click();
    await p.waitForURL(u => u.searchParams.get('tab') === 'outbox' && u.searchParams.get('outbox_kind') === 'delivery-dlq');
    await expectVisible(p, 'delivery-unknown');
    await p.locator('.notification-panel .filters .el-select__wrapper').nth(1).click();
    await p.getByRole('option', { name: '需核对', exact: true }).click();
    await p.waitForURL(u => u.searchParams.get('outbox_status') === 'uncertain');
    await p.reload();
    await expectVisible(p, 'delivery-unknown');
    await p.locator('.notification-panel .el-table__expand-icon').first().click();
    await p.getByRole('button', { name: '查看原任务', exact: true }).click();
    await p.waitForURL(u => !!u.searchParams.get('detail'));
    await p.locator('.el-drawer__close-btn').click();
    await p.waitForURL(u => !u.searchParams.has('detail') && u.searchParams.get('outbox_status') === 'uncertain');
    await p.getByRole('button', { name: '返回来源页面', exact: true }).click();
    await p.waitForURL(u => u.pathname.endsWith('/diagnostics') && u.searchParams.get('q') === 'delivery_dlq');
    await p.goto(`${base}/console/diagnostics?q=error_burst`);
    await p.locator('.groups .el-table__row').first().getByRole('button', { name: '打开', exact: true }).click();
    await p.waitForURL(u => u.pathname.endsWith('/runs') && u.searchParams.get('tab') === 'jobs');
    await expectVisible(p, '当前匹配 1 条');
    await p.locator('.run-filters .el-select__wrapper').nth(2).click();
    await p.getByRole('option', { name: '最近 24 小时', exact: true }).click();
    await p.waitForURL(u => u.searchParams.get('run_period') === '24h' && u.searchParams.get('run_status') === 'error');
    await p.reload();
    await expectVisible(p, '当前匹配 1 条');
    assert.deepEqual(errors, []);
    console.log('✓ troubleshooting: exact diagnostic focus, missing objects, filters, tabs, reload and return context passed');
  } finally { await context.close(); }
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
  await page.getByRole('button', { name: '接入向导', exact: true }).click();
  await expectVisible(page, '业务配置准备');
  await expectVisible(page, '模型凭证');
  await expectVisible(page, '触发路由');
  await expectVisible(page, '演示数据已导入，运行演示验证');
  if (smokeRequests !== 0) throw new Error('导入演示数据后不应自动运行 Smoke');
  const demoSmokeButton = page.getByRole('button', { name: '运行演示验证' }).first();
  if (!(await demoSmokeButton.getAttribute('class'))?.includes('el-button--primary')) {
    throw new Error('演示数据已导入时，运行演示验证 应是主 CTA');
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
  await page.getByRole('button', { name: '放弃修改', exact: true }).click();

  await page.getByRole('button', { name: '编辑' }).first().click();
  await page.getByRole('tab', { name: '治理', exact: true }).click();
  await expectVisible(page, '工具源总限额');
  const totalLimitHelp = page.getByRole('button', { name: '点击查看：工具源总限额', exact: true });
  await totalLimitHelp.focus();
  await totalLimitHelp.press('Enter');
  await expectVisible(page, '用户、授权和会话共用');
  await totalLimitHelp.press('Escape');
  await page.getByText('工具源总限额（次/分钟，0=关闭）', { exact: true }).click();
  const defaultPolicy = page.locator('.limit-editor').first();
  await defaultPolicy.locator('.el-select__wrapper').first().click();
  await page.getByRole('option', { name: '自定义中枢限额', exact: true }).click();
  await defaultPolicy.getByRole('spinbutton').fill('1000');
  await page.getByRole('button', { name: '添加工具覆盖', exact: true }).click();
  await page.getByText('选择或输入工具名', { exact: true }).click();
  await page.getByRole('option', { name: 'list_demo_orders', exact: true }).last().click();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expectVisible(page, '已保存');
  if (fixtures.providers[0].tool_rate_limits.default.count !== 1000 || fixtures.providers[0].tool_rate_limits.default.window !== '1h') throw new Error('custom hour policy not saved');
  if (fixtures.providers[0].tool_rate_limits.overrides.list_demo_orders.mode !== 'inherit') throw new Error('per-tool override not saved');
  await page.getByRole('button', { name: '编辑' }).first().click();
  await page.getByRole('tab', { name: '治理', exact: true }).click();
  if (await page.locator('.limit-editor').first().getByRole('spinbutton').inputValue() !== '1000') throw new Error('saved policy did not restore');
  if (process.env.BAILING_RATE_SCREENSHOT) await page.screenshot({ path: process.env.BAILING_RATE_SCREENSHOT, fullPage: true });
  await page.getByRole('button', { name: '取消', exact: true }).click();

  await page.getByRole('menuitem', { name: '任务', exact: true }).click();
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

  await verifyCallSnippets(page, `http://127.0.0.1:${port}`);
  await verifyStatusFeedback(page, context, `http://127.0.0.1:${port}`);

  await verifyRuntimeActions(page, context, `http://127.0.0.1:${port}`);
  await verifyOnboardingAndForms(browser, `http://127.0.0.1:${port}`);
  await verifyTroubleshooting(browser, `http://127.0.0.1:${port}`);
  await verifyTroubleshootingExtra(browser, `http://127.0.0.1:${port}`, mockApi, fixtures);

  if (errors.length) throw new Error(`console errors:\n${errors.join('\n')}`);
  console.log('✓ console e2e passed');
} finally {
  await browser.close();
  server.close();
}
