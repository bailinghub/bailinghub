import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const exportDir = join(root, '.oss-dist', 'bailinghub');

function run(cmd, args, cwd = root) {
  console.log(`> ${[cmd, ...args].join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function output(cmd, args, cwd = root) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const rx = (parts, flags = '') => new RegExp(parts.join(''), flags);

function verifyGitBoundary() {
  const rehearsalRoot = mkdtempSync(join(tmpdir(), 'bailinghub-oss-git-'));
  const repoDir = join(rehearsalRoot, 'repo');
  cpSync(exportDir, repoDir, { recursive: true });

  try {
    run('git', ['init', '-q'], repoDir);
    run('git', ['config', 'user.email', 'release-check@bailinghub.local'], repoDir);
    run('git', ['config', 'user.name', 'Bailing Release Check'], repoDir);
    run('git', ['add', '.'], repoDir);
    run('git', ['commit', '-q', '-m', 'chore: verify oss export'], repoDir);
    const files = output('git', ['ls-files'], repoDir).trim().split(/\r?\n/).filter(Boolean);
    const gitignore = readFileSync(join(repoDir, '.gitignore'), 'utf8');
  const requiredGitignoreRules = [
    '.oss-dist/',
    'bailinghub-*.tgz',
    'web/site/',
    'web/console/',
    'deploy/',
    'config.json',
    '.env',
    'data/',
    'internal/',
    'private/',
    'enterprise/',
    'src/private/',
    'src/enterprise/',
    'sql/private/',
    'sql/enterprise/',
    'web-admin/src/private/',
    'web-admin/src/platform/',
  ];
    for (const rule of requiredGitignoreRules) {
      if (!gitignore.includes(rule)) {
        throw new Error(`OSS git boundary .gitignore is missing required rule: ${rule}`);
      }
    }
  const forbiddenPrefixes = [
    '.oss-dist/',
    'deploy/',
    'web/site/',
    'web/console/',
    'node_modules/',
    'web-admin/node_modules/',
    'data/',
    'internal/',
    'private/',
    'enterprise/',
    'src/private/',
    'src/enterprise/',
    'sql/private/',
    'sql/enterprise/',
    'web-admin/src/private/',
    'web-admin/src/platform/',
  ];
  const allowedHiddenRoots = new Set(['.github']);
  const allowedHiddenFiles = new Set(['.dockerignore', '.env.example', '.gitignore', '.npmignore']);
  const forbiddenFiles = new Set(['config.json', '.env', 'targets.local.json']);
  const bannedText = rx([
    '/Users/', 'macmini',
    '|', '项目', '\\/www',
    '|', 'Nie', '0712',
    '|', 'github', '_pat', '_',
    '|', 'pt', '-[A-Za-z0-9_-]{20,}',
    '|', 'bnopen', '\\.cn',
    '|', 'sh-', 'cynosdb', 'mysql', '-[A-Za-z0-9.-]+', 'tencent', 'cdb\\.com',
  ]);
  const forbiddenPublicWording = new RegExp([
    '商业' + '版',
    '商业' + '扩展',
    '商业' + '仓',
    '\\b[Cc]om' + 'mercial\\b',
  ].join('|'));
  const findings = [];
  const forbiddenImplementationText = [
    { name: 'private edition implementation', re: new RegExp(`\\b(?:${['Com' + 'mercialEdition', 'com' + 'mercialEdition', 'TenantAwareStoreFactory', 'TenantScopeResolver', 'Com' + 'mercialScopeResolver', 'Com' + 'mercialIdentityProvider', 'Com' + 'mercialPolicyEngine'].join('|')})\\b`) },
    { name: 'platform tenant implementation', re: /\b(?:PlatformTenantAdmin|platformTenantAdmin|tenantRegistry|TenantRegistry|platformTenantRoutes|PlatformTenantRoutes)\b/ },
    { name: 'private licensing or billing implementation', re: /\b(?:LicenseServer|licenseServer|BillingPolicy|billingPolicy|TenantBilling|tenantBilling|WhiteLabel|whiteLabel)\b/ },
  ];
  const guardScriptFiles = new Set([
    'scripts/export-oss.mjs',
    'scripts/oss-boundary-check.mjs',
    'scripts/verify-oss-export.mjs',
    'scripts/release-audit.mjs',
  ]);
  const forbiddenSqlSchemaText = [
    { name: 'platform isolation table', re: /\bCREATE\s+TABLE\b[\s\S]*?\b(?:bz_)?(?:tenants|tenant_members|tenant_roles|tenant_plans|tenant_quotas|tenant_registry|platform_tenants|platform_admins|plans|subscriptions|billing_accounts)\b/i },
    { name: 'platform isolation column', re: /\bADD\s+COLUMN\s+`?tenant_id`?\b/i },
    { name: 'platform isolation index', re: /\b(?:KEY|INDEX|CONSTRAINT)\b[\s\S]{0,160}\btenant_id\b/i },
  ];
    for (const file of files) {
      const top = file.split('/')[0];
      const hiddenNotAllowed = top.startsWith('.') && !allowedHiddenRoots.has(top) && !allowedHiddenFiles.has(file);
      if (hiddenNotAllowed || forbiddenFiles.has(file) || forbiddenPrefixes.some((prefix) => file.startsWith(prefix)) || file.includes('.bak.')) {
        findings.push(`git boundary must not include ${file}`);
      }
      if (/^bailinghub-.*\.tgz$/.test(file)) findings.push(`git boundary must not include generated tarball ${file}`);
    }
    const textFiles = files.filter((file) => /\.(?:md|ts|tsx|js|mjs|json|sql|php|py|vue|html|css|sh|yml|yaml|txt|gitignore|npmignore|dockerignore)$/.test(file));
    for (const file of textFiles) {
      const text = output('git', ['show', `:${file}`], repoDir);
      if (bannedText.test(text)) findings.push(`${file}: forbidden private text in git boundary`);
      if (file !== 'LICENSE' && forbiddenPublicWording.test(text)) {
        findings.push(`${file}: use neutral public wording for private extension boundaries`);
      }
      if (!guardScriptFiles.has(file)) {
        for (const rule of forbiddenImplementationText) {
          if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay out of the OSS git boundary`);
        }
      }
      if (/^sql\/.+\.sql$/.test(file)) {
        for (const rule of forbiddenSqlSchemaText) {
          if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay in private migrations`);
        }
      }
    }
    if (!files.includes('.github/workflows/ci.yml')) findings.push('git boundary missing .github/workflows/ci.yml');
    if (!files.includes('.github/workflows/images.yml')) findings.push('git boundary missing .github/workflows/images.yml');
    if (!files.includes('.github/ISSUE_TEMPLATE/bug_report.yml')) findings.push('git boundary missing bug issue template');
    if (!files.includes('.github/ISSUE_TEMPLATE/feature_request.yml')) findings.push('git boundary missing feature issue template');
    if (!files.includes('.github/pull_request_template.md')) findings.push('git boundary missing pull request template');
    if (!files.includes('package-lock.json')) findings.push('git boundary missing package-lock.json');
    if (findings.length) {
      console.error('OSS git boundary verification failed:');
      for (const finding of findings) console.error(`  - ${finding}`);
      throw new Error('OSS git boundary verification failed');
    }
    console.log(`✓ OSS git boundary passed (${files.length} tracked files)`);
  } finally {
    rmSync(rehearsalRoot, { recursive: true, force: true });
  }
}

run('npm', ['run', 'oss:export']);

if (!existsSync(join(exportDir, 'package-lock.json'))) {
  throw new Error('OSS export is missing root package-lock.json; GitHub CI uses npm ci.');
}
if (!existsSync(join(exportDir, '.github', 'workflows', 'ci.yml'))) {
  throw new Error('OSS export is missing .github/workflows/ci.yml.');
}
for (const file of [
  'THIRD_PARTY_NOTICES.md',
  'assets/architecture-overview.zh-CN.svg',
  'assets/architecture-overview.zh-CN-dark.svg',
  'assets/architecture-overview.en.svg',
  'assets/architecture-overview.en-dark.svg',
]) {
  if (!existsSync(join(exportDir, file))) throw new Error(`OSS export is missing ${file}.`);
}

verifyGitBoundary();
run('npm', ['ci'], exportDir);
run('npm', ['run', 'release:audit'], exportDir);
run('npm', ['run', 'typecheck'], exportDir);
run('npm', ['test'], exportDir);
run('npm', ['--prefix', 'web-admin', 'ci'], exportDir);
run('npm', ['run', 'web-admin:check'], exportDir);
run('npm', ['run', 'sdk:test'], exportDir);
run('npm', ['run', 'sdk:test7'], exportDir);
run('npm', ['run', 'sdk:test-node'], exportDir);
run('npm', ['run', 'sdk:test-python'], exportDir);

console.log('✓ OSS export verification passed');
