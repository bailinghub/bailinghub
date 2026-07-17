import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const findings = [];
const requiredRepoFiles = [
  'README.md',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'docs/RELEASE_NOTES_v0.1.0.md',
  'docs/RELEASE_NOTES_v0.1.1.md',
  'docs/RELEASE_NOTES_v0.1.2.md',
  'docs/CHANGELOG.md',
  'config.example.json',
  '.env.example',
  'package-lock.json',
  'Dockerfile',
  'docker-compose.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/gitee-mirror.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/pull_request_template.md',
  'scripts/export-oss.mjs',
  'scripts/verify-oss-export.mjs',
  'scripts/check-doc-links.mjs',
  'scripts/generate-third-party-notices.mjs',
  'scripts/generate-readme-assets.mjs',
  'scripts/validate-examples.mjs',
  'scripts/check-image-tags.sh',
  'scripts/write-build-info.mjs',
];

function readText(path) {
  return readFileSync(path, 'utf8');
}

function assertPackageMetadata() {
  const pkg = JSON.parse(readText('package.json'));
  const expected = {
    name: 'bailinghub',
    private: false,
    license: 'Apache-2.0',
    homepage: 'https://www.bailinghub.com',
    repository: 'git+https://github.com/bailinghub/bailinghub.git',
    bugs: 'https://github.com/bailinghub/bailinghub/issues',
  };
  if (pkg.name !== expected.name) findings.push(`package.json: name must be ${expected.name}`);
  if (pkg.private !== expected.private) findings.push('package.json: package must be publishable (private=false)');
  if (pkg.license !== expected.license) findings.push(`package.json: license must be ${expected.license}`);
  if (pkg.homepage !== expected.homepage) findings.push(`package.json: homepage must be ${expected.homepage}`);
  if (pkg.repository?.url !== expected.repository) findings.push(`package.json: repository.url must be ${expected.repository}`);
  if (pkg.bugs?.url !== expected.bugs) findings.push(`package.json: bugs.url must be ${expected.bugs}`);
  if (pkg.exports?.['./extension-api']?.default !== './src/extension-api.ts') findings.push('package.json: exports must expose ./extension-api');
  if (!pkg.engines?.node || !String(pkg.engines.node).includes('22')) findings.push('package.json: engines.node must declare Node 22+');
  const keywords = new Set(Array.isArray(pkg.keywords) ? pkg.keywords : []);
  for (const keyword of ['ai', 'agent', 'middleware', 'tool-governance']) {
    if (!keywords.has(keyword)) findings.push(`package.json: missing keyword ${keyword}`);
  }
}

function assertRepoEntrance() {
  for (const file of requiredRepoFiles) {
    if (!existsSync(file)) findings.push(`${file}: required release file missing`);
  }
  if (!existsSync('src/extension-api.ts')) findings.push('src/extension-api.ts: stable extension API entry missing');
  if (existsSync('.github/workflows/ci.yml')) {
    const ci = readText('.github/workflows/ci.yml');
    if (!ci.includes('npm run release:audit')) findings.push('.github/workflows/ci.yml: CI must run release:audit');
    if (!ci.includes('docker compose up -d --build')) findings.push('.github/workflows/ci.yml: CI must exercise Docker demo');
  }
  if (existsSync('scripts/install.sh')) {
    const install = readText('scripts/install.sh');
    if (!install.includes('https://www.bailinghub.com/connect/bailinghub-source.tgz')) {
      findings.push('scripts/install.sh: default source package must use official website domain');
    }
  }
  if (existsSync('README.md')) {
    const readme = readText('README.md');
    for (const required of ['docker compose up --build', 'https://www.bailinghub.com/install.sh', 'docs/CONTRACT.md', 'docs/QUICKSTART.md', 'docs/CHANGELOG.md']) {
      if (!readme.includes(required)) findings.push(`README.md: missing ${required}`);
    }
  }
  const pkg = JSON.parse(readText('package.json'));
  const releaseCheck = String(pkg.scripts?.['release:check'] ?? '');
  if (pkg.scripts?.['oss:export'] !== 'node scripts/export-oss.mjs') findings.push('package.json: oss:export must run scripts/export-oss.mjs');
  if (pkg.scripts?.['oss:verify'] !== 'node scripts/verify-oss-export.mjs') findings.push('package.json: oss:verify must run scripts/verify-oss-export.mjs');
  for (const required of ['npm run notices:check', 'npm run assets:check', 'npm run audit:deps', 'npm run typecheck', 'npm test', 'npm run web-admin:check', 'npm run docs:check', 'npm run examples:check', 'npm run sdk:test', 'npm run sdk:test7', 'npm run sdk:test-node', 'npm run sdk:test-python', 'npm run sdk:test-runtime', 'npm run sdk:test-p1', 'npm run release:audit', 'npm run oss:verify']) {
    if (!releaseCheck.includes(required)) findings.push(`package.json: release:check must include ${required}`);
  }
}

function assertSdkMetadata() {
  for (const file of ['sdk/php/composer.json', 'sdk/php7/composer.json']) {
    if (!existsSync(file)) {
      findings.push(`${file}: required PHP SDK composer metadata missing`);
      continue;
    }
    const composer = JSON.parse(readText(file));
    if (composer.license !== 'Apache-2.0') findings.push(`${file}: license must be Apache-2.0`);
    const description = String(composer.description ?? '');
    if (/proprietary/i.test(description) || /v\d+\s*验签/.test(description)) {
      findings.push(`${file}: description must not mention proprietary licensing or versioned signature labels`);
    }
  }
  const sdkTextFiles = [
    'sdk/php/README.md',
    'sdk/php7/README.md',
    'sdk/node/README.md',
    'sdk/python/README.md',
    'sdk/java/README.md',
    'sdk/go/README.md',
    'sdk/dotnet/README.md',
    'sdk/php/src/Verify.php',
    'sdk/php7/src/Verify.php',
    'sdk/php/examples/thinkphp-integration.php',
    'sdk/php7/examples/well-known.php',
  ];
  for (const file of sdkTextFiles) {
    if (!existsSync(file)) continue;
    if (/v\d+\s*验签/.test(readText(file))) {
      findings.push(`${file}: use sha256= signature wording, not versioned signature wording`);
    }
  }
  for (const file of [
    'sdk/node/src/index.mjs',
    'sdk/python/bailing_connect/__init__.py',
    'sdk/php/src/HubClient.php',
    'sdk/php7/src/HubClient.php',
    'sdk/java/src/main/java/com/bailing/connect/BailingConnect.java',
    'sdk/go/bailingconnect/connect.go',
    'sdk/dotnet/Bailing.Connect/BailingConnect.cs',
  ]) {
    if (!existsSync(file)) findings.push(`${file}: required SDK runtime helper missing`);
  }
}

function assertSqlMigrations() {
  const files = packageFiles().filter((file) => /^sql\/\d{3}_.+\.sql$/.test(file)).sort();
  const platformIsolationSchema = [
    { name: 'platform isolation table', re: /\bCREATE\s+TABLE\b[\s\S]*?\b(?:bz_)?(?:tenants|tenant_members|tenant_roles|tenant_plans|tenant_quotas|tenant_registry|platform_tenants|platform_admins|plans|subscriptions|billing_accounts)\b/i },
    { name: 'platform isolation column', re: /\bADD\s+COLUMN\s+`?tenant_id`?\b/i },
    { name: 'platform isolation index', re: /\b(?:KEY|INDEX|CONSTRAINT)\b[\s\S]{0,160}\btenant_id\b/i },
  ];
  const seen = new Set();
  for (const file of files) {
    const num = file.slice(4, 7);
    if (seen.has(num)) findings.push(`sql: duplicate migration number ${num}`);
    seen.add(num);
    const text = readText(file);
    const destructive = [
      /\bDROP\s+(?:COLUMN|TABLE)\b/i,
      /\bRENAME\s+(?:TABLE|COLUMN)\b/i,
      /\bALTER\s+TABLE\b[\s\S]*?\bMODIFY\b/i,
      /\bTRUNCATE\b/i,
    ];
    if (destructive.some((re) => re.test(text))) {
      findings.push(`${file}: destructive schema statement is not allowed in the open-source baseline`);
    }
    if (/v\d+\s*签名|v\d+\s*验签/.test(text)) {
      findings.push(`${file}: use sha256= signature wording, not versioned signature wording`);
    }
    for (const rule of platformIsolationSchema) {
      if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay in private migrations`);
    }
  }
}

function packageFiles() {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) && parsed[0]?.files ? parsed[0].files.map((f) => String(f.path ?? '')) : [];
}

const rx = (parts, flags = '') => new RegExp(parts.join(''), flags);

assertPackageMetadata();
assertRepoEntrance();
assertSdkMetadata();
assertSqlMigrations();

const packName = execFileSync('npm', ['pack', '--silent'], { encoding: 'utf8' }).trim();
function readPackageFile(path) {
  return execFileSync('tar', ['-xOf', packName, `package/${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
try {
  const files = packageFiles();
  const forbiddenPrefixes = [
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
  const forbiddenFiles = new Set(['config.json', '.env']);
  for (const file of files) {
    if (forbiddenFiles.has(file) || forbiddenPrefixes.some((prefix) => file.startsWith(prefix)) || file.includes('.bak.')) {
      findings.push(`package must not include ${file}`);
    }
    if (/^bailinghub-.*\.tgz$/.test(file)) {
      findings.push(`package must not include generated package tarball ${file}`);
    }
  }

  const textFiles = files.filter((file) => /\.(?:md|ts|tsx|js|mjs|json|sql|php|py|vue|html|css|sh|yml|yaml|txt)$/.test(file));
  const banned = [
    { name: 'local machine path', re: rx(['/Users/', 'macmini', '|', '项目', '\\/www']) },
    { name: 'known leaked password', re: rx(['Nie', '0712', '\\.\\.']) },
    { name: 'known managed MySQL host', re: rx(['sh-', 'cynosdb', 'mysql', '-[A-Za-z0-9.-]+', 'tencent', 'cdb\\.com']) },
    { name: 'known internal git token', re: rx(['pt', '-[A-Za-z0-9_-]{20,}']) },
    { name: 'GitHub PAT', re: rx(['github', '_pat', '_[A-Za-z0-9_]+']) },
    { name: 'old official domain', re: rx(['bailing\\.', 'bnopen', '\\.cn', '|', 'bnopen', '\\.cn']) },
    { name: 'legacy internal bucket example', re: /bainiancloud-\d+/ },
  ];
  const forbiddenPublicWording = new RegExp([
    '商业' + '版',
    '商业' + '扩展',
    '商业' + '仓',
    '\\b[Cc]om' + 'mercial\\b',
  ].join('|'));
  const privateImplementationText = [
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
  for (const file of textFiles) {
    let text = '';
    try {
      text = readPackageFile(file);
    } catch {
      continue;
    }
    for (const rule of banned) {
      if (rule.re.test(text)) findings.push(`${file}: ${rule.name}`);
    }
    if (file !== 'LICENSE' && forbiddenPublicWording.test(text)) {
      findings.push(`${file}: use neutral public wording for private extension boundaries`);
    }
    if (!guardScriptFiles.has(file)) {
      for (const rule of privateImplementationText) {
        if (rule.re.test(text)) findings.push(`${file}: ${rule.name} must stay out of the public package`);
      }
    }
  }
} finally {
  execFileSync('rm', ['-f', packName]);
}

if (findings.length) {
  console.error('Release audit failed:');
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

console.log('✓ release audit passed');
