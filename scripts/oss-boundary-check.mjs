import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const findings = [];

function read(file) {
  return existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '';
}

function requireIgnore(file, pattern) {
  const text = read(file);
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!lines.includes(pattern)) findings.push(`${file} must exclude ${pattern}`);
}

const requiredIgnorePatterns = [
  'web/site/',
  'web/console/',
  'web/console.bak.*/',
  'deploy/',
  '.deploy-backup/',
  '.oss-dist/',
  '.oss-publish/',
  'bailinghub-*.tgz',
  '*.bak.*',
  '*.bak.*/',
  'src.bak.*/',
  'config.json',
  '.env',
  '.paused',
  'build-info.json',
  'data/',
  'internal/',
  '*.internal.md',
  '*.private.md',
  'private/',
  'enterprise/',
  'src/private/',
  'src/enterprise/',
  'sql/private/',
  'sql/enterprise/',
  'web-admin/src/private/',
  'web-admin/src/platform/',
  '*.private.*',
  '*.enterprise.*',
];

for (const pattern of requiredIgnorePatterns) {
  requireIgnore('.dockerignore', pattern);
  requireIgnore('.npmignore', pattern);
}

const dockerfile = read('Dockerfile');
if (/COPY\s+\.\s+\./.test(dockerfile) && !read('.dockerignore').includes('web/site/')) {
  findings.push('Dockerfile copies the repository context, so .dockerignore must exclude web/site/');
}

let packFiles = [];
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  packFiles = Array.isArray(parsed) && parsed[0]?.files ? parsed[0].files.map((f) => String(f.path ?? '')) : [];
} catch (e) {
  findings.push(`npm pack --dry-run failed: ${e instanceof Error ? e.message : String(e)}`);
}

const forbiddenPackPrefixes = [
  'web/site/',
  'web/console/',
  'web/console.bak.',
  'deploy/',
  '.deploy-backup/',
  '.oss-dist/',
  '.oss-publish/',
  'src.bak.',
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
const forbiddenPackFiles = new Set(['config.json', '.env', '.paused', 'build-info.json']);
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
const forbiddenLegacyText = [
  { name: 'retired capability header', re: new RegExp(`\b${'x-' + 'ai'}\b`, 'i') },
  { name: 'retired target name', re: new RegExp(`\b${'cloud-' + 'llm'}(?:-v\d+)?\b`, 'i') },
  { name: 'retired product name', re: new RegExp(`\b${'bailing-' + 'ai'}\b`, 'i') },
  { name: 'internal editor metadata', re: new RegExp(`${'\.qo' + 'der'}|${'Co-Authored-' + 'By:'}`, 'i') },
  { name: 'pre-release historical narration', re: new RegExp([
    'v1\\.5\\s*' + '定稿',
    '兼容' + '老部署',
    '向旧' + '模块导出',
    '历史「[^」]+」路径' + '已废弃',
  ].join('|')) },
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
for (const file of packFiles) {
  if (forbiddenPackFiles.has(file) || forbiddenPackPrefixes.some((prefix) => file.startsWith(prefix)) || file.includes('.bak.')) {
    findings.push(`open-source package must not include ${file}`);
  }
  if (/^bailinghub-.*\.tgz$/.test(file)) {
    findings.push(`open-source package must not include generated package tarball ${file}`);
  }
}

for (const file of packFiles.filter((file) => /\.(?:ts|tsx|js|mjs|vue|json|sql|md|yml|yaml|php|py|sh|html|css|txt)$/.test(file))) {
  const text = read(file);
  if (!text) continue;
  if (file !== 'LICENSE' && forbiddenPublicWording.test(text)) {
    findings.push(`${file}: use neutral public wording for private extension boundaries`);
  }
  if (!guardScriptFiles.has(file)) {
    for (const rule of forbiddenImplementationText) {
      if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay out of the OSS package`);
    }
    for (const rule of forbiddenLegacyText) {
      if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay out of the first public release`);
    }
  }
  if (/^sql\/.+\.sql$/.test(file)) {
    for (const rule of forbiddenSqlSchemaText) {
      if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay in private migrations`);
    }
  }
}

if (findings.length) {
  console.error('OSS boundary check failed:');
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

console.log(`✓ oss boundary check passed (${packFiles.length} package files inspected)`);
