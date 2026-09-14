import assert from 'node:assert/strict';
import test from 'node:test';
import { ossPutHeaders } from './oss-signature';
import { putObject } from './object-storage';
import type { StorageBucket } from '../../core/contracts/types';

const bucket: StorageBucket = { name: 'media', kind: 'oss', bucket: 'example-bucket', access_key: 'TESTACCESSKEY', secret_key: 'synthetic-test-secret',
  region: 'cn-shanghai', enabled: true, public_base_url: 'https://cdn.example.com', path_prefix: 'assets' };
// Fixed vectors independently verified against official ali-oss 6.23.0 signUtils.authorizationV4.
test('OSS V4 matches official SDK vectors, including encoded Unicode object paths', () => {
  for (const [key, signature] of [
    ['assets/front.png', '63193ef534c03b0752075a575f9731b3f0dbe559f1def4cea00ba44aea71512a'],
    ['assets/中文 image(1).png', 'f15b9ebaefb3b1521403d87f7c2c85a7b122cda4ffc3568ab3c716cb406a445d'],
  ]) {
    const headers = ossPutHeaders(bucket, key!, Buffer.from('synthetic image'), 'image/png', new Date('2026-09-14T01:02:03Z'));
    assert.equal(headers.authorization, `OSS4-HMAC-SHA256 Credential=TESTACCESSKEY/20260914/cn-shanghai/oss/aliyun_v4_request,Signature=${signature}`);
    assert.equal(headers['x-oss-object-acl'], 'public-read');
  }
});
test('OSS sends bytes with checksum and no redirect, returns configured CDN URL', async () => {
  const original = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = (async (url, init) => {
      calls++; assert.equal(url, 'https://example-bucket.oss-cn-shanghai.aliyuncs.com/assets/front.png');
      assert.equal(init!.method, 'PUT'); assert.equal(init!.redirect, 'error'); assert.deepEqual(init!.body, Buffer.from('bytes'));
      assert.ok((init!.headers as Record<string, string>)['content-md5']);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    assert.equal(await putObject(bucket, 'assets/front.png', Buffer.from('bytes'), 'image/png'), 'https://cdn.example.com/assets/front.png');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test('OSS failed upload keeps backend details out of the public error', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('<Error>private diagnostic</Error>', { status: 403 })) as typeof fetch;
    await assert.rejects(putObject(bucket, 'assets/front.png', Buffer.from('bytes'), 'image/png'), { message: 'OSS PUT 403' });
    await assert.rejects(putObject({ ...bucket, endpoint: 'http://example.com' }, 'assets/front.png', Buffer.from('bytes'), 'image/png'), { message: 'Invalid OSS endpoint' });
  } finally { globalThis.fetch = original; }
});
