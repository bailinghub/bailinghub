import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--require-all')) {
  console.error('Usage: node scripts/sdk-p1-check.mjs [--require-all]');
  process.exit(2);
}
const requireAll = args.includes('--require-all');
const matrixMarker = 'PASS: 24 readonly/risk combinations + 6 idempotent combinations';
let pass = 0;
let fail = 0;
let skipped = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` ← ${extra}` : ''}`);
  }
}

function details(result) {
  return [result.error?.message, result.stderr, result.stdout].filter(Boolean).join('\n').trim();
}

function run(cmd, args, cwd = root, timeout = 300_000) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 });
}

function toolchain(name, probes) {
  // Probe the actual executables with the same inherited PATH as every test.
  // A login shell can replace PATH and accidentally validate a different toolchain.
  const unavailable = probes.map(([cmd, probeArgs]) => ({ cmd, result: run(cmd, probeArgs, root, 15_000) }))
    .filter(({ result }) => result.status !== 0);
  if (!unavailable.length) return true;
  skipped++;
  console.log(`  SKIP ${name} example and declaration matrix: ${unavailable.map(({ cmd, result }) => `${cmd}: ${details(result) || `exit ${result.status}`}`).join('; ')}`);
  if (requireAll) ok(`${name} toolchain required (--require-all)`, false);
  return false;
}

console.log('— P1 SDK checks');

if (toolchain('Java', [['javac', ['-version']], ['java', ['-version']]])) {
  const javaOut = mkdtempSync(join(tmpdir(), 'bailing-java-'));
  try {
    const compile = run('javac', ['-d', javaOut, 'sdk/java/src/main/java/com/bailing/connect/BailingConnect.java', 'sdk/java/examples/BuildSpec.java', 'sdk/java/tests/DeclarationTest.java']);
    ok('Java SDK, example and declaration matrix compile', compile.status === 0, details(compile));
    if (compile.status === 0) {
      const out = run('java', ['-cp', javaOut, 'BuildSpec']);
      ok('Java example emits OpenAPI', out.status === 0 && out.stdout.includes('"openapi":"3.0.0"'), details(out));
      const matrix = run('java', ['-cp', javaOut, 'DeclarationTest']);
      ok('Java declaration matrix: 24 readonly/risk + 6 idempotent', matrix.status === 0 && matrix.stdout.includes(matrixMarker), details(matrix));
    }
  } finally {
    rmSync(javaOut, { recursive: true, force: true });
  }
}

if (toolchain('Go', [['go', ['version']]])) {
  const out = run('go', ['run', './examples/build-spec'], resolve(root, 'sdk/go'));
  ok('Go example emits OpenAPI', out.status === 0 && out.stdout.includes('"openapi": "3.0.0"'), details(out));
  const matrix = run('go', ['test', '-count=1', '-v', './bailingconnect'], resolve(root, 'sdk/go'));
  ok('Go declaration matrix: 24 readonly/risk + 6 idempotent', matrix.status === 0
    && matrix.stdout.includes('--- PASS: TestDeclarationReadonlyRiskMatrix (')
    && matrix.stdout.includes('--- PASS: TestDeclarationIdempotentPresence ('), details(matrix));
}

if (toolchain('.NET', [['dotnet', ['--version']]])) {
  const dotnetRoot = mkdtempSync(join(tmpdir(), 'bailing-dotnet-'));
  try {
    // dotnet writes bin/obj next to each project. Keep them out of SDK sources
    // and distribution archives, and do not reuse stale local build outputs.
    cpSync(resolve(root, 'sdk/dotnet'), dotnetRoot, {
      recursive: true,
      filter: (source) => !['bin', 'obj'].includes(basename(source)),
    });
    const out = run('dotnet', ['run', '--project', 'examples/BuildSpec/BuildSpec.csproj'], dotnetRoot);
    ok('.NET example emits OpenAPI', out.status === 0 && out.stdout.includes('"openapi": "3.0.0"'), details(out));
    const matrix = run('dotnet', ['run', '--project', 'tests/Declaration/Declaration.csproj'], dotnetRoot);
    ok('.NET declaration matrix: 24 readonly/risk + 6 idempotent', matrix.status === 0 && matrix.stdout.includes(matrixMarker), details(matrix));
  } finally {
    rmSync(dotnetRoot, { recursive: true, force: true });
  }
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail} / 跳过工具链 ${skipped}${requireAll ? '（不允许跳过）' : ''}`);
process.exit(fail ? 1 : 0);
