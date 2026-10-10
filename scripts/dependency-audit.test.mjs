import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateScope, collectUsage } from './dependency-audit.mjs';

const load = name => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8'));
const policy = load('../security/dependency-audit-exceptions.json');
const now = new Date('2026-10-10T03:00:00Z');
function fixture(scope = 'core') {
  const audit = { auditReportVersion: 2, vulnerabilities: structuredClone(policy.scopes[scope].knownAuditRows), metadata: { vulnerabilities: { info: 0, low: 0, moderate: 3, high: 0, critical: 0, total: 3 } } };
  const lock = load(scope === 'core' ? '../package-lock.json' : '../web-admin/package-lock.json');
  return { scope, audit, lock, usage: structuredClone(policy.scopes[scope].reviewedUsageFiles), policy: structuredClone(policy), now };
}
for (const scope of ['core', 'web-admin']) {
  test(`${scope}: reviewed advisory passes while preserving all three moderate findings`, () => {
    const result = evaluateScope(fixture(scope));
    assert.equal(result.pass, true);
    assert.equal(result.rawCounts.moderate, 3);
    assert.equal(result.rawCounts.total, 3);
    assert.equal(result.exceptedRows, 3);
    assert.equal(result.unexceptedRows, 0);
  });
}
test('exception expires at the exact boundary', () => {
  const input = fixture(); input.now = new Date(policy.expiresAt);
  assert.equal(evaluateScope(input).pass, false);
});
test('exception cannot begin before the approval period or exceed 30 days', () => {
  const input = fixture(); input.now = new Date('2026-10-09T23:59:59Z');
  assert.equal(evaluateScope(input).pass, false);
  input.now = now; input.policy.expiresAt = '2026-11-10T00:00:00Z';
  assert.equal(evaluateScope(input).pass, false);
});
test('a new moderate finding is blocked rather than globally ignored', () => {
  const input = fixture();
  input.audit.vulnerabilities.newPackage = { name: 'newPackage', severity: 'moderate', via: [{ url: 'https://github.com/advisories/GHSA-new' }], nodes: ['node_modules/newPackage'] };
  input.audit.metadata.vulnerabilities.moderate++;
  input.audit.metadata.vulnerabilities.total++;
  const result = evaluateScope(input);
  assert.equal(result.pass, false); assert.equal(result.rawCounts.moderate, 4); assert.equal(result.unexceptedRows, 1);
});
test('an additional advisory on the accepted package is blocked', () => {
  const input = fixture(); input.audit.vulnerabilities['sprintf-js'].via.push({ url: 'https://github.com/advisories/GHSA-new', severity: 'high' });
  assert.equal(evaluateScope(input).pass, false);
});
test('adding an unrelated advisory to both policy and audit cannot broaden the exception', () => {
  const input = fixture();
  const row = { name: 'anotherPackage', severity: 'moderate', via: [{ url: 'https://github.com/advisories/GHSA-new', severity: 'moderate' }], nodes: ['node_modules/anotherPackage'] };
  input.policy.scopes.core.knownAuditRows.anotherPackage = structuredClone(row);
  input.audit.vulnerabilities.anotherPackage = row;
  input.audit.metadata.vulnerabilities.moderate++;
  input.audit.metadata.vulnerabilities.total++;
  assert.equal(evaluateScope(input).pass, false);
});
test('changing or appending an advisory in both policy and audit is blocked', () => {
  const input = fixture();
  for (const rows of [input.policy.scopes.core.knownAuditRows, input.audit.vulnerabilities]) {
    rows['sprintf-js'].via[0].url = 'https://github.com/advisories/GHSA-new';
  }
  assert.equal(evaluateScope(input).pass, false);
  const next = fixture();
  for (const rows of [next.policy.scopes.core.knownAuditRows, next.audit.vulnerabilities]) {
    rows['sprintf-js'].via.push({ url: 'https://github.com/advisories/GHSA-new', severity: 'moderate' });
  }
  assert.equal(evaluateScope(next).pass, false);
});
test('rewriting the reviewed dependency chain in both policy and audit is blocked', () => {
  const input = fixture();
  for (const rows of [input.policy.scopes.core.knownAuditRows, input.audit.vulnerabilities]) {
    rows.argparse.via = ['anotherPackage'];
    rows['sprintf-js'].effects = ['anotherPackage'];
  }
  assert.equal(evaluateScope(input).pass, false);
});
test('removing a reviewed policy row cannot redefine the approved exception', () => {
  const input = fixture();
  delete input.policy.scopes.core.knownAuditRows.argparse;
  delete input.audit.vulnerabilities.argparse;
  input.audit.metadata.vulnerabilities.moderate--;
  input.audit.metadata.vulnerabilities.total--;
  assert.equal(evaluateScope(input).pass, false);
});
test('a changed audit node or suggested fix cannot silently broaden the exception', () => {
  const input = fixture(); input.audit.vulnerabilities['sprintf-js'].nodes.push('node_modules/new/node_modules/sprintf-js');
  assert.equal(evaluateScope(input).pass, false);
  const next = fixture(); next.audit.vulnerabilities['sprintf-js'].fixAvailable = true;
  assert.equal(evaluateScope(next).pass, false);
});
test('a changed dependency version or additional installed copy is blocked', () => {
  const input = fixture(); input.lock.packages['node_modules/mammoth'].version = '1.13.0';
  assert.equal(evaluateScope(input).pass, false);
  const next = fixture(); next.lock.packages['node_modules/new/node_modules/sprintf-js'] = { version: '1.0.3' };
  assert.equal(evaluateScope(next).pass, false);
});
test('a new package consuming the same vulnerable copy is blocked', () => {
  const input = fixture(); input.lock.packages['node_modules/new-consumer'] = { version: '1.0.0', dependencies: { 'sprintf-js': '~1.0.2' } };
  assert.equal(evaluateScope(input).pass, false);
});
test('new CLI usage and modified reviewed library usage are blocked', () => {
  const input = fixture(); input.usage['src/new-cli.ts'] = 'unreviewed';
  assert.equal(evaluateScope(input).pass, false);
  const next = fixture(); next.usage['src/adapters/llm/file.ts'] = 'modified';
  assert.equal(evaluateScope(next).pass, false);
});
test('filesystem inventory detects a new source CLI and package script CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'dependency-audit-usage-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/new-cli.ts'), "spawn('mammoth', ['input.docx']);\n");
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { convert: 'mammoth input.docx' } }));
    const usage = collectUsage(root, 'core');
    assert.ok(usage['src/new-cli.ts']);
    assert.ok(usage['package.json#scripts.convert']);
    const input = fixture(); input.usage = usage;
    assert.equal(evaluateScope(input).pass, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('failed audit payload and misleading aggregate counts fail closed', () => {
  const input = fixture(); input.audit.error = { code: 'EACCESS' };
  assert.equal(evaluateScope(input).pass, false);
  const next = fixture(); next.audit.metadata.vulnerabilities.total = 0;
  assert.equal(evaluateScope(next).pass, false);
});
