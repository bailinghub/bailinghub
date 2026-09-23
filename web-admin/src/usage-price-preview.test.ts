import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveBillingModel, estimateModelAllowance, type ReferenceQuote } from './usage-price-preview';

const chat: ReferenceQuote = { source: 'openrouter', currency: 'USD', modelId: 'provider/model', endpointId: 'provider', fetchedAt: 1,
  lines: [{billable:'prompt',unit:'token',costUsd:'0.000001'}, {billable:'completion',unit:'token',costUsd:'0.000003'}] };
const image: ReferenceQuote = {...chat, lines:[{billable:'output_image',unit:'image',variant:'1k',costUsd:'0.03'}, {billable:'output_image',unit:'image',variant:'2k',costUsd:'0.06'}]};

test('optional pricing override matches the exact selected identifier without alias guesses', () => {
  assert.equal(effectiveBillingModel('provider/custom-alias', 'other/exact-version'), 'other/exact-version');
  assert.equal(effectiveBillingModel(' provider/model ', '  '), 'provider/model');
});
test('whole allowance is independently estimated with plan multiplier and stated input/output mix', () => {
  const first = estimateModelAllowance(chat, 10, 2, 'chat')[0];
  assert.equal(first.estimate, '约 333.33 万 Token');
  assert.match(first.prices, /输入 \$1 .*输出 \$3/);
  assert.match(first.assumption, /3∶1/);
  assert.equal(estimateModelAllowance(chat, 20, 2, 'chat')[0].estimate, '约 666.66 万 Token');
  assert.equal(estimateModelAllowance(chat, 10, 1, 'chat')[0].estimate, '约 666.66 万 Token');
  // No selected-model count is supplied: adding another choice never divides either estimate.
  assert.deepEqual(estimateModelAllowance(chat, 10, 2, 'chat')[0], first);
});
test('per-image estimates floor counts for each resolution and show multiplied unit cost', () => {
  const result = estimateModelAllowance(image, 10, 1.5, 'image');
  assert.equal(result[0].estimate, '约 222 张');
  assert.equal(result[1].estimate, '约 111 张');
  assert.equal(result[1].label, '2K');
  assert.match(result[0].prices, /倍率后 \$0.045/);
});
test('price tiers remain separate scenarios; base-price estimate is not passed off as all-tier rate', () => {
  const quote = {...chat, tiers:[{minPromptTokens:100000,lines:chat.lines.map(l=>({...l,costUsd:String(Number(l.costUsd)*2)}))}]};
  const result=estimateModelAllowance(quote,10,2,'chat');
  assert.equal(result.length,2); assert.match(result[0].label,/0–99,999/); assert.match(result[1].label,/100,000\+/);
  assert.equal(result[1].estimate,'约 166.66 万 Token');
});
test('unknown, invalid and free rates never become invented free or unlimited allowance', () => {
  assert.deepEqual(estimateModelAllowance(undefined,10,1,'chat'),[]);
  assert.deepEqual(estimateModelAllowance({...chat,lines:[{...chat.lines[0],costUsd:'NaN'}]},10,1,'chat'),[]);
  assert.match(estimateModelAllowance({...chat,lines:chat.lines.map(l=>({...l,costUsd:'0'}))},10,1,'chat')[0].estimate,/暂不估算/);
  assert.match(estimateModelAllowance(chat,10,0,'chat')[0].estimate,/有效价格和倍率/);
});
test('additional request fees do not produce an overstated token estimate', () => {
  assert.match(estimateModelAllowance({...chat,lines:[...chat.lines,{billable:'request',unit:'request',costUsd:'0.01'}]},10,1,'chat')[0].estimate,/额外按次/);
});
test('pixel and image-token prices retain their actual units instead of guessing image counts', () => {
  for(const unit of ['megapixel','token']) {
    const result=estimateModelAllowance({...image,lines:[{billable:'output_image',unit,costUsd:'0.01'}]},10,1,'image')[0];
    assert.doesNotMatch(result.estimate,/张/);assert.match(result.assumption,/张数取决于/);
  }
});

import { planEstimateBudget } from './usage-price-preview';
test('weekly estimates use the full weekly allowance per model, not sale price', () => {
  const budget = planEstimateBudget({mode:'periodic',priceUsd:100,periodAllowanceUsd:20});
  assert.equal(budget,20);
  assert.equal(estimateModelAllowance(chat,budget!,2,'chat')[0].estimate,'约 666.66 万 Token');
  assert.equal(estimateModelAllowance(image,budget!,1.5,'image')[0].estimate,'约 444 张');
  assert.equal(planEstimateBudget({mode:'periodic',priceUsd:100}),null);
  assert.equal(planEstimateBudget({mode:'credits',priceUsd:100}),100);
});
