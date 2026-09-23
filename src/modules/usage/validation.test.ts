import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKnownFields, integer } from './validation';

test('shared validation accepts exact integers and rejects ambiguous quantities', () => {
  assert.equal(integer(0, 'count'), 0);
  assert.equal(integer(10, 'count', 1, 10), 10);
  for (const value of ['10', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => integer(value, 'count'), { code: 'USAGE_INVALID_INPUT' });
  }
});

test('shared field validation rejects unknown configuration and non-object input', () => {
  assertKnownFields({ label: 'Synthetic' }, ['label'], 'sample');
  for (const value of [null, [], 'text', { label: 'Synthetic', hiddenSetting: true }]) {
    assert.throws(() => assertKnownFields(value, ['label'], 'sample'), { code: 'USAGE_INVALID_INPUT' });
  }
});
