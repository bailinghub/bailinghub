import assert from 'node:assert/strict';
import test from 'node:test';
import { executeModelTool, modelToolBody } from './model-tool-provider';
import { ProviderFailure } from './provider-failure';
import type { UsageServiceConfig } from './contracts';
const credential={base_url:'https://synthetic.invalid/compatible-mode/v1',api_key:'sk-private-test-key'};
const config:UsageServiceConfig={credential:'synthetic',model:'synthetic-image',providerScope:'synthetic',maxInputBytes:4096,maxOutputTokens:100,timeoutMs:1000,purpose:'tool',tool:{name:'image',capability:'image_generation',description:'Synthetic',outputs:['image'],adapter:'aliyun-image-native',parameters:[{name:'prompt',type:'string',required:true,description:'Prompt'}]}};

test('native image adapter sends exactly one request on the configured origin and parses real usage',async()=>{
 let calls=0;
 const result=await executeModelTool(credential,config,{model:config.model,prompt:'Synthetic',size:'1024x1024',n:1},async(url,init)=>{
  calls++;assert.equal(url,'https://synthetic.invalid/api/v1/services/aigc/multimodal-generation/generation');
  assert.deepEqual(JSON.parse(String(init?.body)),{model:'synthetic-image',input:{messages:[{role:'user',content:[{text:'Synthetic'}]}]},parameters:{size:'1024*1024',n:1}});
  return new Response(JSON.stringify({request_id:'synthetic-request',output:{choices:[{message:{content:[{text:'ignored'},{image:'https://synthetic.invalid/image.png'}]}}]},usage:{input_image_count:0,output_image_count:1,output_image_type:'qima_output_1k'}}));
 });
 assert.equal(calls,1);assert.equal(result.executionId,'synthetic-request');assert.equal(result.rawUsage?.outputImageCount,1);assert.equal(result.rawUsage?.outputVariant,'1k');assert.equal(result.usage,undefined);
});
test('definite provider rejection is not unknown, errors are bounded and do not retain raw body or credentials',async()=>{
 for(const status of [400,401,403,404,405,413,415,422,429]){
  let calls=0;
  await assert.rejects(executeModelTool(credential,config,{prompt:'Synthetic'},async()=>{calls++;return new Response(JSON.stringify({request_id:'test-request',error:{code:'InvalidParameter',message:'private prompt '+credential.api_key},secret:credential.api_key}),{status});}),e=>{
   assert.ok(e instanceof ProviderFailure);assert.equal(e.rejected,true);assert.equal(e.diagnostic.http_status,status);assert.equal(e.diagnostic.provider_code,'InvalidParameter');assert.equal(e.diagnostic.provider_request_id,'test-request');assert.equal(JSON.stringify(e).includes(credential.api_key),false);assert.equal(JSON.stringify(e).includes('private prompt'),false);return true;
  });assert.equal(calls,1);
 }
 await assert.rejects(executeModelTool(credential,config,{},async()=>new Response('x'.repeat(17000),{status:404})),(e:any)=>e.rejected===true&&e.diagnostic.http_status===404);
 await assert.rejects(executeModelTool(credential,config,{},async()=>new Response(JSON.stringify({code:credential.api_key,request_id:credential.api_key}),{status:400})),(e:any)=>!e.diagnostic.provider_code&&!e.diagnostic.provider_request_id);
});
test('timeouts, server errors and malformed success remain uncertain without retry or protocol fallback',async()=>{
 for(const fetcher of [async()=>{throw Error('connection lost');},async()=>new Response('{}',{status:503}),async()=>new Response('{}',{status:408}),async()=>new Response('bad json')]){
  let calls=0;
  await assert.rejects(executeModelTool(credential,config,{},async()=>{calls++;return fetcher();}),(e:any)=>e instanceof ProviderFailure&&!e.rejected&&e.diagnostic.next_action==='inspect_original');assert.equal(calls,1);
 }
});
test('native adapter shares declared parameter validation and rejects model-controlled undeclared input',()=>{
 assert.throws(()=>modelToolBody(config,{prompt:'Synthetic',url:'https://other.invalid'}));
 assert.deepEqual(modelToolBody(config,{prompt:'Synthetic'}),{model:config.model,prompt:'Synthetic'});
});
