import { test } from 'node:test';
import assert from 'node:assert/strict';
import { budgetThresholdExceeded, checkLaunchBudget, normalizeBudgetPolicy, validateBudgetPolicy, type BudgetUsage } from './budget-runtime';
import type { Client, Route } from '../contracts/types';

function route(budget?: Record<string, unknown>): Route {
  return {
    route_key: 'budget.route',
    name: '预算路由',
    enabled: true,
    target: 'llm',
    target_config: { credential: 'main' },
    profile: 'default',
    session_policy: 'new',
    budget,
  };
}

function client(budget?: Record<string, unknown>): Client {
  return {
    app_id: 'client-a',
    name: '接入方A',
    token: 't'.repeat(32),
    allowed_routes: ['*'],
    allowed_channels: [],
    rate_limit_per_min: 60,
    enabled: true,
    budget,
  };
}

test('normalizeBudgetPolicy: 支持 day/hour/month/window_hours 并清理无效阈值', () => {
  assert.deepEqual(normalizeBudgetPolicy({ window: 'hour', hard_cost_usd: '1.5', hard_tokens: '1000', soft_cost_usd: 0 }), {
    enabled: true,
    window_hours: 1,
    hard_cost_usd: 1.5,
    hard_tokens: 1000,
    soft_cost_usd: undefined,
    soft_tokens: undefined,
  });
  assert.equal(normalizeBudgetPolicy({}) , null);
  assert.equal(normalizeBudgetPolicy(null), null);
  assert.equal(normalizeBudgetPolicy({ enabled: false, window_hours: 2 })?.enabled, false);
});

test('validateBudgetPolicy: 拒绝非法窗口和阈值', () => {
  assert.equal(validateBudgetPolicy({ window: 'week' }), 'budget.window 仅支持 hour/day/month');
  assert.equal(validateBudgetPolicy({ window_hours: 0 }), 'budget.window_hours 必须是正整数');
  assert.equal(validateBudgetPolicy({ hard_cost_usd: -1 }), 'budget.hard_cost_usd 必须是正数');
  assert.equal(validateBudgetPolicy({ hard_tokens: 1.2 }), 'budget.hard_tokens 必须是正整数');
  assert.equal(validateBudgetPolicy({ hard_cost_usd: 1, hard_tokens: 1000 }), null);
});

test('budgetThresholdExceeded: 达到硬限即拒绝，未启用则放行', () => {
  const usage: BudgetUsage = { jobs: 3, cost_usd: 2, tokens: 900 };
  assert.deepEqual(budgetThresholdExceeded({ enabled: false, window_hours: 24, hard_cost_usd: 1 }, usage), { ok: true });
  assert.equal(budgetThresholdExceeded({ enabled: true, window_hours: 24, hard_cost_usd: 2 }, usage).reason, 'cost_exceeded');
  assert.equal(budgetThresholdExceeded({ enabled: true, window_hours: 24, hard_tokens: 900 }, usage).reason, 'tokens_exceeded');
  assert.equal(budgetThresholdExceeded({ enabled: true, window_hours: 24, hard_cost_usd: 3, hard_tokens: 1000 }, usage).ok, true);
});

test('checkLaunchBudget: 路由预算先拦截，接入方预算随后兜底', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const store = {
    async budgetUsageSince(filter: { routeKey?: string; clientAppId?: string; sinceMs: number }) {
      calls.push(filter);
      return filter.routeKey ? { jobs: 1, cost_usd: 5, tokens: 100 } : { jobs: 2, cost_usd: 1, tokens: 2000 };
    },
  };

  const r = await checkLaunchBudget({
    route: route({ window_hours: 1, hard_cost_usd: 5 }),
    client: client({ window_hours: 1, hard_tokens: 1000 }),
    store,
    nowMs: 10_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.scope, 'route');
  assert.equal(r.reason, 'cost_exceeded');
  assert.equal(calls.length, 1);

  calls.length = 0;
  const c = await checkLaunchBudget({
    route: route({ window_hours: 1, hard_cost_usd: 6 }),
    client: client({ window_hours: 1, hard_tokens: 1000 }),
    store,
    nowMs: 10_000,
  });
  assert.equal(c.ok, false);
  assert.equal(c.scope, 'client');
  assert.equal(c.reason, 'tokens_exceeded');
  assert.equal(calls.length, 2);
});
