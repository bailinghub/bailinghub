import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../core/config/config';
import type { ChatEntry, Job, Route } from '../core/contracts/types';
import type { RuntimeContext } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { CHAT_STREAM_PROTOCOL, InMemoryJobStreamBroker } from '../core/runtime/job-stream';
import { handleChatConfigFor, handleChatEventsFor, handleChatFor, handleChatThreadFor, normalizePresentationCapabilities, type ChatApiDeps } from './chat';

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string | number | string[]> = {};
  body: Uint8Array = Buffer.alloc(0);
  ended = false;

  writeHead(code: number, headers?: Record<string, string | number | string[]>): void {
    this.statusCode = code;
    if (headers) Object.assign(this.headers, headers);
  }

  setHeader(name: string, value: string | number | string[]): void {
    this.headers[name.toLowerCase()] = value;
  }

  flushHeaders(): void { /* SSE 测试不需要真实 socket flush */ }

  write(chunk: string | Buffer): boolean {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.body = Buffer.concat([Buffer.from(this.body), value]);
    return true;
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.write(chunk);
    this.ended = true;
  }
}

function request(origin = 'https://shop.example.com', headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(new EventEmitter(), { headers: { origin, ...headers } }) as IncomingMessage;
}

function jsonRequest(body: Record<string, unknown>, origin = 'https://shop.example.com'): IncomingMessage {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  stream.method = 'POST';
  stream.headers = { origin, 'x-forwarded-for': '127.0.0.1' };
  return stream;
}

function responseJson(res: FakeResponse): Record<string, unknown> {
  return JSON.parse(Buffer.from(res.body).toString('utf8')) as Record<string, unknown>;
}

function entry(overrides: Partial<ChatEntry> = {}): ChatEntry {
  return {
    entry_key: 'pub_demo1234',
    name: '官网助手',
    route_key: 'chat.main',
    enabled: true,
    allowed_origins: ['https://shop.example.com'],
    rate_limit_per_min: 20,
    ...overrides,
  };
}

function deps(value: ChatEntry | null): ChatApiDeps {
  const config = {
    chatEntries: { get: async () => value },
  } as unknown as ConfigStoreContract;
  return {
    cfg: { brand: { name: '百灵中枢' } } as AppConfig,
    isPaused: () => false,
    runtimeContextFor: async () => ({} as RuntimeContext),
    runtimeStoresFor: () => ({ state: {} as RuntimeStateStore, config }),
    resolveProjectPathFor: async () => null,
    now: () => new Date(0).toISOString(),
    engineForContext: () => ({ launchJob: async () => { throw new Error('not used'); } }),
  };
}

function finishedJob(overrides: Partial<Job> = {}): Job {
  return {
    job_id: 'job-stream-1',
    request_id: 'req-stream-1',
    status: 'done',
    profile: 'default',
    project: '',
    source: 'chat:pub_demo1234',
    input_preview: '测试',
    result: { text: '最终权威回答' },
    metadata: { chat_entry: 'pub_demo1234', visitor_id: 'visitor-12345678' },
    created_at: new Date(0).toISOString(),
    updated_at: new Date(1).toISOString(),
    ...overrides,
  };
}

test('chat presentation capabilities: 仅保留有限且合法的渲染器标识', () => {
  assert.deepEqual(normalizePresentationCapabilities({
    renderers: ['bailing-chart', ' BAILING-CHART ', 'table.v2', '../bad', 123, ...Array(20).fill('extra-renderer')],
  }), { renderers: ['bailing-chart', 'table.v2', 'extra-renderer'] });
  assert.equal(normalizePresentationCapabilities({ renderers: [] }), undefined);
  assert.equal(normalizePresentationCapabilities('bailing-chart'), undefined);
});

function streamDeps(job: Job, broker: InMemoryJobStreamBroker): ChatApiDeps {
  const config = {
    chatEntries: { get: async () => entry() },
  } as unknown as ConfigStoreContract;
  const state = {
    getJob: async (jobId: string) => jobId === job.job_id ? job : null,
  } as unknown as RuntimeStateStore;
  return {
    cfg: { brand: { name: '百灵中枢' } } as AppConfig,
    isPaused: () => false,
    runtimeContextFor: async () => ({} as RuntimeContext),
    runtimeStoresFor: () => ({ state, config }),
    resolveProjectPathFor: async () => null,
    now: () => new Date(0).toISOString(),
    jobStream: broker,
    engineForContext: () => ({ launchJob: async () => { throw new Error('not used'); } }),
  };
}

async function configBody(value: ChatEntry | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = new FakeResponse();
  await handleChatConfigFor(deps(value), request(), res as unknown as ServerResponse, 'pub_demo1234');
  return {
    status: res.statusCode,
    body: JSON.parse(Buffer.from(res.body).toString('utf8')) as Record<string, unknown>,
  };
}

test('chat config: 启用入口下发品牌控制且保留部署品牌兼容字段', async () => {
  const result = await configBody(entry({
    appearance: { powered_by_visible: true, powered_by_text: '由示例业务驱动' },
  }));

  assert.equal(result.status, 200);
  assert.equal(result.body.enabled, true);
  assert.equal(result.body.brand, '百灵中枢');
  assert.equal(result.body.powered_by_visible, true);
  assert.equal(result.body.powered_by_text, '由示例业务驱动');
});

test('chat config: 老入口生成默认品牌文案', async () => {
  const result = await configBody(entry());

  assert.equal(result.status, 200);
  assert.equal(result.body.powered_by_visible, true);
  assert.equal(result.body.powered_by_text, '由 百灵中枢 驱动');
});

test('chat config: 停用入口返回静默隐藏状态，不存在入口仍返回 404', async () => {
  const disabled = await configBody(entry({ enabled: false }));
  assert.equal(disabled.status, 200);
  assert.deepEqual(disabled.body, { enabled: false });

  const missing = await configBody(null);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: '聊天入口不存在' });
});

test('chat events: 增量事件可回放，done 仍以任务库最终结果为权威值', async () => {
  const broker = new InMemoryJobStreamBroker();
  const job = finishedJob();
  broker.publish(job.job_id, { type: 'phase', data: { name: 'model', round: 1 } });
  broker.publish(job.job_id, { type: 'delta', data: { text: '临时增量', round: 1 } });
  broker.seal(job.job_id);
  const res = new FakeResponse();

  await handleChatEventsFor(
    streamDeps(job, broker),
    request(),
    res as unknown as ServerResponse,
    'pub_demo1234',
    job.job_id,
    new URL(`https://hub.example.com/chat/pub_demo1234/events/${job.job_id}`),
  );

  const body = Buffer.from(res.body).toString('utf8');
  assert.equal(res.statusCode, 200);
  assert.equal(res.ended, true);
  assert.match(body, new RegExp(`"protocol":"${CHAT_STREAM_PROTOCOL.replaceAll('.', '\\.')}`));
  assert.match(body, /id: 1\nevent: phase/);
  assert.match(body, /id: 2\nevent: delta/);
  assert.match(body, /临时增量/);
  assert.match(body, /event: done/);
  assert.match(body, /最终权威回答/);
});

test('chat events: Last-Event-ID 跳过已收到事件，回放窗口丢失时明确 reset', async () => {
  const job = finishedJob();
  const cursorBroker = new InMemoryJobStreamBroker();
  cursorBroker.publish(job.job_id, { type: 'delta', data: { text: 'FIRST_CHUNK', round: 1 } });
  cursorBroker.publish(job.job_id, { type: 'delta', data: { text: 'SECOND_CHUNK', round: 1 } });
  cursorBroker.seal(job.job_id);
  const cursorRes = new FakeResponse();

  await handleChatEventsFor(
    streamDeps(job, cursorBroker),
    request('https://shop.example.com', { 'last-event-id': '1' }),
    cursorRes as unknown as ServerResponse,
    'pub_demo1234',
    job.job_id,
    new URL(`https://hub.example.com/chat/pub_demo1234/events/${job.job_id}`),
  );
  const cursorBody = Buffer.from(cursorRes.body).toString('utf8');
  assert.doesNotMatch(cursorBody, /FIRST_CHUNK/);
  assert.match(cursorBody, /SECOND_CHUNK/);

  const gapBroker = new InMemoryJobStreamBroker({ maxEventsPerJob: 1 });
  gapBroker.publish(job.job_id, { type: 'delta', data: { text: 'DROPPED_CHUNK', round: 1 } });
  gapBroker.publish(job.job_id, { type: 'delta', data: { text: 'LATEST_CHUNK', round: 1 } });
  gapBroker.seal(job.job_id);
  const gapRes = new FakeResponse();
  await handleChatEventsFor(
    streamDeps(job, gapBroker),
    request(),
    gapRes as unknown as ServerResponse,
    'pub_demo1234',
    job.job_id,
    new URL(`https://hub.example.com/chat/pub_demo1234/events/${job.job_id}`),
  );
  const gapBody = Buffer.from(gapRes.body).toString('utf8');
  assert.match(gapBody, /event: reset/);
  assert.match(gapBody, /replay_gap/);
  assert.doesNotMatch(gapBody, /DROPPED_CHUNK/);
  assert.match(gapBody, /LATEST_CHUNK/);
});

const chatRoute: Route = {
  route_key: 'chat.main',
  name: '聊天路由',
  enabled: true,
  target: 'llm',
  target_config: {},
  profile: 'general',
  session_policy: 'per_key',
};

function formReply(): string {
  return '请补充信息：\n```bailing-form\n' + JSON.stringify({
    version: 1,
    form_id: 'refund_info',
    title: '退款信息',
    schema: {
      reason: { type: 'textarea', label: '退款原因', required: true, maxLength: 200 },
      method: {
        type: 'single_select',
        label: '退款方式',
        required: true,
        options: [{ label: '原路退回', value: 'original' }, { label: '余额', value: 'balance' }],
      },
    },
  }) + '\n```';
}

function interactionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    visitor_id: 'visitor-12345678',
    thread_id: 'case-1',
    interaction_response: {
      type: 'bailing-form',
      version: 1,
      source_job_id: 'source-job-123',
      form_id: 'refund_info',
      submission_id: 'submission-123',
      action: 'submit',
      values: { reason: '商品损坏', method: 'original' },
      ...overrides,
    },
  };
}

function sourceFormJob(overrides: Partial<Job> = {}): Job {
  return finishedJob({
    job_id: 'source-job-123',
    request_id: 'source-request-123',
    source: 'chat:pub_demo1234',
    result: { text: formReply() },
    metadata: { chat_entry: 'pub_demo1234', visitor_id: 'visitor-12345678', thread_id: 'case-1' },
    ...overrides,
  });
}

function chatFixture(source: Job = sourceFormJob(), throwAfterCreate = false): {
  deps: ChatApiDeps;
  jobs: Map<string, Job>;
  launches: Array<Record<string, unknown>>;
} {
  const jobs = new Map<string, Job>([[source.job_id, source]]);
  const launches: Array<Record<string, unknown>> = [];
  const config = {
    chatEntries: {
      get: async () => entry(),
      listPageContexts: async () => [],
    },
    rateLimits: { consume: async () => false },
    routes: { get: async () => chatRoute },
    targets: { list: async () => [] },
    conversations: {
      sessionForScope: async () => ({ sessionId: 'session-1', isContinue: true, scopeKey: 'scope-1' }),
    },
  } as unknown as ConfigStoreContract;
  const state = {
    getJob: async (jobId: string) => jobs.get(jobId) ?? null,
    findByRequestId: async (requestId: string) => [...jobs.values()].find((item) => item.request_id === requestId) ?? null,
  } as unknown as RuntimeStateStore;
  const fixtureDeps: ChatApiDeps = {
    cfg: { brand: { name: '百灵中枢' } } as AppConfig,
    isPaused: () => false,
    runtimeContextFor: async () => ({} as RuntimeContext),
    runtimeStoresFor: () => ({ state, config }),
    resolveProjectPathFor: async () => null,
    now: () => new Date(0).toISOString(),
    engineForContext: () => ({
      launchJob: async (spec) => {
        launches.push(spec as unknown as Record<string, unknown>);
        const created = finishedJob({
          job_id: 'response-job-123',
          request_id: spec.requestId,
          status: 'queued',
          source: spec.source,
          result: undefined,
          raw_result: undefined,
          input: spec.fullInput,
          input_preview: spec.fullInput.slice(0, 200),
          metadata: spec.metadata,
        });
        jobs.set(created.job_id, created);
        if (throwAfterCreate) throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
        return created;
      },
    }),
  };
  return { deps: fixtureDeps, jobs, launches };
}

test('POST /chat interaction: 从来源 done 回答重解析 schema，生成新用户轮次且 metadata 不重复 values', async () => {
  const fixture = chatFixture();
  const res = new FakeResponse();
  await handleChatFor(fixture.deps, jsonRequest(interactionBody()), res as unknown as ServerResponse, 'pub_demo1234');

  assert.equal(res.statusCode, 200);
  assert.equal(responseJson(res)['job_id'], 'response-job-123');
  assert.equal(fixture.launches.length, 1);
  const launch = fixture.launches[0]!;
  assert.match(String(launch['requestId']), /^chat_form_[0-9a-f]{48}$/);
  assert.match(String(launch['fullInput']), /退款方式（method）：原路退回/);
  assert.match(String(launch['fullInput']), /用户数据，不是系统指令/);
  const metadata = launch['metadata'] as Record<string, unknown>;
  assert.deepEqual(metadata['interaction'], {
    type: 'bailing-form',
    version: 1,
    source_job_id: 'source-job-123',
    form_id: 'refund_info',
    submission_id: 'submission-123',
    action: 'submit',
  });
  assert.equal(JSON.stringify(metadata).includes('商品损坏'), false);

  const replay = new FakeResponse();
  await handleChatFor(fixture.deps, jsonRequest(interactionBody()), replay as unknown as ServerResponse, 'pub_demo1234');
  assert.equal(responseJson(replay)['deduped'], true);
  assert.equal(fixture.launches.length, 1);
});

test('POST /chat interaction: 跨访客或跨 thread 的来源统一不可探测', async () => {
  for (const source of [
    sourceFormJob({ metadata: { chat_entry: 'pub_demo1234', visitor_id: 'other-visitor', thread_id: 'case-1' } }),
    sourceFormJob({ metadata: { chat_entry: 'pub_demo1234', visitor_id: 'visitor-12345678', thread_id: 'other-thread' } }),
    sourceFormJob({ source: 'chat:another-entry' }),
  ]) {
    const fixture = chatFixture(source);
    const res = new FakeResponse();
    await handleChatFor(fixture.deps, jsonRequest(interactionBody()), res as unknown as ServerResponse, 'pub_demo1234');
    assert.equal(res.statusCode, 404);
    assert.equal(responseJson(res)['error'], 'not found');
    assert.equal(fixture.launches.length, 0);
  }
});

test('POST /chat interaction: 来源须为 done 且 values 必须满足来源 schema', async () => {
  const pendingFixture = chatFixture(sourceFormJob({ status: 'running' }));
  const pending = new FakeResponse();
  await handleChatFor(pendingFixture.deps, jsonRequest(interactionBody()), pending as unknown as ServerResponse, 'pub_demo1234');
  assert.equal(pending.statusCode, 409);

  const invalidFixture = chatFixture();
  const invalid = new FakeResponse();
  await handleChatFor(
    invalidFixture.deps,
    jsonRequest(interactionBody({ values: { reason: '损坏', method: 'not-allowed' } })),
    invalid as unknown as ServerResponse,
    'pub_demo1234',
  );
  assert.equal(invalid.statusCode, 400);
  assert.match(String(responseJson(invalid)['error']), /允许的选项/);
  assert.equal(invalidFixture.launches.length, 0);

  const absentFixture = chatFixture(sourceFormJob({ result: { text: '这里只有普通文字，没有表单。' } }));
  const absent = new FakeResponse();
  await handleChatFor(absentFixture.deps, jsonRequest(interactionBody()), absent as unknown as ServerResponse, 'pub_demo1234');
  assert.equal(absent.statusCode, 400);
  assert.match(String(responseJson(absent)['error']), /没有可提交/);
});

test('POST /chat interaction: canonical 用户消息超过 4000 字时明确拒绝而非截断', async () => {
  const longReply = '```bailing-form\n' + JSON.stringify({
    version: 1,
    form_id: 'refund_info',
    title: '长表单',
    schema: {
      first: { type: 'textarea', label: '第一段', required: true, maxLength: 2000 },
      second: { type: 'textarea', label: '第二段', required: true, maxLength: 2000 },
    },
  }) + '\n```';
  const fixture = chatFixture(sourceFormJob({ result: { text: longReply } }));
  const res = new FakeResponse();
  await handleChatFor(
    fixture.deps,
    jsonRequest(interactionBody({ values: { first: '甲'.repeat(2000), second: '乙'.repeat(2000) } })),
    res as unknown as ServerResponse,
    'pub_demo1234',
  );
  assert.equal(res.statusCode, 400);
  assert.match(String(responseJson(res)['error']), /超过 4000 字上限/);
  assert.equal(fixture.launches.length, 0);
});

test('POST /chat interaction: createJob 并发唯一键失败后回查赢家并返回幂等结果', async () => {
  const fixture = chatFixture(sourceFormJob(), true);
  const res = new FakeResponse();
  await handleChatFor(fixture.deps, jsonRequest(interactionBody()), res as unknown as ServerResponse, 'pub_demo1234');

  assert.equal(res.statusCode, 200);
  assert.equal(responseJson(res)['job_id'], 'response-job-123');
  assert.equal(responseJson(res)['deduped'], true);
  assert.equal(fixture.launches.length, 1);
});

test('GET /chat thread: 入站表单提交从 job metadata 回灌简化 interaction，不回传 values', async () => {
  const submitted = finishedJob({
    job_id: 'response-job-123',
    thread_id: 7,
    source: 'chat:pub_demo1234',
    metadata: {
      chat_entry: 'pub_demo1234',
      visitor_id: 'visitor-12345678',
      thread_id: 'case-1',
      interaction: {
        type: 'bailing-form',
        version: 1,
        source_job_id: 'source-job-123',
        form_id: 'refund_info',
        submission_id: 'submission-123',
        action: 'submit',
      },
    },
  });
  const state = { getJob: async () => submitted } as unknown as RuntimeStateStore;
  const config = {
    chatEntries: { get: async () => entry() },
    conversations: {
      findThread: async () => 7,
      threadMessages: async () => [{
        direction: 'in',
        content: '用户提交了上一条回答中的结构化表单。',
        job_id: 'response-job-123',
        created_at: new Date(0).toISOString(),
      }],
    },
  } as unknown as ConfigStoreContract;
  const historyDeps: ChatApiDeps = {
    cfg: { brand: { name: '百灵中枢' } } as AppConfig,
    isPaused: () => false,
    runtimeContextFor: async () => ({} as RuntimeContext),
    runtimeStoresFor: () => ({ state, config }),
    resolveProjectPathFor: async () => null,
    now: () => new Date(0).toISOString(),
    engineForContext: () => ({ launchJob: async () => { throw new Error('not used'); } }),
  };
  const res = new FakeResponse();
  await handleChatThreadFor(
    historyDeps,
    request(),
    res as unknown as ServerResponse,
    'pub_demo1234',
    new URL('https://hub.example.com/chat/pub_demo1234/thread?visitor_id=visitor-12345678&thread_id=case-1'),
  );
  const messages = responseJson(res)['messages'] as Array<Record<string, unknown>>;
  assert.deepEqual(messages[0]?.['interaction'], {
    type: 'bailing-form',
    version: 1,
    source_job_id: 'source-job-123',
    form_id: 'refund_info',
    submission_id: 'submission-123',
    action: 'submit',
  });
  assert.equal(JSON.stringify(messages).includes('values'), false);
});
