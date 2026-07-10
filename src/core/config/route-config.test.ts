// 覆盖：路由配置模型的保存前校验与规范化。
// 路由是开源框架的核心契约，入口层不应散落理解各配置块的细节。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRouteConfig,
  prepareRouteConfig,
  routeDeliveryConfig,
  routeKnowledgeConfig,
  routeRetryConfig,
  validateRouteConfig,
} from './route-config';

const deps = {
  targetExists: (target: string) => ['claude-code', 'llm', 'notify'].includes(target),
  targetNeedsProject: (target: string) => target === 'claude-code',
  toolProviderExists: async (name: string) => name === 'bn-server',
};
const defaults = { defaultProfile: 'default' };

test('prepareRouteConfig: 补齐默认值并清掉空配置块', async () => {
  const prepared = await prepareRouteConfig({
    route_key: ' staff.audit ',
    target: 'claude-code',
    project: 'example',
    target_config: {},
    delivery: {},
    retry: {},
    tools: {},
    audience: {},
    memory: {},
    budget: {},
  }, deps, defaults);

  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  assert.equal(prepared.route.route_key, 'staff.audit');
  assert.equal(prepared.route.name, 'staff.audit');
  assert.equal(prepared.route.profile, 'default');
  assert.equal(prepared.route.session_policy, 'new');
  assert.equal(prepared.route.delivery, undefined);
  assert.equal(prepared.route.retry, undefined);
  assert.equal(prepared.route.tools, undefined);
  assert.equal(prepared.route.audience, undefined);
  assert.equal(prepared.route.memory, undefined);
  assert.equal(prepared.route.budget, undefined);
});

test('normalizeRouteConfig: 未指定目标时使用通用 llm 目标', () => {
  const route = normalizeRouteConfig({ route_key: 'assistant.general' }, defaults);
  assert.equal(route.target, 'llm');
});

test('validateRouteConfig: route_key 必须是机器可读标识', async () => {
  const err = await validateRouteConfig({ route_key: '中文路由' }, deps, defaults);
  assert.match(err ?? '', /route_key 仅限/);
});

test('validateRouteConfig: 需要 project 的 target 必须填项目', async () => {
  const err = await validateRouteConfig({ route_key: 'code.review', target: 'claude-code' }, deps, defaults);
  assert.equal(err, 'target claude-code 需要 project');
});

test('validateRouteConfig: llm 必须配置 credential', async () => {
  const err = await validateRouteConfig({ route_key: 'chat.main', target: 'llm' }, deps, defaults);
  assert.equal(err, 'target=llm 时 target_config.credential 必填');
});

test('validateRouteConfig: llm input.image 配置要符合模式与调用上限', async () => {
  const err = await validateRouteConfig({
    route_key: 'chat.main',
    target: 'llm',
    target_config: { credential: 'main', input: { image: { mode: 'scan', max_calls: 99 } } },
  }, deps, defaults);
  assert.match(err ?? '', /target_config\.input\.image\.mode/);

  const err2 = await validateRouteConfig({
    route_key: 'chat.main',
    target: 'llm',
    target_config: { credential: 'main', input: { image: { mode: 'tool', max_calls: 99 } } },
  }, deps, defaults);
  assert.equal(err2, 'target_config.input.image.max_calls 必须是 1..30 的整数');
});

test('validateRouteConfig: webhook 送达必须有 url', async () => {
  const err = await validateRouteConfig({
    route_key: 'notify.webhook',
    target: 'notify',
    delivery: { type: 'webhook' },
  }, deps, defaults);
  assert.equal(err, 'delivery.type=webhook 时 delivery.url 必填');
});

test('validateRouteConfig: none 送达不需要收件人', async () => {
  const err = await validateRouteConfig({
    route_key: 'notify.none',
    target: 'notify',
    delivery: { type: 'none' },
  }, deps, defaults);
  assert.equal(err, null);
});

test('validateRouteConfig: channel 送达必须有 channel 且能定位收件人', async () => {
  const err = await validateRouteConfig({
    route_key: 'notify.channel',
    target: 'notify',
    delivery: { type: 'channel', channel: 'bn-wecom' },
  }, deps, defaults);
  assert.equal(err, 'delivery.type=channel 时 delivery.to 或 delivery.to_field 至少填一个');
});

test('validateRouteConfig: 自定义送达类型也必须能定位收件人', async () => {
  const err = await validateRouteConfig({
    route_key: 'notify.sms',
    target: 'notify',
    delivery: { type: 'sms' },
  }, deps, defaults);
  assert.equal(err, 'delivery.type=sms 时 delivery.to 或 delivery.to_field 至少填一个');
});

test('validateRouteConfig: knowledge 至少绑定一个知识库且数值在范围内', async () => {
  const err = await validateRouteConfig({
    route_key: 'kb.bad',
    target: 'notify',
    knowledge: { top_k: 100 },
  }, deps, defaults);
  assert.equal(err, 'knowledge.kb_id 或 knowledge.kb_ids 至少填一个');

  const err2 = await validateRouteConfig({
    route_key: 'kb.bad',
    target: 'notify',
    knowledge: { kb_id: 'main', top_k: 100 },
  }, deps, defaults);
  assert.equal(err2, 'knowledge.top_k 必须是 1..20 的整数');
});

test('validateRouteConfig: retry 与 memory 范围错误会提前拒绝', async () => {
  const err = await validateRouteConfig({
    route_key: 'retry.bad',
    target: 'notify',
    retry: { max: 9 },
  }, deps, defaults);
  assert.equal(err, 'retry.max 必须是 0..5 的整数');

  const err2 = await validateRouteConfig({
    route_key: 'memory.bad',
    target: 'notify',
    memory: { recent_messages: 0 },
  }, deps, defaults);
  assert.equal(err2, 'memory.recent_messages 必须是 1..50 的整数');
});

test('validateRouteConfig: budget 必须是合法预算策略', async () => {
  const err = await validateRouteConfig({
    route_key: 'budget.bad',
    target: 'notify',
    budget: { hard_tokens: 1.2 },
  }, deps, defaults);
  assert.equal(err, 'budget.hard_tokens 必须是正整数');
});

test('validateRouteConfig: audience 必须是合法受众策略', async () => {
  const err = await validateRouteConfig({
    route_key: 'audience.bad',
    target: 'notify',
    audience: { roles: 123 } as any,
  }, deps, defaults);
  assert.equal(err, 'audience.roles 必须是字符串或字符串数组');
});

test('validateRouteConfig: tools 校验复用工具模型规则', async () => {
  const err = await validateRouteConfig({
    route_key: 'tools.bad',
    target: 'notify',
    tools: { sources: [{ provider: 'missing', allow: ['x.*'] }] },
  }, deps, defaults);
  assert.match(err ?? '', /工具源 missing 未注册/);
});

test('normalizeRouteConfig: 保存前统一 trim 字符串并保留非空配置', () => {
  const route = normalizeRouteConfig({
    route_key: ' order.audit ',
    name: ' 订单审核 ',
    target: 'llm',
    target_config: { credential: 'main' },
    delivery: { type: 'webhook', url: 'https://biz.example.com/cb' },
    audience: { auto: true, priority: 9, keywords: '订单,审核', roles: [' ops '] } as any,
    budget: { window: 'day', hard_cost_usd: 2 },
    session_policy: 'fixed',
    session_fixed_id: ' s1 ',
  }, defaults);

  assert.equal(route.route_key, 'order.audit');
  assert.equal(route.name, '订单审核');
  assert.equal(route.target, 'llm');
  assert.deepEqual(route.target_config, { credential: 'main' });
  assert.deepEqual(route.delivery, { type: 'webhook', url: 'https://biz.example.com/cb' });
  assert.deepEqual(route.audience, { auto: true, priority: 9, keywords: ['订单', '审核'], roles: ['ops'] });
  assert.deepEqual(route.budget, { window: 'day', hard_cost_usd: 2 });
  assert.equal(route.session_fixed_id, 's1');
});

test('routeKnowledgeConfig: 运行期解析知识配置并补齐默认值', () => {
  assert.deepEqual(routeKnowledgeConfig({
    kb_ids: [' main ', '', 'policy'],
    top_k: 99,
    min_score: -1,
    inject: 'doc',
    page_boost: true,
  }), {
    kb_ids: ['main', 'policy'],
    top_k: 20,
    min_score: 0,
    inject: 'doc',
    max_docs: 4,
    page_boost: true,
  });
  assert.equal(routeKnowledgeConfig({}), null);
});

test('routeRetryConfig: 运行期解析重试配置并夹紧范围', () => {
  assert.deepEqual(routeRetryConfig({ max: 99, backoff_ms: 10 }), { max: 5, backoff_ms: 500 });
  assert.deepEqual(routeRetryConfig(null), { max: 0, backoff_ms: 5000 });
});

test('routeDeliveryConfig: 运行期只接受带 type 的送达配置', () => {
  assert.deepEqual(routeDeliveryConfig({ type: ' webhook ', url: 'https://biz.example.com/cb' }), {
    type: 'webhook',
    url: 'https://biz.example.com/cb',
  });
  assert.equal(routeDeliveryConfig({ url: 'https://biz.example.com/cb' }), null);
});
