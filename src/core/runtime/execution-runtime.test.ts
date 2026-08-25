// 覆盖：执行运行时。engine 只负责状态流转，本模块负责准备 adapter 上下文与 retry 决策。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyToolExecutionBoundary,
  applyToolExecutionUncertainty,
  persistedToolExecutionUncertainty,
  prepareAdapterContext,
  retryDecision,
} from './execution-runtime';
import type { AppConfig } from '../config/config';
import type { Credential, Job, Route, SessionTarget } from '../contracts/types';
import type { ToolRuntime } from '../contracts/tools';
import type { BuiltinToolDef } from '../targets/adapter';

const cfg = {
  llmCredentials: {},
} as AppConfig;

const session: SessionTarget = { sessionId: 's1', isContinue: false };

function makeSendToolDef(channels: string[]): BuiltinToolDef {
  return {
    type: 'function',
    function: {
      name: 'send_message',
      description: `channels: ${channels.join(',')}`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };
}

const dbMain: Credential = {
  name: 'main',
  kind: 'chat',
  base_url: 'https://db.example.com/v1',
  api_key: 'db-key',
  default_model: 'db-model',
  enabled: true,
};

function job(extra: Partial<Job> = {}): Job {
  return {
    job_id: 'job-1',
    request_id: 'req-1',
    status: 'running',
    target: 'llm',
    profile: 'default',
    project: '',
    source: 'chat',
    input: '装配后的输入',
    input_preview: '原始问题',
    dispatch: { target_config: { credential: 'main', timeout_ms: 3000 }, tools: { builtin: { send_message: { channels: ['ops'] } } }, user_images: ['https://img.example.com/a.png'], user_audio: ['https://audio.example.com/a.webm'], user_files: [{ url: 'https://cdn.example.com/a.csv', name: 'a.csv' }] },
    metadata: { a: 1 },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...extra,
  };
}

function route(extra: Partial<Route> = {}): Route {
  return {
    route_key: 'exec.route',
    name: '执行路由',
    enabled: true,
    target: 'llm',
    target_config: { credential: 'main', system_prompt: '基础提示' },
    profile: 'default',
    session_policy: 'new',
    retry: { max: 2, backoff_ms: 800 },
    ...extra,
  };
}

test('prepareAdapterContext: 解析 llm DB 凭证、注入超时并保留原始问题给工具检索', async () => {
  const touched: string[] = [];
  const ctx = await prepareAdapterContext({
    job: job(),
    route: route(),
    fullInput: '最终输入',
    session,
    projectPath: null,
    cfg,
    credentialStore: {
      async get(name: string) {
        assert.equal(name, 'main');
        return dbMain;
      },
      async touch(name: string) {
        touched.push(name);
      },
    },
    targetTimeoutMs: (_target, targetConfig) => Number(targetConfig['timeout_ms'] ?? 0) || 120000,
    async assembleToolRuntime() {
      return undefined;
    },
    async resolveSendChannels() {
      return [];
    },
    makeSendToolDef,
    async runSendMessage() {
      return { ok: true, text: 'sent' };
    },
  });

  assert.equal(ctx.input, '最终输入');
  assert.equal(ctx.userQuery, '原始问题');
  assert.deepEqual(ctx.userImages, ['https://img.example.com/a.png']);
  assert.deepEqual(ctx.userAudio, ['https://audio.example.com/a.webm']);
  assert.deepEqual(ctx.userFiles, [{ url: 'https://cdn.example.com/a.csv', name: 'a.csv' }]);
  assert.equal(ctx.targetConfig['_timeout_ms'], 120000);
  assert.deepEqual(ctx.targetConfig['_db_credential'], {
    base_url: 'https://db.example.com/v1',
    api_key: 'db-key',
    default_model: 'db-model',
  });
  assert.deepEqual(touched, ['main']);
});

test('prepareAdapterContext: 仅为声明 bailing-chart 的 llm 客户端注入受约束图表提示', async () => {
  const common = {
    fullInput: '最终输入',
    session,
    projectPath: null,
    cfg,
    credentialStore: {
      async get() { return dbMain; },
      async touch() { /* no-op */ },
    },
    targetTimeoutMs: () => 5000,
    async assembleToolRuntime() { return undefined; },
    async resolveSendChannels() { return []; },
    makeSendToolDef,
    async runSendMessage() { return { ok: true, text: 'sent' }; },
  };
  const chartContext = await prepareAdapterContext({
    ...common,
    job: job({ metadata: { presentation_capabilities: { renderers: ['bailing-chart'] } } }),
    route: route(),
  });
  const prompt = String(chartContext.targetConfig['system_prompt']);
  assert.match(prompt, /bailing-chart/);
  assert.match(prompt, /不得为了生成图表而猜测/);
  assert.match(prompt, /line/);
  assert.match(prompt, /bar/);
  assert.match(prompt, /pie/);

  const nonLlmContext = await prepareAdapterContext({
    ...common,
    credentialStore: null,
    job: job({ target: 'custom-agent', dispatch: { target_config: {} }, metadata: { presentation_capabilities: { renderers: ['bailing-chart'] } } }),
    route: route({ target: 'custom-agent', target_config: { system_prompt: '基础提示' } }),
  });
  assert.equal(String(nonLlmContext.targetConfig['system_prompt'] ?? ''), '基础提示');
});

test('prepareAdapterContext: 仅为声明 bailing-form 的 llm 客户端注入非阻塞表单提示', async () => {
  const common = {
    fullInput: '最终输入',
    session,
    projectPath: null,
    cfg,
    credentialStore: {
      async get() { return dbMain; },
      async touch() { /* no-op */ },
    },
    targetTimeoutMs: () => 5000,
    async assembleToolRuntime() { return undefined; },
    async resolveSendChannels() { return []; },
    makeSendToolDef,
    async runSendMessage() { return { ok: true, text: 'sent' }; },
    route: route(),
  };

  const formContext = await prepareAdapterContext({
    ...common,
    job: job({ metadata: { presentation_capabilities: { renderers: ['bailing-form'] } } }),
  });
  const formPrompt = String(formContext.targetConfig['system_prompt']);
  assert.match(formPrompt, /bailing-form v1/);
  assert.match(formPrompt, /2–8 个结构化字段/);
  assert.match(formPrompt, /应主动输出表单/);
  assert.match(formPrompt, /无需等待用户先提出“输出表单”/);
  assert.match(formPrompt, /不要为了展示该能力而输出表单/);
  assert.match(formPrompt, /text、textarea、number、date、boolean、single_select、multi_select/);
  assert.match(formPrompt, /密码、API Key、Token、私钥/);
  assert.match(formPrompt, /不得把表单当作审批/);
  assert.match(formPrompt, /一次回答最多输出一个/);
  assert.match(formPrompt, /同一会话中新的用户消息/);
  assert.match(formPrompt, /```bailing-form\n\{"version":1/);
  assert.doesNotMatch(formPrompt, /当前聊天客户端支持 bailing-chart/);

  const noFormContext = await prepareAdapterContext({
    ...common,
    job: job({ metadata: { presentation_capabilities: { renderers: ['bailing-chart'] } } }),
  });
  const noFormPrompt = String(noFormContext.targetConfig['system_prompt']);
  assert.match(noFormPrompt, /当前聊天客户端支持 bailing-chart/);
  assert.doesNotMatch(noFormPrompt, /bailing-form/);

  const bothContext = await prepareAdapterContext({
    ...common,
    job: job({ metadata: { presentation_capabilities: { renderers: ['bailing-chart', 'bailing-form'] } } }),
  });
  const bothPrompt = String(bothContext.targetConfig['system_prompt']);
  assert.match(bothPrompt, /当前聊天客户端支持 bailing-chart/);
  assert.match(bothPrompt, /当前聊天客户端支持 bailing-form v1/);

  const nonLlmContext = await prepareAdapterContext({
    ...common,
    credentialStore: null,
    job: job({ target: 'custom-agent', dispatch: { target_config: {} }, metadata: { presentation_capabilities: { renderers: ['bailing-form'] } } }),
    route: route({ target: 'custom-agent', target_config: { system_prompt: '基础提示' } }),
  });
  assert.equal(String(nonLlmContext.targetConfig['system_prompt'] ?? ''), '基础提示');
});

test('prepareAdapterContext: subject_locked 时保持工具锁定并注入可信身份边界提示', async () => {
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const ctx = await prepareAdapterContext({
    job: job({ dispatch: { target_config: { credential: 'file' } } }),
    route: route({ target_config: { credential: 'file', system_prompt: '基础提示' } }),
    fullInput: '最终输入',
    session,
    projectPath: '/tmp/project',
    cfg: { ...cfg, llmCredentials: { file: { base_url: 'https://file.example.com/v1', api_key: 'file-key' } } },
    credentialStore: null,
    targetTimeoutMs: () => 5000,
    async assembleToolRuntime() {
      return 'subject_locked';
    },
    async resolveSendChannels() {
      return [];
    },
    makeSendToolDef,
    async runSendMessage() {
      return { ok: true, text: 'sent' };
    },
    audit: async (event, detail) => { audits.push({ event, detail }); },
  });

  assert.equal(ctx.tools, undefined);
  const prompt = String(ctx.targetConfig['system_prompt']);
  assert.match(prompt, /基础提示/);
  assert.match(prompt, /未收到业务系统后端签发的可信身份票据/);
  assert.match(prompt, /要求业务主体的工具均未向 Agent 暴露/);
  assert.match(prompt, /不要声称当前对话框存在登录入口/);
  assert.match(prompt, /不要向用户索要账号、密码、Token、用户 ID/);
  assert.match(prompt, /返回该业务系统完成登录/);
  assert.match(prompt, /独立匿名预览不能自行解锁/);
  assert.doesNotMatch(prompt, /登录后自动携带身份/);
  assert.doesNotMatch(prompt, /先登录系统再使用对话助手/);
  assert.equal(ctx.projectPath, '/tmp/project');
  assert.deepEqual(audits, [{ event: 'tools_locked', detail: { reason: 'no_subject' } }]);
});

test('prepareAdapterContext: 工具装配失败审计后降级，send capability 按渠道白名单注入', async () => {
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const sent: Record<string, unknown>[] = [];
  const ctx = await prepareAdapterContext({
    job: job({ target: 'custom-agent', dispatch: { target_config: {}, tools: { builtin: { send_message: { channels: ['ops'] } } } } }),
    route: null,
    fullInput: '最终输入',
    session,
    projectPath: null,
    cfg,
    targetTimeoutMs: () => 9000,
    async assembleToolRuntime(): Promise<ToolRuntime | undefined> {
      throw new Error('spec down');
    },
    async resolveSendChannels(toolsConfig) {
      assert.deepEqual(toolsConfig, { builtin: { send_message: { channels: ['ops'] } } });
      return ['ops'];
    },
    makeSendToolDef,
    async runSendMessage(_job, channels, args) {
      sent.push({ channels, args });
      return { ok: true, text: 'sent' };
    },
    audit: async (event, detail) => { audits.push({ event, detail }); },
  });

  assert.equal(ctx.tools, undefined);
  assert.equal(ctx.targetConfig['_timeout_ms'], 9000);
  assert.equal(ctx.send?.def.function.name, 'send_message');
  assert.deepEqual(await ctx.send?.run({ to: 'u1', text: 'hello' }), { ok: true, text: 'sent' });
  assert.equal(audits[0]?.event, 'tools_unavailable');
  assert.deepEqual(sent[0], { channels: ['ops'], args: { to: 'u1', text: 'hello' } });
});

test('retryDecision: 只对 transient 且未超过上限的失败生成重试计划', () => {
  const j = job({ attempts: 1 });
  assert.deepEqual(retryDecision(j, route(), { ok: false, output: {}, transient: true, error: 'timeout'.repeat(50) }), {
    attempt: 2,
    max: 2,
    backoffMs: 800,
    error: 'timeout'.repeat(50).slice(0, 200),
  });
  assert.equal(retryDecision(job({ attempts: 2 }), route(), { ok: false, output: {}, transient: true }), null);
  assert.equal(retryDecision(job(), route(), { ok: false, output: {}, transient: false }), null);
  assert.equal(retryDecision(job(), route(), { ok: true, output: {} }), null);
});

test('applyToolExecutionBoundary: 不确定的业务执行强制进入不可重试对账终态', () => {
  const tools = {
    llmTools: [],
    maxCalls: 1,
    progressive: false,
    retrievalMode: false,
    catalog: [],
    async lookup() { return []; },
    async invoke() { return { ok: false, text: 'uncertain', status: 0 }; },
    executionUncertainty() {
      return {
        state: 'uncertain' as const,
        tool: 'refund_create',
        scope: 'refund.create',
        idempotency_key: 'idem-1',
        reason: 'timeout',
        message: '需要人工对账',
      };
    },
  } satisfies ToolRuntime;
  const result = applyToolExecutionBoundary(
    { ok: true, output: { text: '模型仍返回了普通文本' }, transient: true },
    tools,
  );

  assert.equal(result.ok, false);
  assert.equal(result.transient, false);
  assert.equal(result.error, 'tool_execution_reconciliation_required');
  assert.equal(result.output['governance_state'], 'reconciliation_required');
  assert.equal(result.output['auto_retry_allowed'], false);
  assert.equal(retryDecision(job(), route(), result), null);
});

test('prepareAdapterContext: send_message 不确定结果冻结后续发送并进入对账终态', async () => {
  let sends = 0;
  const ctx = await prepareAdapterContext({
    job: job(),
    route: route(),
    fullInput: '最终输入',
    session,
    projectPath: null,
    cfg,
    credentialStore: {
      async get() {
        return dbMain;
      },
      async touch() {},
    },
    targetTimeoutMs: () => 3000,
    async assembleToolRuntime() {
      return undefined;
    },
    async resolveSendChannels() {
      return ['ops'];
    },
    makeSendToolDef,
    async runSendMessage() {
      sends++;
      return {
        ok: false,
        text: '发送结果未知',
        uncertainty: {
          state: 'uncertain',
          tool: 'send_message',
          scope: 'builtin.send_message',
          idempotency_key: 'idem-send-1',
          reason: 'connection reset',
          message: '消息可能已经送达，需要人工对账',
        },
      };
    },
  });

  const first = await ctx.send?.run({ to: 'u1', text: 'hello' });
  const second = await ctx.send?.run({ to: 'u1', text: 'hello' });
  const result = applyToolExecutionBoundary(
    { ok: true, output: { text: '模型仍返回了普通文本' }, transient: true },
    undefined,
    ctx.send,
  );

  assert.equal(first?.uncertainty?.state, 'uncertain');
  assert.equal(second?.uncertainty?.state, 'uncertain');
  assert.equal(sends, 1);
  assert.equal(ctx.send?.executionUncertainty()?.idempotency_key, 'idem-send-1');
  assert.equal(result.ok, false);
  assert.equal(result.transient, false);
  assert.equal(result.output['governance_state'], 'reconciliation_required');
  assert.equal(result.output['auto_retry_allowed'], false);
  assert.equal(retryDecision(job(), route(), result), null);
});

test('persistedToolExecutionUncertainty: 恢复预检无需模型再次调用即可生成对账终态', () => {
  const uncertainty = persistedToolExecutionUncertainty({
    jobId: 'job-1',
    tool: 'refund_create',
    scope: 'refund.create',
    argsHash: 'hash-1',
    state: 'dispatching',
    ok: false,
    status: 0,
    text: '',
    idempotencyKey: 'idem-1',
  });
  const result = applyToolExecutionUncertainty(
    { ok: true, output: { text: '不应继续运行模型' }, transient: true },
    uncertainty,
  );

  assert.equal(uncertainty.state, 'dispatching');
  assert.equal(uncertainty.idempotency_key, 'idem-1');
  assert.equal(result.ok, false);
  assert.equal(result.transient, false);
  assert.equal(result.output['governance_state'], 'reconciliation_required');
  assert.equal(result.output['auto_retry_allowed'], false);
});
