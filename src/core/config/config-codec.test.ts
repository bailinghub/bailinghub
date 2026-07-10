import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeChannelSecrets, rowChannel, rowRoute, rowToolProvider, traceSeverityValue, traceStageValue } from './config-codec';

test('mergeChannelSecrets: 密钥字段传空时保留已有值，非密钥字段正常覆盖', () => {
  const got = mergeChannelSecrets(
    { token: '', aes_key: undefined, route: 'new', label: 'updated' },
    { token: 'old-token', aes_key: 'old-aes', route: 'old', secret: 'old-secret' },
  );

  assert.deepEqual(got, {
    token: 'old-token',
    aes_key: 'old-aes',
    route: 'new',
    label: 'updated',
    secret: 'old-secret',
  });
});

test('config-codec: trace 字段非法值归入安全默认值', () => {
  assert.equal(traceStageValue('tool'), 'tool');
  assert.equal(traceStageValue('bad-stage'), 'system');
  assert.equal(traceSeverityValue('warning'), 'warning');
  assert.equal(traceSeverityValue('fatal'), 'info');
});

test('rowChannel: 坏 config JSON 降级为空对象', () => {
  assert.deepEqual(rowChannel({
    name: 'wecom-main',
    kind: 'wecom',
    route_key: 'support',
    config: '{bad json',
    enabled: 1,
  }).config, {});
});

test('rowRoute: 缺少目标值时使用通用 llm 目标', () => {
  assert.equal(rowRoute({ route_key: 'assistant.general', name: '通用助理', enabled: 1 }).target, 'llm');
});

test('rowToolProvider: 读取持久化授权探针结果', () => {
  const provider = rowToolProvider({
    name: 'demo-business',
    base_url: 'https://biz.example.com',
    spec_source: 'inline',
    spec_json: '{}',
    authz_probe_json: JSON.stringify({
      status: 'suspect',
      http: 200,
      tool: 'staff_list',
      requires_subject: true,
      reason: '疑似只验签未授权',
      at: '2026-07-01T12:00:00.000Z',
    }),
    secret: 'secret',
    log_payload: 1,
    timeout_ms: 10000,
    rate_limit_per_min: 120,
    auto_refresh_min: 0,
    enabled: 1,
  });

  assert.deepEqual(provider.authz_probe, {
    status: 'suspect',
    http: 200,
    tool: 'staff_list',
    requires_subject: true,
    reason: '疑似只验签未授权',
    at: '2026-07-01T12:00:00.000Z',
  });
});
