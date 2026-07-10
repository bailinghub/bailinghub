// 覆盖：企微长文本按字节分条（splitWecomText）——每条不超上限、拼回无损、不切断多字节字符。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitWecomText } from './wecom-api';

const utf8 = (s: string): number => Buffer.byteLength(s, 'utf8');
const MAX = 1900; // 默认切分粒度

test('splitWecomText：短文本原样单条', () => {
  const s = '好消息！现在已经有权限了。';
  assert.deepEqual(splitWecomText(s), [s]);
});

test('splitWecomText：长中文按字节分条，每条 ≤ 上限、拼回无损', () => {
  // 800 行表格行，混中文 —— 远超 2048 字节
  const rows = Array.from({ length: 800 }, (_, i) => `| ${i} | 宝应黄金海岸汤泉酒店 | 46c5m8h1 | 示例业务 | 在营 |`);
  const text = '平台下目前共有 717 家门店：\n\n' + rows.join('\n');
  const parts = splitWecomText(text);
  assert.ok(parts.length > 1, '应被切成多条');
  for (const p of parts) assert.ok(utf8(p) <= MAX, `每条 ≤ ${MAX} 字节，实际 ${utf8(p)}`);
  assert.equal(parts.join(''), text, '拼回必须与原文逐字一致（分隔符保留）');
});

test('splitWecomText：超长无换行行按字符硬切且不切断多字节字符', () => {
  const text = '汤'.repeat(2000); // 每字 3 字节 = 6000 字节，且无换行可切
  const parts = splitWecomText(text);
  assert.ok(parts.length >= 4);
  for (const p of parts) {
    assert.ok(utf8(p) <= MAX);
    // 不出现替换字符 / 半个字符：往返编码无损即证明边界没切坏
    assert.equal(Buffer.from(p, 'utf8').toString('utf8'), p);
  }
  assert.equal(parts.join(''), text);
});

test('splitWecomText：含 emoji（代理对）不被从中切断', () => {
  const text = '🎉'.repeat(700); // 每个 emoji 4 字节 = 2800 字节
  const parts = splitWecomText(text);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(utf8(p) <= MAX);
    assert.ok(!p.includes('�'), '不应出现替换字符');
  }
  assert.equal(parts.join(''), text);
});
