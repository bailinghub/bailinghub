// Local UI fixture only. Every API response is synthetic; no upstream requests are made.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 18947;
const BUILD_DIRECTORY = resolve(process.env.UI_BUILD_DIRECTORY || '/tmp/bailinghub-conversation-audit-ui-build');
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const HISTORY_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_A = '33333333-3333-4333-8333-333333333333';
const SESSION_B = '44444444-4444-4444-8444-444444444444';
const RUN_A = '66666666-6666-4666-8666-666666666661';
const RUN_B = '66666666-6666-4666-8666-666666666662';
const JOB_A = 'fixture-job-a';
const JOB_B = 'fixture-job-b';
const timestamp = (second = 0) => `2026-09-08T01:00:${String(second).padStart(2, '0')}.000Z`;
const members = [
  { session_id: SESSION_A, display_label: 'FIXTURE · 示例授权 A', confirmed: true, client_app_id: 'fixture-crm', client_name: 'FIXTURE CRM', route_key: 'fixture-crm-customers', principal: { id: 'fixture-a', tenant: 'fixture-tenant-a', roles: ['reader'] }, on_behalf_of: 'fixture-principal-a' },
  { session_id: SESSION_B, display_label: 'FIXTURE · 示例授权 B', confirmed: true, client_app_id: 'fixture-erp', client_name: 'FIXTURE ERP', route_key: 'fixture-erp-orders', principal: { id: 'fixture-b', tenant: 'fixture-tenant-b', roles: ['reader'] }, on_behalf_of: 'fixture-principal-b' },
];
// Old admin schema v1 responses omit all member-level system/route fields.
const { client_app_id, client_name, route_key, ...legacyMember } = members[0];
const event = (sequence, kind, values = {}) => ({
  event_id: `fixture-event-${sequence}`, sequence, client_turn_id: 'fixture-turn-1', kind,
  created_at: timestamp(sequence), ...values,
});
const fullAnswer = '[FIXTURE · 脱敏客户端完整答复]\n\n'
  + '已分别完成两个授权下的只读查询。\n\n'
  + 'CRM 示例授权 A：找到演示对象 ALPHA，状态为“可用”，展示数量为 12。\n'
  + 'ERP 示例授权 B：找到演示对象 BETA，状态为“待检查”，展示数量为 7。\n\n'
  + '两项结果来自各自独立的授权执行。本条消息保留客户端提交的完整可见答复，'
  + '不是把两条执行摘要拼接后推测出来的正文。工具卡片可分别打开原始授权记录和工具详情。\n\n'
  + '本次仅进行了查询，没有更新任何业务对象。以上名称、数量、身份和执行记录全部是本地 UI fixture。';
const events = [
  event(1, 'turn_start', { status: 'running' }),
  event(2, 'user_message', { content: '[FIXTURE] 请分别查询 CRM 示例授权 A 和 ERP 示例授权 B 的业务对象，在同一条答复中汇总。只查询，不执行写操作。' }),
  event(3, 'run_link', { run_id: RUN_A, member_session_id: SESSION_A, thread_id: 101 }),
  event(4, 'run_link', { run_id: RUN_B, member_session_id: SESSION_B, thread_id: 102 }),
  event(5, 'assistant_message', { content: fullAnswer }),
  event(6, 'turn_end', { status: 'completed' }),
  event(7, 'turn_start', { client_turn_id: 'fixture-turn-2', status: 'running' }),
  event(8, 'user_message', { client_turn_id: 'fixture-turn-2', content: '[FIXTURE] 请保留上轮结果。此轮用于验证客户端正文缺失提示。' }),
  // Deliberately absent content: the UI must not infer it from any run summary.
  event(9, 'assistant_message', { client_turn_id: 'fixture-turn-2' }),
  event(10, 'turn_end', { client_turn_id: 'fixture-turn-2', status: 'completed' }),
];
const conversation = {
  conversation_id: CONVERSATION_ID, client_archive_id: '55555555-5555-4555-8555-555555555551',
  client_conversation_id: 'FIXTURE · 跨系统两授权完整对话与跨页记录', client_app_id: 'fixture-crm', route_key: 'fixture-crm-customers',
  state: 'ready', member_count: 2, confirmed_count: 2, last_sequence: 10, message_count: 4, turn_count: 2,
  last_turn_status: 'completed', created_at: timestamp(), updated_at: timestamp(10),
};
const history = {
  ...conversation, conversation_id: HISTORY_ID, client_archive_id: '55555555-5555-4555-8555-555555555552',
  client_conversation_id: 'FIXTURE · 历史授权记录尚无客户端正文', member_count: 1, confirmed_count: 1,
  client_app_id: 'fixture-legacy-client', route_key: 'fixture-legacy-route',
  last_sequence: 0, message_count: 0, turn_count: 0, last_turn_status: null, updated_at: timestamp(),
};
const thread = (id) => ({
  thread_id: id, channel: 'agent:fixture', client_name: members[id === 101 ? 0 : 1].client_name, principal_id: id === 101 ? 'fixture-a' : 'fixture-b',
  scope_key: 'fixture-scope', route_name: members[id === 101 ? 0 : 1].route_key, message_count: 2,
  last_active_at: timestamp(6), last_preview: `FIXTURE · 仅授权 ${id === 101 ? 'A' : 'B'} 执行摘要`,
});
const threads = [thread(101), thread(102)];
const trace = (label) => ({
  summary: { event_count: 1, tool_results: 1, partial: false },
  events: [{ ts: timestamp(4), event: 'tool_result', stage: 'tool', title: '已返回工具结果（FIXTURE）',
    source: 'hub_governance', summary: `仅示例授权 ${label} 的执行结果`, detail: { fixture: true, authorization: label } }],
});
const runTrace = (id, runId) => {
  const label = id === 101 ? 'A' : 'B';
  return {
    run: { run_id: runId, thread_id: id, status: 'completed', conversation_audit_id: CONVERSATION_ID,
      client_turn_id: 'fixture-turn-1', created_at: timestamp(3), completed_at: timestamp(6) },
    invocations: [{ job_id: id === 101 ? JOB_A : JOB_B, tool: 'fixture.object.read', state: 'executed', status: 'done', approval_status: null }],
    trace: trace(label),
  };
};
const jobTrace = (jobId) => {
  const isA = jobId === JOB_A;
  return {
    job: { job_id: jobId, request_id: `fixture-request-${isA ? 'a' : 'b'}`, status: 'done', target: 'tool', source: 'agent_client',
      client_app_id: members[isA ? 0 : 1].client_app_id, thread_id: isA ? 101 : 102, conversation_audit_id: CONVERSATION_ID,
      client_turn_id: 'fixture-turn-1', created_at: timestamp(3), raw_input: '脱敏查询参数（FIXTURE）',
      result: { text: `授权 ${isA ? 'A' : 'B'} 查询完成（FIXTURE）` }, dispatch: {} },
    trace: trace(isA ? 'A' : 'B'),
  };
};
const user = { username: 'FIXTURE 审计用户', via: 'fixture', role: 'auditor', perms: ['runs:read'], capabilities: { modules: ['runs'] } };
const positiveInteger = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

export function fixtureApi(url) {
  const path = url.pathname;
  if (path === '/health') return { ok: true, status: 'ok', fixture: true };
  if (path === '/branding') return {
    site_name: 'FIXTURE · 百灵中枢', browser_title: 'FIXTURE · 客户端会话审计验收', site_description: '仅本地脱敏 UI fixture',
    site_keywords: ['fixture'], login_heading: '本地 UI 验收', login_subheading: '全部记录为合成样本',
    has_logo: false, has_favicon: false, logo_url: null, favicon_url: null, revision: 'fixture', updated_at: null,
  };
  if (path === '/me' || path === '/admin/api/me') return user;
  if (path === '/runs' || path === '/admin/api/runs') return [];
  if (path === '/admin/api/status') return { executors: [] };
  if (path === '/admin/api/demo-dataset/status') return { installed: true, can_import: false, available: false, imported: true, empty: false };
  if (['/admin/api/credentials', '/admin/api/targets', '/admin/api/tool-providers', '/admin/api/clients', '/admin/api/routes'].includes(path)) return [];
  if (path === '/admin/api/conversation-audits') {
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const limit = Math.min(100, positiveInteger(url.searchParams.get('limit'), 50));
    const all = [conversation, history], items = all.slice(offset, offset + limit);
    const has_more = offset + items.length < all.length;
    return { schema: 'bailing.agent-conversation-audit-list.v1', items, has_more, next_offset: has_more ? offset + items.length : null };
  }
  const detail = path.match(/^\/admin\/api\/conversation-audits\/([^/]+)$/);
  if (detail && [CONVERSATION_ID, HISTORY_ID].includes(detail[1])) {
    const isHistory = detail[1] === HISTORY_ID;
    const after = Math.max(0, Number(url.searchParams.get('after_sequence')) || 0);
    const requestedLimit = Math.min(100, positiveInteger(url.searchParams.get('limit'), 100));
    const remaining = (isHistory ? [] : events).filter(item => item.sequence > after);
    const page = remaining.slice(0, after === 0 ? Math.min(3, requestedLimit) : requestedLimit);
    const has_more = remaining.length > page.length;
    return { schema: 'bailing.agent-conversation-audit-detail.v1', conversation: isHistory ? history : conversation,
      members: isHistory ? [legacyMember] : members, events: page, has_more,
      next_after_sequence: has_more ? page.at(-1).sequence : null };
  }
  if (path === '/admin/api/threads') return threads;
  const threadDetail = path.match(/^\/admin\/api\/threads\/(101|102)$/);
  if (threadDetail) {
    const id = Number(threadDetail[1]), label = id === 101 ? 'A' : 'B', runId = id === 101 ? RUN_A : RUN_B;
    return { thread: thread(id), messages: [
      { id: 1, direction: 'in', content: `[FIXTURE] 查询示例授权 ${label} 的业务对象`, created_at: timestamp(2), agent_run_id: runId },
      { id: 2, direction: 'out', content: `仅授权 ${label} 执行摘要（FIXTURE），不是客户端完整答复。`, created_at: timestamp(5), agent_run_id: runId },
    ] };
  }
  const run = path.match(/^\/admin\/api\/threads\/(101|102)\/agent-runs\/([^/]+)\/trace$/);
  if (run && ((run[1] === '101' && run[2] === RUN_A) || (run[1] === '102' && run[2] === RUN_B))) return runTrace(Number(run[1]), run[2]);
  const job = path.match(/^\/admin\/api\/runs\/(fixture-job-[ab])\/trace$/);
  if (job) return jobTrace(job[1]);
  return undefined;
}

function sendJson(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-bailing-fixture': 'synthetic-only' });
  response.end(JSON.stringify(data));
}
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' };

export function createFixtureServer() {
  return createServer(async (request, response) => {
    if (request.method !== 'GET') {
      response.setHeader('allow', 'GET');
      sendJson(response, 405, { error: 'FIXTURE: only GET is allowed; no data can be changed.' });
      return;
    }
    try {
      const url = new URL(request.url || '/', `http://${HOST}:${PORT}`);
      const data = fixtureApi(url);
      if (data !== undefined) { sendJson(response, 200, data); return; }
      if (url.pathname.startsWith('/admin/api/')) { sendJson(response, 404, { error: 'FIXTURE: this API route is not defined.' }); return; }
      if (url.pathname === '/') { response.writeHead(302, { location: '/console/runs' }); response.end(); return; }
      const pathname = decodeURIComponent(url.pathname);
      const relative = pathname.replace(/^\/console\/?/, '').replace(/^\/+/, '');
      let filePath = resolve(BUILD_DIRECTORY, relative || 'index.html');
      if (filePath !== BUILD_DIRECTORY && !filePath.startsWith(`${BUILD_DIRECTORY}${sep}`)) { sendJson(response, 404, { error: 'FIXTURE: file not found.' }); return; }
      const isFile = await stat(filePath).then(value => value.isFile()).catch(() => false);
      if (!isFile && (pathname === '/console' || pathname.startsWith('/console/'))) filePath = resolve(BUILD_DIRECTORY, 'index.html');
      else if (!isFile) { sendJson(response, 404, { error: 'FIXTURE: file not found.' }); return; }
      const contents = await readFile(filePath);
      response.writeHead(200, { 'content-type': mimeTypes[extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-bailing-fixture': 'synthetic-only' });
      response.end(contents);
    } catch {
      sendJson(response, 500, { error: 'FIXTURE: UI build unavailable or request invalid.' });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createFixtureServer();
  server.once('error', () => { console.error('[FIXTURE ONLY] Unable to bind the local UI fixture.'); process.exitCode = 1; });
  server.listen(PORT, HOST, () => {
    console.log(`[FIXTURE ONLY] http://${HOST}:${PORT}/console/runs`);
    console.log('[FIXTURE ONLY] Synthetic API data; GET only; no upstream or real service access.');
    console.log(`[FIXTURE ONLY] Main conversation: ${CONVERSATION_ID}; first event page ends at sequence 3.`);
  });
}
