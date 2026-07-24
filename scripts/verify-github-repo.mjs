import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const exportDir = join(root, '.oss-dist', 'bailinghub');
const expectedRepo = 'git+https://github.com/bailinghub/bailinghub.git';

function run(cmd, args, cwd = root) {
  console.log(`> ${[cmd, ...args].join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function output(cmd, args, cwd = root) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function requireFile(file) {
  if (!existsSync(join(exportDir, file))) throw new Error(`GitHub rehearsal missing required file: ${file}`);
}

function assertIncludes(file, needles) {
  const text = readFileSync(join(exportDir, file), 'utf8');
  for (const needle of needles) {
    if (!text.includes(needle)) throw new Error(`${file} must include: ${needle}`);
  }
}

function assertNotTracked(files, predicate, message) {
  const bad = files.filter(predicate);
  if (bad.length) throw new Error(`${message}: ${bad.slice(0, 20).join(', ')}`);
}

function assertNoInstallerEnvPrefix(files) {
  const installer = 'curl -fsSL https://www.bailinghub.com/install.sh | sh';
  const findings = [];
  for (const file of files.filter((name) => /\.(?:md|sh|html)$/.test(name))) {
    const lines = readFileSync(join(repoDir, file), 'utf8').split(/\r?\n/);
    let continuedEnv = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      const startsWithEnv = /^BAILING_[A-Z0-9_]+=/.test(line);
      if (startsWithEnv && line.includes(installer)) {
        findings.push(`${file}:${index + 1}`);
      }
      if (continuedEnv && line === installer) {
        findings.push(`${file}:${index + 1}`);
      }
      if (startsWithEnv) {
        continuedEnv = line.endsWith('\\');
      } else if (continuedEnv && line !== installer) {
        continuedEnv = false;
      }
    }
  }
  if (findings.length) {
    throw new Error(`Installer environment must be attached to sh, not curl: ${findings.slice(0, 20).join(', ')}`);
  }
}

run('npm', ['run', 'oss:export']);

const pkg = JSON.parse(readFileSync(join(exportDir, 'package.json'), 'utf8'));
if (pkg.private !== false) throw new Error('package.json private must be false for GitHub release.');
if (pkg.license !== 'Apache-2.0') throw new Error('package.json license must be Apache-2.0.');
if (pkg.repository?.url !== expectedRepo) throw new Error(`package.json repository.url must be ${expectedRepo}.`);

const requiredFiles = [
  'README.md',
  'assets/bailinghub-lockup.svg',
  'assets/bailinghub-lockup-dark.svg',
  'assets/bailinghub-lockup.png',
  'assets/bailinghub-lockup-dark.png',
  'assets/architecture-overview.zh-CN.svg',
  'assets/architecture-overview.zh-CN-dark.svg',
  'assets/architecture-overview.en.svg',
  'assets/architecture-overview.en-dark.svg',
  'assets/architecture-overview.zh-CN.png',
  'assets/architecture-overview.zh-CN-dark.png',
  'assets/architecture-overview.en.png',
  'assets/architecture-overview.en-dark.png',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.images.yml',
  '.dockerignore',
  '.gitignore',
  '.npmignore',
  '.github/workflows/ci.yml',
  '.github/workflows/images.yml',
  '.github/workflows/gitee-mirror.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml',
  '.github/pull_request_template.md',
  'scripts/install.sh',
  'scripts/publish-images.sh',
  'scripts/publish-mysql-image.sh',
  'docs/DEMO.md',
  'docs/RELEASE_NOTES_v0.1.0.md',
  'docs/RELEASE_NOTES_v0.1.1.md',
  'docs/RELEASE_NOTES_v0.1.2.md',
  'docs/RELEASE_NOTES_v0.1.3.md',
  'docs/RELEASE_NOTES_v0.1.4.md',
  'docs/RELEASE_NOTES_v0.1.5.md',
  'docs/RELEASE_NOTES_v0.1.6.md',
  'docs/RELEASE_NOTES_v0.1.7.md',
  'docs/RELEASE_NOTES_v0.1.8.md',
  'docs/CHANGELOG.md',
];
for (const file of requiredFiles) requireFile(file);

assertIncludes('README.md', [
  'assets/bailinghub-lockup.png',
  'assets/architecture-overview.zh-CN.png',
  'THIRD_PARTY_NOTICES.md',
  'https://trial.bailinghub.com/console/login',
  'issues/new?template=bug_report.yml',
  'curl -fsSL https://www.bailinghub.com/install.sh | sh',
  'BAILING_INSTALL_MODE=source',
  'crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailinghub',
  'Apache License 2.0',
]);
assertIncludes('docs/DEMO.md', ['BAILING_INSTALL_MODE=image', 'bailing-mysql:8.4', 'npm run images:publish-mysql']);
assertIncludes('.github/workflows/images.yml', ['docker/build-push-action', 'bailing-demo-business', 'bailing-mysql']);

if (existsSync(join(exportDir, '.git'))) {
  throw new Error('GitHub rehearsal source must be a history-free OSS export.');
}

const rehearsalRoot = mkdtempSync(join(tmpdir(), 'bailinghub-github-'));
const repoDir = join(rehearsalRoot, 'repo');
cpSync(exportDir, repoDir, { recursive: true });

try {
  run('git', ['init', '-q'], repoDir);
  run('git', ['config', 'user.email', 'release-check@bailinghub.local'], repoDir);
  run('git', ['config', 'user.name', 'Bailing Release Check'], repoDir);
  run('git', ['remote', 'add', 'origin', 'https://github.com/bailinghub/bailinghub.git'], repoDir);
  run('git', ['add', '.'], repoDir);
  run('git', ['commit', '-q', '-m', 'chore: rehearse github repository'], repoDir);

  const files = output('git', ['ls-files'], repoDir).trim().split(/\r?\n/).filter(Boolean);
  const fileSet = new Set(files);
  for (const file of requiredFiles) {
    if (!fileSet.has(file)) throw new Error(`GitHub rehearsal did not track required file: ${file}`);
  }

  assertNotTracked(files, (file) => file.startsWith('web/site/'), 'GitHub rehearsal must not track website');
  assertNotTracked(files, (file) => file.startsWith('web/console/'), 'GitHub rehearsal must not track console build output');
  assertNotTracked(files, (file) => file.startsWith('deploy/'), 'GitHub rehearsal must not track private deploy assets');
  assertNotTracked(files, (file) => file.startsWith('.oss-dist/'), 'GitHub rehearsal must not track release output');
  assertNotTracked(files, (file) => file === 'config.json' || file === '.env', 'GitHub rehearsal must not track local secrets');
  assertNotTracked(files, (file) => file.includes('.bak.'), 'GitHub rehearsal must not track backup files');
  assertNoInstallerEnvPrefix(files);

  const bannedParts = [
    String.raw`/Users/` + 'macmini',
    '项目' + String.raw`/www`,
    'Nie' + '0712',
    'github' + '_pat_',
    String.raw`pt-[A-Za-z0-9_-]{20,}`,
    'sh-' + 'cynosdb' + 'mysql' + String.raw`-[A-Za-z0-9.-]+` + 'tencent' + String.raw`cdb\.com`,
    'bnopen' + String.raw`\.cn`,
  ];
  const bannedText = new RegExp(`(${bannedParts.join('|')})`);
  const textFiles = files.filter((file) => /\.(?:md|ts|tsx|js|mjs|json|sql|php|py|vue|html|css|sh|yml|yaml|txt|gitignore|npmignore|dockerignore)$/.test(file));
  const findings = [];
  for (const file of textFiles) {
    const text = output('git', ['show', `:${file}`], repoDir);
    if (bannedText.test(text)) findings.push(file);
  }
  if (findings.length) {
    throw new Error(`GitHub rehearsal found private text in: ${findings.slice(0, 20).join(', ')}`);
  }

  console.log(`✓ GitHub repository rehearsal passed (${files.length} tracked files)`);
} finally {
  rmSync(rehearsalRoot, { recursive: true, force: true });
}
