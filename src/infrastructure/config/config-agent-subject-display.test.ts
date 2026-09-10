import assert from 'node:assert/strict';
import test from 'node:test';
import { APP, AUTH, SESSION, OTHER_SESSION, FUTURE, LedgerFixture } from '../../test-support/agent-auth-lifecycle-fixture';

function withoutDisplay(row: Record<string, unknown>) {
  const copy = structuredClone(row); delete copy.subject_display; delete copy.updated_at; return copy;
}

async function fixture() {
  const f = new LedgerFixture();
  const approved = await f.repository.approveAuthorization({ authorizationId: AUTH, clientAppId: APP,
    principal: { id: 'operator-a', tenant: 'account-a', roles: ['manager'] }, onBehalfOf: 'account-a:operator-a',
    allowedRoutes: ['shop'], codeHash: 'synthetic-code-hash', codeExpiresAt: FUTURE, subjectDisplay: { name: 'Account A' } });
  assert.equal(approved.ok, true);
  assert.equal((await f.exchange()).ok, true);
  return f;
}

test('subject name survives authorization, exchange, refresh, rename and clear without changing identity', async () => {
  const f = await fixture();
  assert.deepEqual((await f.repository.getAuthorization(AUTH))?.subject_display, { name: 'Account A' });
  assert.deepEqual((await f.repository.getSessionByAccessHash('access-original'))?.subject_display, { name: 'Account A' });
  const original = structuredClone(f.rows.session.get(SESSION)!);
  const originalTokens = structuredClone([...f.rows.token.entries()]);
  const renamed = await f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: SESSION, subjectDisplay: { name: 'Account North' } });
  assert.equal(renamed.ok, true);
  if (renamed.ok) {
    assert.deepEqual(renamed.session.subject_display, { name: 'Account North' });
    assert.equal(renamed.session.authorization_id, AUTH);
  }
  assert.deepEqual(withoutDisplay(f.rows.session.get(SESSION)!), withoutDisplay(original));
  assert.deepEqual([...f.rows.token.entries()], originalTokens);
  assert.deepEqual((await f.repository.getAuthorization(AUTH))?.subject_display, { name: 'Account A' }, 'approval-time metadata remains a snapshot');
  const rotated = await f.rotate();
  assert.equal(rotated.ok, true);
  if (rotated.ok) assert.deepEqual(rotated.session.subject_display, { name: 'Account North' });
  const clear = await f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: SESSION, subjectDisplay: null });
  assert.equal(clear.ok, true);
  if (clear.ok) assert.equal(clear.session.subject_display, null);
  assert.equal(f.rows.session.size, 1);
});

test('same display names stay separate and cross-client/inactive updates fail without mutations', async () => {
  const f = await fixture();
  const original = structuredClone(f.rows.session.get(SESSION)!);
  f.rows.session.set(OTHER_SESSION, { ...original, session_id: OTHER_SESSION, on_behalf_of: 'account-b:operator-b' });
  assert.equal((await f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: OTHER_SESSION, subjectDisplay: { name: 'Account A' } })).ok, true);
  assert.equal(f.rows.session.size, 2);
  assert.equal(f.rows.session.get(SESSION)!.on_behalf_of, original.on_behalf_of);
  assert.equal(f.rows.session.get(OTHER_SESSION)!.on_behalf_of, 'account-b:operator-b');
  assert.deepEqual(await f.repository.updateSubjectDisplay({ clientAppId: 'other-client', sessionId: SESSION, subjectDisplay: { name: 'Wrong' } }), { ok: false, reason: 'not_found' });
  for (const patch of [{ refresh_expires_at: '2000-01-01 00:00:00' }, { revoked_at: '2026-01-01 00:00:00' }]) {
    f.rows.session.set(SESSION, { ...original, ...patch });
    const before = structuredClone(f.rows.session.get(SESSION));
    assert.deepEqual(await f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: SESSION, subjectDisplay: { name: 'Wrong' } }), { ok: false, reason: 'inactive' });
    assert.deepEqual(f.rows.session.get(SESSION), before);
  }
});

test('old unnamed Session can be backfilled without changing original credentials', async () => {
  const f = new LedgerFixture(); await f.approve(); await f.exchange();
  const original = structuredClone(f.rows.session.get(SESSION)!);
  assert.equal((await f.repository.getSessionByAccessHash('access-original'))?.subject_display, null);
  await f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: SESSION, subjectDisplay: { name: 'Workspace A' } });
  assert.deepEqual(withoutDisplay(f.rows.session.get(SESSION)!), withoutDisplay(original));
  assert.deepEqual((await f.repository.getSessionByAccessHash('access-original'))?.subject_display, { name: 'Workspace A' });
});

test('display write/commit failures roll back and a same-value retry does not rotate a Session', async () => {
  const f = await fixture(); const original = structuredClone(f.rows.session.get(SESSION));
  for (const failure of ['query', 'commit']) {
    if (failure === 'query') f.failNext('SET subject_display='); else f.failNextCommit();
    await assert.rejects(() => f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: SESSION, subjectDisplay: { name: 'Updated' } }));
    assert.deepEqual(f.rows.session.get(SESSION), original);
  }
  for (let i = 0; i < 2; i++) assert.equal((await f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: SESSION, subjectDisplay: { name: 'Updated' } })).ok, true);
  assert.equal(f.rows.session.size, 1); assert.equal(f.rows.token.size, 1);
});

test('revocation wins over a waiting display update and cannot be undone by a name', async () => {
  const f = await fixture();
  const held = f.holdNextLock('session', SESSION);
  const revoke = f.repository.revokeSessionForClient(APP, SESSION);
  await held.arrived;
  const blocked = f.waitForBlocked('session', SESSION);
  const update = f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: SESSION, subjectDisplay: { name: 'Updated' } });
  await blocked; held.release();
  assert.equal(await revoke, true);
  assert.deepEqual(await update, { ok: false, reason: 'inactive' });
  assert.deepEqual(JSON.parse(f.rows.session.get(SESSION)!.subject_display), { name: 'Account A' });
});

test('concurrent refresh and display update preserve both independent changes', async () => {
  const f = await fixture();
  const held = f.holdNextLock('session', SESSION);
  const refresh = f.rotate(); await held.arrived;
  const blocked = f.waitForBlocked('session', SESSION);
  const update = f.repository.updateSubjectDisplay({ clientAppId: APP, sessionId: SESSION, subjectDisplay: { name: 'Updated' } });
  await blocked; held.release();
  assert.equal((await refresh).ok, true); assert.equal((await update).ok, true);
  const current = await f.repository.getSessionByAccessHash('access-next');
  assert.equal(current?.session_id, SESSION); assert.deepEqual(current?.subject_display, { name: 'Updated' });
});
