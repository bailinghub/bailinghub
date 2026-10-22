import test from 'node:test';
import assert from 'node:assert/strict';
import {newBudgetForm,readBudgetForm,writeBudgetConfig,clearVerifiedBudgetRoute} from './usage-output-budget';
const config={maxOutputTokens:65536,defaultOutputTokens:32768,outputTokenParameter:'max_completion_tokens' as const,outputBudgetScope:'completion_total' as const,modelMaxOutputTokens:131072};
test('legacy editing preserves the old policy and explicit policy roundtrips separately',()=>{
  assert.deepEqual(writeBudgetConfig(readBudgetForm({maxOutputTokens:8192}),'chat'),{maxOutputTokens:8192});
  assert.deepEqual(writeBudgetConfig(readBudgetForm(config),'chat'),config);
  assert.equal(newBudgetForm().maxOutputTokens,undefined);
  assert.throws(()=>writeBudgetConfig(newBudgetForm(),'chat'),/服务输出上限/);
});
test('default, service and verified model ceilings remain ordered; partial policy cannot silently become legacy',()=>{
  for(const patch of [{defaultOutputTokens:65537},{maxOutputTokens:131073},{maxOutputTokens:65536,modelMaxOutputTokens:32768}])
    assert.throws(()=>writeBudgetConfig(readBudgetForm({...config,...patch}),'chat'));
  assert.throws(()=>writeBudgetConfig(readBudgetForm({maxOutputTokens:8192,defaultOutputTokens:4096}),'chat'),/输出参数/);
  assert.throws(()=>writeBudgetConfig(readBudgetForm({...config,outputBudgetScope:'final_answer'}),'chat'),/含思考/);
});
test('changing route requires new semantic confirmation but preserves numeric budgets',()=>{
  const form=readBudgetForm(config);clearVerifiedBudgetRoute(form);
  assert.equal(form.defaultOutputTokens,32768);assert.equal(form.maxOutputTokens,65536);
  assert.equal(form.modelMaxOutputTokens,undefined);
  assert.throws(()=>writeBudgetConfig(form,'chat'),/供应商路由/);
});
test('image/model tools do not inherit chat policy or get an invented image-token budget',()=>{
  assert.deepEqual(writeBudgetConfig(readBudgetForm(config),'tool'),{maxOutputTokens:65536});
  assert.deepEqual(writeBudgetConfig(newBudgetForm(),'tool'),{maxOutputTokens:8192});
});
