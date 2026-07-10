import { createHash, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const host = process.env.DEMO_HOST || '127.0.0.1';
const port = Number(process.env.DEMO_PORT || 19080);
const secret = process.env.DEMO_TOOL_SECRET || 'demo-tool-secret-change-me';
const clientToken = process.env.DEMO_CLIENT_TOKEN || 'bailing-demo-client-token';
const hubUrl = (process.env.DEMO_HUB_URL || 'http://localhost:18900').replace(/\/+$/, '');

const principals = new Map([
  ['demo-user-001', { uid: 'demo-user-001', tenant: 'demo-shop', name: 'Alice' }],
  ['demo-user-002', { uid: 'demo-user-002', tenant: 'demo-shop', name: 'Bob' }],
]);

const orders = [
  { order_no: 'SO-1001', tenant: 'demo-shop', customer: 'Alice', item: 'AI 咨询套餐', amount: 199, status: 'paid', logistics: '待发货' },
  { order_no: 'SO-1002', tenant: 'demo-shop', customer: 'Alice', item: '门店会员年卡', amount: 699, status: 'paid', logistics: '已完成' },
  { order_no: 'SO-2001', tenant: 'demo-shop', customer: 'Bob', item: '智能客服坐席', amount: 299, status: 'pending', logistics: '未付款' },
];
const tickets = [];
const refunds = [];
const approvals = [];

function acc(scope, opts = {}) {
  const capability = { version: 1, enabled: true, scope };
  if (opts.risk && opts.risk !== 'low') capability.risk = { level: opts.risk };
  if (opts.requiresSubject) capability.subject = { required: true };
  if (opts.confirm || opts.confirmPrompt || opts.confirmWhen) {
    capability.approval = {};
    if (opts.confirm) capability.approval.required = true;
    if (opts.confirmWhen) capability.approval.when = opts.confirmWhen;
    if (opts.confirmPrompt) capability.approval.prompt = opts.confirmPrompt;
  }
  const execution = {};
  if (opts.readonly === true) execution.readonly = true;
  if (opts.idempotent === false) execution.idempotent = false;
  if (opts.timeoutMs) execution.timeout_ms = opts.timeoutMs;
  if (opts.rateLimit) execution.rate_limit = opts.rateLimit;
  if (Object.keys(execution).length) capability.execution = execution;
  if (opts.sensitive) capability.audit = { sensitive: true };
  const guidance = {};
  if (opts.whenToUse) guidance.when_to_use = opts.whenToUse;
  if (opts.returns) guidance.returns = opts.returns;
  if (opts.examples) guidance.examples = opts.examples;
  if (opts.context) guidance.context = opts.context;
  if (Object.keys(guidance).length) capability.guidance = guidance;
  return capability;
}

const toolSpec = {
  openapi: '3.1.0',
  info: { title: 'Bailing demo business tools', version: '1.0.0' },
  'x-bailing-authz-probe': { method: 'POST', path: '/.well-known/bailing/authz-probe' },
  paths: {
    '/orders': {
      get: {
        operationId: 'list_demo_orders',
        summary: '查询当前操作主体可见的订单列表',
        description: '按订单号或客户名查询 demo 订单。无过滤条件时返回当前主体可见的最近订单。',
        'x-agent-capability': acc('demo.order.read', {
          requiresSubject: true,
          whenToUse: '用户询问订单状态、付款状态、物流状态或历史订单时使用。',
          returns: '订单号、客户、商品、金额、状态、物流状态。',
        }),
        parameters: [
          { name: 'order_no', in: 'query', required: false, description: '订单号，例如 SO-1001。用户没给订单号时不要编造。', schema: { type: 'string' } },
          { name: 'customer', in: 'query', required: false, description: '客户名，可用于模糊过滤。', schema: { type: 'string' } },
        ],
      },
    },
    '/tickets': {
      post: {
        operationId: 'create_demo_ticket',
        summary: '为当前操作主体创建售后工单',
        description: '当用户明确要求登记问题、创建工单或需要人工跟进时使用。',
        'x-agent-capability': acc('demo.ticket.create', {
          risk: 'medium',
          requiresSubject: true,
          idempotent: false,
          whenToUse: '用户要求人工处理、售后跟进、开工单或记录问题时使用。',
          returns: '工单编号与当前状态。',
        }),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  order_no: { type: 'string', description: '关联订单号，例如 SO-1001。' },
                  title: { type: 'string', description: '工单标题，简短概括用户问题。' },
                  message: { type: 'string', description: '工单正文，记录用户诉求和已查询到的关键信息。' },
                },
                required: ['title', 'message'],
              },
            },
          },
        },
      },
    },
    '/refunds': {
      post: {
        operationId: 'request_demo_refund',
        summary: '提交退款申请',
        description: '高风险示例工具：会产生退款申请，必须进入中枢审批车道。',
        'x-agent-capability': acc('demo.refund.request', {
          risk: 'high',
          confirm: true,
          requiresSubject: true,
          confirmPrompt: '确认要为订单 {{order_no}} 申请退款 {{amount}} 元吗？',
        }),
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  order_no: { type: 'string', description: '订单号。' },
                  amount: { type: 'number', description: '退款金额。' },
                  reason: { type: 'string', description: '退款原因。' },
                },
                required: ['order_no', 'amount', 'reason'],
              },
            },
          },
        },
      },
    },
    '/failure-demo': {
      get: {
        operationId: 'demo_failure_probe',
        summary: '触发一个可观测失败',
        description: '用于演示中枢 trace 如何记录业务工具 5xx、错误正文和排障路径。',
        'x-agent-capability': acc('demo.failure.read', { requiresSubject: true }),
      },
    },
  },
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function textOf(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function signToolCall(ts, method, pathWithQuery, body, onBehalfOf = '', jobId = '') {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const mac = createHmac('sha256', secret).update(`${ts}.${method}.${pathWithQuery}.${bodyHash}.${onBehalfOf}.${jobId}`).digest('hex');
  return `sha256=${mac}`;
}

function signBody(ts, body, signSecret) {
  return `sha256=${createHmac('sha256', signSecret).update(`${ts}.${body}`).digest('hex')}`;
}

function equal(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function verifyToolSignatureOnly(req, rawBody, url) {
  const ts = String(req.headers['x-bailing-timestamp'] || '');
  const sig = String(req.headers['x-bailing-signature'] || '');
  const subject = String(req.headers['x-bailing-on-behalf-of'] || '');
  const jobId = String(req.headers['x-bailing-job-id'] || '');
  if (!ts || !sig.startsWith('sha256=')) return { ok: false, status: 401, error: 'missing signature' };
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(ts)) > 300) return { ok: false, status: 401, error: 'stale signature' };
  const expected = signToolCall(ts, req.method || 'GET', url.pathname + url.search, rawBody, subject, jobId);
  if (!equal(sig, expected)) return { ok: false, status: 401, error: 'bad signature' };
  return { ok: true, subject, jobId };
}

function verifyTool(req, rawBody, url) {
  const sig = verifyToolSignatureOnly(req, rawBody, url);
  if (!sig.ok) return sig;
  const principal = principals.get(sig.subject);
  if (!principal) return { ok: false, status: 403, error: 'unknown or unauthorized subject' };
  return { ok: true, principal };
}

function verifyCallback(req, rawBody) {
  const ts = String(req.headers['x-bailing-timestamp'] || '');
  const sig = String(req.headers['x-bailing-signature'] || '');
  if (!ts || !sig.startsWith('sha256=')) return false;
  if (Math.abs(Date.now() - Number(ts)) > 5 * 60 * 1000) return false;
  return equal(sig, signBody(ts, rawBody, clientToken));
}

function parseJson(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

function parseForm(raw) {
  const data = new URLSearchParams(raw);
  return Object.fromEntries(data.entries());
}

function escapeHtml(v) {
  return String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function decisionPayload(approval, decision) {
  return {
    kind: 'tool_approval_decision',
    schema_version: 'bailing.approval-decision.v1',
    approval_id: Number(approval.approval_id),
    job_id: approval.job_id,
    request_id: approval.request_id,
    args_hash: approval.args_hash,
    decision,
    decision_id: `demo-${approval.approval_id}-${decision}`,
    approver: 'demo-manager',
    comment: decision === 'approved' ? 'demo business approved' : 'demo business denied',
  };
}

async function sendApprovalDecision(approval, decision) {
  const payload = decisionPayload(approval, decision);
  const resp = await fetch(`${hubUrl}${approval.decision_path || `/approvals/${approval.approval_id}/decision`}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${clientToken}`,
    },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!resp.ok) throw new Error(`Hub decision HTTP ${resp.status}: ${text.slice(0, 300)}`);
  approval.status = decision;
  approval.decided_at = new Date().toISOString();
  approval.decision_id = payload.decision_id;
  approval.decision_response = body;
  return body;
}

function renderPage() {
  const orderRows = orders.map((o) => `<tr><td>${o.order_no}</td><td>${o.customer}</td><td>${o.item}</td><td>${o.amount}</td><td>${o.status}</td><td>${o.logistics}</td></tr>`).join('');
  const ticketRows = tickets.slice().reverse().map((t) => `<tr><td>${t.ticket_id}</td><td>${t.order_no || '-'}</td><td>${escapeHtml(t.title)}</td><td>${t.status}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无工单</td></tr>';
  const refundRows = refunds.slice().reverse().map((r) => `<tr><td>${r.refund_id}</td><td>${r.order_no}</td><td>${r.amount}</td><td>${r.status}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">暂无退款申请</td></tr>';
  const approvalRows = approvals.slice().reverse().map((a) => {
    const approvedPayload = decisionPayload(a, 'approved');
    const curl = `curl -X POST ${hubUrl}${a.decision_path || `/approvals/${a.approval_id}/decision`} \\
  -H 'content-type: application/json' \\
  -H 'authorization: Bearer ${clientToken}' \\
  -d '${JSON.stringify(approvedPayload)}'`;
    const actions = a.status === 'pending'
      ? `<form class="approval-actions" method="post" action="/api/approvals/${a.approval_id}/decision">
          <button class="button button--approve" type="submit" name="decision" value="approved">批准</button>
          <button class="button button--deny" type="submit" name="decision" value="denied">拒绝</button>
        </form>`
      : `<div class="decision">已裁决：<b>${escapeHtml(a.status)}</b>${a.decision_id ? ` · <code>${escapeHtml(a.decision_id)}</code>` : ''}</div>`;
    return `<article class="approval">
      <div><b>#${a.approval_id}</b> ${escapeHtml(a.tool)} <span class="tag">${escapeHtml(a.risk)}</span> <span class="tag tag--status">${escapeHtml(a.status)}</span></div>
      <p>${escapeHtml(a.summary || a.reason || '待审批工具调用')}</p>
      <pre>${escapeHtml(JSON.stringify(a.args || {}, null, 2))}</pre>
      ${actions}
      ${a.decision_response ? `<details><summary>中枢决策响应</summary><pre>${escapeHtml(JSON.stringify(a.decision_response, null, 2))}</pre></details>` : ''}
      <details><summary>复制审批决策示例</summary><pre>${escapeHtml(curl)}</pre></details>
    </article>`;
  }).join('') || '<div class="empty">暂无审批意图。可在控制台发起“给 SO-1001 退款 199 元”的 demo 请求。</div>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Bailing Demo Business</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0d10; color: #e8eaed; }
    body { margin: 0; padding: 28px; }
    .wrap { max-width: 1180px; margin: 0 auto; display: grid; gap: 18px; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; }
    h1 { margin: 0; font-size: 26px; }
    p { color: #a7adb7; line-height: 1.7; }
    a { color: #57d178; text-decoration: none; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    section, .approval { border: 1px solid #252a33; border-radius: 8px; background: #12151a; padding: 16px; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { border-bottom: 1px solid #252a33; padding: 8px; text-align: left; }
    th { color: #a7adb7; font-weight: 500; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { background: #0b0d10; border: 1px solid #252a33; border-radius: 6px; padding: 10px; overflow: auto; color: #d7dae0; }
    .links { display: flex; gap: 12px; flex-wrap: wrap; }
    .tag { display: inline-block; color: #ffcf66; border: 1px solid #6b5630; border-radius: 999px; padding: 1px 7px; font-size: 12px; margin-left: 6px; }
    .tag--status { color: #8ee6a3; border-color: #2f6540; }
    .approval-actions { display: flex; gap: 8px; margin: 12px 0; }
    .button { border: 0; border-radius: 6px; padding: 8px 12px; cursor: pointer; color: #06100a; font-weight: 700; }
    .button--approve { background: #57d178; }
    .button--deny { background: #ff7777; }
    .decision { margin: 12px 0; color: #c9ced8; }
    .muted, .empty { color: #7f8794; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } body { padding: 16px; } }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <h1>Demo 业务系统</h1>
        <p>用于开源体验：订单查询、售后工单、高风险退款审批、故障 trace 排障。</p>
      </div>
      <nav class="links">
        <a href="/health">Health</a>
        <a href="/.well-known/bailing/tools.json">Tools Spec</a>
        <a href="${hubUrl}/console/">中枢控制台</a>
      </nav>
    </header>
    <section>
      <h2>订单</h2>
      <table><thead><tr><th>订单号</th><th>客户</th><th>商品</th><th>金额</th><th>状态</th><th>物流</th></tr></thead><tbody>${orderRows}</tbody></table>
    </section>
    <div class="grid">
      <section>
        <h2>售后工单</h2>
        <table><thead><tr><th>工单</th><th>订单</th><th>标题</th><th>状态</th></tr></thead><tbody>${ticketRows}</tbody></table>
      </section>
      <section>
        <h2>退款申请</h2>
        <table><thead><tr><th>退款单</th><th>订单</th><th>金额</th><th>状态</th></tr></thead><tbody>${refundRows}</tbody></table>
      </section>
    </div>
    <section id="approvals">
      <h2>业务侧审批意图</h2>
      ${approvalRows}
    </section>
  </div>
</body>
</html>`;
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    html(res, 200, renderPage());
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, app: 'demo-business' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/bailing/tools.json') {
    json(res, 200, toolSpec);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    json(res, 200, { orders, tickets, refunds, approvals });
    return;
  }

  const raw = await textOf(req);

  const decisionMatch = req.method === 'POST' ? url.pathname.match(/^\/api\/approvals\/(\d+)\/decision$/) : null;
  if (decisionMatch) {
    const approval = approvals.find((a) => Number(a.approval_id) === Number(decisionMatch[1]));
    if (!approval) { json(res, 404, { error: 'approval not found' }); return; }
    const body = req.headers['content-type']?.includes('application/x-www-form-urlencoded') ? parseForm(raw) : (parseJson(raw) || {});
    const decision = body.decision === 'denied' ? 'denied' : 'approved';
    try {
      await sendApprovalDecision(approval, decision);
      res.writeHead(303, { location: '/#approvals' });
      res.end();
    } catch (e) {
      approval.decision_error = e instanceof Error ? e.message : String(e);
      json(res, 502, { error: approval.decision_error });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/approvals') {
    if (!verifyCallback(req, raw)) { json(res, 401, { error: 'bad callback signature' }); return; }
    const body = parseJson(raw);
    if (!body) { json(res, 400, { error: 'invalid json' }); return; }
    const approval = {
      ...body,
      status: 'pending',
      received_at: new Date().toISOString(),
    };
    approvals.push(approval);
    json(res, 200, { ok: true, approval_id: body.approval_id, stored: true });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/.well-known/bailing/authz-probe') {
    const sig = verifyToolSignatureOnly(req, raw, url);
    if (!sig.ok) { json(res, sig.status, { error: sig.error }); return; }
    const body = parseJson(raw) || {};
    const subject = String(body.subject || sig.subject || '');
    json(res, 200, { authorized: principals.has(subject), subject });
    return;
  }

  const auth = verifyTool(req, raw, url);
  if (!auth.ok) {
    json(res, auth.status, { error: auth.error });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/orders') {
    const orderNo = url.searchParams.get('order_no')?.trim().toLowerCase();
    const customer = url.searchParams.get('customer')?.trim().toLowerCase();
    const visible = orders.filter((o) => o.tenant === auth.principal.tenant);
    const filtered = visible.filter((o) => {
      if (orderNo && !o.order_no.toLowerCase().includes(orderNo)) return false;
      if (customer && !o.customer.toLowerCase().includes(customer)) return false;
      return true;
    });
    json(res, 200, { subject: auth.principal.uid, orders: filtered.slice(0, 20) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/tickets') {
    const body = parseJson(raw);
    if (!body) { json(res, 400, { error: 'invalid json' }); return; }
    const ticket = {
      ticket_id: `T-${randomUUID().slice(0, 8)}`,
      subject: auth.principal.uid,
      order_no: String(body.order_no || ''),
      title: String(body.title || '未命名工单').slice(0, 80),
      message: String(body.message || '').slice(0, 1000),
      status: 'open',
      created_at: new Date().toISOString(),
    };
    tickets.push(ticket);
    json(res, 200, ticket);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/refunds') {
    const body = parseJson(raw);
    if (!body) { json(res, 400, { error: 'invalid json' }); return; }
    const refund = {
      refund_id: `R-${randomUUID().slice(0, 8)}`,
      subject: auth.principal.uid,
      order_no: String(body.order_no || ''),
      amount: Number(body.amount || 0),
      reason: String(body.reason || ''),
      status: 'submitted',
      created_at: new Date().toISOString(),
    };
    refunds.push(refund);
    json(res, 202, refund);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/failure-demo') {
    json(res, 500, {
      error: 'demo intentional failure',
      hint: '这是 demo 故障工具，用于在中枢 trace 中观察业务工具 5xx、响应正文和排障路径。',
      subject: auth.principal.uid,
    });
    return;
  }

  json(res, 404, { error: 'not found' });
}).listen(port, host, () => {
  console.log(`[demo-business] listening http://${host}:${port}`);
});
