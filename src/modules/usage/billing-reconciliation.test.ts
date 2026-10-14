import test from 'node:test';
import assert from 'node:assert/strict';
import type { UsageRepository } from './repository';
import { getBillingRepository, usageReconciliationSnapshotFor } from './billing-repository';

const price = { source: 'openrouter', currency: 'USD', modelId: 'synthetic', endpointId: 'synthetic', fetchedAt: 1,
  lines: [{ billable: 'output_image', unit: 'image', costUsd: '0.1' }] };
function fixture(count = 51) {
  const records: Record<string, any>[] = Array.from({ length: count }, (_, n) => ({
    id: `request-${String(n).padStart(2, '0')}`, operation_id: `op-${n}`, account_id: 'account', user_id: 'user', session_id: 'session',
    service_id: 'model', conversation_id: null, turn_id: null, request_hash: 'a'.repeat(64), revision: 1, state: 'completed',
    result_state: 'complete', billing_state: 'pending', service_json: {}, service_revision: 1, model: 'synthetic', fence: 'same-fence',
    billing_rate_json: { planId: 'plan', planRevision: 1, multiplier: 1, price }, grant_id: 'grant', grant_revision: 1,
    grant_json: { mode: 'credits', priceUsd: 100, duration: { unit: 'forever', count: 0 } }, period_start: 1, period_end: null,
    result_json: 'INVALID_RESULT_JSON_MUST_NEVER_BE_READ', result_hash: 'b'.repeat(64), usage_json: null,
    raw_usage_json: n === count - 1 ? { requestCount: 1, outputImageCount: 1 } : { requestCount: 1 },
    reference_cost_usd: null, billed_usd: null, overage_usd: null, cancelled_at: null, created_at: n, updated_at: 1,
  }));
  const ledger: string[] = [], attempts: string[] = [], statements: string[] = [];
  const period = { allowance_usd: '100', consumed_usd: '0' };
  const executor = { async query(sql: string, args: any[] = []): Promise<any> {
    statements.push(sql);
    if (sql.includes('ORDER BY updated_at,id LIMIT 50')) {
      let selected = records.filter(r => r.billing_state === 'pending');
      if (args.length) selected = selected.filter(r => r.updated_at > args[0] || (r.updated_at === args[1] && r.id > args[2]));
      return [selected.sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id)).slice(0, 50).map(r => ({ id: r.id, updated_at: r.updated_at }))];
    }
    if (sql.startsWith('SELECT account_id FROM bz_usage_billing_requests')) return [[records.find(r => r.id === args[0])]];
    if (sql.startsWith('SELECT * FROM bz_usage_accounts')) return [[{ id: 'account', state: 'active' }]];
    if (sql.includes('NULL AS result_json') && sql.includes('FROM bz_usage_billing_requests WHERE id=?')) {
      if (sql.includes('FOR UPDATE')) attempts.push(args[0]);
      const record = records.find(r => r.id === args[0]);
      return [record ? [{ ...record, result_json: null }] : []];
    }
    if (sql.startsWith('SELECT * FROM bz_usage_billing_periods')) return [[period]];
    if (sql.startsWith('SELECT CAST(UNIX_TIMESTAMP')) return [[{ ms: 1000 }]];
    if (sql.startsWith('UPDATE bz_usage_billing_periods')) { period.consumed_usd = args[0]; return [{}]; }
    if (sql.startsWith('INSERT INTO bz_usage_billing_ledger')) { ledger.push(args[0]); return [{}]; }
    if (sql.startsWith("UPDATE bz_usage_billing_requests SET billing_state='settled'")) {
      Object.assign(records.find(r => r.id === args[4])!, { billing_state: 'settled', reference_cost_usd: args[0], billed_usd: args[1], overage_usd: args[2], updated_at: args[3] });
      return [{}];
    }
    throw new Error('Unexpected synthetic statement');
  } };
  const repository = { getPool: () => executor, withTransaction: async (fn: (c: any) => Promise<any>) => fn(executor) } as unknown as UsageRepository;
  return { tokens: getBillingRepository(repository), records, ledger, attempts, statements, period };
}
test('fifty unpriceable originals cannot starve the fifty-first payable result, including equal timestamps', async () => {
  const h = fixture();
  await h.tokens.reconcilePendingUsage();
  assert.equal(h.ledger.length, 0); assert.equal(h.tokens.getReconciliationProgress().scanned, 50);
  await h.tokens.reconcilePendingUsage();
  assert.deepEqual(h.ledger, ['request-50']); assert.equal(h.records[50]!.billed_usd, '0.1');
  await h.tokens.reconcilePendingUsage();
  assert.equal(h.ledger.length, 1); assert.equal(h.period.consumed_usd, '0.1');
  assert.equal(h.records.filter(r => r.billing_state === 'pending').length, 50);
  assert(h.statements.every(sql => !sql.startsWith('SELECT * FROM bz_usage_billing_requests')));
});
test('one malformed record does not stop a later valid receipt and progress contains no evidence bodies', async () => {
  const h = fixture(2); h.records[0]!.billing_rate_json = 'SYNTHETIC_MALFORMED_JSON';
  await h.tokens.reconcilePendingUsage();
  assert.deepEqual(h.ledger, ['request-01']);
  assert.deepEqual(h.tokens.getReconciliationProgress(), { scanned: 2, settled: 1, deferred: 0, failed: 1, hasMore: false });
});
test('concurrent reconciliation shares one page rather than skipping its cursor', async () => {
  const h = fixture();
  const first = h.tokens.reconcilePendingUsage();
  assert.equal(h.tokens.reconcilePendingUsage(), first);
  await first;
  assert.equal(h.attempts.length, 50);
});

test('readonly reconciliation snapshot is absent before the first page and returns detached aggregate values afterward', async () => {
  const h = fixture(2);
  assert.equal(usageReconciliationSnapshotFor(h.tokens.repository), undefined);
  const before = h.statements.length;
  assert.equal(usageReconciliationSnapshotFor(h.tokens.repository), undefined);
  assert.equal(h.statements.length, before);
  await h.tokens.reconcilePendingUsage();
  const snapshot = usageReconciliationSnapshotFor(h.tokens.repository)!;
  assert.equal(snapshot.scanned, 2);
  snapshot.scanned = 999;
  assert.equal(usageReconciliationSnapshotFor(h.tokens.repository)!.scanned, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /account|request|SYNTHETIC|result_json/);
});
