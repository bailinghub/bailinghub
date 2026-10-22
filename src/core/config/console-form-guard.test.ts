import assert from 'node:assert/strict';
import test from 'node:test';
import { createFormExitGuard, formSnapshot, needsUnloadWarning } from '../../../web-admin/src/form-guard';
import { hasClientRouteDraft, rememberClientRouteDraft, takeClientRouteDraft, type ClientRouteDraft } from '../../../web-admin/src/client-route-draft';

test('unchanged forms leave quietly; edits, reverted edits and in-flight saves have distinct unload behavior', async () => {
  const form = { name: 'existing', routes: ['one'], settings: { window: 'day', enabled: true } };
  const baseline = formSnapshot(form);
  let active = true, saving = false, prompts = 0, blocked = 0;
  const state = { active: () => active, saving: () => saving, dirty: () => formSnapshot(form) !== baseline };
  const guard = createFormExitGuard(state, async () => { prompts++; return false; }, () => { blocked++; });
  assert.equal(await guard.confirmLeave(), true);
  assert.equal(needsUnloadWarning(state), false);
  form.routes.push('two');
  assert.equal(needsUnloadWarning(state), true);
  assert.equal(await guard.confirmLeave(), false);
  assert.deepEqual(form.routes, ['one', 'two'], 'cancel retains the exact input');
  form.routes.pop();
  assert.equal(needsUnloadWarning(state), false, 'reverting the edit restores a clean form');
  saving = true;
  assert.equal(needsUnloadWarning(state), true, 'an unchanged form can still have a pending save');
  assert.equal(await guard.confirmLeave(), false);
  assert.equal(prompts, 1); assert.equal(blocked, 1);
  active = false;
  assert.equal(needsUnloadWarning(state), false);
  assert.equal(await guard.confirmLeave(), true);
});

test('overlapping close and navigation share one confirmation; starting a save prevents a late discard', async () => {
  let saving = false, prompts = 0;
  let answer!: (value: boolean) => void;
  const guard = createFormExitGuard({ active: () => true, dirty: () => true, saving: () => saving },
    () => { prompts++; return new Promise<boolean>((resolve) => { answer = resolve; }); }, () => undefined);
  const close = guard.confirmLeave(), navigation = guard.confirmLeave();
  assert.equal(prompts, 1);
  saving = true; answer(true);
  assert.equal(await close, false); assert.equal(await navigation, false);
  saving = false;
  const retry = guard.confirmLeave(); answer(true);
  assert.equal(await retry, true); assert.equal(prompts, 2);
});

test('a dismissed or rejected confirmation never permits navigation', async () => {
  const guard = createFormExitGuard({ active: () => true, dirty: () => true, saving: () => false },
    async () => { throw new Error('modal dismissed'); }, () => undefined);
  assert.equal(await guard.confirmLeave(), false);
  assert.equal(formSnapshot({ a: 1, nested: { b: 2, a: 3 } }), formSnapshot({ nested: { a: 3, b: 2 }, a: 1 }),
    'hydrating an equivalent object with a different key order does not invent edits');
});

test('the client dependency detour restores only its owner, once, without adding a wildcard or retaining token fields', () => {
  const input = { form: { app_id: 'draft', name: 'Unfinished client', agent_authorize_url: '', allowed_routes: [], allowed_channels: [],
    rate_limit_per_min: 60, description: 'keep this input', enabled: true, token: 'must-not-be-retained', secret: 'also-not-retained' },
    budget: { enabled: true, window: 'day', hard_tokens: 1234 }, budgetRest: { legacy_budget_flag: true }, editing: false, baseline: 'original-baseline' } as ClientRouteDraft;
  rememberClientRouteDraft('user-a', input);
  input.form.name = 'changed after leaving';
  assert.equal(hasClientRouteDraft('user-a'), true);
  assert.equal(hasClientRouteDraft('user-b'), false);
  const restored = takeClientRouteDraft('user-a')!;
  assert.equal(restored.form.name, 'Unfinished client');
  assert.deepEqual(restored.form.allowed_routes, []);
  assert.equal(restored.budget.hard_tokens, 1234);
  assert.equal(restored.baseline, 'original-baseline');
  assert.equal('token' in restored.form, false); assert.equal('secret' in restored.form, false);
  assert.equal(takeClientRouteDraft('user-a'), undefined);
  rememberClientRouteDraft('user-a', input);
  assert.equal(takeClientRouteDraft('user-b'), undefined);
  assert.equal(takeClientRouteDraft('user-a'), undefined, 'changing account discards the previous draft');
});
