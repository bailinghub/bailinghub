# 百灵中枢 Node SDK

业务系统侧 SDK，用来生成工具源 OpenAPI、签发聊天访客票据、校验中枢工具调用签名、校验 callback 签名、实现 authorize 探针，并调用中枢 `/run`、`/jobs/{id}`、`/send`。

## 安装

```bash
npm install @bailinghub/connect
```

仓库内本地验证：

```bash
node sdk/node/examples/build-spec.mjs > tools.json
node sdk/node/examples/build-spec.mjs | npm run sdk:test-node
```

## 生成工具源

```js
import { buildOpenApiSpec, param, tool } from '@bailinghub/connect';

const spec = buildOpenApiSpec({
  title: 'CRM 工具源',
  version: '1.0.0',
  authzProbe: { method: 'POST', path: '/.well-known/bailing/authz-probe' },
  tools: [
    tool({
      name: 'member_query',
      method: 'GET',
      path: '/api/members/{id}',
      description: '查询会员基础资料',
      scope: 'member.read',
      requiresSubject: true,
      params: [
        param('id', { in: 'path', required: true, description: '会员 ID' })
      ]
    }),
    tool({
      name: 'refund_request_create',
      method: 'POST',
      path: '/api/refunds/requests',
      description: '创建退款申请',
      scope: 'refund.request',
      risk: 'medium',
      requiresSubject: true,
      confirmWhen: [{ param: 'amount', op: '>', value: 500, label: '超过 500 元退款需人工确认' }],
      params: [
        param('order_id', { required: true, description: '订单 ID' }),
        param('amount', { type: 'number', required: true, description: '退款金额，单位元' }),
        param('reason', { required: true, description: '退款原因' })
      ]
    })
  ]
});

console.log(JSON.stringify(spec, null, 2));
```

## 验签与授权

```js
import { verifyToolCall } from '@bailinghub/connect';

const rawBody = await request.text();
const pathWithQuery = new URL(request.url).pathname + new URL(request.url).search;
const onBehalfOf = request.headers.get('x-bailing-on-behalf-of') || '';
const jobId = request.headers.get('x-bailing-job-id') || '';

const ok = verifyToolCall(process.env.BAILING_TOOL_SECRET, {
  method: request.method,
  pathWithQuery,
  body: rawBody,
  timestamp: request.headers.get('x-bailing-timestamp'),
  signature: request.headers.get('x-bailing-signature'),
  onBehalfOf,
  jobId
});

if (!ok) return new Response('bad signature', { status: 401 });
if (!await canUserReadMember(onBehalfOf)) return new Response('forbidden', { status: 403 });
```

验签只证明请求来自中枢，不代表这个主体有权限执行该动作。业务工具端点必须先验签，再按 `X-Bailing-On-Behalf-Of` 走自身权限表做授权裁决。

## 访客票据与 HubClient

```js
import { HubClient, signTicket } from '@bailinghub/connect';

const ticket = signTicket(process.env.BAILING_CLIENT_TOKEN, `${tenantId}:${userId}`);

const hub = new HubClient({
  baseUrl: 'https://hub.example.com',
  token: process.env.BAILING_CLIENT_TOKEN,
});

const job = await hub.run({
  requestId: `crm_${orderId}`,
  route: 'order-support',
  input: '查询订单处理建议',
  metadata: { principal: { id: String(userId), tenant: String(tenantId) } },
});

const result = await hub.getJob(job.job_id);
await hub.send({ requestId: `notice_${orderId}`, channel: 'team-im', to: 'user_001', text: '任务已完成' });
```
