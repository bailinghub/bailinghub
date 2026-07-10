// 覆盖：送达层的结果通知文案渲染。投递副作用走集成链路，这里先钉住纯函数契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDeliveryMessage } from './delivery';
import type { Job } from '../core/contracts/types';

function job(result: Record<string, unknown>): Job {
  return {
    job_id: 'job-1',
    request_id: 'req-1',
    status: 'done',
    target: 'llm',
    profile: 'default',
    project: '',
    source: 'test',
    input_preview: 'input',
    result,
    metadata: {},
    dispatch: { route_name: '员工审核' },
    created_at: '2026-06-30T00:00:00.000Z',
    updated_at: '2026-06-30T00:00:01.000Z',
  };
}

test('renderDeliveryMessage: report 结果渲染摘要、等级、证据和建议', () => {
  const text = renderDeliveryMessage(job({
    report: {
      summary: '存在高风险变更',
      severity: 'high',
      category: 'security',
      evidence: ['删除鉴权', '暴露密钥'],
      suggested_next_step: '先回滚再复查',
    },
  }));

  assert.match(text, /【员工审核】结果通知/);
  assert.match(text, /结论：存在高风险变更/);
  assert.match(text, /等级：high/);
  assert.match(text, /1\. 删除鉴权/);
  assert.match(text, /建议：先回滚再复查/);
});

test('renderDeliveryMessage: text 结果渲染正文，空结果返回空串', () => {
  assert.match(renderDeliveryMessage(job({ text: '处理完成' })), /处理完成/);
  assert.equal(renderDeliveryMessage(job({})), '');
});
