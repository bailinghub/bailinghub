import assert from 'node:assert/strict';
import test from 'node:test';
import { compileOpenApiTools } from './openapi-tools';
import { hasToolDefinitionErrors, validateToolDefinition } from './tool-definition';
import { boundedToolText, TOOL_DESCRIPTION_MAX_CHARS, TOOL_USAGE_GUIDANCE_MAX_BYTES, TOOL_USAGE_GUIDANCE_MAX_CHARS } from './tool-guidance';

function compile(summary: string | undefined, description: string, extra = {}) {
  return compileOpenApiTools(JSON.stringify({ paths: { '/page': { get: {
    operationId: 'page_get', ...(summary !== undefined ? { summary } : {}), description,
    'x-agent-capability': { enabled: true, scope: 'page.read', ...extra },
    'x-business-private': 'must-not-be-guidance',
  } } } }));
}

test('OpenAPI summary remains short while full description and authored guidance remain retrievable', () => {
  const result = compile('读取首页', '必须先绑定页面设置，否则前台不会生效。冲突时读取原修订。', {
    guidance: { when_to_use: '核对首页绑定', returns: '返回当前页面和修订', examples: [{ page_id: 1 }] },
  });
  const tool = result.tools[0]!;
  assert.ok(tool.description.startsWith('读取首页'));
  assert.ok(!tool.description.includes('冲突时'));
  assert.equal(tool.descriptionTruncated, undefined, 'separate detail does not mean summary was truncated');
  assert.match(tool.usageGuidance!.text, /必须先绑定页面设置/);
  assert.match(tool.usageGuidance!.text, /冲突时读取原修订/);
  assert.match(tool.usageGuidance!.text, /核对首页绑定/);
  assert.match(tool.usageGuidance!.text, /返回当前页面和修订/);
  assert.match(tool.usageGuidance!.text, /page_id/);
  assert.doesNotMatch(tool.usageGuidance!.text, /must-not-be-guidance/);
  assert.equal(tool.usageGuidance!.truncated, false);
  assert.equal(hasToolDefinitionErrors(validateToolDefinition(tool)), false);
});

test('long summaries explicitly diagnose short-description truncation and preserve the tail in detail', () => {
  const description = `${'说明'.repeat(300)}。末尾约束：禁止自动重放写操作。`;
  const result = compile(undefined, description);
  const tool = result.tools[0]!;
  assert.equal(Array.from(tool.description).length, TOOL_DESCRIPTION_MAX_CHARS);
  assert.equal(tool.descriptionTruncated, true);
  assert.equal(tool.usageGuidance!.text, description);
  assert.equal(tool.usageGuidance!.truncated, false);
  assert.ok(result.diagnostics.some((d) => d.code === 'tool_description_truncated' && d.severity === 'warning'));
});

test('guidance has simultaneous character and UTF-8 byte budgets, complete characters, and explicit diagnostics', () => {
  for (const source of ['a'.repeat(TOOL_USAGE_GUIDANCE_MAX_CHARS + 1), '中'.repeat(30_000), '𠮷'.repeat(20_000)]) {
    const result = compile('短摘要', source);
    const guidance = result.tools[0]!.usageGuidance!;
    assert.equal(guidance.truncated, true);
    assert.ok(Array.from(guidance.text).length <= TOOL_USAGE_GUIDANCE_MAX_CHARS);
    assert.ok(Buffer.byteLength(guidance.text, 'utf8') <= TOOL_USAGE_GUIDANCE_MAX_BYTES);
    assert.equal(guidance.sourceChars, Array.from(`短摘要\n\n${source}`).length);
    assert.equal(guidance.sourceBytes, Buffer.byteLength(`短摘要\n\n${source}`, 'utf8'));
    assert.equal(guidance.text.includes('\ufffd'), false);
    assert.ok(result.diagnostics.some((d) => d.code === 'tool_usage_guidance_truncated'));
    assert.equal(hasToolDefinitionErrors(validateToolDefinition(result.tools[0])), false);
  }
  const exact = boundedToolText('中'.repeat(100), 100, 300);
  assert.equal(exact.truncated, false);
  const over = boundedToolText('中'.repeat(101), 100, 300);
  assert.equal(over.truncated, true);
  assert.equal(over.text, exact.text);
});

test('empty summary falls back to description and optional guidance cannot bypass its bounds', () => {
  const tool = compile('', '读取当前页面').tools[0]!;
  assert.equal(tool.description, '读取当前页面');
  assert.equal(tool.usageGuidance, undefined);
  assert.equal(tool.descriptionTruncated, undefined);
  assert.ok(validateToolDefinition({ ...tool, usageGuidance: { text: 'a'.repeat(32 * 1024 + 1), truncated: false, sourceChars: 33 * 1024, sourceBytes: 33 * 1024 } })
    .some((d) => d.code === 'invalid_usage_guidance'));
  assert.ok(validateToolDefinition({ ...tool, usageGuidance: { text: 'ok', truncated: false, sourceChars: 3, sourceBytes: 3 } })
    .some((d) => d.code === 'invalid_usage_guidance'), 'an allegedly complete detail must not hide omitted source text');
  const inlineGuidance = compile('读取页面', '', { guidance: { when_to_use: '核对绑定', returns: '当前页面' } }).tools[0]!;
  assert.equal(inlineGuidance.usageGuidance, undefined, 'formatting differences alone must not advertise additional detail');
  assert.match(inlineGuidance.description, /核对绑定/);
  assert.match(inlineGuidance.description, /当前页面/);
});
