import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { checkVendor } from './vendor-mammoth.mjs';
import { evaluateScope, evaluateUpstreamAudit, auditUpstream } from './dependency-audit.mjs';

function fixture(scope = 'core') {
  return { scope, audit: { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } }, lock: { packages: {} } };
}
for (const scope of ['core', 'web-admin']) {
  test(`${scope}: zero raw findings pass without an exception or expiry`, () => {
    const result = evaluateScope(fixture(scope));
    assert.equal(result.pass, true); assert.equal(result.rawCounts.total, 0); assert.equal(result.exceptedRows, 0);
  });
}
for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
  test(`all ${severity} findings block`, () => {
    const input = fixture();
    input.audit.vulnerabilities.package = { name: 'package', severity };
    input.audit.metadata.vulnerabilities[severity] = 1;
    input.audit.metadata.vulnerabilities.total = 1;
    const result = evaluateScope(input);
    assert.equal(result.pass, false); assert.equal(result.unexceptedRows, 1);
  });
}
test('audit errors, invalid rows, malformed metadata and mismatched counts fail closed', () => {
  for (const audit of [null, {}, { error: 'registry unavailable' }, { ...fixture().audit, vulnerabilities: [] }, { ...fixture().audit, metadata: undefined }, { ...fixture().audit, vulnerabilities: { unknown: null } }]) {
    assert.equal(evaluateScope({ ...fixture(), audit }).pass, false);
  }
  const input = fixture(); input.audit.metadata.vulnerabilities.total = 1;
  assert.equal(evaluateScope(input).pass, false);
});
test('retired CLI packages and nested dependency references are rejected even with a clean audit', () => {
  for (const packages of [{ 'node_modules/argparse': { version: '2.0.1' } }, { 'node_modules/x/node_modules/sprintf-js': { version: '1.1.3' } }, { 'vendor/mammoth-library': { dependencies: { argparse: '*' } } }]) {
    assert.equal(evaluateScope({ ...fixture(), lock: { packages } }).pass, false);
  }
  assert.equal(evaluateScope({ ...fixture(), lock: {} }).pass, false);
});
test('upstream query accepts only an empty direct advisory report', () => {
  assert.equal(evaluateUpstreamAudit({}).pass, true);
  assert.equal(evaluateUpstreamAudit({ mammoth: [] }).pass, true);
  for (const report of [null, [], { error: 'failure' }, { mammoth: {} }, { mammoth: [{ id: 1, severity: 'high' }] }]) assert.equal(evaluateUpstreamAudit(report).pass, false);
});
test('registry failures cannot become a clean upstream audit', async () => {
  await assert.rejects(auditUpstream(async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(auditUpstream(async () => { throw new Error('offline'); }), /offline/);
  await assert.rejects(auditUpstream(async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } })), /invalid JSON/);
  const result = await auditUpstream(async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { mammoth: ['1.12.0'] });
    return { ok: true, json: async () => ({ mammoth: [{ id: 9 }] }) };
  });
  assert.equal(result.pass, false);
});


test('vendor gate rejects source tampering, a self-rehashed different archive and missing npm bundling', () => {
  const base = mkdtempSync(join(tmpdir(), 'docx-vendor-gate-'));
  try {
    cpSync(new URL('../vendor/', import.meta.url), join(base, 'vendor'), { recursive: true });
    cpSync(new URL('../package.json', import.meta.url), join(base, 'package.json'));
    mkdirSync(join(base, 'web-admin'));
    cpSync(new URL('../web-admin/package.json', import.meta.url), join(base, 'web-admin/package.json'));
    cpSync(new URL('../package-lock.json', import.meta.url), join(base, 'package-lock.json'));
    cpSync(new URL('../web-admin/package-lock.json', import.meta.url), join(base, 'web-admin/package-lock.json'));
    const source = join(base, 'vendor/mammoth-library/lib/raw-text.js');
    const original = readFileSync(source); writeFileSync(source, '// changed');
    assert.throws(() => checkVendor(base), /Vendor source changed/); writeFileSync(source, original);
    const distributionPath = join(base, 'vendor/mammoth-library-distribution.json');
    const distribution = JSON.parse(readFileSync(distributionPath));
    const archivePath = join(base, 'vendor', distribution.file);
    const archive = readFileSync(archivePath);
    const alternate = join(base, 'alternate');
    cpSync(join(base, 'vendor/mammoth-library'), alternate, { recursive: true });
    writeFileSync(join(alternate, 'lib/raw-text.js'), '// substituted parser');
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', base], { cwd: alternate, stdio: 'pipe' });
    const changedArchive = readFileSync(join(base, distribution.file));
    writeFileSync(archivePath, changedArchive);
    writeFileSync(distributionPath, JSON.stringify({ ...distribution, sha256: createHash('sha256').update(changedArchive).digest('hex') }));
    assert.throws(() => checkVendor(base), /archive does not match the reviewed source/);
    writeFileSync(archivePath, archive); writeFileSync(distributionPath, JSON.stringify(distribution));
    const manifestPath = join(base, 'package.json'); const manifest = JSON.parse(readFileSync(manifestPath));
    delete manifest.bundleDependencies; writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => checkVendor(base), /Core must bundle/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
