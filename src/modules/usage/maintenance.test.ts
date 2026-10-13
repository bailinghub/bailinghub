import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageRepository } from './repository';
import { getBillingRepository } from './billing-repository';
import { runUsageMaintenanceFor } from './maintenance';

function owner() {
  const repository = new UsageRepository(() => { throw new Error('No database is used in this synthetic port test'); });
  const tokens = getBillingRepository(repository);
  tokens.ready = async () => true;
  return { repository, tokens };
}
test('startup/tick/HTTP share one registered reconciliation and close drains it', async () => {
  const { repository, tokens } = owner();
  let release!: () => void, calls = 0;
  tokens.reconcilePendingUsage = async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); };
  const first = runUsageMaintenanceFor(repository, 1);
  assert.equal(runUsageMaintenanceFor(repository, 1), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  repository.backgroundWork.beginDrain();
  assert.equal(await repository.backgroundWork.drain(1), false);
  await runUsageMaintenanceFor(repository, 100000);
  assert.equal(calls, 1);
  release(); await first;
  assert.equal(await repository.backgroundWork.drain(1000), true);
});
test('one owner failure backs off safely while a different owner progresses', async () => {
  const one = owner(), two = owner();
  let failing = true, attempts = 0, independent = 0;
  const warnings: string[] = [];
  one.repository.backgroundWork.setFailureReporter(kind => warnings.push(kind));
  one.tokens.reconcilePendingUsage = async () => { attempts++; if (failing) throw new Error('SYNTHETIC_PRIVATE_SQL_MUST_NOT_ESCAPE'); };
  two.tokens.reconcilePendingUsage = async () => { independent++; };
  await runUsageMaintenanceFor(one.repository, 1000);
  await runUsageMaintenanceFor(one.repository, 60999);
  await runUsageMaintenanceFor(two.repository, 1000);
  assert.equal(attempts, 1); assert.equal(independent, 1);
  assert.deepEqual(warnings, ['usage-reconciliation']);
  failing = false;
  await runUsageMaintenanceFor(one.repository, 61000);
  await runUsageMaintenanceFor(one.repository, 61001);
  assert.equal(attempts, 3); // A successful scan clears failure backoff.
});
test('optional usage absence and a missing repository do not create model work', async () => {
  const { repository, tokens } = owner(); let calls = 0;
  tokens.ready = async () => false;
  tokens.reconcilePendingUsage = async () => { calls++; };
  await runUsageMaintenanceFor(null);
  await runUsageMaintenanceFor(repository);
  assert.equal(calls, 0);
});

test('a slow SQL failure starts its bounded retry delay at failure completion', async () => {
  const { repository, tokens } = owner(); let clock = 1, attempts = 0, fail = true;
  tokens.reconcilePendingUsage = async () => { attempts++; if (fail) { clock = 120000; throw new Error('Synthetic slow SQL failure'); } };
  await runUsageMaintenanceFor(repository, () => clock);
  fail = false; clock = 179999;
  await runUsageMaintenanceFor(repository, () => clock); assert.equal(attempts, 1);
  clock = 180000;
  await runUsageMaintenanceFor(repository, () => clock); assert.equal(attempts, 2);
});
