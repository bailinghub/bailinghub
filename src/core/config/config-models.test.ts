import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareAlertRuleConfig,
  prepareChannelConfig,
  prepareChatEntryConfig,
  prepareClientConfig,
  prepareCredentialConfig,
  prepareExecutorTokenConfig,
  preparePageContextConfig,
  prepareStorageBucketConfig,
  prepareTargetConfig,
  prepareToolProviderConfig,
} from './config-models';
import type { ToolProvider } from '../contracts/types';

test('prepareClientConfig: 规范化接入方并校验预算', () => {
  const ok = prepareClientConfig({
    app_id: ' app-main ',
    name: ' 主业务 ',
    allowed_routes: [' chat.main ', ''],
    allowed_channels: [' ops-wecom '],
    rate_limit_per_min: '0' as any,
    budget: { window: 'day', hard_tokens: 1000 },
    description: '  demo  ',
  });

  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.value, {
    app_id: 'app-main',
    name: '主业务',
    allowed_routes: ['chat.main'],
    allowed_channels: ['ops-wecom'],
    rate_limit_per_min: 0,
    budget: { window: 'day', hard_tokens: 1000 },
    enabled: true,
    description: 'demo',
  });

  const bad = prepareClientConfig({ app_id: 'bad id', name: 'x', allowed_routes: ['*'] });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /app_id/);

  const badBudget = prepareClientConfig({ app_id: 'app-main', name: 'x', allowed_routes: ['*'], budget: { hard_tokens: 1.2 } });
  assert.equal(badBudget.ok, false);
  assert.match(badBudget.ok ? '' : badBudget.error, /client\.budget\.hard_tokens/);
});

test('prepareExecutorTokenConfig: target 白名单不能为空', () => {
  const ok = prepareExecutorTokenConfig({ name: ' runner-main ', allowed_targets: [' llm ', ''] });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.value.allowed_targets, ['llm']);

  const bad = prepareExecutorTokenConfig({ name: 'runner-main', allowed_targets: [] });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /allowed_targets/);
});

test('prepareCredentialConfig: 规范化凭证用途并保留 api_key 编辑语义', () => {
  const ok = prepareCredentialConfig({
    name: ' main-chat ',
    kind: 'both',
    base_url: ' https://llm.example.com/v1 ',
    api_key: ' ',
    default_model: ' qwen-plus ',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.deepEqual(ok.value, {
    name: 'main-chat',
    kind: 'both',
    base_url: 'https://llm.example.com/v1',
    api_key: '',
    default_model: 'qwen-plus',
    enabled: true,
    description: undefined,
  });

  const bad = prepareCredentialConfig({ name: 'main-chat' });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /base_url/);
});

test('prepareTargetConfig: inhub 目标必须有内置适配器，自定义目标走 executor', () => {
  const ok = prepareTargetConfig({ name: ' llm ', kind: 'inhub', timeout_ms: '9999999' as any }, {
    hasInhubAdapter: (name) => name === 'llm',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.kind, 'inhub');
  assert.equal(ok.value.timeout_ms, 3600000);

  const bad = prepareTargetConfig({ name: 'custom-agent', kind: 'inhub' }, { hasInhubAdapter: () => false });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /inhub 类目标/);
});

test('prepareStorageBucketConfig: COS 要求 region，URL 去尾斜杠并补默认路径', () => {
  const ok = prepareStorageBucketConfig({
    name: ' chat-cos ',
    kind: 'cos',
    region: ' ap-shanghai ',
    bucket: ' bailing-123 ',
    public_base_url: 'https://cdn.example.com///',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.public_base_url, 'https://cdn.example.com');
  assert.equal(ok.value.path_prefix, 'bailing/chat');

  const bad = prepareStorageBucketConfig({ name: 'chat-cos', kind: 'cos', bucket: 'b', public_base_url: 'https://cdn.example.com' });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /COS 必须填地域/);

  const local = prepareStorageBucketConfig({ name: ' local-media ', kind: 'local' });
  assert.equal(local.ok, true);
  if (!local.ok) return;
  assert.equal(local.value.kind, 'local');
  assert.equal(local.value.bucket, 'local');
  assert.equal(local.value.public_base_url, '');
});

test('prepareChannelConfig: 企微新建必须带 token/aes_key，编辑可留空交给仓储保留', async () => {
  const bad = await prepareChannelConfig({ name: 'ops-wecom', kind: 'wecom', route_key: 'chat.main', config: {} }, {
    isNew: async () => true,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /Token 与 EncodingAESKey/);

  const ok = await prepareChannelConfig({
    name: 'ops-wecom',
    kind: 'wecom',
    route_key: ' chat.main ',
    config: { token: '', aes_key: '', reply_wait_ms: 9999, bucket: ' uploads ' },
  }, { isNew: async () => false });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.config.reply_wait_ms, 4500);
  assert.equal(ok.value.config.bucket, 'uploads');
});

test('prepareAlertRuleConfig: 校验渠道引用、收件人和冷却范围', async () => {
  const ok = await prepareAlertRuleConfig({
    id: 7,
    event_prefix: ' executor_offline_very_long_prefix '.repeat(4),
    channel: ' ops-wecom ',
    recipients: [' zhangsan ', '', 'lisi'],
    cooldown_min: 9999,
    description: 'x'.repeat(300),
  }, { channelExists: async (name) => name === 'ops-wecom' });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.id, 7);
  assert.equal(ok.value.channel, 'ops-wecom');
  assert.deepEqual(ok.value.recipients, ['zhangsan', 'lisi']);
  assert.equal(ok.value.cooldown_min, 1440);
  assert.equal(ok.value.event_prefix.length, 64);
  assert.equal(ok.value.description?.length, 255);

  const bad = await prepareAlertRuleConfig({ channel: 'missing', recipients: ['u'] }, { channelExists: async () => false });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /渠道 missing 不存在/);
});

test('prepareChatEntryConfig: 生成入口、校验引用并收紧外观', async () => {
  const ok = await prepareChatEntryConfig({
    name: ' 官网客服 ',
    route_key: ' chat.main ',
    allowed_origins: [' https://example.com/// ', ''],
    ticket_client: 'app-main',
    bucket: 'chat-cos',
    rate_limit_per_min: 9999,
    title: 'T'.repeat(80),
    greeting: 'G'.repeat(300),
    color: '#12abef',
    appearance: {
      width: 9999,
      height: 100,
      title_align: 'left',
      position: 'right',
      offset_x: -3,
      offset_y: 900,
      avatar: 'https://cdn.example.com/a.png',
      launcher_icon: 'javascript:bad',
      resizable: true,
      ai_notice: false,
      powered_by_visible: false,
      powered_by_text: '  由示例业务驱动  ',
    },
  }, {
    routeExists: async (key) => key === 'chat.main',
    entryExists: async () => false,
    clientExists: async (appId) => appId === 'app-main',
    bucketExists: async (name) => name === 'chat-cos',
  });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.match(ok.value.entry_key, /^pub_[a-f0-9]{16}$/);
  assert.deepEqual(ok.value.allowed_origins, ['https://example.com']);
  assert.equal(ok.value.rate_limit_per_min, 600);
  assert.equal(ok.value.title?.length, 64);
  assert.equal(ok.value.greeting?.length, 255);
  assert.deepEqual(ok.value.appearance, {
    width: 720,
    height: 360,
    title_align: 'left',
    position: 'right',
    offset_x: 0,
    offset_y: 400,
    avatar: 'https://cdn.example.com/a.png',
    resizable: true,
    ai_notice: false,
    powered_by_visible: false,
    powered_by_text: '由示例业务驱动',
  });

  const missingRoute = await prepareChatEntryConfig({ name: 'x', route_key: 'missing' }, {
    routeExists: async () => false,
    entryExists: async () => false,
    clientExists: async () => true,
    bucketExists: async () => true,
  });
  assert.equal(missingRoute.ok, false);
  assert.match(missingRoute.ok ? '' : missingRoute.error, /路由 missing 不存在/);
});

test('preparePageContextConfig: 页面上下文只接受寻址字段，不开放 kb_tag 写入', async () => {
  const ok = await preparePageContextConfig({
    id: '9',
    entry_key: 'pub_demo',
    url_pattern: ' */member/list* ',
    page_key: 'member-list-too-long'.repeat(8),
    page_name: '会员列表',
    description: 'd'.repeat(1200),
    kb_tag: 'should-ignore',
    priority: '12',
    enabled: false,
  }, { entryExists: async (key) => key === 'pub_demo' });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.id, 9);
  assert.equal(ok.value.url_pattern, '*/member/list*');
  assert.equal(ok.value.page_key?.length, 64);
  assert.equal(ok.value.description?.length, 1000);
  assert.equal(ok.value.kb_tag, undefined);
  assert.equal(ok.value.priority, 12);
  assert.equal(ok.value.enabled, false);

  const bad = await preparePageContextConfig({ entry_key: 'missing', url_pattern: '*' }, { entryExists: async () => false });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.error, /聊天入口 missing 不存在/);
});

test('prepareToolProviderConfig: 编辑留空时保留现有密钥并校验 spec/source 与向量维度', () => {
  const old: ToolProvider = {
    name: 'biz-tools',
    base_url: 'https://old.example.com',
    spec_source: 'inline',
    spec_json: '{"openapi":"3.1.0"}',
    secret: 'old-secret',
    log_payload: true,
    timeout_ms: 10000,
    rate_limit_per_min: 120,
    auto_refresh_min: 0,
    enabled: true,
  };
  const ok = prepareToolProviderConfig({
    name: ' biz-tools ',
    base_url: 'https://biz.example.com///',
    secret: '',
    spec_source: 'inline',
    spec_json: '{"openapi":"3.1.0","paths":{}}',
    timeout_ms: 999999,
    embed_credential: ' embed-main ',
    embed_model: ' text-embedding ',
    embed_dim: '1024',
  }, old);
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.value.secret, 'old-secret');
  assert.equal(ok.value.base_url, 'https://biz.example.com');
  assert.equal(ok.value.timeout_ms, 60000);
  assert.equal(ok.value.embed_credential, 'embed-main');
  assert.equal(ok.value.embed_dim, 1024);

  const badSpecUrl = prepareToolProviderConfig({ name: 'biz-tools', base_url: 'https://biz.example.com', secret: 's', spec_source: 'url' });
  assert.equal(badSpecUrl.ok, false);
  assert.match(badSpecUrl.ok ? '' : badSpecUrl.error, /spec_url/);

  const badSpec = prepareToolProviderConfig({ name: 'biz-tools', base_url: 'https://biz.example.com', secret: 's', spec_json: '{bad' });
  assert.equal(badSpec.ok, false);
  assert.match(badSpec.ok ? '' : badSpec.error, /JSON 或 YAML/);

  const yamlSpec = prepareToolProviderConfig({
    name: 'yaml-tools', base_url: 'https://biz.example.com', secret: 's',
    spec_json: 'openapi: 3.0.0\ninfo:\n  title: Demo\n  version: "1"\npaths: {}',
  });
  assert.equal(yamlSpec.ok, true);
  if (yamlSpec.ok) assert.deepEqual(JSON.parse(yamlSpec.value.spec_json ?? ''), { openapi: '3.0.0', info: { title: 'Demo', version: '1' }, paths: {} });

  const badDim = prepareToolProviderConfig({ name: 'biz-tools', base_url: 'https://biz.example.com', secret: 's', embed_dim: '1.2' });
  assert.equal(badDim.ok, false);
  assert.match(badDim.ok ? '' : badDim.error, /embed_dim/);
});
