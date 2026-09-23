import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPresentation, readPresentation } from './usage-presentation';

test('USD allowance preview uses fixed credits or percentage, never supplier token usage', () => {
  const credits = previewPresentation({mode:'credits',priceUsd:100});
  assert.equal(credits.kind,'credits'); assert.equal(credits.remaining,100000); assert.equal(credits.displayValue,'100000');
  const periodic = previewPresentation({mode:'periodic',priceUsd:100,periodAllowanceUsd:20});
  assert.equal(periodic.kind,'percentage'); assert.equal(periodic.remaining,100);
  assert.equal(previewPresentation({mode:'credits',priceUsd:Number.NaN}).state,'unavailable');
});
test('account presentation requires authoritative projection, never derives balance from raw token or USD fields', () => {
  assert.equal(readPresentation({availableUsd:10, inputTokens:1000},'credits').state,'unavailable');
  const presentation = {schema:'bailing.usage-presentation.v1',kind:'percentage',state:'active',remaining:99.7,total:100,displayValue:'99'};
  assert.equal(readPresentation(presentation,'periodic').remaining,99.7);
  assert.equal(readPresentation(presentation,'credits').state,'unavailable');
});

test('period preview requires its own allowance, never the sale price', () => {
  assert.equal(previewPresentation({mode:'periodic',priceUsd:100}).state,'unavailable');
});
