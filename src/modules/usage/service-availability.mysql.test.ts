import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUsageTestHarness } from './test-harness';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
const admin = 'synthetic-admin';
test('directory excludes unpriced selected models, keeps reasons scoped and becomes ready after configuration', {skip:!enabled}, async()=>{
  const h=await createUsageTestHarness();
  try {
    const config={...h.service.config,pricing:undefined};
    const unpriced=await h.repository.putService({id:'unpriced',label:'Unpriced',expectedRevision:0,config});
    await h.repository.putService({id:'outside',label:'Must not be disclosed',expectedRevision:0,config});
    const user=await h.identity.exchange(h.issuerToken,{request_key:randomUUID(),tenant:'synthetic',subject:randomUUID(),service_id:h.service.id,model_access:'token_gateway'});
    await h.tokens.putPlan({id:'ready-plan',label:'Readiness',expected_revision:0,config:{mode:'credits',priceUsd:100,multiplier:1,serviceIds:[unpriced.id,h.service.id],duration:{unit:'forever',count:1}}});
    await h.tokens.grant(user.session.accountId,{request_key:randomUUID(),plan_id:'ready-plan',expected_revision:0});
    const directory=async()=> (await h.request('/usage/v1/model/models',user.credential)).body;
    const before=await directory();
    assert.deepEqual(before.items.map((x:any)=>x.service_id),[h.service.id]);
    assert.equal(before.default_service_id,h.service.id);
    assert.deepEqual(before.unavailable_items.map((x:any)=>[x.service_id,x.code]),[[unpriced.id,'USAGE_PRICE_NOT_CONFIGURED']]);
    assert(!JSON.stringify(before).includes('Must not be disclosed'));
    assert(!JSON.stringify(before.unavailable_items).includes('credential'));
    const models=(await h.request('/admin/api/usage/services',admin)).body.items;
    assert.equal(models.find((x:any)=>x.id===unpriced.id).availability.code,'USAGE_PRICE_NOT_CONFIGURED');
    const input={operation_id:randomUUID(),service_id:unpriced.id,messages:[{role:'user',content:'Synthetic'}]};
    const denied=await h.request('/usage/v1/model/requests',user.credential,'POST',input);
    assert.equal(denied.body.code,'USAGE_PRICE_NOT_CONFIGURED');assert.equal(denied.body.feedback.dispatch,'not_dispatched');
    const [rows]=await h.pool.query<any[]>('SELECT COUNT(*) n FROM bz_usage_billing_requests');assert.equal(Number(rows[0].n),0);
    const updated=await h.request('/admin/api/usage/services',admin,'POST',{id:unpriced.id,label:unpriced.label,expected_revision:1,config:h.service.config});
    assert.equal(updated.status,200,JSON.stringify(updated.body));
    assert.equal((await directory()).items.length,2);assert.equal((await directory()).unavailable_items.length,0);
    await h.pool.query('DELETE FROM bz_usage_price_snapshots');
    const missing=await directory();assert.deepEqual(missing.items,[]);assert.equal(missing.default_service_id,null);
    assert(missing.unavailable_items.every((x:any)=>x.code==='USAGE_PRICE_UNAVAILABLE'));
    assert.equal(h.state.calls,0);assert.equal(h.state.counts,0);
  } finally {await h.close();}
});

test('admin cannot activate unbound or unsynchronized pricing; rejected edit preserves original revision', {skip:!enabled},async()=>{
  const h=await createUsageTestHarness();try{
    for(const pricing of [undefined,{...h.service.config.pricing!,modelId:'synthetic/no-quote'}]) {
      const response=await h.request('/admin/api/usage/services',admin,'POST',{id:h.service.id,label:h.service.label,expected_revision:1,config:{...h.service.config,pricing}});
      assert.equal(response.status,503);assert(['USAGE_PRICE_NOT_CONFIGURED','USAGE_PRICE_UNAVAILABLE'].includes(response.body.code));
      assert.equal((await h.repository.getService(h.service.id))!.revision,1);
    }
    const suspended=await h.request('/admin/api/usage/services',admin,'POST',{id:h.service.id,label:h.service.label,expected_revision:1,state:'suspended',config:{...h.service.config,pricing:undefined}});
    assert.equal(suspended.status,200);
    const reactivated=await h.request('/admin/api/usage/services',admin,'POST',{id:h.service.id,label:h.service.label,expected_revision:2,state:'active',config:{...h.service.config,pricing:undefined}});
    assert.equal(reactivated.body.code,'USAGE_PRICE_NOT_CONFIGURED');assert.equal(h.state.calls,0);
  }finally{await h.close();}
});

test('console rejects newly selected unready services but preserves existing unavailable selections without rewriting allowance', {skip:!enabled},async()=>{
  const h=await createUsageTestHarness();try{
    const missing=await h.repository.putService({id:'new-unready',label:'Unready',expectedRevision:0,config:{...h.service.config,pricing:undefined}});
    const config={mode:'credits',priceUsd:100,multiplier:1,serviceIds:[missing.id],duration:{unit:'forever',count:1}};
    const body={id:'configure-plan',label:'Plan',expected_revision:0,config};
    const rejected=await h.request('/admin/api/usage/billing/plans',admin,'POST',body);
    assert.equal(rejected.body.code,'USAGE_PRICE_NOT_CONFIGURED');assert.equal((await h.tokens.listPlans()).length,0);
    // External provisioning may stage a declaration; the console must allow its later removal or unrelated edits.
    const staged=await h.tokens.putPlan(body);
    const kept=await h.request('/admin/api/usage/billing/plans',admin,'POST',{...body,label:'Updated label',expected_revision:staged.revision});
    assert.equal(kept.status,200,JSON.stringify(kept.body));assert.deepEqual(kept.body.config.serviceIds,[missing.id]);
    const removed=await h.request('/admin/api/usage/billing/plans',admin,'POST',{...body,expected_revision:2,config:{...config,serviceIds:[]}});
    assert.equal(removed.status,200);assert.equal(h.state.calls,0);
  }finally{await h.close();}
});
