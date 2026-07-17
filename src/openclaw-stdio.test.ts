import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('openclaw stdio adapter: 保留会话、提取文本且默认不转交业务工具凭据', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bailing-openclaw-test-'));
  try {
    const fake = join(dir, 'fake-openclaw');
    const argsFile = join(dir, 'args.json');
    const inputFile = join(dir, 'input.txt');
    const envFile = join(dir, 'env.json');
    writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGS_OUT, JSON.stringify(args));
const messageFile = args[args.indexOf('--message-file') + 1];
fs.writeFileSync(process.env.FAKE_INPUT_OUT, fs.readFileSync(messageFile, 'utf8'));
fs.writeFileSync(process.env.FAKE_ENV_OUT, JSON.stringify({
  tools: process.env.BAILING_TOOLS,
  token: process.env.BAILING_TOOL_TOKEN,
  url: process.env.BAILING_TOOLS_URL,
}));
process.stdout.write(JSON.stringify({ payloads: [{ text: 'adapter-ok' }] }));
`);
    chmodSync(fake, 0o755);

    const adapter = join(process.cwd(), 'web', 'connect', 'openclaw-stdio.mjs');
    const result = spawnSync(process.execPath, [adapter, '--bin', fake, '--agent', 'bailinghub-executor'], {
      input: '请总结这个任务',
      encoding: 'utf8',
      env: {
        ...process.env,
        BAILING_SESSION_ID: 'thread/42',
        BAILING_TOOL_TOKEN: 'must-not-forward',
        BAILING_TOOLS: '[{"name":"refund"}]',
        BAILING_TOOLS_URL: 'https://hub.example/tools/invoke',
        FAKE_ARGS_OUT: argsFile,
        FAKE_INPUT_OUT: inputFile,
        FAKE_ENV_OUT: envFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'adapter-ok\n');
    assert.equal(readFileSync(inputFile, 'utf8'), '请总结这个任务');
    assert.deepEqual(JSON.parse(readFileSync(envFile, 'utf8')), {});

    const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
    assert.equal(args[0], 'agent');
    assert.ok(args.includes('--local'));
    assert.equal(args[args.indexOf('--agent') + 1], 'bailinghub-executor');
    assert.match(args[args.indexOf('--session-key') + 1]!, /^bailing-thread-42-[a-f0-9]{12}$/);
    assert.equal(args[args.indexOf('--timeout') + 1], '600');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
