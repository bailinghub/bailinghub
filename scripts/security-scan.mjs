import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const requiredFiles = ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CONTRIBUTING.md', '.env.example', 'config.example.json'];
const allowedLiteralValues = new Set([
  'demo-tool-secret-change-me',
  'bailing-demo-client-token',
  'bailing-root-pass',
  'bailing-pass',
  'bailing-demo-admin',
  'bailing-test-secret',
  'your-api-key',
  '<your-approval-record-id>',
  '<business-user-id>',
  'REPLACE_ME',
  '[REDACTED_SECRET]',
]);
const skipPath = (file) => (
  file === 'LICENSE'
  || file === 'package-lock.json'
  || file === 'web-admin/package-lock.json'
  || file.startsWith('web/console/')
  || file.startsWith('node_modules/')
  || file.startsWith('web-admin/node_modules/')
  || file.startsWith('.git/')
);
const isTestFixture = (file) => /\.(test|spec)\.(ts|js|mjs)$/.test(file) || file.includes('/__tests__/');
const rx = (parts, flags = '') => new RegExp(parts.join(''), flags);

const patterns = [
  { name: 'private key', re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'OpenAI API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Tencent Cloud secret id', re: /\bAKID[A-Za-z0-9]{13,}\b/ },
  { name: 'known leaked password', re: rx(['Nie', '0712', '\\.\\.']) },
  { name: 'known managed MySQL host in source', re: rx(['sh-', 'cynosdb', 'mysql', '-[A-Za-z0-9.-]+', 'tencent', 'cdb\\.com']) },
  { name: 'legacy fixed server token fallback', re: /server(?:Token|\.token)\s*\|\|\s*['"]bailing['"]/ },
  { name: 'predictable Compose admin token', re: /BAILING_TOKEN:\s*\$\{BAILING_TOKEN:-[^}]+\}/ },
];

function trackedAndUntrackedFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function looksText(buf) {
  if (!buf.length) return true;
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  return !sample.includes(0);
}

function scanSecretAssignments(file, text, findings) {
  if (isTestFixture(file)) return;
  const re = /\b(password|passwd|pwd|api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|token)\b\s*[:=]\s*["']([^"'\n]{8,})["']/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = m[2].trim();
    if (allowedLiteralValues.has(value)) continue;
    if (/^(change-me|example|placeholder|your-|<.+>|xxx+|\*+|demo-|bailing-)/i.test(value)) continue;
    if (file.includes('/README') || file.startsWith('docs/') || file.startsWith('sdk/')) continue;
    findings.push({ file, name: `suspicious ${m[1]} assignment`, sample: value.slice(0, 12) + '...' });
  }
}

const findings = [];
for (const f of requiredFiles) {
  if (!existsSync(join(root, f))) findings.push({ file: f, name: 'required open-source file missing', sample: f });
}

for (const file of trackedAndUntrackedFiles()) {
  if (skipPath(file)) continue;
  const full = join(root, file);
  if (!existsSync(full) || !statSync(full).isFile()) continue;
  const buf = readFileSync(full);
  if (!looksText(buf)) continue;
  const text = buf.toString('utf8');
  for (const p of patterns) {
    if (isTestFixture(file) && p.name === 'OpenAI API key') continue;
    const m = text.match(p.re);
    if (m) findings.push({ file, name: p.name, sample: m[0].slice(0, 80) });
  }
  scanSecretAssignments(file, text, findings);
}

if (findings.length) {
  console.error('Security scan failed:');
  for (const f of findings) console.error(`  - ${f.file}: ${f.name} (${f.sample})`);
  process.exit(1);
}

console.log('✓ security scan passed');
