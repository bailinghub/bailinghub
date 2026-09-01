import test from 'node:test';
import assert from 'node:assert/strict';
import {
  includesAllCurrentOperationIds,
  mergeExactOperationIds,
} from '../../../web-admin/src/agent-direct-selection';

test('本地 Agent 全选当前写操作会保留手填项，并写入精确 operationId 快照', () => {
  assert.deepEqual(
    mergeExactOperationIds(
      ['manual_write', 'staff_edit'],
      ['staff_edit', 'item_add', '*', 'bad-operation'],
    ),
    ['manual_write', 'staff_edit', 'item_add'],
  );
});

test('本地 Agent 全选状态只比较当前工具目录，不把未来能力视为已授权', () => {
  assert.equal(includesAllCurrentOperationIds(['staff_edit', 'item_add'], ['staff_edit', 'item_add']), true);
  assert.equal(includesAllCurrentOperationIds(['staff_edit'], ['staff_edit', 'item_add']), false);
  assert.equal(includesAllCurrentOperationIds([], []), false);
});
