import test from 'node:test';
import assert from 'node:assert/strict';
import { mysqlJobUpdatePlan } from './state-mysql-update-plan';
import type { Job } from '../../core/contracts/types';

test('mysql job update plan only writes explicit patch fields', () => {
  const plan = mysqlJobUpdatePlan({
    status: 'done',
    result: { text: 'ok' },
    claim_token: undefined,
    executor_id: undefined,
  }, '2026-01-02T03:04:05.000Z');

  assert.deepEqual(plan.assignments, [
    'status=?',
    'result=?',
    'executor_id=?',
    'claim_token=?',
    'updated_at=?',
  ]);
  assert.deepEqual(plan.values, [
    'done',
    '{"text":"ok"}',
    null,
    null,
    '2026-01-02 03:04:05',
  ]);
});

test('mysql job update plan ignores identity and create-time fields', () => {
  const patch = {
    job_id: 'other-job',
    request_id: 'other-request',
    created_at: '2026-01-01T00:00:00.000Z',
    input_preview: 'new preview',
  } as Partial<Job>;

  const plan = mysqlJobUpdatePlan(patch, '2026-01-02T03:04:05.000Z');

  assert.deepEqual(plan.assignments, ['input_preview=?', 'updated_at=?']);
  assert.deepEqual(plan.values, ['new preview', '2026-01-02 03:04:05']);
});

test('mysql job update plan does not null required columns from explicit undefined', () => {
  const plan = mysqlJobUpdatePlan({
    status: undefined,
    profile: undefined,
    attempts: undefined,
    run_after: undefined,
  } as Partial<Job>, '2026-01-02T03:04:05.000Z');

  assert.deepEqual(plan.assignments, ['run_after=?', 'updated_at=?']);
  assert.deepEqual(plan.values, [null, '2026-01-02 03:04:05']);
});
