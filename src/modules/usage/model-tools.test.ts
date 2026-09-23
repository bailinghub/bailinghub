import assert from 'node:assert/strict';
import test from 'node:test';
import { validateModelToolConfig, modelToolDescriptor, isModelTool, type ModelToolConfig } from './model-tools';
import type { UsageService } from './contracts';
const tool = (): ModelToolConfig => ({name:'create_asset',capability:'custom_media',description:'Create media for the requested campaign.',outputs:['image'],parameters:[{name:'prompt',type:'string',required:true,description:'Description of the asset'}],adapter:'pending'});
const service = (): UsageService => ({id:'image-service',label:'Create images',revision:2,state:'active',config:{credential:'private-credential-alias',model:'synthetic',providerScope:'private-provider-scope',maxInputBytes:1024,maxOutputTokens:100,timeoutMs:1000,purpose:'tool',tool:tool()}});
test('purpose separates existing chat models and configurable tools',()=>{
  validateModelToolConfig({}); validateModelToolConfig({purpose:'chat'});
  validateModelToolConfig({purpose:'tool',tool:tool()});
  assert.equal(isModelTool(service()),true);
  const chat=service(); delete chat.config.purpose;delete chat.config.tool;
  assert.equal(isModelTool(chat),false);
  assert.throws(()=>validateModelToolConfig({purpose:'chat',tool:tool()}));
  assert.throws(()=>validateModelToolConfig({purpose:'tool'}));
});
test('tool schemas reject ambiguous and unsafe fields before persistence',()=>{
  for (const bad of [
    {...tool(),adapter:'arbitrary-url'}, {...tool(),perImage:100}, {...tool(),outputs:[]},
    {...tool(),name:'invalid tool'}, {...tool(),parameters:[...tool().parameters,...tool().parameters]},
    {...tool(),parameters:[{...tool().parameters[0],name:'__proto__'}]},
  ]) assert.throws(()=>validateModelToolConfig({purpose:'tool',tool:bad as ModelToolConfig}));
});
test('directory returns only declaration, explicit unavailability and shared USD multiplier',()=>{
  const value=modelToolDescriptor(service(),2);
  assert.equal(value.callable,false);assert.equal(value.reason,'MODEL_TOOL_ADAPTER_NOT_READY');
  assert.equal(value.billing_scope,'shared_plan');assert.equal(value.billing_unit,'USD');
  assert.deepEqual(value.billing_rate,{multiplier:2});
  assert.deepEqual(value.tool.input_schema.required,['prompt']);
  assert.equal(value.tool.input_schema.additionalProperties,false);
  assert.equal(JSON.stringify(value).includes('private-'),false);
  assert.equal(JSON.stringify(value).includes('synthetic'),false);
});
test('file references remain declarations, not filesystem paths or uploads',()=>{
  const s=service(); s.config.tool!.parameters=[{name:'source',type:'file',required:true,description:'Host-owned artifact reference'}];
  assert.deepEqual(modelToolDescriptor(s).tool.input_schema.properties.source,{type:'string',description:'Host-owned artifact reference','x-bailing-value':'artifact_ref'});
});
