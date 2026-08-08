import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const STABLE_VERSION_RE = /^\d+\.\d+\.\d+$/;

export const releaseConsistencyFiles = [
  'package.json',
  'package-lock.json',
  'docker-compose.images.yml',
  'scripts/install.sh',
  'scripts/check-image-tags.sh',
  'scripts/publish-images.sh',
  'docs/INDEPENDENT_VALIDATION.md',
  'docs/INDEPENDENT_VALIDATION.en.md',
  '.github/ISSUE_TEMPLATE/independent_validation.yml',
  'README.md',
  'README.en.md',
  'docs/README.md',
  'docs/README.en.md',
  'docs/CHANGELOG.md',
  'docs/CHANGELOG.en.md',
  'scripts/check-doc-links.mjs',
  'scripts/release-audit.mjs',
  'scripts/verify-github-repo.mjs',
];

function readText(root, relativePath, findings) {
  const absolutePath = resolve(root, relativePath);
  if (!existsSync(absolutePath)) {
    findings.push(`${relativePath}: required release file is missing`);
    return '';
  }
  return readFileSync(absolutePath, 'utf8');
}

function readJson(root, relativePath, findings) {
  const text = readText(root, relativePath, findings);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    findings.push(`${relativePath}: invalid JSON (${error.message})`);
    return {};
  }
}

function normalizeExpectedVersion(value) {
  if (!value) return '';
  return String(value).trim().replace(/^v/, '');
}

function currentStableVersion(changelog, findings) {
  const version = extractSingleVersion(
    changelog,
    /^## v(?<version>\d+\.\d+\.\d+) /m,
    'docs/CHANGELOG.md',
    'current stable release entry',
    findings,
  );
  if (version && !STABLE_VERSION_RE.test(version)) {
    findings.push(`docs/CHANGELOG.md: current stable release entry must be semantic, received ${version}`);
  }
  return version;
}

function extractSingleVersion(text, regex, file, label, findings) {
  const match = text.match(regex);
  if (!match?.groups?.version) {
    findings.push(`${file}: cannot find ${label}`);
    return '';
  }
  return match.groups.version;
}

function expectVersion(actual, expected, file, label, findings) {
  if (!actual) return;
  if (actual !== expected) {
    findings.push(`${file}: ${label} is ${actual}, expected ${expected}`);
  }
}

function expectContains(text, expected, file, label, findings) {
  if (!text.includes(expected)) {
    findings.push(`${file}: missing ${label} (${expected})`);
  }
}

export function checkReleaseConsistency({ root = process.cwd(), expected = '' } = {}) {
  const findings = [];
  const pkg = readJson(root, 'package.json', findings);
  const version = String(pkg.version ?? '').trim();
  const isPrerelease = version.includes('-');
  const publishTag = String(pkg.publishConfig?.tag ?? '').trim();

  if (!VERSION_RE.test(version)) {
    findings.push(`package.json: version must be semantic, received ${version || '<empty>'}`);
  }

  if (isPrerelease && publishTag !== 'next') {
    findings.push(
      `package.json: prerelease versions must use publishConfig.tag "next", received ${publishTag || '<empty>'}`,
    );
  }
  if (!isPrerelease && publishTag && publishTag !== 'latest') {
    findings.push(
      `package.json: stable versions may only use publishConfig.tag "latest" or omit it, received ${publishTag}`,
    );
  }

  const expectedVersion = normalizeExpectedVersion(
    expected
      || (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : ''),
  );
  if (expectedVersion && expectedVersion !== version) {
    findings.push(`release ref: expected ${expectedVersion}, package.json declares ${version || '<empty>'}`);
  }

  const lock = readJson(root, 'package-lock.json', findings);
  expectVersion(String(lock.version ?? ''), version, 'package-lock.json', 'top-level version', findings);
  expectVersion(String(lock.packages?.['']?.version ?? ''), version, 'package-lock.json', 'root package version', findings);

  const changelog = readText(root, 'docs/CHANGELOG.md', findings);
  const stableVersion = isPrerelease ? currentStableVersion(changelog, findings) : version;

  const compose = readText(root, 'docker-compose.images.yml', findings);
  for (const image of ['bailinghub', 'bailing-demo-business']) {
    const escaped = image.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const imageVersion = extractSingleVersion(
      compose,
      new RegExp(`${escaped}:(?<version>\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)`),
      'docker-compose.images.yml',
      `${image} default image tag`,
      findings,
    );
    expectVersion(imageVersion, stableVersion, 'docker-compose.images.yml', `${image} default image tag`, findings);
  }

  const fallbackChecks = [
    {
      file: 'scripts/install.sh',
      regex: /\[\s+-n\s+"\$IMAGE_TAG"\s+\]\s+\|\|\s+IMAGE_TAG="(?<version>[^"]+)"/,
      label: 'installer fallback version',
    },
    {
      file: 'scripts/check-image-tags.sh',
      regex: /\[\s+-n\s+"\$TAG"\s+\]\s+\|\|\s+TAG="(?<version>[^"]+)"/,
      label: 'image-check fallback version',
    },
    {
      file: 'scripts/publish-images.sh',
      regex: /\[\s+-n\s+"\$TAG"\s+\]\s+\|\|\s+TAG="(?<version>[^"]+)"/,
      label: 'image-publish fallback version',
    },
  ];
  for (const check of fallbackChecks) {
    const text = readText(root, check.file, findings);
    const actual = extractSingleVersion(text, check.regex, check.file, check.label, findings);
    expectVersion(actual, stableVersion, check.file, check.label, findings);
  }

  for (const [file, baselineText] of [
    ['docs/INDEPENDENT_VALIDATION.md', `稳定基线：\`v${stableVersion}\``],
    ['docs/INDEPENDENT_VALIDATION.en.md', `Stable baseline: \`v${stableVersion}\``],
  ]) {
    const text = readText(root, file, findings);
    expectContains(text, baselineText, file, 'current validation baseline', findings);
    expectContains(text, `--branch v${stableVersion}`, file, 'current validation clone command', findings);
    expectContains(text, `RELEASE_NOTES_v${stableVersion}`, file, 'current release-note link', findings);
  }

  const issueTemplate = readText(root, '.github/ISSUE_TEMPLATE/independent_validation.yml', findings);
  expectContains(
    issueTemplate,
    `placeholder: "v${stableVersion};`,
    '.github/ISSUE_TEMPLATE/independent_validation.yml',
    'current validation placeholder',
    findings,
  );

  const releaseNotes = [
    `docs/RELEASE_NOTES_v${stableVersion}.md`,
    `docs/RELEASE_NOTES_v${stableVersion}.en.md`,
  ];
  for (const file of releaseNotes) {
    readText(root, file, findings);
  }

  const referenceChecks = [
    ['README.md', `docs/RELEASE_NOTES_v${stableVersion}.md`],
    ['README.en.md', `docs/RELEASE_NOTES_v${stableVersion}.en.md`],
    ['docs/README.md', `RELEASE_NOTES_v${stableVersion}.md`],
    ['docs/README.md', `RELEASE_NOTES_v${stableVersion}.en.md`],
    ['docs/README.en.md', `RELEASE_NOTES_v${stableVersion}.md`],
    ['docs/README.en.md', `RELEASE_NOTES_v${stableVersion}.en.md`],
    ['docs/CHANGELOG.md', `## v${stableVersion} `],
    ['docs/CHANGELOG.en.md', `## v${stableVersion} `],
    ['scripts/check-doc-links.mjs', `docs/RELEASE_NOTES_v${stableVersion}.md`],
    ['scripts/release-audit.mjs', `docs/RELEASE_NOTES_v${stableVersion}.md`],
    ['scripts/verify-github-repo.mjs', `docs/RELEASE_NOTES_v${stableVersion}.md`],
  ];
  for (const [file, expectedText] of referenceChecks) {
    const text = readText(root, file, findings);
    expectContains(text, expectedText, file, 'current release reference', findings);
  }

  return { version, stableVersion, expectedVersion, isPrerelease, publishTag, findings };
}

function parseExpected(argv) {
  const index = argv.indexOf('--expected');
  if (index === -1) return '';
  return argv[index + 1] ?? '';
}

function runCli() {
  const result = checkReleaseConsistency({ expected: parseExpected(process.argv.slice(2)) });
  if (result.findings.length > 0) {
    console.error(`Release consistency check failed for ${result.version || '<unknown>'}:`);
    for (const finding of result.findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  const ref = result.expectedVersion ? `, release ref ${result.expectedVersion}` : '';
  const channel = result.isPrerelease
    ? `, stable release surface ${result.stableVersion}, npm tag ${result.publishTag}`
    : `, npm tag ${result.publishTag || 'latest (default)'}`;
  console.log(`Release consistency check passed for ${result.version}${channel}${ref}.`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) runCli();
