import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signBody, verifySignedBody } from './signing';

const SECRET = 'approval-secret';
const TS = '1718000000000';
const BODY = '{"decision":"approved","approver":"user_2002"}';

test('verifySignedBody: accepts sha256 signed raw body inside timestamp window', () => {
  const sig = `sha256=${signBody(SECRET, TS, BODY)}`;
  assert.equal(verifySignedBody({ 'x-bailing-timestamp': TS, 'x-bailing-signature': sig }, SECRET, BODY, Number(TS) + 10_000), true);
});

test('verifySignedBody: rejects body tampering and old version prefixes', () => {
  const sig = `sha256=${signBody(SECRET, TS, BODY)}`;
  assert.equal(verifySignedBody({ 'x-bailing-timestamp': TS, 'x-bailing-signature': sig }, SECRET, '{"decision":"denied"}', Number(TS)), false);
  assert.equal(verifySignedBody({ 'x-bailing-timestamp': TS, 'x-bailing-signature': sig.replace('sha256=', 'v1=') }, SECRET, BODY, Number(TS)), false);
});

test('verifySignedBody: rejects timestamps outside replay window', () => {
  const sig = `sha256=${signBody(SECRET, TS, BODY)}`;
  assert.equal(verifySignedBody({ 'x-bailing-timestamp': TS, 'x-bailing-signature': sig }, SECRET, BODY, Number(TS) + 301_000), false);
  assert.equal(verifySignedBody({ 'x-bailing-timestamp': 'not-a-number', 'x-bailing-signature': sig }, SECRET, BODY, Number(TS)), false);
});
