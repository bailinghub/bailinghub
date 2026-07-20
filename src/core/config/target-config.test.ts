// 覆盖：target_config 的目标专属配置模型。
// 路由层只编排目标，具体目标怎么配应由本模块收口，后续新增 target 时在这里扩展契约。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmTargetConfig, normalizeTargetConfig, targetConfig, validateTargetConfig } from './target-config';

test('validateTargetConfig: 非 llm 目标只校验通用 target_config 形态与 timeout', () => {
  assert.equal(validateTargetConfig('claude-code', { any: 'thing' }), null);
  assert.equal(validateTargetConfig('claude-code', { timeout_ms: 999 }), 'target_config.timeout_ms 必须是 1000..3600000 的整数');
  assert.equal(validateTargetConfig('claude-code', []), 'target_config 必须是对象');
});

test('validateTargetConfig: llm 必须配置 credential', () => {
  assert.equal(validateTargetConfig('llm', {}), 'target=llm 时 target_config.credential 必填');
  assert.equal(validateTargetConfig('llm', { credential: 'main' }), null);
});

test('validateTargetConfig: llm temperature / input image/audio/file 有明确范围', () => {
  assert.equal(
    validateTargetConfig('llm', { credential: 'main', temperature: 3 }),
    'target_config.temperature 必须是 0..2 的数字',
  );
  assert.match(
    validateTargetConfig('llm', { credential: 'main', input: { image: { mode: 'scan' } } }) ?? '',
    /target_config\.input\.image\.mode/,
  );
  assert.equal(
    validateTargetConfig('llm', { credential: 'main', input: { image: { mode: 'tool', max_calls: 31 } } }),
    'target_config.input.image.max_calls 必须是 1..30 的整数',
  );
  assert.match(
    validateTargetConfig('llm', { credential: 'main', input: { audio: { mode: 'listen' } } }) ?? '',
    /target_config\.input\.audio\.mode/,
  );
  assert.equal(
    validateTargetConfig('llm', { credential: 'main', input: { audio: { mode: 'transcribe', max_seconds: 999 } } }),
    'target_config.input.audio.max_seconds 必须是 1..600 的整数',
  );
  assert.equal(
    validateTargetConfig('llm', { credential: 'main', input: { file: { mode: 'extract', max_chars: 999 } } }),
    'target_config.input.file.max_chars 必须是 1000..200000 的整数',
  );
  assert.equal(validateTargetConfig('llm', { credential: 'main', streaming: 'true' }), 'target_config.streaming 必须是 boolean');
});

test('normalizeTargetConfig: llm 清洗已知字段，保留扩展字段', () => {
  assert.deepEqual(normalizeTargetConfig('llm', {
    credential: ' main ',
    model: ' qwen-plus ',
    system_prompt: '  hello  ',
    temperature: '0.3',
    streaming: false,
    timeout_ms: '120000',
    vision: { mode: 'prepass' },
    audio: { mode: 'transcribe' },
    extra: true,
    input: {
      image: {
        credential: ' vl ',
        model: ' qwen-vl-max ',
        mode: ' tool ',
        max_calls: '6',
        prompt: 'ocr',
      },
      audio: {
        credential: ' asr ',
        model: ' whisper-1 ',
        mode: ' transcribe ',
        max_bytes: '12582912',
        max_seconds: '60',
        language: 'zh',
      },
      file: {
        credential: ' doc ',
        model: ' qwen-long ',
        mode: ' summarize ',
        max_bytes: '20971520',
        max_chars: '24000',
        parse: 'text',
      },
    },
  }), {
    credential: 'main',
    model: 'qwen-plus',
    system_prompt: 'hello',
    temperature: 0.3,
    streaming: false,
    timeout_ms: 120000,
    extra: true,
    input: {
      image: {
        credential: 'vl',
        model: 'qwen-vl-max',
        mode: 'tool',
        max_calls: 6,
        prompt: 'ocr',
      },
      audio: {
        credential: 'asr',
        model: 'whisper-1',
        mode: 'transcribe',
        max_bytes: 12582912,
        max_seconds: 60,
        language: 'zh',
      },
      file: {
        credential: 'doc',
        model: 'qwen-long',
        mode: 'summarize',
        max_bytes: 20971520,
        max_chars: 24000,
        parse: 'text',
      },
    },
  });
});

test('normalizeTargetConfig: 非 llm 目标只清洗通用 timeout，保留目标自有字段', () => {
  assert.deepEqual(normalizeTargetConfig('custom-agent', { timeout_ms: '90000', command: 'run', args: ['x'] }), {
    timeout_ms: 90000,
    command: 'run',
    args: ['x'],
  });
});

test('targetConfig / llmTargetConfig: 运行期解析空值与凭证', () => {
  assert.deepEqual(targetConfig(null), {});
  assert.equal(llmTargetConfig({ model: 'x' }), null);
  assert.deepEqual(llmTargetConfig({ credential: ' main ', model: ' m ' }), {
    credential: 'main',
    model: 'm',
  });
});
