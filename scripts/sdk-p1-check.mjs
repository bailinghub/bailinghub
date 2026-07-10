import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` ← ${extra}` : ''}`);
  }
}

function has(cmd) {
  return spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
}

function run(cmd, args, cwd = root) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
}

console.log('— P1 SDK checks');

const javaOut = join(tmpdir(), `bailing-java-${Date.now()}`);
if (has('javac') && has('java')) {
  const compile = run('javac', ['-d', javaOut, 'sdk/java/src/main/java/com/bailing/connect/BailingConnect.java', 'sdk/java/examples/BuildSpec.java']);
  ok('Java SDK compiles', compile.status === 0, compile.stderr);
  if (compile.status === 0) {
    const out = run('java', ['-cp', javaOut, 'BuildSpec']);
    ok('Java example emits OpenAPI', out.status === 0 && out.stdout.includes('"openapi":"3.0.0"'), out.stderr || out.stdout);
  }
  rmSync(javaOut, { recursive: true, force: true });
} else {
  ok('Java SDK source present', existsSync(resolve(root, 'sdk/java/src/main/java/com/bailing/connect/BailingConnect.java')));
}

if (has('go')) {
  const out = run('go', ['run', './examples/build-spec'], resolve(root, 'sdk/go'));
  ok('Go example emits OpenAPI', out.status === 0 && out.stdout.includes('"openapi": "3.0.0"'), out.stderr || out.stdout);
} else {
  ok('Go SDK source present', existsSync(resolve(root, 'sdk/go/bailingconnect/connect.go')));
}

if (has('dotnet')) {
  const out = run('dotnet', ['run', '--project', 'sdk/dotnet/examples/BuildSpec/BuildSpec.csproj']);
  ok('.NET example emits OpenAPI', out.status === 0 && out.stdout.includes('"openapi": "3.0.0"'), out.stderr || out.stdout);
} else {
  ok('.NET SDK source present', existsSync(resolve(root, 'sdk/dotnet/Bailing.Connect/BailingConnect.cs')));
}

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
