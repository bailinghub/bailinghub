import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createUsageTestHarness } from './test-harness';
import { handleModelGatewayApiFor } from './model-gateway';
import type { UsageServiceConfig } from './contracts';

const enabled = process.env.BAILING_USAGE_TEST_MYSQL === '1';
async function fixture(options: {response?: () => Response | Promise<Response>} = {}) {
  const h = await createUsageTestHarness();
  const modelId = 'synthetic/image-model', endpointId = 'synthetic-image-provider';
  const pricing = {source:'openrouter' as const,kind:'image' as const,modelId,endpointId};
  const snapshot = {...pricing,currency:'USD',fetchedAt:Date.now(),lines:[
    {billable:'input_image',unit:'image',costUsd:'0.01',variant:'1k'},
    {billable:'output_image',unit:'image',costUsd:'0.2',variant:'1k'},
  ]};
  await h.pool.query('INSERT INTO bz_usage_price_snapshots(cache_key,snapshot_json,fetched_at) VALUES(?,?,?)',[
    createHash('sha256').update(`image:${modelId}`).digest('hex'),JSON.stringify({fetchedAt:Date.now(),items:[{id:endpointId,pricing:snapshot}]}),Date.now(),
  ]);
  const config: UsageServiceConfig = {...h.service.config,purpose:'tool',model:'synthetic-image',pricing,
    tool:{name:'generate_image',capability:'image_generation',description:'Generate a synthetic test image.',outputs:['image'],adapter:'aliyun-image',parameters:[
      {name:'prompt',type:'string',required:true,description:'Synthetic image description'},
      {name:'n',type:'number',required:false,description:'Image count'},
    ]}};
  const image = await h.repository.putService({id:'synthetic-image',label:'Synthetic image tool',expectedRevision:0,config});
  const excluded = await h.repository.putService({id:'unselected-image',label:'Unselected synthetic tool',expectedRevision:0,config});
  const pending = await h.repository.putService({id:'pending-video',label:'Declaration only',expectedRevision:0,config:{...config,pricing:undefined,tool:{...config.tool!,name:'generate_video',capability:'video_generation',outputs:['video'],adapter:'pending'}}});
  const user = await h.identity.exchange(h.issuerToken,{request_key:randomUUID(),tenant:'synthetic',subject:randomUUID(),service_id:h.service.id,model_access:'token_gateway'});
  const plan = await h.tokens.putPlan({id:'image-plan',label:'Synthetic shared USD allowance',expected_revision:0,config:{mode:'periodic',periodAllowanceUsd:100,priceUsd:100,multiplier:1.5,periodUnit:'week',duration:{unit:'month',count:1},serviceIds:[h.service.id,image.id,pending.id]}});
  await h.tokens.grant(user.session.accountId,{request_key:randomUUID(),plan_id:plan.id,expected_revision:0});
  let release!:()=>void;
  const responseGate = new Promise<void>(resolve=>{release=resolve;});
  const calls: Array<{url:string;body:Record<string,unknown>}> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);assert.equal(url,'https://synthetic.invalid/v1/images/generations');
    calls.push({url,body:JSON.parse(String(init?.body))});
    await responseGate;
    if (options.response) return options.response();
    return new Response(JSON.stringify({id:'synthetic-provider-request',data:[{url:'https://synthetic.invalid/generated.png'}],usage:{input_image_count:0,output_image_count:1,output_image_type:'1k',output_width:1024,output_height:1024}}),{status:200,headers:{'content-type':'application/json'}});
  };
  const server = createServer(async(req,res)=>{
    if(!await handleModelGatewayApiFor({usage:h.repository,cfg:{llmCredentials:{synthetic:{base_url:'https://synthetic.invalid/v1',api_key:'REPLACE_ME'}}},fetcher},req,res,new URL(req.url!,'http://localhost'))) {res.writeHead(404);res.end();}
  }).listen(0,'127.0.0.1');await once(server,'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path:string,method='GET',body?:unknown) {
    const response = await fetch(base+path,{method,headers:{authorization:`Bearer ${user.credential}`,'content-type':'application/json'},...(body === undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as Record<string,any>};
  }
  const input = (serviceId=image.id) => ({operation_id:randomUUID(),service_id:serviceId,conversation_id:'original-conversation',turn_id:'original-turn',arguments:{prompt:'Synthetic test image',n:1}});
  async function settled(operationId:string) {
    for(let i=0;i<300;i++) {
      const r = await request(`/usage/v1/model/requests/${operationId}`);
      assert.equal(r.status,200,JSON.stringify(r.body));
      if(r.body.billing_state==='settled') return r.body;
      await delay(10);
    }
    throw new Error('Synthetic image operation did not settle');
  }
  return {...h,image,excluded,pending,user,calls,input,request,release,settled,
    async close(){release();for(let i=0;i<300;i++){const [rows]=await h.pool.query<any[]>("SELECT COUNT(*) n FROM bz_usage_billing_requests WHERE fence IS NOT NULL AND result_hash IS NULL AND state='dispatch_committed'");if(!Number(rows[0].n))break;await delay(10);}server.close();server.closeAllConnections();await h.close();},
  };
}

test('image HTTP returns pending before provider result; image-count receipt settles shared USD without invented Tokens', {skip:!enabled}, async()=>{
  const h=await fixture();try{
    const input=h.input(), first=await h.request('/usage/v1/model/tools/requests','POST',input);
    assert.equal(first.status,202);assert.equal(first.body.result_state,'pending');assert.equal(first.body.billing_state,'pending');
    assert.equal(h.calls.length,1);assert.equal(h.calls[0]!.body.model,'synthetic-image');
    h.release();const done=await h.settled(input.operation_id);
    assert.equal(done.result_state,'complete');assert.equal(done.usage,null);assert.equal(done.raw_usage.outputImageCount,1);
    assert.equal(done.reference_cost_usd,0.2);assert.equal(done.billed_usd,0.3);assert.equal(done.response.outputs[0].type,'image');
    const summary=await h.tokens.summary(h.user.session.accountId);assert.equal(summary.availableUsd,99.7);assert.equal(summary.presentation.remaining,99.7);
  }finally{await h.close();}
});

test('lost image ACK and repeated original POST/GET reuse one generation and one ledger entry', {skip:!enabled},async()=>{
  const h=await fixture();try{
    const input=h.input();await h.request('/usage/v1/model/tools/requests','POST',input);
    const retry=await h.request('/usage/v1/model/tools/requests','POST',input);assert.equal(retry.status,202);assert.equal(h.calls.length,1);
    h.release();const done=await h.settled(input.operation_id);
    const recovered=await h.request('/usage/v1/model/tools/requests','POST',input);assert.equal(recovered.status,200);assert.deepEqual(recovered.body,done);assert.equal(h.calls.length,1);
    const changed=await h.request('/usage/v1/model/tools/requests','POST',{...input,arguments:{prompt:'Changed'}});assert.equal(changed.status,409);assert.equal(h.calls.length,1);
    const [rows]=await h.pool.query<any[]>('SELECT COUNT(*) n FROM bz_usage_billing_ledger WHERE account_id=?',[h.user.session.accountId]);assert.equal(Number(rows[0].n),1);
  }finally{await h.close();}
});

test('cancelled image keeps late cost evidence but never re-exposes outputs or dispatches another generation', {skip:!enabled},async()=>{
  const h=await fixture();try{
    const input=h.input();await h.request('/usage/v1/model/tools/requests','POST',input);
    const cancelled=await h.request(`/usage/v1/model/requests/${input.operation_id}/cancel`,'POST',{});assert.equal(cancelled.status,200);assert.equal(cancelled.body.result_state,'cancelled');
    h.release();const done=await h.settled(input.operation_id);assert.equal(done.result_state,'cancelled');assert.equal('response' in done,false);assert.equal(done.billed_usd,0.3);
    const retry=await h.request('/usage/v1/model/tools/requests','POST',input);assert.equal(retry.body.result_state,'cancelled');assert.equal('response' in retry.body,false);assert.equal(h.calls.length,1);
  }finally{await h.close();}
});

test('tool and chat directories stay separate; pending or unselected tools never reach provider', {skip:!enabled},async()=>{
  const h=await fixture();try{
    const models=await h.request('/usage/v1/model/models'),tools=await h.request('/usage/v1/model/tools');
    assert.equal(models.status,200);assert.deepEqual(models.body.items.map((i:any)=>i.service_id),[h.service.id],JSON.stringify({models:models.body,summary:await h.tokens.summary(h.user.session.accountId),now:Date.now()}));
    assert.deepEqual(tools.body.items.map((i:any)=>i.service_id),[h.image.id]);
    assert.equal(tools.body.unavailable_items.find((i:any)=>i.service_id===h.pending.id).code,'MODEL_TOOL_ADAPTER_NOT_READY');
    const unselected=await h.request('/usage/v1/model/tools/requests','POST',h.input(h.excluded.id));assert.equal(unselected.status,403);
    const pending=await h.request('/usage/v1/model/tools/requests','POST',h.input(h.pending.id));assert.equal(pending.status,400);assert.equal(pending.body.code,'MODEL_TOOL_ADAPTER_NOT_READY');
    const wrongPurpose=await h.request('/usage/v1/model/requests','POST',{operation_id:randomUUID(),service_id:h.image.id,messages:[{role:'user',content:'Synthetic'}]});assert.equal(wrongPurpose.status,400);
    assert.equal(h.calls.length,0);
    const [rows]=await h.pool.query<any[]>('SELECT COUNT(*) n FROM bz_usage_billing_requests');assert.equal(Number(rows[0].n),0);
  }finally{await h.close();}
});

for(const status of [404,503]) test(`provider HTTP ${status} persists safe outcome; repeated original recovery never regenerates`,{skip:!enabled},async()=>{
 const h=await fixture({response:()=>new Response(JSON.stringify({code:'SyntheticError',message:'DO_NOT_STORE',request_id:'synthetic-original'}),{status})});
 try{
  const input=h.input();await h.request('/usage/v1/model/tools/requests','POST',input);h.release();
  let receipt:any;
  for(let i=0;i<100;i++){receipt=(await h.request(`/usage/v1/model/requests/${input.operation_id}`)).body;if(receipt.result_state!=='pending')break;await delay(10);}
  assert.equal(receipt.result_state,status===404?'failed':'unknown');assert.equal(receipt.billing_state,status===404?'settled':'pending');
  assert.equal(receipt.error.http_status,status);assert.equal(receipt.error.retryable,false);assert.equal(receipt.response,undefined);
  assert.equal(receipt.billed_usd,status===404?0:null);assert.equal(receipt.dispatch,status===404?'rejected':'unknown');
  const replay=await h.request('/usage/v1/model/tools/requests','POST',input);assert.equal(replay.body.result_state,receipt.result_state);assert.equal(h.calls.length,1);
  const [records]=await h.pool.query<any[]>('SELECT result_json FROM bz_usage_billing_requests');assert.equal(JSON.stringify(records).includes('DO_NOT_STORE'),false);
  await h.tokens.reconcilePendingUsage();assert.equal(h.calls.length,1);
  const summary=await h.tokens.summary(h.user.session.accountId);assert.equal(summary.availableUsd,100);
  if(status===404){const cancel=await h.request(`/usage/v1/model/requests/${input.operation_id}/cancel`,'POST',{});assert.equal(cancel.body.result_state,'failed');}
 }finally{await h.close();}
});

test('late rejection after cancellation closes billing without changing cancellation or exposing response',{skip:!enabled},async()=>{
 const h=await fixture({response:()=>new Response('{}',{status:400})});try{
  const input=h.input();await h.request('/usage/v1/model/tools/requests','POST',input);
  await h.request(`/usage/v1/model/requests/${input.operation_id}/cancel`,'POST',{});h.release();
  const done=await h.settled(input.operation_id);assert.equal(done.result_state,'cancelled');assert.equal(done.billed_usd,0);assert.equal(done.response,undefined);assert.equal(h.calls.length,1);
 }finally{await h.close();}
});
