import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAttachments, extractAudioUrls, extractFileRefs, extractImageUrls } from './content';

test('content: 分别抽取图片、语音与文件 URL', () => {
  const text = [
    '帮我看一下',
    '![图片](https://cdn.example.com/a.png)',
    '[语音：voice.webm](https://cdn.example.com/v.webm)',
    '[文件：报价.csv](https://cdn.example.com/price.csv)',
    '[普通链接](https://example.com/page)',
  ].join('\n');

  assert.deepEqual(extractImageUrls(text), ['https://cdn.example.com/a.png']);
  assert.deepEqual(extractAudioUrls(text), ['https://cdn.example.com/v.webm']);
  assert.deepEqual(extractFileRefs(text), [{ url: 'https://cdn.example.com/price.csv', name: '文件：报价.csv' }]);
  assert.deepEqual(extractAttachments(text), [
    { type: 'image', url: 'https://cdn.example.com/a.png', caption: '图片' },
    { type: 'file', url: 'https://cdn.example.com/price.csv', name: '文件：报价.csv' },
    { type: 'audio', url: 'https://cdn.example.com/v.webm', name: '语音：voice.webm' },
  ]);
});

test('content: 相邻 markdown 附件不丢失，图片链接不误归入普通链接', () => {
  const text = [
    '[文件：a.csv](https://cdn.example.com/a.csv)[文件：b.csv](https://cdn.example.com/b.csv)',
    '[语音：a.webm](https://cdn.example.com/a.webm)[语音：b.webm](https://cdn.example.com/b.webm)',
    '![图片](https://cdn.example.com/image.png)',
  ].join('');

  assert.deepEqual(extractFileRefs(text), [
    { url: 'https://cdn.example.com/a.csv', name: '文件：a.csv' },
    { url: 'https://cdn.example.com/b.csv', name: '文件：b.csv' },
  ]);
  assert.deepEqual(extractAudioUrls(text), [
    'https://cdn.example.com/a.webm',
    'https://cdn.example.com/b.webm',
  ]);
  assert.deepEqual(extractAttachments(text), [
    { type: 'image', url: 'https://cdn.example.com/image.png', caption: '图片' },
    { type: 'file', url: 'https://cdn.example.com/a.csv', name: '文件：a.csv' },
    { type: 'file', url: 'https://cdn.example.com/b.csv', name: '文件：b.csv' },
    { type: 'audio', url: 'https://cdn.example.com/a.webm', name: '语音：a.webm' },
    { type: 'audio', url: 'https://cdn.example.com/b.webm', name: '语音：b.webm' },
  ]);
});
