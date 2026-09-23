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

## 可选模型套餐与登录

`UsageIssuerClient` 使用独立的服务端 Usage issuer 凭据，提供 `exchangeSession`、`revokeUser`、`listBillingPlans`、`getBillingSummary`、`grantBillingPlan` 和 `controlBillingPlan`。不要复用业务 Client Token，也不要把 issuer 凭据或管理方法交给浏览器或模型。

业务后端根据已验证登录提交 `request_key/tenant/subject/generation/service_id` 换取短期模型凭证。`model_access: "service"` 限定所选模型；显式 `"token_gateway"` 可在身份来源及套餐允许的模型交集中选择，不扩大业务权限。只将短期凭证和固定身份交给对应使用人。登录不依赖套餐摘要成功；未开通套餐通过摘要的 `grant=null` 表达。

`grantBillingPlan(accountId, input)` 的 input 包含原 `request_key`、`plan_id`、`expected_revision`。`controlBillingPlan(accountId, input)` 使用原请求键、当前修订和 `state: active|suspended`。`getBillingSummary(accountId)` 读取当前账户美元余额、实际费用与周期状态，不执行模型。向用户展示时只使用摘要 `presentation`：额度包显示积分，周期套餐显示剩余百分比；美元字段用于计费核账；原始 Token 用量保留在模型请求明细中。售价、收款和合同由业务系统负责。

套餐管理统一使用 `/usage/v1/external/billing/`。套餐目录返回 `config.priceUsd`、周期套餐必填的 `config.periodAllowanceUsd`、`periodUnit`、`duration`、`serviceIds` 和 `multiplier`。周期套餐售价与每周期额度是两个独立字段；账户摘要使用 `bailing.billing-summary.v1`，美元余额为 `availableUsd`，已消费为 `consumedUsd`，客户展示使用 `presentation`。

管理写入不会自动重试。回包丢失时沿原键、原参数核对，不能换新键重复发放。异常只包含脱敏错误码、`outcome`、`requestKey` 和安全反馈。`revokeUser` 按原 tenant/subject/generation 幂等停用，不需要 request_key。

完整契约见 [模型服务与套餐计费](../../docs/MODEL_BILLING.md)。安装业务 SDK 本身不接管本地模型流量；客户端接入模型请求/流式入口后才会计量。


示例将准备和发送分开：先调用 `prepareBillingPlan` 并持久化 `grantInput`，再调用 `applyBillingPlan`；回包不确定时沿用已保存的输入，不能重新计算修订。服务端开通示例见 [examples/billing.mjs](examples/billing.mjs)。TypeScript 可通过 `import { UsageIssuerClient, type BillingSummary } from "@bailinghub/connect/usage"` 获取完整的套餐与身份类型。
