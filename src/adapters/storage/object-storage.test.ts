import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localObjectFile, localStorageBucket, objectKey, putObject, storageBucketForRuntime } from './object-storage';

test('local media storage: 写入 data/uploads 并返回公开 URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bailing-local-upload-'));
  try {
    const bucket = localStorageBucket('https://hub.example.com');
    const key = objectKey(bucket, 'pub_demo', 'image/png');
    const url = await putObject(bucket, key, Buffer.from('png-bytes'), 'image/png', { root });
    assert.equal(url, `https://hub.example.com/uploads/${key}`);

    const target = localObjectFile(root, key);
    assert.ok(target);
    assert.equal(target.contentType, 'image/png');
    assert.equal(readFileSync(target.file, 'utf8'), 'png-bytes');
    assert.equal(localObjectFile(root, '../secret.txt'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('local media storage: 显式 local 配置在运行期补齐公开 /uploads 地址', async () => {
  const bucket = storageBucketForRuntime({
    ...localStorageBucket(''),
    name: 'local-media',
    public_base_url: '',
    path_prefix: 'media',
  }, 'https://hub.example.com/');

  assert.equal(bucket.name, 'local-media');
  assert.equal(bucket.kind, 'local');
  assert.equal(bucket.public_base_url, 'https://hub.example.com/uploads');
  assert.equal(bucket.path_prefix, 'media');
});
