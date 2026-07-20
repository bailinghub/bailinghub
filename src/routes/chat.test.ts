import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../core/config/config';
import type { ChatEntry, Job } from '../core/contracts/types';
import type { RuntimeContext } from '../core/edition';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { CHAT_STREAM_PROTOCOL, InMemoryJobStreamBroker } from '../core/runtime/job-stream';
import { handleChatConfigFor, handleChatEventsFor, type ChatApiDeps } from './chat';

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
