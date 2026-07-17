#!/usr/bin/env node
// BailingHub -> OpenClaw stdin/stdout adapter (single file, zero dependencies, Node >= 18).
// stdin receives one BailingHub task. stdout emits only the final OpenClaw reply so executor.mjs can report it.
//
// Usage:
//   node openclaw-stdio.mjs --agent bailinghub-executor
//
// The adapter uses BAILING_SESSION_ID to preserve multi-turn context. It runs OpenClaw locally by default;
// pass --gateway only when a separately managed OpenClaw Gateway should own the run.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name) => argv.includes(name);

const agentId = String(valueOf('--agent') ?? process.env.OPENCLAW_AGENT ?? 'bailinghub-executor').trim();
const openclawBin = String(valueOf('--bin') ?? process.env.OPENCLAW_BIN ?? 'openclaw').trim();
const model = String(valueOf('--model') ?? process.env.OPENCLAW_MODEL ?? '').trim();
const thinking = String(valueOf('--thinking') ?? process.env.OPENCLAW_THINKING ?? '').trim();
const timeoutSeconds = Number(valueOf('--timeout') ?? process.env.OPENCLAW_TIMEOUT_SECONDS ?? 600);
const useGateway = has('--gateway') || process.env.OPENCLAW_USE_GATEWAY === '1';

if (!/^[A-Za-z0-9_-]+$/.test(agentId)) {
  console.error('OpenClaw agent id 只能包含字母、数字、下划线和连字符');
  process.exit(2);
}
if (!openclawBin) {
  console.error('缺少 OpenClaw CLI 路径');
  process.exit(2);
}
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
  console.error('--timeout 必须是 1~3600 秒的整数');
  process.exit(2);
}

async function readTaskInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('任务正文超过 4 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sessionKey() {
  const raw = String(
    process.env.BAILING_SESSION_ID
      || process.env.BAILING_REQUEST_ID
      || process.env.BAILING_JOB_ID
      || 'task',
  );
  const slug = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'task';
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `bailing-${slug}-${digest}`;
}

function extractReply(data) {
  const payloads = Array.isArray(data?.payloads)
    ? data.payloads
    : Array.isArray(data?.result?.payloads)
      ? data.result.payloads
      : [];
  const text = payloads
    .map((item) => typeof item?.text === 'string' ? item.text.trim() : '')
    .filter(Boolean)
    .join('\n\n');
  if (text) return text;
  const status = String(data?.status ?? data?.result?.status ?? 'unknown');
  throw new Error(`OpenClaw 没有返回可见文本（status=${status}）`);
}

async function runOpenClaw(messageFile) {
  const args = [
    'agent',
    ...(useGateway ? [] : ['--local']),
    '--agent', agentId,
    '--session-key', sessionKey(),
    '--message-file', messageFile,
    '--json',
    '--timeout', String(timeoutSeconds),
    ...(model ? ['--model', model] : []),
    ...(thinking ? ['--thinking', thinking] : []),
  ];

  // Business-tool credentials are not forwarded to OpenClaw by default. A later governed-tool adapter can opt in
  // explicitly; the basic bridge only grants task text and session continuity.
  const childEnv = { ...process.env, NO_COLOR: '1' };
  if (process.env.OPENCLAW_FORWARD_BAILING_TOOLS !== '1') {
    delete childEnv.BAILING_TOOLS;
    delete childEnv.BAILING_TOOL_TOKEN;
    delete childEnv.BAILING_TOOLS_URL;
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(openclawBin, args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let settled = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`无法启动 OpenClaw：${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new Error(`OpenClaw 执行失败（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`));
        return;
      }
      try {
        resolve(extractReply(JSON.parse(stdout)));
      } catch (error) {
        reject(new Error(`无法解析 OpenClaw JSON：${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

let dir = '';
try {
  const input = await readTaskInput();
  if (!input.trim()) throw new Error('任务正文为空');
  dir = await mkdtemp(join(tmpdir(), 'bailing-openclaw-'));
  const messageFile = join(dir, 'task.txt');
  await writeFile(messageFile, input, { encoding: 'utf8', mode: 0o600 });
  const reply = await runOpenClaw(messageFile);
  process.stdout.write(`${reply}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (dir) await rm(dir, { recursive: true, force: true });
}
