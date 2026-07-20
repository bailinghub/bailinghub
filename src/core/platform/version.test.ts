import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_VERSIONS } from './version';

test('公开中英文契约文档与运行时边界版本一致', () => {
  for (const file of ['docs/CONTRACT.md', 'docs/CONTRACT.en.md']) {
    const content = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(content, new RegExp(`\\b${CONTRACT_VERSIONS.boundary.replaceAll('.', '\\.')}\\b`), `${file} 契约版本未与运行时同步`);
  }
});

test('公开中英文流式文档与运行时协议版本一致', () => {
  for (const file of ['docs/STREAMING.md', 'docs/STREAMING.en.md']) {
    const content = readFileSync(join(process.cwd(), file), 'utf8');
    assert.match(content, new RegExp(`\\b${CONTRACT_VERSIONS.chatStream.replaceAll('.', '\\.')}\\b`), `${file} 流式协议版本未与运行时同步`);
  }
});
