import assert from 'node:assert/strict';
import test from 'node:test';
import { LedgerFixture, AUTH, SESSION, OTHER_SESSION } from '../../test-support/agent-auth-lifecycle-fixture';

for (const first of ['revoke', 'exchange'] as const) {
  test(`approved authorization: concurrent ${first} obtains the row lock first without a surviving grant`, { timeout: 5000 }, async () => {
    const db = new LedgerFixture();
    await db.approve();
    const gate = db.holdNextLock('authorization', AUTH);
    const waiting = db.waitForBlocked('authorization', AUTH);
    const firstResult = db[first]();
    await gate.arrived;
    const secondResult = first === 'revoke' ? db.exchange() : db.revoke();
    try { await waiting; } finally { gate.release(); }
    const [one, two] = await Promise.all([firstResult, secondResult]);
    const revoked = first === 'revoke' ? one : two;
    const exchanged = first === 'exchange' ? one : two;
    assert.equal(revoked.ok, true);
    assert.equal(exchanged.ok, first === 'exchange');
    assert.equal(db.rows.session.size, first === 'exchange' ? 1 : 0);
    await db.assertNoCredentialsWork();
    assert.equal((await db.revoke()).ok, true, 'retry is idempotent');
  });
}

for (const first of ['revoke', 'rotate'] as const) {
  test(`consumed authorization: concurrent ${first} obtains the session lock first and revokes the entire refresh family`, { timeout: 5000 }, async () => {
    const db = new LedgerFixture();
    await db.approve();
    assert.equal((await db.exchange()).ok, true);
    const gate = db.holdNextLock('session', SESSION);
    const waiting = db.waitForBlocked('session', SESSION);
    const firstResult = db[first]();
    await gate.arrived;
    const secondResult = first === 'revoke' ? db.rotate() : db.revoke();
    try { await waiting; } finally { gate.release(); }
    const [one, two] = await Promise.all([firstResult, secondResult]);
    assert.equal((first === 'revoke' ? one : two).ok, true);
    assert.equal((first === 'rotate' ? one : two).ok, first === 'rotate');
    await db.assertNoCredentialsWork();
    assert.equal((await db.revoke()).ok, true);
  });
}

test('client ownership is enforced before revocation; consumed cross-client links fail without mutating either session', async () => {
  const db = new LedgerFixture();
  await db.approve();
  assert.deepEqual(await db.repository.revokeAuthorization({ authorizationId: AUTH, clientAppId: 'unrelated-app' }), { ok: false, reason: 'wrong_client' });
  assert.equal((await db.exchange()).ok, true);
  const before = structuredClone(db.rows.session.get(SESSION));
  db.rows.session.get(SESSION)!.client_app_id = 'unrelated-app';
  assert.deepEqual(await db.revoke(), { ok: false, reason: 'wrong_client' });
  assert.equal(db.rows.session.get(SESSION)!.revoked_at, null);
  assert.equal(db.rows.token.get('refresh-original')!.status, 'active');
  db.rows.session.set(SESSION, before!);
  assert.equal((await db.revoke()).ok, true);
  await db.assertNoCredentialsWork();
});

test('refresh revalidates token ownership after its unlocked locator read', { timeout: 5000 }, async () => {
  const db = new LedgerFixture();
  await db.approve();
  assert.equal((await db.exchange()).ok, true);
  const gate = db.holdNextLock('session', SESSION);
  const rotation = db.rotate();
  await gate.arrived;
  // Synthetic corrupt/changed storage: the refresh locator no longer owns the
  // session that was just locked. No new credential may escape this mismatch.
  db.rows.token.get('refresh-original')!.session_id = OTHER_SESSION;
  gate.release();
  assert.deepEqual(await rotation, { ok: false, reason: 'invalid_grant' });
  assert.equal(db.rows.token.has('refresh-next'), false);
  assert.equal(db.rows.session.get(SESSION)!.access_token_hash, 'access-original');
});

test('storage failure after staging session revocation rolls back and cannot report success', async () => {
  const db = new LedgerFixture();
  await db.approve();
  assert.equal((await db.exchange()).ok, true);
  db.failNext("UPDATE bz_agent_refresh_tokens SET status='revoked'");
  await assert.rejects(db.revoke(), /synthetic storage unavailable/);
  assert.equal(db.rows.session.get(SESSION)!.revoked_at, null);
  assert.equal(db.rows.token.get('refresh-original')!.status, 'active');
  assert.equal((await db.revoke()).ok, true, 'explicit retry can establish committed success');
  await db.assertNoCredentialsWork();
});

test('commit failure after revoking an approved code leaves the caller without success evidence', async () => {
  const db = new LedgerFixture();
  await db.approve();
  db.failNextCommit();
  await assert.rejects(db.revoke(), /synthetic commit unavailable/);
  assert.equal(db.rows.authorization.get(AUTH)!.status, 'approved');
  assert.equal(db.rows.authorization.get(AUTH)!.code_hash, 'synthetic-code-hash');
  assert.equal((await db.revoke()).ok, true);
  assert.equal((await db.exchange()).ok, false);
});

test('exchange failure after staging credentials rolls them back before a subsequent revocation', async () => {
  const db = new LedgerFixture();
  await db.approve();
  db.failNext("UPDATE bz_agent_authorizations SET status='consumed'");
  await assert.rejects(db.exchange(), /synthetic storage unavailable/);
  assert.equal(db.rows.session.size, 0);
  assert.equal(db.rows.token.size, 0);
  assert.equal((await db.revoke()).ok, true);
  assert.equal((await db.exchange()).ok, false);
});

for (const state of ['pending', 'approved', 'revoked', 'denied', 'expired'] as const) {
  test(`${state} authorization can be safely revoked repeatedly without minting a session`, async () => {
    const db = new LedgerFixture();
    if (state === 'approved') await db.approve();
    else db.rows.authorization.get(AUTH)!.status = state;
    assert.equal((await db.revoke()).ok, true);
    assert.equal((await db.revoke()).ok, true);
    assert.equal(db.rows.authorization.get(AUTH)!.code_hash, null);
    assert.equal(db.rows.authorization.get(AUTH)!.code_expires_at, null);
    assert.equal((await db.exchange()).ok, false);
    assert.equal(db.rows.session.size, 0);
    assert.equal(db.rows.token.size, 0);
  });
}

test('missing consumed session or unknown authorization state cannot claim committed revocation', async () => {
  const db = new LedgerFixture();
  await db.approve();
  assert.equal((await db.exchange()).ok, true);
  db.rows.session.delete(SESSION);
  assert.deepEqual(await db.revoke(), { ok: false, reason: 'not_found' });
  assert.equal(db.rows.token.get('refresh-original')!.status, 'active', 'failed mutation has no partial changes');
  db.rows.authorization.get(AUTH)!.status = 'unexpected-state';
  await assert.rejects(db.revoke(), /lifecycle state is invalid/);
});

test('concurrent repeated revocations serialize and both acknowledge the same revoked session', { timeout: 5000 }, async () => {
  const db = new LedgerFixture();
  await db.approve();
  assert.equal((await db.exchange()).ok, true);
  const gate = db.holdNextLock('authorization', AUTH);
  const waiting = db.waitForBlocked('authorization', AUTH);
  const first = db.revoke();
  await gate.arrived;
  const second = db.revoke();
  try { await waiting; } finally { gate.release(); }
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.sessionId, SESSION);
  }
  await db.assertNoCredentialsWork();
});
