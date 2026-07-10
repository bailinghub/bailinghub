// 契约级 selftest：只测冻结的信封 v1（docs/CONTRACT.md）——鉴权矩阵 / 触发与幂等语义 / 隔离 / 执行器通道 / RBAC / 降级。
// 刻意不测内部实现与 UI（那些还在演进，测它们=给自己上枷锁；契约是冻结的，测它不会churn）。
// 用法：npm run selftest [-- <hubUrl> <serverToken>]   缺省读 config.json（executor.hub_url + server.token）。
// 自带夹具（selftest-* 前缀），结束清理；产生的 done 任务留作历史无害。
import { createHmac } from 'node:crypto';
import { loadConfig } from '../src/core/config/config';

const cfg = loadConfig();
// 用 || 而非 ??：config 里的空串（hubUrl:"" 等）也回落默认，否则 HUB="" → spec_url 拼成 "/health" 崩 ERR_INVALID_URL
const HUB = (process.argv[2] || cfg.executor.hubUrl || `http://127.0.0.1:${cfg.server.port}`).replace(/\/$/, '');
const TOKEN = process.argv[3] || cfg.server.token || cfg.executor.token;
if (!TOKEN) { console.error('缺 server token：传参或在 config.json 配置'); process.exit(1); }

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? '  ← ' + extra : ''}`); }
}

interface Resp { status: number; json: any; setCookie: string }
async function req(method: string, path: string, opts: { token?: string; body?: unknown; cookie?: string } = {}): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.cookie) headers['cookie'] = opts.cookie;
  const r = await fetch(HUB + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(15000) });
  let json: any = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json, setCookie: r.headers.get('set-cookie') ?? '' };
}

function acc(scope: string, opts: Record<string, unknown> = {}): Record<string, unknown> {
  const capability: Record<string, unknown> = { version: 1, enabled: true, scope };
  if (typeof opts.risk === 'string' && opts.risk !== 'low') capability.risk = { level: opts.risk };
  if (opts.requiresSubject === true) capability.subject = { required: true };
  if (opts.confirm === true || Array.isArray(opts.confirmWhen) || typeof opts.confirmPrompt === 'string') {
    const approval: Record<string, unknown> = {};
    if (opts.confirm === true) approval.required = true;
    if (Array.isArray(opts.confirmWhen)) approval.when = opts.confirmWhen;
    if (typeof opts.confirmPrompt === 'string') approval.prompt = opts.confirmPrompt;
    capability.approval = approval;
  }
  return capability;
}

const SUF = Math.random().toString(36).slice(2, 7); // request_id 防与上次运行残留撞号
const T = { target: 'selftest-exec', route: 'selftest-route', a: 'selftest-a', b: 'selftest-b', acct: 'selftest-kbe' };
const PWD = `Selftest_${SUF}_pw`;
let chatEntryKey = ''; // 聊天入口钥由服务端生成，清理时回填

console.log(`契约 selftest → ${HUB}\n`);
try {
  console.log('— 健康与鉴权');
  ok('health 200', (await req('GET', '/health')).status === 200);
  ok('无 token 触发 → 401', (await req('POST', '/run', { body: { request_id: 'x', input: 'x' } })).status === 401);
  ok('坏 token → 401', (await req('POST', '/run', { token: 'bad' + SUF, body: { request_id: 'x', input: 'x' } })).status === 401);

  console.log('— 夹具（目标/路由/两个接入方/工具源）');
  ok('注册执行器目标', (await req('POST', '/admin/api/targets', { token: TOKEN, body: { name: T.target, kind: 'executor', description: 'selftest 专用' } })).status === 200);
  // 工具源先于路由注册（路由 tools 校验 provider 必须已存在）；base_url 指向必拒端口——契约只测"调用走通全闸"，不真打业务
  const stSpec = JSON.stringify({ openapi: '3.0.0', info: { title: 'st', version: '1' }, paths: {
    '/x/list': { get: { summary: 'demo 列表', 'x-agent-capability': acc('st.demo.read') } },
    '/x/del': { post: { summary: '无 schema 的写接口', 'x-agent-capability': acc('st.demo.delete') } },
    '/x/secure': { get: { summary: '需操作主体的接口', 'x-agent-capability': acc('st.demo.secure', { requiresSubject: true }) } },
    '/x/old': { get: { summary: '弃用接口', 'x-agent-capability': acc('st.demo.read'), deprecated: true } },
  } });
  const tpReg = await req('POST', '/admin/api/tool-providers', { token: TOKEN, body: { name: 'selftest-tp', base_url: 'http://127.0.0.1:9', secret: `st_${SUF}`, spec_source: 'inline', spec_json: stSpec } });
  ok('注册工具源', tpReg.status === 200);
  // 注册期 authorize 探针：base_url 必拒端口 → 探针网络失败 = inconclusive；且应优先选中 requires-subject 的 GET（/x/secure）不碰写接口
  ok('注册触发 authorize 探针（必拒端口→inconclusive，选中 requires-subject GET）', tpReg.json?.authz_probe?.status === 'inconclusive' && tpReg.json?.authz_probe?.requires_subject === true);
  // url 模式 + 自动刷新：spec_url 指向中枢自己的 /health（合法 JSON、0 工具）——只测签名拉取链路与对账字段，不依赖外部夹具
  ok('注册 url 模式工具源（带自动刷新）', (await req('POST', '/admin/api/tool-providers', { token: TOKEN, body: { name: 'selftest-tp-url', base_url: 'http://127.0.0.1:9', secret: `stu_${SUF}`, spec_source: 'url', spec_url: `${HUB}/health`, auto_refresh_min: 7 } })).status === 200);
  const tpRefresh = await req('POST', '/admin/api/tool-providers/selftest-tp-url/refresh', { token: TOKEN });
  ok('手动刷新拉取成功 + 对账字段', tpRefresh.status === 200 && tpRefresh.json?.tools === 0 && Array.isArray(tpRefresh.json?.added) && Array.isArray(tpRefresh.json?.removed) && Array.isArray(tpRefresh.json?.changed));
  const tpList = (await req('GET', '/admin/api/tool-providers', { token: TOKEN })).json as any[];
  ok('auto_refresh_min 入库回显', tpList?.find((x) => x.name === 'selftest-tp-url')?.auto_refresh_min === 7);
  ok('建路由（挂工具白名单）', (await req('POST', '/admin/api/routes', { token: TOKEN, body: { route_key: T.route, name: 'selftest', target: T.target, session_policy: 'new', profile: 'readonly', tools: { sources: [{ provider: 'selftest-tp', allow: ['st.demo.read', 'st.demo.secure'] }], max_calls: 3 } } })).status === 200);
  const ca = (await req('POST', '/admin/api/clients', { token: TOKEN, body: { app_id: T.a, name: 'selftest A', allowed_routes: [T.route], rate_limit_per_min: 3 } })).json;
  const cb = (await req('POST', '/admin/api/clients', { token: TOKEN, body: { app_id: T.b, name: 'selftest B', allowed_routes: [T.route], rate_limit_per_min: 60 } })).json;
  ok('接入方发钥', !!ca?.token && !!cb?.token);

  console.log('— 接入方策略闸门');
  ok('client 不带 route → 403', (await req('POST', '/run', { token: ca.token, body: { request_id: `st_${SUF}_g1`, input: 'x' } })).status === 403);
  ok('client 自带 profile → 403', (await req('POST', '/run', { token: ca.token, body: { request_id: `st_${SUF}_g2`, route: T.route, profile: 'x', input: 'x' } })).status === 403);
  ok('白名单外路由 → 403', (await req('POST', '/run', { token: ca.token, body: { request_id: `st_${SUF}_g3`, route: 'not-allowed-' + SUF, input: 'x' } })).status === 403);

  console.log('— 触发 / 幂等 / 隔离');
  const run1 = await req('POST', '/run', { token: ca.token, body: { request_id: `st_${SUF}_main`, route: T.route, input: 'selftest 载荷' } });
  ok('触发 202 + job_id', run1.status === 202 && !!run1.json?.job_id);
  const again = await req('POST', '/run', { token: ca.token, body: { request_id: `st_${SUF}_main`, route: T.route, input: '换内容也应撞回同单' } });
  ok('同 request_id 幂等同 job', again.status === 202 && again.json?.job_id === run1.json?.job_id);
  ok('跨方 request_id 撞号 → 409', (await req('POST', '/run', { token: cb.token, body: { request_id: `st_${SUF}_main`, route: T.route, input: 'x' } })).status === 409);
  ok('B 查 A 的 job → 404', (await req('GET', '/jobs/' + run1.json?.job_id, { token: cb.token })).status === 404);
  const mine = await req('GET', '/jobs/' + run1.json?.job_id, { token: ca.token });
  ok('A 查自己的 job → 200 queued', mine.status === 200 && mine.json?.status === 'queued');

  console.log('— 限速');
  // A 限速 3/分钟：main + again 已耗 2 槽，再来一单占满，第四单应 429
  const r3 = await req('POST', '/run', { token: ca.token, body: { request_id: `st_${SUF}_rate3`, route: T.route, input: 'x' } });
  ok('第 3 单仍 202', r3.status === 202);
  ok('第 4 单 → 429', (await req('POST', '/run', { token: ca.token, body: { request_id: `st_${SUF}_rate4`, route: T.route, input: 'x' } })).status === 429);

  console.log('— 主动出站 /send（鉴权闸 + 校验，不实发）');
  // B 未授权任何渠道（allowed_channels 默认空 = fail-closed）；用 B（限速 60，槽位充足）测闸门
  ok('缺字段 → 400', (await req('POST', '/send', { token: cb.token, body: { request_id: `st_${SUF}_s0`, channel: 'x' } })).status === 400);
  ok('未授权渠道 → 403', (await req('POST', '/send', { token: cb.token, body: { request_id: `st_${SUF}_s1`, channel: `no-such-ch-${SUF}`, to: 'u1', text: 'x' } })).status === 403);
  ok('admin 推不存在的渠道 → 400', (await req('POST', '/send', { token: TOKEN, body: { request_id: `st_${SUF}_s2`, channel: `no-such-ch-${SUF}`, to: 'u1', text: 'x' } })).status === 400);

  console.log('— 聊天入口（公开面：无 token 可用，靠入口钥+Origin 白名单+IP 限速）');
  const ce = await req('POST', '/admin/api/chat-entries', { token: TOKEN, body: { name: 'selftest 聊天', route_key: T.route, greeting: 'selftest 问候', ticket_client: T.a } });
  chatEntryKey = String(ce.json?.entry_key ?? '');
  ok('建聊天入口（服务端发公开 entry_key）', ce.status === 200 && /^pub_[0-9a-f]{16}$/.test(chatEntryKey));
  ok('入口配置公开可取', (await req('GET', `/chat/${chatEntryKey}/config`)).status === 200);
  const chat1 = await req('POST', `/chat/${chatEntryKey}`, { body: { message: 'selftest 你好', wait_ms: 1 } });
  ok('公开发消息 → 受理待答（无需任何 token）', chat1.status === 200 && chat1.json?.done === false && !!chat1.json?.job_id && !!chat1.json?.visitor_id);
  ok('结果轮询 → 仍在处理', (await req('GET', `/chat/${chatEntryKey}/result/${chat1.json?.job_id}`)).json?.done === false);
  ok('未知入口 → 404', (await req('POST', '/chat/pub_' + '0'.repeat(16), { body: { message: 'x' } })).status === 404);
  // 评价契约：只能评自己问出来的那条
  ok('评价回答（up）', (await req('POST', `/chat/${chatEntryKey}/rate/${chat1.json?.job_id}`, { body: { rating: 'up', visitor_id: chat1.json?.visitor_id } })).status === 200);
  ok('别人不能替评 → 404', (await req('POST', `/chat/${chatEntryKey}/rate/${chat1.json?.job_id}`, { body: { rating: 'down', visitor_id: 'someone-else-1' } })).status === 404);
  // 访客票据契约：业务后端用接入方 token 签发，可信身份进 metadata；坏票明确 401
  const tPayload = Buffer.from(JSON.stringify({ uid: 'st-user-9', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const tk = `v1.${tPayload}.${createHmac('sha256', ca.token).update(tPayload).digest('hex')}`;
  const chat2 = await req('POST', `/chat/${chatEntryKey}`, { body: { message: 'selftest 带票', wait_ms: 1, ticket: tk } });
  ok('带票发消息 → 受理', chat2.status === 200 && chat2.json?.done === false);
  const jobView = await req('GET', '/admin/api/runs/' + chat2.json?.job_id, { token: TOKEN });
  ok('票据身份进 metadata.visitor_uid', jobView.json?.metadata?.visitor_uid === 'st-user-9');
  ok('坏票 → 401', (await req('POST', `/chat/${chatEntryKey}`, { body: { message: 'x', ticket: 'v1.AAAA.' + '0'.repeat(64) } })).status === 401);

  console.log('— 执行器通道契约（本脚本亲自当执行器）');
  // 排干式认领：循环领到队列空。契约只承诺"队列里的都会被认领"，不承诺亚秒级 FIFO 排序；
  // 顺带清掉历史 selftest 异常中断留下的滞留任务（防止给积压告警留尾巴）。
  const queuedIds = new Set([run1.json?.job_id, r3.json?.job_id]);
  const drained: string[] = [];
  let firstJob: any = null;
  let toolsTested = false;
  for (let i = 0; i < 10; i++) {
    const c = await req('POST', '/executor/claim', { token: TOKEN, body: { executor_id: 'selftest-runner', targets: [T.target], wait_ms: 1 } });
    const j = c.json?.job;
    if (!j) break;
    if (!firstJob) firstJob = j;
    // —— 统一工具面契约（在回报终态前测：tool_token 终态即失效）——
    if (!toolsTested && j.job_id === run1.json?.job_id) {
      toolsTested = true;
      ok('认领件带工具面（defs + tool_token）', Array.isArray(j.tools?.defs) && j.tools.defs.length === 1 && !!j.tools.tool_token && j.tools.invoke_url === `/jobs/${j.job_id}/tools/invoke`);
      // 白名单含 st.demo.secure（requires-subject），但本任务无操作主体 → 装配层直接过滤，AI 看不到
      ok('requires-subject 工具对无主体任务被装配过滤', !j.tools.defs.some((d: any) => String(d.scope) === 'st.demo.secure'));
      ok('defs 携带 readonly/idempotent 标记', j.tools.defs[0]?.readonly === true && j.tools.defs[0]?.idempotent === true);
      const inv = (tok: string, body: unknown) => req('POST', `/jobs/${j.job_id}/tools/invoke`, { token: tok, body });
      ok('坏 tool_token → 401', (await inv('bad' + SUF, { tool: 'get_x_list' })).status === 401);
      const miss = await inv(String(j.tools?.tool_token ?? ''), { tool: 'no-such-tool' });
      ok('白名单外工具被拒（清单之外走不到执行）', miss.status === 200 && miss.json?.ok === false);
      const real = await inv(String(j.tools?.tool_token ?? ''), { tool: 'get_x_list', arguments: {} });
      ok('白名单内工具走通全闸（外发失败如实回流）', real.status === 200 && real.json?.ok === false && String(real.json?.text ?? '').includes('调用失败'));
    }
    drained.push(j.job_id);
    await req('POST', '/executor/result', { token: TOKEN, body: { job_id: j.job_id, ok: true, output: { text: 'selftest done' } } });
  }
  ok('本套件两单均被认领并回报', [...queuedIds].every((id) => drained.includes(id)), `drained=${drained.length}`);
  ok('工具面契约已覆盖', toolsTested);
  ok('认领件带完整工作项', !!firstJob?.input && !!firstJob?.session);
  const fin = await req('GET', '/jobs/' + run1.json?.job_id, { token: ca.token });
  ok('终态 done + result 回流', fin.json?.status === 'done' && fin.json?.result?.text === 'selftest done');

  console.log('— 渐进式披露（工具数 > 阈值 → 目录 + 按需取定义）');
  const bigPaths: Record<string, unknown> = {};
  for (let i = 1; i <= 13; i++) {
    bigPaths[`/big/t${String(i).padStart(2, '0')}`] = { get: { operationId: `big_t${String(i).padStart(2, '0')}`, summary: `大清单工具 ${i}`, 'x-agent-capability': acc(`st.big.read${i}`) } };
  }
  ok('注册大清单夹具（13 工具源+目标+路由）',
    (await req('POST', '/admin/api/tool-providers', { token: TOKEN, body: { name: 'selftest-tp-big', base_url: 'http://127.0.0.1:9', secret: `stb_${SUF}`, spec_source: 'inline', spec_json: JSON.stringify({ openapi: '3.0.0', info: { title: 'big', version: '1' }, paths: bigPaths }) } })).status === 200
    && (await req('POST', '/admin/api/targets', { token: TOKEN, body: { name: 'selftest-big-exec', kind: 'executor' } })).status === 200
    && (await req('POST', '/admin/api/routes', { token: TOKEN, body: { route_key: 'selftest-big-route', name: 'selftest-big', target: 'selftest-big-exec', session_policy: 'new', profile: 'readonly', tools: { sources: [{ provider: 'selftest-tp-big', allow: ['st.big.*'] }], max_calls: 3 } } })).status === 200);
  const bigRun = await req('POST', '/run', { token: TOKEN, body: { request_id: `st_${SUF}_big`, route: 'selftest-big-route', input: '渐进披露契约载荷' } });
  const bigClaim = await req('POST', '/executor/claim', { token: TOKEN, body: { executor_id: 'selftest-runner', targets: ['selftest-big-exec'], wait_ms: 1 } });
  const bj = bigClaim.json?.job;
  ok('认领件为目录模式（catalog + defs_url，无全量 defs）',
    bj?.tools?.mode === 'catalog' && bj?.tools?.catalog?.length === 13 && !bj?.tools?.defs && String(bj?.tools?.defs_url ?? '').endsWith('/tools/defs'));
  ok('目录条目轻量（一句话摘要，无参数 schema）', !!bj?.tools?.catalog?.[0]?.summary && bj?.tools?.catalog?.[0]?.parameters === undefined);
  const defsR = await req('GET', `${bj?.tools?.defs_url}?names=big_t03,big_t07,no-such`, { token: String(bj?.tools?.tool_token ?? '') });
  ok('按需取定义（未知名忽略，含完整参数 schema）',
    defsR.status === 200 && defsR.json?.defs?.length === 2 && !!defsR.json.defs[0]?.parameters && defsR.json.defs.map((d: any) => d.name).join(',') === 'big_t03,big_t07');
  ok('坏 token 取定义 → 401', (await req('GET', `${bj?.tools?.defs_url}?names=big_t01`, { token: 'bad' + SUF })).status === 401);
  await req('POST', '/executor/result', { token: TOKEN, body: { job_id: bj?.job_id, ok: true, output: { text: 'big done' } } });
  void bigRun;

  console.log('— RBAC（kb_editor 会话）');
  ok('建 kb_editor 账号', (await req('POST', '/admin/api/admins', { token: TOKEN, body: { username: T.acct, role: 'kb_editor', password: PWD } })).status === 200);
  const login = await req('POST', '/admin/login', { body: { username: T.acct, password: PWD } });
  const cookie = login.setCookie.split(';')[0] ?? '';
  ok('登录拿到会话 Cookie', login.status === 200 && cookie.startsWith('bz_sess='));
  const me = await req('GET', '/admin/api/me', { cookie });
  ok('me 角色与权限正确', me.json?.role === 'kb_editor' && Array.isArray(me.json?.perms) && me.json.perms.includes('kb:write'));
  ok('kb_editor 读路由 → 403', (await req('GET', '/admin/api/routes', { cookie })).status === 403);
  ok('kb_editor 读知识库 → 200', (await req('GET', '/admin/api/kb', { cookie })).status === 200);
  ok('kb_editor 摸执行器通道 → 403', (await req('POST', '/executor/claim', { cookie, body: { targets: ['claude-code'] } })).status === 403);

  console.log('— 工具源契约（鉴权执行层）');
  const tp = await req('GET', '/admin/api/tool-providers/selftest-tp/tools', { token: TOKEN });
  ok('spec 派生工具清单（GET 进、无 schema 写接口被跳过）',
    tp.status === 200 && tp.json?.tools?.length === 2 && tp.json?.skipped?.length === 2);
  ok('deprecated 接口被跳过且注明原因', (tp.json?.skipped ?? []).some((s: any) => String(s.path).includes('/x/old') && String(s.reason).includes('deprecated')));
  ok('挂未注册工具源的路由被拒 → 400', (await req('POST', '/admin/api/routes', { token: TOKEN, body: { route_key: 'st-tool-' + SUF, target: T.target, session_policy: 'new', tools: { sources: [{ provider: 'no-such-' + SUF, allow: ['x.read'] }] } } })).status === 400);
  ok('不存在的审批单 → 404', (await req('POST', '/admin/api/tool-approvals/999999999/approve', { token: TOKEN, body: {} })).status === 404);

  console.log('— 降级与拒绝语义');
  ok('未知 kb 检索 → 400 优雅拒绝', (await req('POST', '/kb/search', { token: TOKEN, body: { kb_id: 'no-such-' + SUF, query: 'x' } })).status === 400);
  ok('入库插座：未知 kb 推文档 → 404', (await req('PUT', `/kb/no-such-${SUF}/docs/k1`, { token: cb.token, body: { title: 'x', content: 'x' } })).status === 404);
  ok('入库插座：未知 kb 删文档 → 404', (await req('DELETE', `/kb/no-such-${SUF}/docs/k1`, { token: cb.token } )).status === 404);
  ok('数据源：未知 kb → 404', (await req('GET', `/admin/api/kb/no-such-${SUF}/datasources`, { token: TOKEN })).status === 404);
  ok('未知 route → 400', (await req('POST', '/run', { token: TOKEN, body: { request_id: `st_${SUF}_u`, route: 'no-such-' + SUF, input: 'x' } })).status === 400);
  ok('未知 target 路由被拒 → 400', (await req('POST', '/admin/api/routes', { token: TOKEN, body: { route_key: 'st-bad-' + SUF, target: 'no-such-target-' + SUF, session_policy: 'new' } })).status === 400);
} finally {
  console.log('— 清理夹具');
  for (const p of [
    `/admin/api/clients/${T.a}`, `/admin/api/clients/${T.b}`,
    `/admin/api/routes/${T.route}`, `/admin/api/targets/${T.target}`, `/admin/api/admins/${T.acct}`,
    '/admin/api/tool-providers/selftest-tp', '/admin/api/tool-providers/selftest-tp-url',
    '/admin/api/routes/selftest-big-route', '/admin/api/targets/selftest-big-exec', '/admin/api/tool-providers/selftest-tp-big',
    ...(chatEntryKey ? [`/admin/api/chat-entries/${chatEntryKey}`] : []),
    '/admin/api/executors/selftest-runner', // 认领留下的心跳记录：不删会触发"执行器离线"误报
  ]) await req('DELETE', p, { token: TOKEN }).catch(() => { /* 尽力而为 */ });
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
