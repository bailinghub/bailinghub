import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createUsageTestHarness } from './test-harness';
import { UsageRepository, usageHash } from './repository';
import type { PriceSnapshot } from './billing-contracts';
import { getBillingRepository } from './billing-repository';
import { handleUsageApiFor } from './http';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
type Harness = Awaited<ReturnType<typeof createUsageTestHarness>>;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
/** Pause one real SQL boundary; all HTTP, transactions and locking still use MySQL. */
function sqlGate(h: Harness, matches: (sql: string, args: any[]) => boolean, after = false, fail = false) {
  const entered = deferred(), release = deferred();
  const original = h.pool.getConnection.bind(h.pool);
  let armed = true;
  const errors: string[] = [];
  h.pool.getConnection = (async () => {
    const connection = await original();
    return new Proxy(connection, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'query' && key !== 'execute') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: any[]) => {
        try {
        const selected = armed && matches(String(args[0]), args[1] ?? []);
        if (selected) {
          armed = false;
          if (after) {
            const result = await value.apply(target, args); entered.resolve(); await release.promise;
            if (fail) throw new Error('synthetic_cleanup_unavailable');
            return result;
          }
          entered.resolve(); await release.promise;
          if (fail) throw new Error('synthetic_cleanup_unavailable');
        }
        return await value.apply(target, args);
        } catch (error) { errors.push(String((error as { code?: string }).code ?? error)); throw error; }
      };
    } });
  }) as typeof h.pool.getConnection;
  return { errors, entered: entered.promise, release: release.resolve, restore() { release.resolve(); h.pool.getConnection = original; } };
}
const identityInsert = (state: string) => (sql: string, args: any[]) => sql.startsWith('INSERT INTO bz_usage_users') && args[5] === state;
const sessionCleanup = (sql: string) => sql.startsWith("UPDATE bz_usage_sessions SET state='revoked' WHERE user_id=");
function input(h: Harness, subject = randomUUID(), extra: Record<string, unknown> = {}) {
  return { request_key: randomUUID(), tenant: 'synthetic', subject, generation: 'original', service_id: h.service.id, ...extra };
}
const exact = (body: ReturnType<typeof input>) => ({ tenant: body.tenant, subject: body.subject, generation: body.generation });
const exchange = (h: Harness, body: ReturnType<typeof input>, token = h.issuerToken) => h.request('/usage/v1/sessions/exchange', token, 'POST', body);
const revoke = (h: Harness, body: ReturnType<typeof input>, token = h.issuerToken) => h.request('/usage/v1/external/users/revoke', token, 'POST', exact(body));
async function stored(h: Harness, body: ReturnType<typeof input>) {
  const [rows] = await h.pool.query<any[]>('SELECT id,state FROM bz_usage_users WHERE issuer_id=? AND tenant_key=? AND subject_key=? AND generation_key=?', ['synthetic-product', body.tenant, body.subject, body.generation]);
  return rows[0];
}
async function noActiveSessions(h: Harness, userId: string) {
  const [rows] = await h.pool.query<any[]>("SELECT COUNT(*) AS n FROM bz_usage_sessions WHERE user_id=? AND state='active'", [userId]);
  assert.equal(Number(rows[0].n), 0);
}

test('usage revocation: durable exact-generation fence and account-first concurrency through real HTTP/MySQL', { skip: !enabled, timeout: 120_000 }, async t => {
  const h = await createUsageTestHarness();
  try {
    await t.test('unknown identity revocation persists without creating an account, allowance or credential', async () => {
      const body = input(h);
      assert.deepEqual((await revoke(h, body)).body, { revoked: true });
      const tombstone = await stored(h, body); assert.equal(tombstone.state, 'suspended');
      assert.equal((await revoke(h, body)).status, 200); assert.equal((await stored(h, body)).id, tombstone.id);
      for (const retry of [body, { ...body, request_key: randomUUID() }]) {
        const result = await exchange(h, retry); assert.equal(result.status, 403); assert.equal(result.body.code, 'USAGE_ACCOUNT_SUSPENDED');
      }
      const [counts] = await h.pool.query<any[]>('SELECT (SELECT COUNT(*) FROM bz_usage_accounts) AS accounts,(SELECT COUNT(*) FROM bz_usage_sessions) AS sessions,(SELECT COUNT(*) FROM bz_usage_billing_plans) AS plans,(SELECT COUNT(*) FROM bz_usage_billing_grants) AS grants');
      assert.deepEqual(Object.values(counts[0]).map(Number), [0, 0, 0, 0]);
    });
    await t.test('first exchange delayed before identity persistence cannot revive a revocation that already acknowledged', async () => {
      const body = input(h), gate = sqlGate(h, identityInsert('active'));
      try {
        const pending = exchange(h, body); await gate.entered;
        assert.equal((await revoke(h, body)).status, 200);
        gate.release(); const late = await pending;
        assert.equal(late.status, 403); assert.equal(late.body.code, 'USAGE_ACCOUNT_SUSPENDED');
        const user = await stored(h, body); assert.equal(user.state, 'suspended'); await noActiveSessions(h, user.id);
      } finally { gate.restore(); }
    });
    await t.test('revocation between identity creation and first account transaction prevents account creation', async () => {
      const body = input(h), gate = sqlGate(h, sql => sql === 'SELECT id,state FROM bz_usage_users WHERE id=? FOR UPDATE');
      try {
        const pending = exchange(h, body); await gate.entered;
        const initial = await stored(h, body); assert.equal(initial.state, 'active');
        assert.equal((await revoke(h, body)).status, 200);
        gate.release(); assert.equal((await pending).status, 403);
        const [members] = await h.pool.query<any[]>('SELECT account_id FROM bz_usage_members WHERE user_id=?', [initial.id]);
        assert.equal(members.length, 0); await noActiveSessions(h, initial.id);
      } finally { gate.restore(); }
    });
    await t.test('exchange committing first is revoked with original account and session records retained', async () => {
      const body = input(h), gate = sqlGate(h, sql => sql.startsWith('INSERT INTO bz_usage_sessions'), true);
      try {
        const pendingExchange = exchange(h, body); await gate.entered;
        const pendingRevoke = revoke(h, body);
        gate.release(); const [issued, revoked] = await Promise.all([pendingExchange, pendingRevoke]);
        assert.equal(issued.status, 200); assert.equal(revoked.status, 200);
        assert.equal((await h.request('/usage/v1/session', issued.body.credential)).status, 401);
        assert.equal((await exchange(h, body)).status, 401);
        assert.equal((await exchange(h, { ...body, request_key: randomUUID() })).status, 403);
        const [records] = await h.pool.query<any[]>('SELECT s.id,s.account_id,s.state,a.id AS retained_account FROM bz_usage_sessions s JOIN bz_usage_accounts a ON a.id=s.account_id WHERE s.id=?', [issued.body.session.sessionId]);
        assert.equal(records[0].id, issued.body.session.sessionId); assert.equal(records[0].state, 'revoked'); assert.equal(records[0].retained_account, issued.body.session.accountId);
      } finally { gate.restore(); }
    });
    await t.test('committed tombstone blocks exchange, authentication and model dispatch before session cleanup completes', async () => {
      const user = await h.seedUser(), body = input(h, user.subject, { generation: '' });
      const gate = sqlGate(h, sql => sql.startsWith('SELECT account_id FROM bz_usage_members WHERE user_id=? ORDER BY account_id'));
      try {
        const pending = revoke(h, body); await gate.entered;
        assert.equal((await stored(h, body)).state, 'suspended');
        const [sessions] = await h.pool.query<any[]>('SELECT state FROM bz_usage_sessions WHERE id=?', [user.actor.sessionId]); assert.equal(sessions[0].state, 'active');
        assert.equal((await h.request('/usage/v1/session', user.token)).body.code, 'USAGE_ACCOUNT_SUSPENDED');
        assert.equal((await exchange(h, body)).status, 403);
        const calls = h.state.calls;
        const denied = await h.request('/usage/v1/model/requests', user.token, 'POST', { operation_id: randomUUID(), messages: [{ role: 'user', content: 'Synthetic fenced request.' }] });
        assert.equal(denied.status, 403); assert.equal(denied.body.code, 'USAGE_ACCOUNT_SUSPENDED'); assert.equal(h.state.calls, calls);
        gate.release(); assert.equal((await pending).status, 200);
      } finally { gate.restore(); }
    });
    await t.test('session cleanup failure is reported, but the durable fence survives and exact retry finishes cleanup', async () => {
      const user = await h.seedUser(), body = input(h, user.subject, { generation: '' }), gate = sqlGate(h, sessionCleanup, false, true);
      try {
        const pending = revoke(h, body); await gate.entered; gate.release();
        const failed = await pending; assert.equal(failed.status, 503); assert.equal(failed.body.code, 'USAGE_UNAVAILABLE');
      } finally { gate.restore(); }
      assert.equal((await stored(h, body)).state, 'suspended');
      assert.equal((await h.request('/usage/v1/session', user.token)).body.code, 'USAGE_ACCOUNT_SUSPENDED');
      assert.equal((await exchange(h, body)).status, 403);
      const [before] = await h.pool.query<any[]>('SELECT * FROM bz_usage_billing_ledger WHERE account_id=? ORDER BY id', [user.accountId]);
      assert.equal((await revoke(h, body)).status, 200); assert.equal((await h.request('/usage/v1/session', user.token)).status, 401);
      const [after] = await h.pool.query<any[]>('SELECT * FROM bz_usage_billing_ledger WHERE account_id=? ORDER BY id', [user.accountId]); assert.deepEqual(after, before);
    });
    await t.test('fresh HTTP runtime sees tombstone; issuer, tenant and generation stay isolated', async () => {
      const body = input(h); assert.equal((await revoke(h, body)).status, 200);
      const repository = new UsageRepository(() => h.pool);
      const server = createServer(async (req, res) => { await handleUsageApiFor({ usage: repository }, req, res, new URL(req.url!, 'http://localhost')); }).listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const result = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/usage/v1/sessions/exchange`, { method: 'POST', headers: { authorization: `Bearer ${h.issuerToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(result.status, 403); assert.equal((await result.json() as any).code, 'USAGE_ACCOUNT_SUSPENDED');
      } finally { server.close(); server.closeAllConnections(); }
      const otherIssuer = await h.identity.createIssuer({ id: `issuer-${randomUUID()}`, label: 'Other synthetic product', permissions: ['identity:exchange'], service_ids: [h.service.id] });
      const others = [await exchange(h, { ...body, request_key: randomUUID(), tenant: 'other' }), await exchange(h, { ...body, request_key: randomUUID(), generation: 'reassigned' }), await exchange(h, body, otherIssuer.credential!)];
      for (const result of others) assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(new Set(others.map(result => result.body.session.userId)).size, 3);
      assert.equal((await stored(h, body)).state, 'suspended');
    });
    await t.test('shared-account authentication and exchange use account-first locks without a deadlock retry', async () => {
      const user = await h.seedUser(), key = randomUUID();
      const organization = await h.repository.createAccount({ requestId: key, sourceId: key, sourceOwner: 'synthetic-admin', kind: 'organization', label: 'Synthetic shared account', userId: user.actor.userId });
      await h.pool.query('UPDATE bz_usage_issuers SET account_ids_json=? WHERE id=?', [JSON.stringify([organization.id]), 'synthetic-product']);
      const body = input(h, user.subject, { generation: '', account_id: organization.id });
      const initial = await exchange(h, body); assert.equal(initial.status, 200);
      const authGate = sqlGate(h, sql => sql.includes('FROM bz_usage_sessions s JOIN bz_usage_users u'));
      let accountGate: ReturnType<typeof sqlGate> | undefined;
      try {
        const authenticating = h.request('/usage/v1/session', initial.body.credential); await authGate.entered;
        accountGate = sqlGate(h, (sql, args) => sql === 'SELECT id FROM bz_usage_accounts WHERE id=? FOR UPDATE' && args[0] === organization.id);
        const exchanging = exchange(h, { ...body, request_key: randomUUID() }); await accountGate.entered;
        accountGate.release(); authGate.release();
        const [authenticated, exchanged] = await Promise.all([authenticating, exchanging]);
        assert.equal(authenticated.status, 200); assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
        assert.equal(exchanged.body.session.accountId, organization.id); assert.equal(exchanged.body.session.userId, user.actor.userId);
        assert.deepEqual([...authGate.errors, ...accountGate.errors], []);
      } finally { accountGate?.restore(); authGate.restore(); }
      assert.equal((await revoke(h, body)).status, 200);
      assert.equal((await h.request('/usage/v1/session', user.token)).status, 401);
      assert.equal((await h.request('/usage/v1/session', initial.body.credential)).status, 401);
    });
    await t.test('revocation refuses an un-dispatched request and retains original dispatched billing evidence', async () => {
      const user = await h.seedUser(), body = input(h, user.subject, { generation: '' }), tokens = getBillingRepository(h.repository);
      const priceSnapshot: PriceSnapshot = {source:'openrouter',modelId:'synthetic/model',endpointId:'synthetic-endpoint',currency:'USD',fetchedAt:Date.now(),lines:[{billable:'prompt',unit:'token',costUsd:'1'},{billable:'completion',unit:'token',costUsd:'1'}]};
      const admit = () => tokens.admit({ priceSnapshot, actor: user.actor, serviceId: h.service.id, conversationId: 'original-operation', turnId: null,
        operationId: randomUUID(), requestHash: usageHash(randomUUID()), model: h.service.config.model,
        serviceConfig: h.service.config, expectedServiceRevision: h.service.revision });
      const first = await admit(), dispatched = await tokens.commitDispatch(first.id, user.actor);
      await tokens.markUnknown(first.id, dispatched.fence!, 'synthetic_response_lost');
      const second = await admit();
      assert.equal((await revoke(h, body)).status, 200);
      await assert.rejects(tokens.commitDispatch(second.id, user.actor), (error: any) => ['USAGE_IDENTITY_EXPIRED', 'USAGE_ACCOUNT_SUSPENDED'].includes(error.code));
      const [before] = await h.pool.query<any[]>('SELECT id,state,fence,request_hash,account_id,user_id,session_id FROM bz_usage_billing_requests WHERE id=?', [first.id]);
      assert.equal(before[0].state, 'unknown'); assert.equal(before[0].fence, dispatched.fence);
      const receipt = { response: { text: 'Synthetic original result' }, usage: { inputTokens: 20, outputTokens: 5 } };
      const settled = await tokens.complete(first.id, dispatched.fence!, receipt); assert.equal(settled.billedUsd, 25);
      assert.equal((await tokens.complete(first.id, dispatched.fence!, receipt)).billedUsd, 25);
      const [after] = await h.pool.query<any[]>('SELECT id,state,fence,request_hash,account_id,user_id,session_id FROM bz_usage_billing_requests WHERE id=?', [first.id]);
      assert.deepEqual({ ...after[0], state: 'unknown' }, before[0]);
      const [charges] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_ledger WHERE account_id=?', [user.accountId]);
      assert.equal(Number(charges[0].n), 1);
    });
    await t.test('simultaneous first exchanges serialize on one real identity and return one original personal account', async () => {
      const body = input(h), gate = sqlGate(h, sql => sql.includes('ON DUPLICATE KEY UPDATE change_key=change_key'), true);
      let followerGate: ReturnType<typeof sqlGate> | undefined;
      try {
        const first = exchange(h, body); await gate.entered;
        followerGate = sqlGate(h, identityInsert('active'));
        const follower = exchange(h, { ...body, request_key: randomUUID() }); await followerGate.entered;
        followerGate.release(); gate.release();
        const [a, b] = await Promise.all([first, follower]);
        assert.equal(a.status, 200); assert.equal(b.status, 200);
        assert.equal(a.body.session.userId, b.body.session.userId); assert.equal(a.body.session.accountId, b.body.session.accountId);
        assert.deepEqual((await exchange(h, body)).body, a.body);
        const [members] = await h.pool.query<any[]>('SELECT account_id FROM bz_usage_members WHERE user_id=?', [a.body.session.userId]);
        assert.equal(members.length, 1); assert.deepEqual([...gate.errors, ...followerGate.errors], []);
      } finally { followerGate?.restore(); gate.restore(); }
    });
    await t.test('different first identities reserve independent account keys without gap-lock deadlocks', async () => {
      const capture = sqlGate(h, () => false);
      try {
        const bodies = Array.from({ length: 24 }, () => input(h));
        const results = await Promise.all(bodies.map(body => exchange(h, body)));
        for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(new Set(results.map(result => result.body.session.userId)).size, 24);
        assert.equal(new Set(results.map(result => result.body.session.accountId)).size, 24);
        assert.deepEqual(capture.errors, []);
      } finally { capture.restore(); }
    });
    await t.test('failed account creation rolls back its placeholder; the original key can retry and rejects changed input', async () => {
      const user = await h.seedUser(), body = { request_key: randomUUID(), source_id: randomUUID(), kind: 'organization', label: 'Synthetic rollback account', user_id: user.actor.userId };
      const key = usageHash(['account:hub', body.request_key]);
      const [before] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_accounts');
      const gate = sqlGate(h, sql => sql.startsWith('INSERT INTO bz_usage_members'), true, true);
      try {
        const pending = h.request('/admin/api/usage/accounts', 'synthetic-admin', 'POST', body); await gate.entered; gate.release();
        assert.equal((await pending).status, 503);
      } finally { gate.restore(); }
      const [changes] = await h.pool.query<any[]>('SELECT change_key FROM bz_usage_changes WHERE change_key=?', [key]); assert.equal(changes.length, 0);
      const [after] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_accounts'); assert.deepEqual(after, before);
      const created = await h.request('/admin/api/usage/accounts', 'synthetic-admin', 'POST', body); assert.equal(created.status, 200);
      assert.deepEqual((await h.request('/admin/api/usage/accounts', 'synthetic-admin', 'POST', body)).body, created.body);
      assert.equal((await h.request('/admin/api/usage/accounts', 'synthetic-admin', 'POST', { ...body, label: 'Changed input' })).body.code, 'USAGE_IDEMPOTENCY_CONFLICT');
      const [saved] = await h.pool.query<any[]>("SELECT JSON_TYPE(result_json) AS kind FROM bz_usage_changes WHERE change_key=?", [key]); assert.equal(saved[0].kind, 'OBJECT');
    });
    await t.test('identity persistence never holds the source while waiting for an existing user lock', async () => {
      const body = input(h); assert.equal((await exchange(h, body)).status, 200);
      const user = await stored(h, body), held = await h.pool.getConnection();
      const gate = sqlGate(h, identityInsert('suspended'));
      let pending: ReturnType<typeof revoke> | undefined;
      try {
        await held.query('SET SESSION innodb_lock_wait_timeout=1');
        await held.beginTransaction();
        await held.query('SELECT id FROM bz_usage_users WHERE id=? FOR UPDATE', [user.id]);
        pending = revoke(h, body); await gate.entered;
        // The exchange/dispatch path already owns this user before checking its
        // source. A concurrent identity upsert must not hold the inverse lock.
        await held.query('SELECT id FROM bz_usage_issuers WHERE id=? FOR UPDATE', ['synthetic-product']);
        await held.commit(); gate.release();
        assert.equal((await pending).status, 200);
        assert.deepEqual(gate.errors, []);
        assert.equal((await stored(h, body)).state, 'suspended');
        await noActiveSessions(h, user.id);
      } finally {
        await held.rollback(); gate.release();
        if (pending) await pending;
        await held.query('SET SESSION innodb_lock_wait_timeout=50'); held.release(); gate.restore();
      }
    });
    await t.test('competing first exchanges and revocations converge without a live credential or false success', async () => {
      const capture = sqlGate(h, () => false);
      try {
      for (let round = 0; round < 50; round++) {
        const body = input(h), outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) => i % 3 === round % 3 ? revoke(h, body) : exchange(h, { ...body, request_key: i % 2 ? body.request_key : randomUUID() })));
        for (const result of outcomes) assert.ok([200, 401, 403].includes(result.status), JSON.stringify(result.body));
        assert.equal((await revoke(h, body)).status, 200);
        const user = await stored(h, body); assert.equal(user.state, 'suspended'); await noActiveSessions(h, user.id);
        for (const result of outcomes) if (result.body.credential) assert.equal((await h.request('/usage/v1/session', result.body.credential)).status, 401);
      }
      assert.equal(capture.errors.filter(code => code === 'ER_LOCK_DEADLOCK').length, 0);
      const [pending] = await h.pool.query<any[]>("SELECT COUNT(*) AS n FROM bz_usage_changes WHERE JSON_TYPE(result_json)='NULL'"); assert.equal(Number(pending[0].n), 0);
      } finally { capture.restore(); }
    });
    assert.equal(h.state.calls, 0, 'identity tests never invoke a model');
  } finally { await h.close(); }
});
