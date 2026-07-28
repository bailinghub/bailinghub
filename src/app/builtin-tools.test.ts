// 覆盖：内置 send_message 工具定义（sendToolDef）——必填字段、单/多渠道时 channel 参数的有无与 enum。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runSendMessageFor,
  sendToolDef,
  SEND_TOOL_NAME,
} from './builtin-tools';
import type { Job } from '../core/contracts/types';
import type { ToolExecutionJournalEntry } from '../core/contracts/tools';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

const job: Job = {
  job_id: 'job-send-1',
  request_id: 'req-send-1',
  status: 'running',
  profile: 'general',
  project: '',
  source: 'test',
  input_preview: 'send',
  metadata: {},
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function sendConfig(options: { journalUnavailable?: boolean } = {}) {
  const ledger = new Map<string, ToolExecutionJournalEntry>();
  const keyOf = (jobId: string, tool: string, hash: string) => `${jobId}:${tool}:${hash}`;
  const config = {
    channels: {
      get: async () => ({ name: 'bn-wecom', kind: 'wecom', enabled: true, route_key: 'route-1', config: {} }),
    },
    conversations: {
      resolveThread: async () => 'thread-1',
      appendMessage: async () => undefined,
    },
    toolCalls: {
      get: async (jobId: string, tool: string, hash: string) => {
        if (options.journalUnavailable) throw new Error('db down');
        return ledger.get(keyOf(jobId, tool, hash)) ?? null;
      },
      reserve: async (jobId: string, tool: string, _scope: string, hash: string, idempotencyKey: string) => {
        const key = keyOf(jobId, tool, hash);
        const prior = ledger.get(key);
        if (prior) return { inserted: false, entry: prior };
        const entry: ToolExecutionJournalEntry = {
          state: 'dispatching',
          ok: false,
          status: 0,
          text: '',
          idempotencyKey,
        };
        ledger.set(key, entry);
        return { inserted: true, entry };
      },
      recordResponse: async (jobId: string, tool: string, hash: string, result: { ok: boolean; status: number; text: string }) => {
        const key = keyOf(jobId, tool, hash);
        ledger.set(key, { ...ledger.get(key)!, ...result, state: 'response_recorded' });
      },
      complete: async (jobId: string, tool: string, hash: string) => {
        const key = keyOf(jobId, tool, hash);
        ledger.set(key, { ...ledger.get(key)!, state: 'completed' });
      },
      markUncertain: async (jobId: string, tool: string, hash: string, error: string) => {
        const key = keyOf(jobId, tool, hash);
        ledger.set(key, { ...ledger.get(key)!, state: 'uncertain', error });
      },
      markEvidenceDegraded: async (jobId: string, tool: string, hash: string, error: string) => {
        const key = keyOf(jobId, tool, hash);
        ledger.set(key, { ...ledger.get(key)!, state: 'evidence_degraded', error });
      },
    },
  } as unknown as ConfigStoreContract;
  return { config, ledger };
}

test('sendToolDef：单渠道不暴露 channel 参数（默认用唯一渠道）', () => {
  const def = sendToolDef(['bn-wecom']);
  assert.equal(def.function.name, SEND_TOOL_NAME);
  const props = def.function.parameters['properties'] as Record<string, unknown>;
  assert.ok(props['to'] && props['text'], '必须有 to / text');
  assert.equal(props['channel'], undefined, '单渠道时不应出现 channel 参数');
  assert.deepEqual(def.function.parameters['required'], ['to', 'text']);
});

test('sendToolDef：多渠道时 channel 参数带 enum 限定在白名单内', () => {
  const def = sendToolDef(['bn-wecom', 'ops-wecom']);
  const props = def.function.parameters['properties'] as Record<string, unknown>;
  const channel = props['channel'] as { enum?: string[] } | undefined;
  assert.ok(channel, '多渠道时应暴露 channel 参数');
  assert.deepEqual(channel!.enum, ['bn-wecom', 'ops-wecom'], 'channel 取值必须限定在允许渠道内');
});

test('sendToolDef：描述里列出可用渠道，且说明收件人由大脑指定', () => {
  const def = sendToolDef(['bn-wecom']);
  assert.match(def.function.description, /bn-wecom/);
  assert.match(def.function.description, /收件人由你指定/);
});

test('sendToolDef：支持 files 附件参数（每项 name + content/url）', () => {
  const def = sendToolDef(['bn-wecom']);
  const props = def.function.parameters['properties'] as Record<string, any>;
  assert.ok(props['files'], '应暴露 files 参数');
  assert.equal(props['files'].type, 'array');
  const item = props['files'].items.properties as Record<string, unknown>;
  assert.ok(item['name'] && item['content'] && item['url'], 'files 每项要有 name/content/url');
  assert.deepEqual(props['files'].items.required, ['name']);
});

test('send_message：成功发送先持久化再完成，重复调用不再次投递', async () => {
  const { config, ledger } = sendConfig();
  let sends = 0;
  const sendChannel = async () => { sends++; return { ok: true }; };
  const args = { to: 'u1', text: 'hello' };

  const first = await runSendMessageFor(config, job, ['bn-wecom'], args, undefined, sendChannel);
  const second = await runSendMessageFor(config, job, ['bn-wecom'], args, undefined, sendChannel);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(sends, 1);
  const entry = [...ledger.values()][0]!;
  assert.equal(entry.state, 'completed');
  assert.match(entry.idempotencyKey, /^[a-f0-9]{64}$/);
});

test('send_message：渠道部分送达后失败进入 uncertain，恢复调用禁止重发', async () => {
  const { config, ledger } = sendConfig();
  let sends = 0;
  const sendChannel = async () => {
    sends++;
    return { ok: false, error: 'attachment failed', mayHaveCommitted: true };
  };
  const args = { to: 'u1', text: 'hello', files: [{ name: 'a.txt', content: 'a' }] };

  const first = await runSendMessageFor(config, job, ['bn-wecom'], args, undefined, sendChannel);
  const second = await runSendMessageFor(config, job, ['bn-wecom'], args, undefined, sendChannel);

  assert.equal(first.uncertainty?.state, 'uncertain');
  assert.equal(second.uncertainty?.state, 'uncertain');
  assert.equal(sends, 1);
  assert.equal([...ledger.values()][0]?.state, 'uncertain');
});

test('send_message：投递抛错按结果未知冻结，不把网络错误当成安全重试信号', async () => {
  const { config, ledger } = sendConfig();
  let sends = 0;
  const sendChannel = async () => {
    sends++;
    throw new Error('connection reset');
  };

  const result = await runSendMessageFor(
    config,
    job,
    ['bn-wecom'],
    { to: 'u1', text: 'hello' },
    undefined,
    sendChannel,
  );

  assert.equal(result.uncertainty?.state, 'uncertain');
  assert.equal(result.uncertainty?.idempotency_key.length, 64);
  assert.equal(sends, 1);
  assert.equal([...ledger.values()][0]?.state, 'uncertain');
});

test('send_message：消息已送达但结果审计失败进入 evidence_degraded', async () => {
  const { config, ledger } = sendConfig();
  let sends = 0;
  const result = await runSendMessageFor(
    config,
    job,
    ['bn-wecom'],
    { to: 'u1', text: 'hello' },
    async (event) => {
      if (event === 'builtin_send') throw new Error('audit down');
    },
    async () => { sends++; return { ok: true }; },
  );

  assert.equal(result.uncertainty?.state, 'evidence_degraded');
  assert.equal(sends, 1);
  assert.equal([...ledger.values()][0]?.state, 'evidence_degraded');
});

test('send_message：执行日志不可用时 fail closed，消息不会发出', async () => {
  const { config } = sendConfig({ journalUnavailable: true });
  let sends = 0;
  const result = await runSendMessageFor(
    config,
    job,
    ['bn-wecom'],
    { to: 'u1', text: 'hello' },
    undefined,
    async () => { sends++; return { ok: true }; },
  );

  assert.equal(result.ok, false);
  assert.match(result.text, /执行日志/);
  assert.equal(sends, 0);
});
