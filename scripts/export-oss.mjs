import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const outRoot = join(root, '.oss-dist');
const exportDir = join(outRoot, 'bailinghub');
const tarball = join(outRoot, 'bailinghub-oss-source.tgz');
const findings = [];
const tarEnv = { ...process.env, COPYFILE_DISABLE: '1' };
const tarNoMetadataArgs = ['--no-xattrs'];

const extraRepoFiles = [
  '.github/workflows/ci.yml',
  '.github/workflows/images.yml',
  '.github/workflows/gitee-mirror.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/ISSUE_TEMPLATE/independent_validation.yml',
  '.github/pull_request_template.md',
  '.dockerignore',
  '.gitignore',
  '.npmignore',
  'package-lock.json',
];

const forbiddenPrefixes = [
  'web/site/',
  'web/console/',
  'web/console.bak.',
  'deploy/',
  '.deploy-backup/',
  'src.bak.',
  'data/',
  'internal/',
  '.oss-dist/',
  '.oss-publish/',
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

const forbiddenFiles = new Set([
  'config.json',
  '.env',
]);
const rx = (parts, flags = '') => new RegExp(parts.join(''), flags);

const bannedText = [
  { name: 'local machine path', re: rx(['/Users/', 'macmini', '|', '项目', '\\/www']) },
  { name: 'known leaked password', re: rx(['Nie', '0712', '\\.\\.']) },
  { name: 'known managed MySQL host', re: rx(['sh-', 'cynosdb', 'mysql', '-[A-Za-z0-9.-]+', 'tencent', 'cdb\\.com']) },
  { name: 'known internal git token', re: rx(['pt', '-[A-Za-z0-9_-]{20,}']) },
  { name: 'GitHub PAT', re: rx(['github', '_pat', '_[A-Za-z0-9_]+']) },
  { name: 'old official domain', re: rx(['bailing\\.', 'bnopen', '\\.cn', '|', 'bnopen', '\\.cn']) },
];
const forbiddenPublicWording = new RegExp([
  '商业' + '版',
  '商业' + '扩展',
  '商业' + '仓',
  '\\b[Cc]om' + 'mercial\\b',
].join('|'));
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

function rel(path) {
  return path.split('\\').join('/');
}

function copyIfExists(file) {
  const from = join(root, file);
  if (!existsSync(from)) return;
  const to = join(exportDir, file);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
}

function walk(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full, base));
    else files.push(rel(full.slice(base.length + 1)));
  }
  return files;
}

function scanExport() {
  const files = walk(exportDir);
  for (const file of files) {
    const top = file.split('/')[0];
    const hasAppleDouble = file.split('/').some((part) => part.startsWith('._')) || file.startsWith('__MACOSX/');
    const hiddenNotAllowed = top.startsWith('.') && !allowedHiddenRoots.has(top) && !allowedHiddenFiles.has(file);
    if (hasAppleDouble) findings.push(`export must not include macOS metadata ${file}`);
    if (hiddenNotAllowed || forbiddenFiles.has(file) || forbiddenPrefixes.some((prefix) => file.startsWith(prefix)) || file.includes('.bak.')) {
      findings.push(`export must not include ${file}`);
    }
  }

  const textFiles = files.filter((file) => /\.(?:md|ts|tsx|js|mjs|json|sql|php|py|vue|html|css|sh|yml|yaml|txt|gitignore|npmignore|dockerignore)$/.test(file));
  for (const file of textFiles) {
    const text = readFileSync(join(exportDir, file), 'utf8');
    for (const rule of bannedText) {
      if (rule.re.test(text)) findings.push(`${file}: ${rule.name}`);
    }
    if (file !== 'LICENSE' && forbiddenPublicWording.test(text)) {
      findings.push(`${file}: use neutral public wording for private extension boundaries`);
    }
    if (!guardScriptFiles.has(file)) {
      for (const rule of forbiddenImplementationText) {
        if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay out of the OSS export`);
      }
    }
    if (/^sql\/.+\.sql$/.test(file)) {
      for (const rule of forbiddenSqlSchemaText) {
        if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay in private migrations`);
      }
    }
  }
}

function scanTarball() {
  const entries = execFileSync('tar', ['-tzf', tarball], { cwd: root, env: tarEnv, encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
  for (const entry of entries) {
    const hasAppleDouble = entry.split('/').some((part) => part.startsWith('._')) || entry.startsWith('__MACOSX/');
    if (hasAppleDouble) findings.push(`tarball must not include macOS metadata ${entry}`);
  }
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

const packName = execFileSync('npm', ['pack', '--silent'], { cwd: root, encoding: 'utf8' }).trim();
try {
  execFileSync('tar', [...tarNoMetadataArgs, '-xzf', packName, '-C', outRoot], { cwd: root, env: tarEnv, stdio: 'inherit' });
  renameSync(join(outRoot, 'package'), exportDir);
  for (const file of extraRepoFiles) copyIfExists(file);
  scanExport();
  if (findings.length) {
    console.error('OSS export failed:');
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exit(1);
  }
  execFileSync('tar', [...tarNoMetadataArgs, '-czf', tarball, '-C', outRoot, 'bailinghub'], { cwd: root, env: tarEnv, stdio: 'inherit' });
  scanTarball();
  if (findings.length) {
    console.error('OSS export failed:');
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exit(1);
  }
  const count = walk(exportDir).length;
  console.log(`✓ OSS export ready: ${tarball} (${count} files)`);
} finally {
  rmSync(join(root, packName), { force: true });
}
