import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkVendor, upstream } from './vendor-mammoth.mjs';

const levels = ['info', 'low', 'moderate', 'high', 'critical'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

// No exceptions: zero raw findings is the only passing npm audit result.
export function evaluateScope({ scope, audit, lock }) {
  const reasons = [], counts = Object.fromEntries(levels.map(level => [level, 0]));
  if (!['core', 'web-admin'].includes(scope)) reasons.push('Unknown scope');
  const rows = audit?.vulnerabilities;
  if (audit?.auditReportVersion !== 2 || audit?.error || !rows || Array.isArray(rows) || typeof rows !== 'object') {
    return { scope, pass: false, rawCounts: null, reasons: [...reasons, 'Invalid or failed npm audit response'] };
  }
  for (const [name, row] of Object.entries(rows)) {
    if (row && row.name === name && levels.includes(row.severity)) counts[row.severity]++;
    else reasons.push(`Invalid vulnerability row: ${name}`);
    reasons.push(`Unresolved vulnerability: ${name}`);
  }
  counts.total = Object.keys(rows).length;
  if (stable(counts) !== stable(audit.metadata?.vulnerabilities)) reasons.push('Audit counts do not match vulnerability rows');
  if (!lock?.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) reasons.push('Missing dependency lock inventory');
  for (const [path, entry] of Object.entries(lock?.packages ?? {})) {
    if (/(?:^|\/)node_modules\/(?:argparse|sprintf-js)$/.test(path)) reasons.push(`Retired DOCX CLI dependency present: ${path}`);
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of ['argparse', 'sprintf-js']) if (entry[kind]?.[name]) reasons.push(`Retired DOCX CLI dependency reference: ${path || '<root>'}/${name}`);
    }
  }
  return { scope, pass: reasons.length === 0, rawCounts: counts, exceptedRows: 0, unexceptedRows: counts.total, reasons };
}

// A renamed library distribution must not make upstream library advisories
// invisible. Bulk queries return direct advisories, not removed CLI meta-vulns.
export function evaluateUpstreamAudit(report) {
  const valid = report && typeof report === 'object' && !Array.isArray(report)
    && Object.entries(report).every(([name, rows]) => name === upstream.name && Array.isArray(rows));
  const findings = valid ? Object.values(report).flat() : [];
  return {
    package: `${upstream.name}@${upstream.version}`,
    pass: !!valid && findings.length === 0,
    findings,
    reasons: !valid ? ['Invalid upstream advisory response'] : findings.length ? ['Upstream library advisory requires review'] : [],
  };
}

export async function auditUpstream(fetcher = fetch) {
  const response = await fetcher('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [upstream.name]: [upstream.version] }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Upstream advisory query failed: HTTP ${response.status}`);
  return evaluateUpstreamAudit(await response.json());
}

export function runScope(root, scope) {
  const directory = scope === 'core' ? root : join(root, 'web-admin');
  const run = spawnSync('npm', ['audit', '--json'], { cwd: directory, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (run.error || run.signal || ![0, 1].includes(run.status)) throw new Error(`npm audit failed in ${scope}; exit=${run.status}`);
  return evaluateScope({ scope, audit: JSON.parse(run.stdout), lock: json(join(directory, 'package-lock.json')) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = { root: process.cwd(), scope: 'all' };
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], value = process.argv[index + 1];
      if (!['--root', '--scope'].includes(flag) || !value) throw new Error('Usage: dependency-audit.mjs [--root PATH] [--scope core|web-admin|all]');
      options[flag.slice(2)] = value;
    }
    if (!['core', 'web-admin', 'all'].includes(options.scope)) throw new Error('Unknown scope');
    const root = resolve(options.root);
    const vendor = checkVendor(root);
    const upstreamAudit = await auditUpstream();
    const scopes = options.scope === 'all' ? ['core', 'web-admin'] : [options.scope];
    const results = scopes.map(scope => runScope(root, scope));
    console.log(JSON.stringify({ results, vendor, upstreamAudit, note: 'Strict audit: no dependency exceptions. Vendored upstream library advisories are checked separately.' }, null, 2));
    process.exitCode = upstreamAudit.pass && results.every(result => result.pass) ? 0 : 1;
  } catch (error) {
    console.error(`Dependency audit blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
