import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createUsageTestHarness } from './test-harness';
import { getBillingRepository } from './billing-repository';
import { getUsageDeletionRepository } from './usage-deletion';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const admin = 'synthetic-admin';
type Harness = Awaited<ReturnType<typeof createUsageTestHarness>>;
function gate(h: Harness, matches: (sql: string, args: any[]) => boolean, after = false) {
  let entered!: () => void, release!: () => void, armed = true;
  const reached = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
  const original = h.pool.getConnection.bind(h.pool);
  h.pool.getConnection = (async () => {
    const connection = await original();
    return new Proxy(connection, { get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== 'query' && key !== 'execute') return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: any[]) => {
        if (armed && matches(String(args[0]), args[1] ?? [])) {
          armed = false;
          if (after) { const result = await value.apply(target, args); entered(); await held; return result; }
          entered(); await held;
        }
        return value.apply(target, args);
      };
    } });
  }) as typeof h.pool.getConnection;
  return { reached, release: () => release(), restore() { release(); h.pool.getConnection = original; } };
}
async function fixture() {
  const h = await createUsageTestHarness(), tokens = getBillingRepository(h.repository), deletion = getUsageDeletionRepository(h.repository);
  const config = { mode: 'credits', serviceIds: [h.service.id], priceUsd: 100, duration: { unit: 'month', count: 1 }, multiplier: 1 };
  const plan = (id: string = randomUUID()) => tokens.putPlan({ id, label: 'Synthetic unused plan', expected_revision: 0, config });
  const issuerInput = (id: string, accountIds: string[] = []) => ({ id, label: 'Synthetic unused issuer', permissions: ['identity:exchange'], service_ids: [h.service.id], account_ids: accountIds });
  async function organization() {
    const user = await h.seedUser({ grant: false });
    const input = { requestId: randomUUID(), sourceOwner: 'hub', sourceId: randomUUID(), kind: 'organization' as const, label: 'Synthetic organization', userId: user.actor.userId };
    const account = await h.repository.createAccount(input);
    return { user, input, account };
  }
  const suspend = (id: string) => h.repository.setAccountState({accountId:id,expectedRevision:1,requestId:randomUUID(),actor:admin,state:'suspended'});
  const remove = (kind: 'plan' | 'issuer' | 'account', id: string, expectedRevision = 1, requestKey = randomUUID()) => deletion.remove({ kind, id, expectedRevision, requestKey, actor: admin });
  return { ...h, tokens, deletion, config, plan, issuerInput, organization, remove, suspend };
}

test('idle plan deletion: preview, authority, CAS, exact replay, immutable tombstone and encoded IDs', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const p = await h.plan('synthetic:plan'), path = `/admin/api/usage/billing/plans/${encodeURIComponent(p.id)}`;
    const preview = await h.request(`${path}/deletion-preview`, admin);
    assert.equal(preview.status, 200); assert.equal(preview.body.kind, 'plan'); assert.equal(preview.body.can_delete, true);
    assert.deepEqual(preview.body.blockers, []); assert.equal(preview.body.revision, 1); assert.match(preview.body.effect, /原标识/);
    const body = { request_key: randomUUID(), expected_revision: 1 };
    assert.equal((await h.request(`${path}/deletion-preview`, 'synthetic-auditor')).status, 200);
    assert.equal((await h.request(path, 'synthetic-auditor', 'DELETE', body)).status, 403);
    assert.equal((await h.request(path, admin, 'DELETE', { ...body, expected_revision: 9 })).body.error, 'USAGE_REVISION_CONFLICT');
    assert.equal((await h.request(path, admin, 'DELETE', { ...body, extra: true })).status, 400);
    const removed = await h.request(path, admin, 'DELETE', body); assert.equal(removed.status, 200); assert.equal(removed.body.revision, 2);
    assert.deepEqual((await h.request(path, admin, 'DELETE', body)).body, removed.body);
    assert.equal((await h.request(path, admin, 'DELETE', { ...body, expected_revision: 2 })).body.error, 'USAGE_IDEMPOTENCY_CONFLICT');
    assert.equal((await h.request(path, admin, 'DELETE', { request_key: randomUUID(), expected_revision: 2 })).body.error, 'USAGE_RESOURCE_DELETED');
    assert.equal((await h.request(`${path}/deletion-preview`, admin)).status, 404);
    assert.deepEqual(await h.tokens.listPlans(), []);
    await assert.rejects(h.tokens.putPlan({ id: p.id, label: p.label, config: p.config, expected_revision: 2 }), { code: 'USAGE_RESOURCE_DELETED' });
    for (const segment of ['bad%ZZ','bad%2Fname','bad%253Aname']) assert.equal((await h.request(`/admin/api/usage/billing/plans/${segment}/deletion-preview`, admin)).status, 400);
    const [saved] = await h.pool.query<any[]>('SELECT state,revision FROM bz_usage_billing_plans WHERE id=?', [p.id]); assert.equal(saved[0].state, 'deleted');
    await h.repository.deleteService({ id: h.service.id, expectedRevision: 1, requestId: randomUUID(), actor: admin });
    const [unchanged] = await h.pool.query<any[]>('SELECT revision FROM bz_usage_billing_plans WHERE id=?', [p.id]); assert.equal(Number(unchanged[0].revision), 2);
  } finally { await h.close(); }
});

test('suspended current grants allow plan deletion while source history stays protected', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const p = await h.plan(), user = await h.seedUser({ grant: false });
    await h.tokens.grant(user.accountId, { request_key: randomUUID(), plan_id: p.id, expected_revision: 0 }, 'issuer:synthetic-product');
    await h.tokens.control(user.accountId, { request_key: randomUUID(), expected_revision: 1, state: 'suspended' }, 'issuer:synthetic-product');
    const plan = await h.deletion.preview('plan', p.id); assert.equal(plan.can_delete, true); assert.deepEqual(plan.blockers, []);
    const failed = await h.request(`/admin/api/usage/billing/plans/${p.id}`, admin, 'DELETE', { request_key: randomUUID(), expected_revision: 1 });
    assert.equal(failed.status, 200);
    await assert.rejects(h.tokens.control(user.accountId,{request_key:randomUUID(),expected_revision:2,state:'active'},'issuer:synthetic-product'),{code:'SERVICE_NOT_ENTITLED'});
    const source = await h.deletion.preview('issuer', 'synthetic-product');
    assert.deepEqual(source.blockers.map(x => x.code).sort(), ['ISSUER_GRANT_HISTORY','ISSUER_SESSION_HISTORY','ISSUER_USER_HISTORY']);
    await assert.rejects(h.remove('issuer', 'synthetic-product'), { code: 'USAGE_RESOURCE_IN_USE' });
    assert.equal((await h.repository.getAccount(user.accountId))!.state, 'active');
  } finally { await h.close(); }
});

test('unused issuer deletion hides the source, invalidates its credential and cannot be recreated or reactivated', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const input = h.issuerInput('unused:source'), created = await h.identity.createIssuer(input);
    const path = `/admin/api/usage/issuers/${encodeURIComponent(input.id)}`, body = { request_key: randomUUID(), expected_revision: 1 };
    assert.equal((await h.request(`${path}/deletion-preview`, 'synthetic-auditor')).status, 403);
    assert.equal((await h.request(path, 'synthetic-auditor', 'DELETE', body)).status, 403);
    const preview = await h.request(`${path}/deletion-preview`, admin); assert.equal(preview.body.can_delete, true); assert.deepEqual(preview.body.blockers, []);
    const removed = await h.request(path, admin, 'DELETE', body); assert.equal(removed.status, 200);
    assert.deepEqual((await h.request(path, admin, 'DELETE', body)).body, removed.body);
    assert(!(await h.identity.listIssuers()).some(item => item.id === input.id));
    await assert.rejects(h.identity.createIssuer(input), { code: 'USAGE_RESOURCE_DELETED' });
    await assert.rejects(h.identity.controlIssuer(input.id, 2, 'active', true), { code: 'USAGE_RESOURCE_DELETED' });
    await assert.rejects(h.identity.exchange(created.credential!, { request_key: randomUUID(), tenant: 'synthetic', subject: 'later', service_id: h.service.id }), { code: 'USAGE_ISSUER_REQUIRED' });
    const [counts] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_users WHERE issuer_id=?', [input.id]); assert.equal(counts[0].n, 0);
  } finally { await h.close(); }
});

test('archived organization preserves members and history; admin-only restoration is CAS protected and idempotent', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const { user, input, account } = await h.organization(), path = `/admin/api/usage/accounts/${account.id}`;
    assert.deepEqual((await h.deletion.preview('account',account.id)).blockers.map(b=>b.code),['ACCOUNT_ACTIVE']);
    await assert.rejects(h.remove('account',account.id),{code:'USAGE_RESOURCE_IN_USE'});
    await h.repository.setMembership({accountId:account.id,userId:user.actor.userId,expectedRevision:1,state:'revoked',requestId:randomUUID(),actor:admin});
    await h.suspend(account.id);
    assert.equal((await h.deletion.preview('account',account.id)).can_delete,true);
    const body = {request_key:randomUUID(),expected_revision:2};
    assert.equal((await h.request(path,'synthetic-auditor','DELETE',body)).status,403);
    const receipt = await h.request(path,admin,'DELETE',body); assert.equal(receipt.status,200);
    assert.equal(await h.repository.getAccount(account.id),null);
    assert(!(await h.repository.listAccounts()).items.some(a=>a.id===account.id));
    assert(!(await h.repository.listAccounts({userId:user.actor.userId,archived:true})).items.some(a=>a.id===account.id));
    const archivedList=await h.request('/admin/api/usage/accounts?view=archived',admin); assert.equal(archivedList.status,200);
    assert(archivedList.body.items.some((a:any)=>a.id===account.id));
    const detail = await h.request(path,admin); assert.equal(detail.body.account.state,'archived');
    assert.equal(detail.body.members[0].state,'revoked'); assert.equal(detail.body.members[0].revision,2);
    await assert.rejects(h.repository.createAccount(input),{code:'USAGE_ACCOUNT_SUSPENDED'});
    await assert.rejects(h.repository.setAccountState({accountId:account.id,expectedRevision:3,requestId:randomUUID(),actor:admin,state:'active'}),{code:'USAGE_ACCOUNT_SUSPENDED'});
    await assert.rejects(h.repository.setMembership({accountId:account.id,userId:user.actor.userId,expectedRevision:2,requestId:randomUUID(),actor:admin,state:'active'}),{code:'USAGE_ACCOUNT_SUSPENDED'});
    await assert.rejects(h.identity.createIssuer(h.issuerInput('bad-reference',[account.id])),{code:'USAGE_ACCOUNT_FORBIDDEN'});
    const restore = {request_key:randomUUID(),expected_revision:3};
    assert.equal((await h.request(`${path}/restore`,'synthetic-auditor','POST',restore)).status,403);
    assert.equal((await h.request(`${path}/restore`,admin,'POST',{...restore,expected_revision:2})).body.error,'USAGE_REVISION_CONFLICT');
    const restored = await h.request(`${path}/restore`,admin,'POST',restore); assert.equal(restored.status,200); assert.equal(restored.body.state,'suspended');
    assert.deepEqual((await h.request(`${path}/restore`,admin,'POST',restore)).body,restored.body);
    assert.equal((await h.request(`${path}/restore`,admin,'POST',{...restore,expected_revision:4})).body.error,'USAGE_IDEMPOTENCY_CONFLICT');
    assert.deepEqual((await h.request(path,admin,'DELETE',body)).body,receipt.body);
    assert.equal((await h.repository.getAccount(account.id))!.state,'suspended'); // Lost delete ACK must not remove it again.
    const [members] = await h.pool.query<any[]>('SELECT state,revision FROM bz_usage_members WHERE account_id=?',[account.id]);
    assert.equal(members[0].state,'revoked'); assert.equal(Number(members[0].revision),2);
    await h.remove('account',account.id,4);
    assert.deepEqual((await h.request(`${path}/restore`,admin,'POST',restore)).body,restored.body);
    assert.equal((await h.repository.getAccount(account.id,true))!.state,'archived'); // Old restore ACK cannot revive a new removal.
  } finally {await h.close();}
});

test('personal archive retains grant and results, settles in-flight once, and never recreates identity or revives credentials', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const p=await h.plan(),user=await h.seedUser({grant:false});
    const originalGrant=await h.tokens.grant(user.accountId,{request_key:randomUUID(),plan_id:p.id,expected_revision:0});
    const original=await h.tokens.admit({actor:user.actor,operationId:randomUUID(),serviceId:h.service.id,conversationId:null,turnId:null,
      requestHash:'b'.repeat(64),expectedServiceRevision:h.service.revision,serviceConfig:h.service.config,model:h.service.config.model,
      priceSnapshot:{source:'openrouter',modelId:'synthetic/model',endpointId:'synthetic',currency:'USD',fetchedAt:1,
        lines:[{billable:'prompt',unit:'token',costUsd:'1'},{billable:'completion',unit:'token',costUsd:'1'}]}});
    const dispatched=await h.tokens.commitDispatch(original.id,user.actor);
    await h.suspend(user.accountId);
    assert.equal((await h.deletion.preview('account',user.accountId)).can_delete,true);
    await h.remove('account',user.accountId,2);
    const login=()=>h.identity.exchange(h.issuerToken,{request_key:randomUUID(),tenant:'synthetic',subject:user.subject,service_id:h.service.id});
    await assert.rejects(login(),{code:'USAGE_ACCOUNT_SUSPENDED'});
    const result={response:{output:'synthetic'},usage:{inputTokens:3,outputTokens:2}};
    const done=await h.tokens.complete(original.id,dispatched.fence!,result); assert.equal(done.billedUsd,5);
    await h.tokens.complete(original.id,dispatched.fence!,result);
    let summary=await h.tokens.summary(user.accountId); assert.equal(summary.availableUsd,0); assert.equal(summary.consumedUsd,5);assert.equal(summary.grant!.id,originalGrant.id);
    const [ledger]=await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_ledger WHERE request_id=?',[original.id]);assert.equal(Number(ledger[0].n),1);
    await assert.rejects(h.tokens.control(user.accountId,{request_key:randomUUID(),expected_revision:1,state:'active'}),{code:'USAGE_ACCOUNT_SUSPENDED'});
    await assert.rejects(h.tokens.grant(user.accountId,{request_key:randomUUID(),plan_id:p.id,expected_revision:1}),{code:'USAGE_ACCOUNT_SUSPENDED'});
    await h.deletion.restoreAccount({id:user.accountId,expectedRevision:3,requestKey:randomUUID(),actor:admin});
    assert.equal((await h.tokens.summary(user.accountId)).availableUsd,0);
    await h.repository.setAccountState({accountId:user.accountId,expectedRevision:4,state:'active',requestId:randomUUID(),actor:admin});
    summary=await h.tokens.summary(user.accountId); assert.equal(summary.availableUsd,95); assert.equal(summary.grant!.id,originalGrant.id);
    await assert.rejects(h.repository.withTransaction(c=>h.identity.validateActor(c,user.actor)));
    const reopened=await login();assert.equal(reopened.session.accountId,user.accountId);
    const [grants]=await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_grants WHERE account_id=?',[user.accountId]); assert.equal(Number(grants[0].n),1);
    const [members]=await h.pool.query<any[]>('SELECT state,revision FROM bz_usage_members WHERE account_id=?',[user.accountId]);assert.equal(members[0].state,'active');assert.equal(Number(members[0].revision),1);
  } finally {await h.close();}
});

test('existing source references do not prevent archive or grant access to archived accounts', { skip: !enabled }, async () => {
  const h=await fixture();
  try {
    const {account}=await h.organization();
    const source=await h.identity.createIssuer(h.issuerInput('configured-only',[account.id]));
    await h.suspend(account.id);await h.remove('account',account.id,2);
    await assert.rejects(h.identity.requireIssuerAccount(source.issuer,account.id),{code:'USAGE_ACCOUNT_FORBIDDEN'});
  } finally {await h.close();}
});

test('deletion checks remain authoritative against delayed grant and first identity exchange', { skip: !enabled, timeout: 30000 }, async () => {
  const h = await fixture();
  try {
    const p = await h.plan(), user = await h.seedUser({ grant: false });
    const planGate = gate(h, (sql, args) => sql === 'SELECT * FROM bz_usage_accounts WHERE id=? FOR UPDATE' && args[0] === user.accountId);
    try {
      const pending = h.tokens.grant(user.accountId, { request_key: randomUUID(), plan_id: p.id, expected_revision: 0 });
      const rejection = assert.rejects(pending, { code: 'SERVICE_NOT_ENTITLED' }); await planGate.reached;
      await h.remove('plan', p.id); planGate.release(); await rejection;
    } finally { planGate.restore(); }
    const source = await h.identity.createIssuer(h.issuerInput('race-source'));
    const sourceGate = gate(h, (sql, args) => sql === 'SELECT state,revision FROM bz_usage_issuers WHERE id=? FOR SHARE' && args[0] === source.issuer.id);
    try {
      const pending = h.identity.exchange(source.credential!, { request_key: randomUUID(), tenant: 'synthetic', subject: 'late', service_id: h.service.id });
      const rejection = assert.rejects(pending, { code: 'USAGE_ISSUER_REQUIRED' }); await sourceGate.reached;
      await h.remove('issuer', source.issuer.id); sourceGate.release(); await rejection;
      const [rows] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_users WHERE issuer_id=?', [source.issuer.id]); assert.equal(rows[0].n, 0);
    } finally { sourceGate.restore(); }
  } finally { await h.close(); }
});

test('grant winning its shared lock makes a stale successful deletion preview non-authoritative', { skip: !enabled, timeout: 30000 }, async () => {
  const h = await fixture();
  try {
    const p = await h.plan(), user = await h.seedUser({ grant: false });
    assert.equal((await h.deletion.preview('plan', p.id)).can_delete, true);
    const hold = gate(h, (sql, args) => sql === 'SELECT * FROM bz_usage_billing_plans WHERE id=? FOR SHARE' && args[0] === p.id, true);
    try {
      const grant = h.tokens.grant(user.accountId, { request_key: randomUUID(), plan_id: p.id, expected_revision: 0 });
      await hold.reached;
      const deletion = assert.rejects(h.remove('plan', p.id), { code: 'USAGE_RESOURCE_IN_USE' });
      hold.release(); await grant; await deletion;
    } finally { hold.restore(); }
  } finally { await h.close(); }
});

test('account deletion serializes with an issuer configuration that tries to add the removed account', { skip: !enabled, timeout: 30000 }, async () => {
  const h = await fixture();
  try {
    const { account } = await h.organization();
    await h.suspend(account.id);
    const hold = gate(h, (sql, args) => sql === 'SELECT state FROM bz_usage_accounts WHERE id=? FOR SHARE' && args[0] === account.id);
    try {
      const source = assert.rejects(h.identity.createIssuer(h.issuerInput('late-reference', [account.id])), { code: 'USAGE_ACCOUNT_FORBIDDEN' });
      await hold.reached; await h.remove('account', account.id,2); hold.release(); await source;
      assert(!(await h.identity.listIssuers()).some(x => x.id === 'late-reference'));
    } finally { hold.restore(); }
  } finally { await h.close(); }
});

test('incomplete USD schema fails closed without legacy configuration bypass', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const p = await h.plan();
    await h.pool.query('ALTER TABLE bz_usage_billing_requests DROP COLUMN billing_rate_json');
    assert.equal(await h.tokens.configurationReady(), false); assert.equal(await h.tokens.ready(), false);
    const result = await h.request(`/admin/api/usage/billing/plans/${p.id}/deletion-preview`, admin);
    assert.equal(result.status, 503); assert.equal(result.body.error, 'USAGE_UNSUPPORTED');
  } finally { await h.close(); }
});


test('replacing a plan releases its catalog entry while preserving old dispatch, settlement and replay', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const oldPlan = await h.plan(), nextPlan = await h.plan(), user = await h.seedUser({ grant: false });
    const originalGrant = await h.tokens.grant(user.accountId, {request_key:randomUUID(),plan_id:oldPlan.id,expected_revision:0});
    const operationId = randomUUID();
    const original = await h.tokens.admit({actor:user.actor,operationId,serviceId:h.service.id,conversationId:null,turnId:null,
      requestHash:'a'.repeat(64),expectedServiceRevision:h.service.revision,serviceConfig:h.service.config,model:h.service.config.model,
      priceSnapshot:{source:'openrouter',modelId:'synthetic/model',endpointId:'synthetic',currency:'USD',fetchedAt:1,
        lines:[{billable:'prompt',unit:'token',costUsd:'1'},{billable:'completion',unit:'token',costUsd:'1'}]}});
    const dispatched = await h.tokens.commitDispatch(original.id,user.actor);
    await h.tokens.grant(user.accountId,{request_key:randomUUID(),plan_id:nextPlan.id,expected_revision:1});
    assert.equal((await h.deletion.preview('plan',oldPlan.id)).can_delete,true);
    assert.equal((await h.deletion.preview('plan',nextPlan.id)).can_delete,false);
    const receipt = await h.remove('plan',oldPlan.id);
    assert.equal(receipt.deleted,true);
    const done = await h.tokens.complete(original.id,dispatched.fence!,{response:{output:'synthetic'},usage:{inputTokens:3,outputTokens:2}});
    assert.equal(done.billedUsd,5); assert.equal(done.grantId,originalGrant.id);
    assert.equal((await h.tokens.findRequest(user.actor,operationId))!.id,original.id);
    await h.tokens.complete(original.id,dispatched.fence!,{response:{output:'synthetic'},usage:{inputTokens:3,outputTokens:2}});
    const [ledger] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_ledger WHERE request_id=?',[original.id]);
    assert.equal(Number(ledger[0].n),1);
    const summary = await h.tokens.summary(user.accountId);
    assert.equal(summary.plan!.id,nextPlan.id);assert.equal(summary.availableUsd,100);
    const [grants] = await h.pool.query<any[]>('SELECT COUNT(*) AS n FROM bz_usage_billing_grants WHERE plan_id=?',[oldPlan.id]);
    assert.equal(Number(grants[0].n),1);
    assert(!(await h.tokens.listPlans()).some(p=>p.id===oldPlan.id));
  } finally {await h.close();}
});

test('expired current plans can be removed but future grants remain protected', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const expired = await h.plan(), future = await h.plan(), user = await h.seedUser({grant:false});
    await h.tokens.grant(user.accountId,{request_key:randomUUID(),plan_id:expired.id,expected_revision:0,starts_at:Date.now()-40*86400000});
    assert.equal((await h.deletion.preview('plan',expired.id)).can_delete,true);
    await h.remove('plan',expired.id);
    assert.equal((await h.tokens.summary(user.accountId)).presentation.state,'expired');
    await h.tokens.grant(user.accountId,{request_key:randomUUID(),plan_id:future.id,expected_revision:1,starts_at:Date.now()+86400000});
    assert.deepEqual((await h.deletion.preview('plan',future.id)).blockers.map(b=>[b.code,b.count]),[['PLAN_CURRENT_ACCOUNTS',1]]);
    await assert.rejects(h.remove('plan',future.id),{code:'USAGE_RESOURCE_IN_USE'});
  } finally {await h.close();}
});


test('disabled test accounts do not pin a plan and reactivation cannot restore deleted model access', { skip: !enabled }, async () => {
  const h = await fixture();
  try {
    const p = await h.plan(), user = await h.seedUser({grant:false});
    await h.tokens.grant(user.accountId,{request_key:randomUUID(),plan_id:p.id,expected_revision:0});
    assert.equal((await h.deletion.preview('plan',p.id)).can_delete,false);
    await h.repository.setAccountState({accountId:user.accountId,expectedRevision:1,requestId:randomUUID(),actor:admin,state:'suspended'});
    assert.equal((await h.deletion.preview('plan',p.id)).can_delete,true);
    await h.remove('plan',p.id);
    await h.repository.setAccountState({accountId:user.accountId,expectedRevision:2,requestId:randomUUID(),actor:admin,state:'active'});
    const summary = await h.tokens.summary(user.accountId);
    assert.equal(summary.plan,null); assert.equal(summary.availableUsd,0);
    await assert.rejects(h.tokens.control(user.accountId,{request_key:randomUUID(),expected_revision:1,state:'active'}),{code:'SERVICE_NOT_ENTITLED'});
  } finally {await h.close();}
});
