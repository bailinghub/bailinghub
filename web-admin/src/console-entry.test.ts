import assert from 'node:assert/strict';
import test from 'node:test';
import { consoleEntry } from './console-entry.js';

test('new installation enters the guide using only routes and clients', async () => {
  const paths: string[] = [];
  assert.equal(await consoleEntry(async (path) => { paths.push(path); return Response.json([]); }, true), 'setup');
  assert.deepEqual(paths, ['/admin/api/routes', '/admin/api/clients']);
});
test('partial integration is not repeatedly forced through onboarding', async () => {
  for (const configured of ['/admin/api/routes', '/admin/api/clients']) {
    assert.equal(await consoleEntry(async (path) => Response.json(path === configured ? [{ id: 'existing' }] : []), true), 'workspace');
  }
});
test('unavailable, forbidden and malformed reads stay in session with a diagnostic guide', async () => {
  for (const response of [new Response('', { status: 503 }), new Response('', { status: 403 }), Response.json({ error: 'bad shape' }), new Response('invalid json')]) {
    assert.equal(await consoleEntry(async (path) => path.endsWith('routes') ? response : Response.json([]), true), 'setup');
  }
  assert.equal(await consoleEntry(async () => { throw new Error('offline'); }, true), 'setup');
});
test('explicit unauthorized response takes precedence over a concurrent network error', async () => {
  assert.equal(await consoleEntry(async (path) => { if (path.endsWith('routes')) throw new Error('offline'); return new Response('', { status: 401 }); }, true), 'session-expired');
});
test('restricted operators are not classified as empty installations', async () => {
  assert.equal(await consoleEntry(async () => { throw new Error('must not fetch'); }, false), 'workspace');
});
