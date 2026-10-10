import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const affectedNames = ['mammoth', 'argparse', 'sprintf-js'];
const approvedAdvisory = 'https://github.com/advisories/GHSA-hp3w-g68c-fv3c';
const usagePattern = /\b(?:mammoth|argparse|sprintf-js)\b/i;
const levels = ['info', 'low', 'moderate', 'high', 'critical'];
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = source => createHash('sha256').update(source).digest('hex');
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

function reviewedRowsAreExact(rows) {
  if (!rows || Array.isArray(rows) || typeof rows !== 'object' ||
      stable(Object.keys(rows).sort()) !== stable([...affectedNames].sort())) return false;
  const chain = { mammoth: ['argparse'], argparse: ['sprintf-js'] };
  const effects = { mammoth: [], argparse: ['mammoth'], 'sprintf-js': ['argparse'] };
  for (const name of affectedNames) {
    const row = rows[name];
    if (!row || row.name !== name || row.severity !== 'moderate' ||
        stable(row.nodes) !== stable([`node_modules/${name}`]) ||
        stable(row.effects) !== stable(effects[name])) return false;
    if (name !== 'sprintf-js') {
      if (stable(row.via) !== stable(chain[name])) return false;
    } else {
      if (!Array.isArray(row.via) || row.via.length !== 1) return false;
      const advisory = row.via[0];
      if (!advisory || typeof advisory !== 'object' || Array.isArray(advisory) ||
          advisory.name !== name || advisory.dependency !== name ||
          advisory.severity !== 'moderate' || advisory.url !== approvedAdvisory) return false;
    }
  }
  return true;
}

export function dependencyState(lock) {
  const versions = {}, references = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (affectedNames.some(name => path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`))) versions[path] = entry.version;
    for (const kind of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(entry[kind] ?? {})) {
        if (affectedNames.includes(name)) references.push(`${path || '<root>'}|${kind}|${name}|${range}`);
      }
    }
  }
  return { versions, references: references.sort() };
}

export function collectUsage(root, scope) {
  const inventory = {};
  const directories = scope === 'core' ? ['src', 'scripts', '.github'] : ['web-admin/src', 'web-admin/scripts'];
  const excluded = new Set(['scripts/dependency-audit.mjs', 'scripts/dependency-audit.test.mjs']);
  function visit(path) {
    const local = relative(root, path).replaceAll('\\', '/');
    if (excluded.has(local)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Source symlink requires review: ${local}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    } else if (stat.isFile() && /\.(?:[cm]?js|[cm]?ts|jsx|tsx|vue|html|ya?ml|json|sh)$/.test(path)) {
      const source = readFileSync(path);
      if (usagePattern.test(source.toString('utf8'))) inventory[local] = hash(source);
    }
  }
  for (const directory of directories) if (existsSync(join(root, directory))) visit(join(root, directory));
  const manifestPath = scope === 'core' ? 'package.json' : 'web-admin/package.json';
  const scripts = json(join(root, manifestPath)).scripts ?? {};
  for (const [name, command] of Object.entries(scripts)) {
    if (usagePattern.test(String(command))) inventory[`${manifestPath}#scripts.${name}`] = hash(String(command));
  }
  return inventory;
}

export function evaluateScope({ scope, audit, lock, usage, policy, now = new Date() }) {
  const reasons = [], counts = Object.fromEntries(levels.map(level => [level, 0]));
  const exception = policy.scopes?.[scope];
  const from = Date.parse(policy.approvedFrom), until = Date.parse(policy.expiresAt), time = +now;
  if (policy.version !== 1 || policy.owner !== 'Jingchuan Nie' || policy.advisory !== approvedAdvisory) reasons.push('Unknown exception policy');
  if (![from, until, time].every(Number.isFinite) || until <= from || until - from > 30 * 86400000) reasons.push('Invalid exception period');
  else if (time < from || time >= until) reasons.push('Exception is not active or has expired');
  if (!exception) reasons.push(`Unknown scope: ${scope}`);
  else if (!reviewedRowsAreExact(exception.knownAuditRows)) reasons.push('Exception policy must contain only the reviewed Mammoth/argparse/sprintf-js chain and advisory');
  const rows = audit?.vulnerabilities;
  if (audit?.auditReportVersion !== 2 || audit?.error || !rows || Array.isArray(rows) || typeof rows !== 'object') {
    reasons.push('Invalid or failed npm audit response');
    return { scope, pass: false, rawCounts: null, exceptedRows: 0, reasons };
  }
  let exceptedRows = 0;
  for (const [name, row] of Object.entries(rows)) {
    if (levels.includes(row.severity)) counts[row.severity]++;
    else reasons.push(`Unknown vulnerability severity: ${name}`);
    if (!exception?.knownAuditRows?.[name] || stable(row) !== stable(exception.knownAuditRows[name])) reasons.push(`Unreviewed vulnerability or changed advisory/dependency path: ${name}`);
    else exceptedRows++;
  }
  counts.total = Object.keys(rows).length;
  if (stable(counts) !== stable(audit.metadata?.vulnerabilities)) reasons.push('Audit counts do not match vulnerability rows');
  if (exception) {
    const state = dependencyState(lock);
    if (stable(state.versions) !== stable(exception.packageVersions)) reasons.push('Reviewed dependency versions or installed locations changed');
    if (stable(state.references) !== stable(exception.dependencyReferences)) reasons.push('New or changed dependency consumer/path requires review');
    if (stable(usage) !== stable(exception.reviewedUsageFiles)) reasons.push('New/changed source or CLI usage requires review');
  }
  return { scope, pass: reasons.length === 0, rawCounts: counts, exceptedRows, unexceptedRows: counts.total - exceptedRows, exceptionExpiresAt: policy.expiresAt, reasons };
}

export function runScope(root, scope, policy) {
  const directory = scope === 'core' ? root : join(root, 'web-admin');
  const run = spawnSync('npm', ['audit', '--json'], { cwd: directory, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  if (run.error || run.signal || ![0, 1].includes(run.status)) throw new Error(`npm audit failed in ${scope}; exit=${run.status}`);
  return evaluateScope({ scope, audit: JSON.parse(run.stdout), lock: json(join(directory, 'package-lock.json')), usage: collectUsage(root, scope), policy });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = { root: process.cwd(), scope: 'all' };
    for (let index = 2; index < process.argv.length; index += 2) {
      const flag = process.argv[index], value = process.argv[index + 1];
      if (!['--root', '--scope', '--policy'].includes(flag) || !value) throw new Error('Usage: dependency-audit.mjs [--root PATH] [--scope core|web-admin|all] [--policy PATH]');
      options[flag.slice(2)] = value;
    }
    if (!['core', 'web-admin', 'all'].includes(options.scope)) throw new Error('Unknown scope');
    const root = resolve(options.root), policy = json(options.policy ?? join(root, 'security/dependency-audit-exceptions.json'));
    const scopes = options.scope === 'all' ? ['core', 'web-admin'] : [options.scope];
    const results = scopes.map(scope => runScope(root, scope, policy));
    console.log(JSON.stringify({ results, note: 'Raw findings remain open; an exact temporary exception is not a vulnerability fix.' }, null, 2));
    process.exitCode = results.every(result => result.pass) ? 0 : 1;
  } catch (error) {
    console.error(`Dependency audit blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
