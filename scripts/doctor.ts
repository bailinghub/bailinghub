import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Check = { name: string; run: () => void };

const root = process.cwd();
const failures: string[] = [];

function log(name: string, ok: boolean, detail = ''): void {
  const mark = ok ? '✓' : '✗';
  console.log(`${mark} ${name}${detail ? ` ${detail}` : ''}`);
}

function command(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function npm(script: string): void {
  execFileSync('npm', ['run', script], { cwd: root, stdio: 'inherit' });
}

function requireFile(file: string): void {
  if (!existsSync(join(root, file))) throw new Error(`missing ${file}`);
}

function checkNodeVersion(): void {
  const version = process.versions.node.split('.').map(Number);
  if ((version[0] ?? 0) < 22) throw new Error(`Node.js >= 22 required, current ${process.versions.node}`);
}

function checkPackageIdentity(): void {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'bailinghub') throw new Error(`unexpected package name: ${pkg.name}`);
  if (pkg.license !== 'Apache-2.0') throw new Error(`unexpected license: ${pkg.license}`);
  if (!pkg.repository?.url?.includes('github.com/bailinghub/bailinghub')) throw new Error('repository url is not bailinghub/bailinghub');
}

function checkRequiredFiles(): void {
  for (const file of [
    'README.md',
    'LICENSE',
    'NOTICE',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    '.env.example',
    'config.example.json',
    'docker-compose.yml',
    'docker-compose.images.yml',
    'Dockerfile',
    'docs/DEMO.md',
    'docs/QUICKSTART.md',
    'schemas/config/route.schema.json',
    'web/widget/widget.js',
  ]) requireFile(file);
}

function checkGitIgnore(): void {
  const ignored = command('git', ['check-ignore', 'config.json', '.env', '.oss-dist', 'web/console', 'data']).split('\n').filter(Boolean);
  const expected = new Set(['config.json', '.env', '.oss-dist', 'web/console', 'data']);
  for (const file of expected) {
    if (!ignored.includes(file)) throw new Error(`${file} is not ignored`);
  }
}

const checks: Check[] = [
  { name: 'Node.js runtime', run: checkNodeVersion },
  { name: 'package identity', run: checkPackageIdentity },
  { name: 'required project files', run: checkRequiredFiles },
  { name: 'git ignore hygiene', run: checkGitIgnore },
  { name: 'documentation links', run: () => npm('docs:check') },
  { name: 'example schemas', run: () => npm('examples:check') },
  { name: 'secret and OSS boundary scan', run: () => { npm('security:scan'); npm('oss:guard'); } },
];

if (process.env.BAILING_DOCTOR_FULL === '1') {
  checks.push(
    { name: 'TypeScript typecheck', run: () => npm('typecheck') },
    { name: 'unit tests', run: () => npm('test') },
  );
}

if (process.env.BAILING_DOCTOR_SMOKE === '1') {
  checks.push({ name: 'runtime smoke', run: () => npm('smoke') });
}

console.log('BailingHub doctor\n');
for (const check of checks) {
  try {
    check.run();
    log(check.name, true);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    failures.push(`${check.name}: ${msg}`);
    log(check.name, false, msg);
  }
}

console.log('');
if (failures.length) {
  console.error('Doctor failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Doctor passed. For runtime checks against a live hub, run BAILING_DOCTOR_SMOKE=1 npm run doctor.');
