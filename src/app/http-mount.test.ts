import assert from 'node:assert/strict';
import test from 'node:test';
import { injectConsoleMountPath, normalizeHttpMountPath } from './http';

test('console mount metadata supports a trusted encoded path and standalone root', () => {
  assert.equal(normalizeHttpMountPath('/tenant/tenant-a/'), '/tenant/tenant-a');
  assert.equal(normalizeHttpMountPath(undefined), '');
  assert.match(
    injectConsoleMountPath('<html><head><title>x</title></head></html>', '/tenant/tenant-a'),
    /<meta name="bailing-kernel-mount" content="\/tenant\/tenant-a" \/>/,
  );
});

test('console mount metadata rejects query, traversal, and unencoded tenant input', () => {
  for (const path of [
    '/tenant/a?x=1',
    '/../admin',
    '/tenant/%2e%2e',
    '/tenant/%2Fadmin',
    '/tenant/%5cadmin',
    '/tenant/%E7',
    '/tenant/a b',
    '//tenant/a',
  ]) {
    assert.throws(() => normalizeHttpMountPath(path), /HTTP mount path/);
  }
});
