import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceAllows, normalizeAudiencePolicy, principalKey, resolvePrincipal, validateAudiencePolicy } from './identity-runtime';

test('resolvePrincipal: 从标准 principal 对象归一主体', () => {
  const p = resolvePrincipal({
    clientAppId: 'crm',
    channel: 'crm',
    metadata: { principal: { id: 'u-1', tenant_id: 't-1', roles: ['staff', 'finance'], audience: 'employee' } },
  });
  assert.deepEqual(p, { id: 'u-1', tenant: 't-1', roles: ['staff', 'finance'], audience: 'employee', channel: 'crm', client_app_id: 'crm' });
  assert.equal(principalKey(p), 't:t-1|p:u-1');
});

test('resolvePrincipal: 兼容平铺字段但输出标准形状', () => {
  const p = resolvePrincipal({ metadata: { user_id: '42', tenant: 'acme', role: 'admin,ops' } });
  assert.equal(p?.id, '42');
  assert.equal(p?.tenant, 'acme');
  assert.deepEqual(p?.roles, ['admin', 'ops']);
});

test('audienceAllows: 按租户/角色/接入方收敛路由受众', () => {
  const p = resolvePrincipal({ clientAppId: 'crm', metadata: { user_id: 'u-1', tenant: 't-1', roles: ['ops'] } });
  assert.equal(audienceAllows({ clients: ['crm'], tenants: ['t-1'], roles: ['ops'] }, p).ok, true);
  assert.deepEqual(audienceAllows({ tenants: ['t-2'] }, p), { ok: false, reason: 'tenant_not_allowed' });
  assert.deepEqual(audienceAllows({ anonymous: true }, null), { ok: true });
  assert.deepEqual(audienceAllows({ clients: ['crm'] }, null), { ok: false, reason: 'route_requires_principal' });
});

test('normalizeAudiencePolicy: 字符串列表与优先级归一', () => {
  assert.deepEqual(normalizeAudiencePolicy({ auto: true, priority: 9999, keywords: '订单,退款', roles: [' admin ', ''] }), {
    auto: true,
    priority: 1000,
    keywords: ['订单', '退款'],
    roles: ['admin'],
  });
  assert.equal(validateAudiencePolicy({ roles: 123 }), 'audience.roles 必须是字符串或字符串数组');
});
