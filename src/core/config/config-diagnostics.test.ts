import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectConfig, type ConfigDiagnosticsStore } from './config-diagnostics';
import type { AppConfig } from './config';
import type { AlertRule, Channel, ChatEntry, Client, Credential, ExecutorToken, ProjectReg, Route, StorageBucket, TargetDef, ToolProvider } from '../contracts/types';

function cfg(): AppConfig {
  return { defaultProfile: 'default' } as AppConfig;
}

function store(over: {
  routes?: Route[];
  targets?: TargetDef[];
  projects?: ProjectReg[];
  credentials?: Credential[];
  channels?: Channel[];
  providers?: ToolProvider[];
  buckets?: StorageBucket[];
  alerts?: AlertRule[];
  chats?: ChatEntry[];
  clients?: Client[];
  executorTokens?: ExecutorToken[];
  runtime?: Pick<ConfigDiagnosticsStore, 'observability' | 'executors' | 'deliveryDlq'>;
}): ConfigDiagnosticsStore {
  const routes = over.routes ?? [];
  const channels = over.channels ?? [];
  return {
    routes: {
      async list() { return routes; },
      async get(key) { return routes.find((r) => r.route_key === key) ?? null; },
    },
    clients: { async list() { return over.clients ?? []; } },
    credentials: { async list() { return over.credentials ?? []; } },
    channels: {
      async list() { return channels; },
    },
    toolProviders: { async list() { return over.providers ?? []; } },
    targets: { async list() { return over.targets ?? []; } },
    projects: { async list() { return over.projects ?? []; } },
    storageBuckets: { async list() { return over.buckets ?? []; } },
    alertRules: { async list() { return over.alerts ?? []; } },
    chatEntries: { async list() { return over.chats ?? []; } },
    executorTokens: { async list() { return over.executorTokens ?? []; } },
    ...(over.runtime ?? {}),
  };
}

const target: TargetDef = { name: 'llm', kind: 'inhub', stateless: true, needs_project: false, timeout_ms: 60_000, enabled: true };
const cred: Credential = { name: 'main-chat', kind: 'both', base_url: 'https://llm.example.com/v1', api_key: 'sk', enabled: true };
const embedCred: Credential = { name: 'main-embed', kind: 'embedding', base_url: 'https://llm.example.com/v1', api_key: 'sk', enabled: true };
const provider: ToolProvider = {
  name: 'biz-tools', base_url: 'https://biz.example.com', spec_source: 'inline', spec_json: '{"openapi":"3.1.0","paths":{}}',
  secret: 'secret', log_payload: true, timeout_ms: 10_000, rate_limit_per_min: 60, auto_refresh_min: 0, enabled: true,
  embed_credential: 'main-embed', embed_model: 'text-embedding', embed_dim: 1024,
};
const channel: Channel = { name: 'ops-wecom', kind: 'wecom', route_key: 'chat.main', config: { token: 't', aes_key: 'a'.repeat(43) }, enabled: true };
const route: Route = {
  route_key: 'chat.main', name: 'Chat', enabled: true, target: 'llm',
  target_config: { credential: 'main-chat' }, profile: 'default', session_policy: 'new',
  tools: { sources: [{ provider: 'biz-tools', allow: ['order.*'] }], builtin: { send_message: { channels: ['ops-wecom'] } } },
};

test('inspectConfig: 健康配置通过', async () => {
  const report = await inspectConfig(store({
    routes: [route],
    targets: [target],
    credentials: [cred, embedCred],
    providers: [provider],
    channels: [channel],
  }), { cfg: cfg() });

  assert.equal(report.ok, true);
  assert.equal(report.errors, 0);
});

test('inspectConfig: 文件凭证可供 llm 路由使用，config/DB 同名时明确告警固定优先级', async () => {
  const fileCfg = { ...cfg(), llmCredentials: {
    'file-only': { base_url: 'https://file.example.com/v1', api_key: 'file-key' },
    'main-chat': { base_url: 'https://override.example.com/v1', api_key: 'override-key' },
  } } as AppConfig;
  const fileRoute = { ...route, target_config: { credential: 'file-only' }, tools: undefined };
  const report = await inspectConfig(store({
    routes: [fileRoute],
    targets: [target],
    credentials: [cred],
  }), { cfg: fileCfg });

  assert.equal(report.errors, 0);
  assert.ok(report.diagnostics.some((d) => d.severity === 'warning'
    && d.area === 'credential'
    && d.id === 'main-chat'
    && d.message.includes('固定优先使用 config/env')));
  assert.equal(report.diagnostics.some((d) => d.message.includes('target_config.credential file-only 不存在')), false);
});

test('inspectConfig: 跨表引用错误和禁用引用会形成稳定诊断', async () => {
  const badRoute: Route = {
    ...route,
    route_key: 'bad.route',
    target_config: { credential: 'missing-chat' },
    knowledge: { kb_id: 'missing-kb' },
    tools: { sources: [{ provider: 'disabled-tools', allow: ['*'] }], builtin: { send_message: { channels: ['missing-channel', 'disabled-wecom'] } } },
  };
  const disabledProvider = { ...provider, name: 'disabled-tools', enabled: false };
  const disabledChannel = { ...channel, name: 'disabled-wecom', enabled: false };
  const report = await inspectConfig(store({
    routes: [badRoute],
    targets: [target],
    credentials: [cred],
    providers: [disabledProvider],
    channels: [disabledChannel],
    clients: [{ app_id: 'app-main', name: 'App', token: 'tok', allowed_routes: ['missing.route'], allowed_channels: ['missing-channel'], rate_limit_per_min: 60, enabled: true }],
    executorTokens: [{ name: 'runner', token: 'tok', allowed_targets: ['llm', 'missing-target'], enabled: true }],
  }), { cfg: cfg() });

  const messages = report.diagnostics.map((d) => `${d.severity}:${d.area}:${d.id}:${d.message}`);
  assert.equal(report.ok, false);
  assert.ok(messages.some((m) => m.includes('target_config.credential missing-chat')));
  assert.ok(messages.some((m) => m.includes('knowledge 引用的知识库 missing-kb 不存在')));
  assert.ok(messages.some((m) => m.includes('tools.builtin.send_message.channels 引用的渠道 missing-channel 不存在')));
  assert.ok(messages.some((m) => m.includes('tools.builtin.send_message.channels 引用的渠道 disabled-wecom 当前未启用')));
  assert.ok(messages.some((m) => m.includes('allowed_routes 引用的路由 missing.route 不存在')));
  assert.ok(messages.some((m) => m.includes('allowed_targets llm 不是 executor 类目标')));
  assert.ok(messages.some((m) => m.includes('allowed_targets 引用的 target missing-target 不存在')));
});

test('inspectConfig: 工具源授权探针结果进入体检', async () => {
  const suspectProvider: ToolProvider = {
    ...provider,
    authz_probe: {
      status: 'suspect',
      http: 200,
      tool: 'staff_list',
      requires_subject: true,
      reason: '疑似只验签未授权',
      at: '2026-07-01T12:00:00.000Z',
    },
  };
  const skippedProvider: ToolProvider = {
    ...provider,
    name: 'skipped-tools',
    authz_probe: {
      status: 'skipped',
      reason: '无适合探针的无参 GET 工具',
      at: '2026-07-01T12:00:00.000Z',
    },
  };

  const report = await inspectConfig(store({
    targets: [target],
    credentials: [cred, embedCred],
    providers: [suspectProvider, skippedProvider],
  }), { cfg: cfg() });

  const messages = report.diagnostics.map((d) => `${d.severity}:${d.area}:${d.id}:${d.message}`);
  assert.ok(messages.some((m) => m.includes('error:tool_provider:biz-tools:授权探针疑似只验签未授权')));
  assert.ok(messages.some((m) => m.includes('warning:tool_provider:skipped-tools:授权探针已跳过')));
});

test('inspectConfig: Audience 与 route=auto 规则进入配置体检', async () => {
  const autoA: Route = {
    ...route,
    route_key: 'order.refund',
    name: 'Refund',
    audience: { auto: true, keywords: ['退款'], clients: ['missing-app'], channels: ['missing-channel'] },
    tools: undefined,
  };
  const autoB: Route = {
    ...route,
    route_key: 'order.refund.manual',
    name: 'Refund Manual',
    audience: { auto: true, keywords: ['退款'] },
    tools: undefined,
  };
  const autoC: Route = {
    ...route,
    route_key: 'order.cancel',
    name: 'Cancel',
    audience: { auto: true, keywords: ['取消'] },
    tools: undefined,
  };
  const autoD: Route = {
    ...route,
    route_key: 'order.cancel.manual',
    name: 'Cancel Manual',
    audience: { auto: true, keywords: ['取消'] },
    tools: undefined,
  };
  const disabledAudience: Route = {
    ...route,
    route_key: 'order.audit',
    name: 'Audit',
    audience: { enabled: false, roles: ['ops'], auto: true },
    tools: undefined,
  };
  const client: Client = {
    app_id: 'app-main',
    name: 'App',
    token: 'tok',
    allowed_routes: ['auto', 'order.refund'],
    allowed_channels: [],
    rate_limit_per_min: 60,
    enabled: true,
  };

  const report = await inspectConfig(store({
    routes: [autoA, autoB, autoC, autoD, disabledAudience],
    targets: [target],
    credentials: [cred],
    clients: [client],
  }), { cfg: cfg() });

  const messages = report.diagnostics.map((d) => `${d.severity}:${d.area}:${d.id}:${d.message}`);
  assert.ok(messages.some((m) => m.includes('error:route_audience:order.refund:audience.clients 引用的接入方 missing-app 不存在')));
  assert.ok(messages.some((m) => m.includes('error:route_audience:order.refund:audience.channels 引用的渠道 missing-channel 不存在')));
  assert.ok(messages.some((m) => m.includes('warning:route_audience:order.audit:audience.enabled=false')));
  assert.ok(messages.some((m) => m.includes('warning:client:app-main:allowed_routes 不应配置 auto')));
  assert.ok(messages.some((m) => m.includes('warning:route_auto:order.cancel<->order.cancel.manual:route=auto 可能同分歧义')));
});

test('inspectConfig: 运行时队列、执行器和送达死信进入系统体检', async () => {
  const execTarget: TargetDef = { name: 'remote-agent', kind: 'executor', stateless: true, needs_project: false, timeout_ms: 60_000, enabled: true };
  const report = await inspectConfig(store({
    targets: [execTarget],
    runtime: {
      observability: {
        async dispatchStatus() {
          return {
            summary: { queued: 2, running: 1, dispatched: 1, delayed_queued: 1, expired_leases: 1, blocked_threads: 1 },
            by_target: [{ target: 'remote-agent', queued: 2, running: 0, dispatched: 0 }],
          };
        },
        async monitorSnapshot() { return { errors_15m: 2, oldest_queued_min: 35 }; },
      },
      executors: { async list() { return [{ executor_id: 'old', targets: ['remote-agent'], last_seen_at: new Date(Date.now() - 5 * 60_000).toISOString() }]; } },
      deliveryDlq: { async list() { return [{ id: 1, parent_job_id: 'job', channel: 'wecom', recipient: 'u1', error: 'fail', resolved: false, created_at: new Date().toISOString() }]; } },
    },
  }), { cfg: cfg() });

  const messages = report.diagnostics.map((d) => `${d.severity}:${d.area}:${d.id}:${d.message}`);
  assert.ok(messages.some((m) => m.includes('error:runtime_dispatch:expired_leases')));
  assert.ok(messages.some((m) => m.includes('warning:runtime_dispatch:blocked_threads')));
  assert.ok(messages.some((m) => m.includes('error:runtime_executor:remote-agent')));
  assert.ok(messages.some((m) => m.includes('warning:runtime_executor:offline')));
  assert.ok(messages.some((m) => m.includes('error:runtime_jobs:queued_backlog')));
  assert.ok(messages.some((m) => m.includes('warning:runtime_delivery:delivery_dlq')));
});
