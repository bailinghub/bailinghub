import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewAutoRoute, selectAutoRoute } from './routing-runtime';
import { resolvePrincipal } from './identity-runtime';
import type { Client, Route } from '../contracts/types';

function route(route_key: string, extra: Partial<Route> = {}): Route {
  return {
    route_key,
    name: route_key,
    enabled: true,
    target: 'llm',
    target_config: { credential: 'main' },
    profile: 'default',
    session_policy: 'new',
    ...extra,
  };
}

const client: Client = {
  app_id: 'crm',
  name: 'CRM',
  token: 't',
  allowed_routes: ['order.refund', 'order.audit'],
  allowed_channels: [],
  rate_limit_per_min: 0,
  enabled: true,
};

test('selectAutoRoute: 在接入方白名单和 Audience 内按关键词选路由', () => {
  const principal = resolvePrincipal({ clientAppId: 'crm', metadata: { user_id: 'u-1', tenant: 't-1', roles: ['cs'] } });
  const got = selectAutoRoute({
    routes: [
      route('order.refund', { audience: { auto: true, keywords: ['退款'], tenants: ['t-1'], roles: ['cs'], priority: 5 } }),
      route('finance.close', { audience: { auto: true, keywords: ['退款'], roles: ['finance'], priority: 100 } }),
    ],
    text: '用户申请退款',
    client,
    principal,
  });
  assert.equal(got.ok, true);
  assert.equal(got.route?.route_key, 'order.refund');
});

test('selectAutoRoute: 同分候选返回歧义而不是随机分配', () => {
  const got = selectAutoRoute({
    routes: [
      route('a.one', { audience: { auto: true, keywords: ['报错'] } }),
      route('a.two', { audience: { auto: true, keywords: ['报错'] } }),
    ],
    text: '页面报错',
    principal: resolvePrincipal({ metadata: { user_id: 'u-1' } }),
  });
  assert.equal(got.ok, false);
  assert.equal(got.error, 'route_auto_ambiguous');
  assert.equal(got.candidates.length, 2);
});

test('selectAutoRoute: 没有显式 auto/keywords 的路由不参与自动分诊', () => {
  const got = selectAutoRoute({
    routes: [route('manual.only')],
    text: '任何输入',
    principal: resolvePrincipal({ metadata: { user_id: 'u-1' } }),
  });
  assert.equal(got.ok, false);
  assert.equal(got.error, 'route_auto_no_match');
});

test('previewAutoRoute: 输出候选、选中项和被过滤原因', () => {
  const got = previewAutoRoute({
    routes: [
      route('order.refund', { audience: { auto: true, keywords: ['退款'], roles: ['cs'], priority: 5 } }),
      route('order.audit', { audience: { auto: true, keywords: ['审核'], roles: ['finance'] } }),
      route('finance.close', { audience: { auto: true, keywords: ['退款'] } }),
      route('order.disabled', { enabled: false, audience: { auto: true, keywords: ['退款'] } }),
      route('order.plain'),
    ],
    text: '客户申请退款',
    client,
    principal: { id: 'u-1', tenant: 't-1', roles: ['cs'], audience: 'employee', client_app_id: 'crm' },
  });
  assert.equal(got.ok, true);
  assert.equal(got.selected_route, 'order.refund');
  assert.equal(got.rows.find((r) => r.route_key === 'order.refund')?.selected, true);
  assert.equal(got.rows.find((r) => r.route_key === 'order.audit')?.rejected_reason, 'role_not_allowed');
  assert.equal(got.rows.find((r) => r.route_key === 'finance.close')?.rejected_reason, 'client_not_allowed');
  assert.equal(got.rows.find((r) => r.route_key === 'order.disabled')?.rejected_reason, 'route_disabled');
  assert.equal(got.rows.find((r) => r.route_key === 'order.plain')?.rejected_reason, 'auto_not_enabled');
});
