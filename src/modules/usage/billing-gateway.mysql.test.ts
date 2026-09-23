import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUsageTestHarness } from './test-harness';
const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
test('USD HTTP: plan-wide multiplier and original price snapshot survive a plan edit', {skip:!enabled},async()=>{
 const h=await createUsageTestHarness();try{
  const user=await h.seedUser({grant:false}),id=randomUUID();
  const config={mode:'credits',priceUsd:1000,multiplier:1.5,serviceIds:[h.service.id],duration:{unit:'month',count:1}};
  assert.equal((await h.request('/admin/api/usage/billing/plans','synthetic-admin','POST',{id,label:'Synthetic',expected_revision:0,config})).status,200);
  assert.equal((await h.request(`/admin/api/usage/billing/accounts/${user.accountId}/grant`,'synthetic-admin','POST',{request_key:randomUUID(),plan_id:id,expected_revision:0})).status,200);
  const models=await h.request('/usage/v1/model/models',user.token);assert.deepEqual(models.body.items[0].billing_rate,{multiplier:1.5});
  const input={operation_id:randomUUID(),messages:[{role:'user',content:'Synthetic'}]};
  const first=await h.request('/usage/v1/model/requests',user.token,'POST',input);assert.equal(first.status,200,JSON.stringify(first.body));
  await h.tokens.drainSettlements();
  assert.equal((await h.request('/admin/api/usage/billing/plans','synthetic-admin','POST',{id,label:'Synthetic',expected_revision:1,config:{...config,multiplier:2}})).status,200);
  const replay=await h.request('/usage/v1/model/requests',user.token,'POST',input);
  assert.equal(replay.body.reference_cost_usd,25);assert.equal(replay.body.billed_usd,37.5);assert.deepEqual(replay.body.billing_rate,first.body.billing_rate);assert.equal(h.state.calls,1);
  const next=await h.request('/usage/v1/model/requests',user.token,'POST',{...input,operation_id:randomUUID()});await h.tokens.drainSettlements();
  assert.equal((await h.request(`/usage/v1/model/requests/${next.body.operation_id}`,user.token)).body.billed_usd,50);
  const summary=(await h.request('/usage/v1/model/summary',user.token)).body;assert.equal(summary.availableUsd,912.5);assert.equal(summary.consumedUsd,87.5);
  assert.equal(summary.presentation.displayValue,'912500');
 }finally{await h.close();}
});
