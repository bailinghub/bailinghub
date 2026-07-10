// 覆盖：路由 tools 配置的工业化分层形态。
// 顶层扁平字段不是公共契约，必须显式拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalConfig, maxToolCalls, routeToolsConfig, sendMessageConfig, toolSourceConfigs, validateRouteToolsConfig } from './tools-config';

test('toolSourceConfigs: 读取 tools.sources，清洗 provider / allow 并去重 scope', () => {
  const cfg = {
    sources: [{
      provider: '  bn-server  ',
      allow: [' tenant.staff.* ', '', 'order.read', 'order.read'],
      subject_field: 'operator_uid',
    }, { provider: 'logistics', allow: ['shipment.read'] }],
    max_calls: 8,
    provider: 'flat-provider',
    allow: ['flat.*'],
  };

  assert.deepEqual(toolSourceConfigs(cfg), [{
    provider: 'bn-server',
    allow: ['tenant.staff.*', 'order.read'],
    subject_field: 'operator_uid',
  }, { provider: 'logistics', allow: ['shipment.read'] }]);
  assert.equal(maxToolCalls(cfg), 8);
});

test('toolSourceConfigs: 顶层 provider/allow 不作为工具源配置', () => {
  assert.deepEqual(toolSourceConfigs({ provider: 'bn-server', allow: ['tenant.staff.*'] }), []);
});

test('sendMessageConfig: 只读取 tools.builtin.send_message.channels', () => {
  const cfg = {
    builtin: {
      send_message: {
        channels: [' bn-wecom ', '', 'ops-wecom'],
      },
    },
    send_channels: ['flat-wecom'],
  };

  assert.deepEqual(sendMessageConfig(cfg), {
    channels: ['bn-wecom', 'ops-wecom'],
  });
});

test('sendMessageConfig: 顶层 send_channels 不作为内置工具配置', () => {
  assert.equal(sendMessageConfig({ send_channels: ['bn-wecom'] }), null);
});

test('approvalConfig: 只读取 tools.approval，并保留业务侧审批配置', () => {
  const cfg = {
    approval: {
      type: ' business_webhook ',
      url: 'https://biz.example.com/ai/approvals',
      to: 'approver-1',
    },
    approver: {
      type: 'flat',
    },
  };

  assert.deepEqual(approvalConfig(cfg), {
    type: 'business_webhook',
    url: 'https://biz.example.com/ai/approvals',
    to: 'approver-1',
  });
});

test('approvalConfig: 顶层 approver 不作为审批配置', () => {
  assert.equal(approvalConfig({ approver: { type: 'business_webhook' } }), null);
});

test('routeToolsConfig: 非对象值视为空配置', () => {
  assert.equal(routeToolsConfig(null), null);
  assert.equal(routeToolsConfig([]), null);
  assert.equal(routeToolsConfig('x'), null);
});

test('validateRouteToolsConfig: 合法结构化配置通过校验', async () => {
  const err = await validateRouteToolsConfig({
    sources: [{ provider: 'bn-server', allow: ['tenant.staff.*'] }],
    max_calls: 8,
    builtin: { send_message: { channels: ['bn-wecom'] } },
    approval: { type: 'business_webhook', url: 'https://biz.example.com/ai/approvals' },
  }, async (name) => name === 'bn-server');

  assert.equal(err, null);
});

test('validateRouteToolsConfig: 拒绝顶层扁平字段', async () => {
  const err = await validateRouteToolsConfig({ provider: 'bn-server', allow: ['tenant.staff.*'] });
  assert.match(err ?? '', /不支持顶层扁平字段：provider,allow/);
});

test('validateRouteToolsConfig: sources.provider 必须对应已注册工具源', async () => {
  const err = await validateRouteToolsConfig({
    sources: [{ provider: 'missing-provider', allow: ['tenant.staff.*'] }],
  }, async () => false);

  assert.match(err ?? '', /工具源 missing-provider 未注册/);
});

test('validateRouteToolsConfig: 拒绝单数 source 字段和重复工具源', async () => {
  assert.match(await validateRouteToolsConfig({ source: { provider: 'other', allow: ['*'] } }) ?? '', /不支持顶层扁平字段：source/);
  assert.match(await validateRouteToolsConfig({
    sources: [{ provider: 'same', allow: ['a'] }, { provider: 'same', allow: ['b'] }],
  }) ?? '', /不允许重复引用工具源 same/);
});

test('validateRouteToolsConfig: send_message.channels 必须有有效渠道', async () => {
  const err = await validateRouteToolsConfig({
    builtin: { send_message: { channels: [' ', ''] } },
  });

  assert.equal(err, 'tools.builtin.send_message.channels 必须是非空数组');
});

test('validateRouteToolsConfig: 业务 webhook 审批必须配置 url', async () => {
  const err = await validateRouteToolsConfig({
    approval: { type: 'business_webhook' },
  });

  assert.equal(err, 'tools.approval.type=business_webhook 时 url 必填');
});
