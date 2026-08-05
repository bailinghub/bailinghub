import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleToolRuntimeFor } from './tool-assembly';
import type { AppConfig } from '../core/config/config';
import type { Job, Route, ToolProvider } from '../core/contracts/types';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { ToolIndexService, ToolRetrievalObservation } from '../services/tools-index';
import { ToolRetrievalError } from '../services/tools-index';

function toolProvider(): ToolProvider {
  const paths = Object.fromEntries(Array.from({ length: 13 }, (_value, index) => {
    const name = `catalog_item_${index + 1}`;
    return [`/${name}`, {
      get: {
        operationId: name,
        summary: `查询目录项 ${index + 1}`,
        'x-agent-capability': { version: 1, enabled: true, scope: 'catalog.read' },
      },
    }];
  }));
  return {
    name: 'mall',
    base_url: 'https://mall.example.com',
    secret: 'provider-secret',
    enabled: true,
    spec_source: 'inline',
    spec_json: JSON.stringify({ openapi: '3.0.0', info: { title: 'mall', version: '1' }, paths }),
    log_payload: false,
    timeout_ms: 10_000,
    rate_limit_per_min: 60,
    embed_credential: 'embedding-main',
    embed_model: 'text-embedding-v3',
    embed_dim: 4,
  } as ToolProvider;
}

const job: Job = {
  job_id: 'job-retrieval',
  request_id: 'req-retrieval',
  status: 'running',
  profile: 'general',
  project: '',
  source: 'test',
  input_preview: '查商品',
  metadata: {},
  created_at: '2026-08-05T00:00:00.000Z',
  updated_at: '2026-08-05T00:00:00.000Z',
};

const route: Route = {
  route_key: 'mall-chat',
  name: '商城助手',
  enabled: true,
  target: 'llm',
  target_config: {},
  profile: 'general',
  session_policy: 'new',
  tools: { sources: [{ provider: 'mall', allow: ['*'] }] },
};

test('assembleToolRuntimeFor: 检索阶段诊断写任务审计，异常仍返回渐进式降级信号', async () => {
  const provider = toolProvider();
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const config = {
    toolProviders: { get: async () => provider },
    approvals: { approvedUnusedForJob: async () => [] },
  } as unknown as ConfigStoreContract;
  const state = {
    appendAudit: async (entry: { event: string; detail: Record<string, unknown> }) => {
      audits.push({ event: entry.event, detail: entry.detail });
    },
  } as unknown as RuntimeStateStore;
  const observation: ToolRetrievalObservation = {
    provider: 'mall',
    status: 'degraded',
    reason: 'index_load_timeout',
    cache_state: 'miss',
    index_rows: 0,
    eligible_rows: 0,
    picked: 0,
    index_load_ms: 5001,
    credential_ms: 0,
    embedding_ms: 0,
    total_ms: 5001,
  };
  const index = {
    retrieve: async (_provider: string, _allowed: Set<string>, _query: string, _ec: unknown, opts: { observe?: (value: ToolRetrievalObservation) => void | Promise<void> }) => {
      await opts.observe?.(observation);
      throw new ToolRetrievalError('index_load_timeout', 'tool index load timed out after 5000 ms');
    },
  } as unknown as ToolIndexService;

  const runtime = await assembleToolRuntimeFor(
    config,
    state,
    index,
    job,
    route,
    { brand: { name: 'BailingHub' } } as unknown as AppConfig,
    () => '2026-08-05T00:00:00.000Z',
    async () => undefined,
  );

  assert.ok(runtime && runtime !== 'subject_locked');
  assert.equal(runtime.retrievalMode, true);
  assert.equal(await runtime.retrieve?.('查商品'), null);
  const diagnostics = audits.filter((entry) => entry.event === 'tools_retrieval_diagnostics');
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0]?.detail, observation);
  assert.doesNotMatch(JSON.stringify(diagnostics[0]), /查商品|provider-secret|embedding-main/);
});
