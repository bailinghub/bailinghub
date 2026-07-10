// 覆盖：执行运行时。engine 只负责状态流转，本模块负责准备 adapter 上下文与 retry 决策。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareAdapterContext, retryDecision } from './execution-runtime';
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

test('prepareAdapterContext: subject_locked 时不暴露业务工具并追加登录提示', async () => {
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
  assert.match(String(ctx.targetConfig['system_prompt']), /基础提示/);
  assert.match(String(ctx.targetConfig['system_prompt']), /未携带登录身份/);
  assert.equal(ctx.projectPath, '/tmp/project');
  assert.equal(audits[0]?.event, 'tools_locked');
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
