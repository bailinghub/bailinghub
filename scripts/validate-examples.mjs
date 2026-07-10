import { existsSync, readFileSync } from 'node:fs';

const findings = [];

function read(file) {
  if (!existsSync(file)) {
    findings.push(`${file}: missing`);
    return '';
  }
  return readFileSync(file, 'utf8');
}

function parseJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (e) {
    findings.push(`${file}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
    return {};
  }
}

function requireIncludes(file, text, needle) {
  if (!text.includes(needle)) findings.push(`${file}: missing ${needle}`);
}

const pkg = parseJson('package.json');
const config = parseJson('config.example.json');
const env = read('.env.example');
const compose = read('docker-compose.yml');
const composeImages = read('docker-compose.images.yml');
const install = read('scripts/install.sh');

if (pkg.name !== 'bailinghub') findings.push('package.json: name must be bailinghub');
if (!/^\d+\.\d+\.\d+/.test(String(pkg.version ?? ''))) findings.push('package.json: version must be semver-like');

if (config.state?.backend !== 'jsonl') findings.push('config.example.json: state.backend must default to jsonl');
if (config.server?.port !== 18900) findings.push('config.example.json: server.port must default to 18900');

for (const key of [
  'BAILING_PUBLIC_PORT=18900',
  'BAILING_DEMO_PUBLIC_PORT=19080',
  'BAILING_MYSQL_PUBLIC_PORT=3307',
  'BAILING_MYSQL_CONNECTION_LIMIT=15',
  'BAILING_JSON_BODY_MAX_BYTES=1048576',
  'BAILING_SHUTDOWN_DRAIN_MS=30000',
  'BAILING_INSTALL_MODE=image',
  'BAILING_SKIP_PORT_CHECK=0',
  'BAILING_ALLOW_UNTESTED_ARCH=0',
]) {
  requireIncludes('.env.example', env, key);
}

for (const [file, text] of [
  ['docker-compose.yml', compose],
  ['docker-compose.images.yml', composeImages],
]) {
  requireIncludes(file, text, '${BAILING_PUBLIC_PORT:-18900}:18900');
  requireIncludes(file, text, '${BAILING_DEMO_PUBLIC_PORT:-19080}:19080');
  requireIncludes(file, text, '${BAILING_MYSQL_PUBLIC_PORT:-3307}:3306');
  requireIncludes(file, text, 'BAILING_STATE_BACKEND: mysql');
  requireIncludes(file, text, 'BAILING_SEED_DEMO: "1"');
  if (/bailing\.bnopen\.cn/.test(text)) findings.push(`${file}: must not reference self-hosted internal instance`);
}

if (String(pkg.version ?? '') && !composeImages.includes(`bailinghub:${pkg.version}`)) {
  findings.push('docker-compose.images.yml: default bailinghub image tag must match package version');
}
if (String(pkg.version ?? '') && !composeImages.includes(`bailing-demo-business:${pkg.version}`)) {
  findings.push('docker-compose.images.yml: default demo image tag must match package version');
}

for (const required of [
  'https://www.bailinghub.com/connect/bailinghub-source.tgz',
  'preflight_environment',
  'preflight_docker',
  'preflight_images',
  'BAILING_SKIP_PORT_CHECK',
  'BAILING_ALLOW_UNTESTED_ARCH',
]) {
  requireIncludes('scripts/install.sh', install, required);
}

if (findings.length) {
  console.error('Example validation failed:');
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

console.log('✓ example validation passed');
