import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const expectedRuntimeExports = [
  'BAILINGHUB_CORE_ARTIFACT_V1',
  'KernelExecutionQueueV1',
  'createBailingHubKernel',
  'createManagedRuntimeMaintenanceStateV1',
  'loadConfig',
  'migrateBailingHubCoreSchema',
].sort();
const expectedRetiredMigrations = [
  {
    filename: '020_provider_sign_version.sql',
    checksumSha256: '9b4ed1ca632a0dcca92a768671584cbc29d09a4d6501697631d355616f15a21e',
    byteLength: 564,
    replay: 'never',
  },
  {
    filename: '021_drop_provider_sign_version.sql',
    checksumSha256: '513ba9dfe031e785da09d931405cbcf867f703b2b7a6d0ec7077719082206466',
    byteLength: 407,
    replay: 'never',
  },
  {
    filename: '037_route_tools_shape.sql',
    checksumSha256: 'da87330abb088868827445a425e30bc6928b8ee47d4aeb680784fcf8d0a11fb4',
    byteLength: 1181,
    replay: 'never',
  },
];

const requiredFiles = [
  'package.json',
  'src/app/kernel.ts',
  'src/kernel-api/v1/index.ts',
  'src/kernel-api/v1/contracts.ts',
  'src/kernel-api/v1/execution-gate.ts',
  'src/kernel-api/v1/artifact.ts',
  'src/infrastructure/schema/core-schema-migrator.ts',
  'src/infrastructure/schema/retired-migrations.ts',
  'sql/001_init_state.sql',
  'sql/053_tool_spec_access_policy.sql',
  'web/console/index.html',
  'web/widget/widget.js',
];

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'silent' },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} exited ${result.status}`);
  }
  return result.stdout;
}

function parsePackManifest(stdout) {
  // npm forwards prepack lifecycle output before the final JSON array even
  // with --silent, so locate the array instead of assuming stdout is pure JSON.
  const jsonStart = stdout.search(/(?:^|\n)\[\s*\{/);
  if (jsonStart < 0) throw new Error('JSON array not found');
  const payload = JSON.parse(stdout.slice(stdout.indexOf('[', jsonStart)));
  const manifest = Array.isArray(payload) ? payload[0] : undefined;
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error('npm pack 没有返回完整文件清单');
  }
  return manifest;
}

function consumerSmokeSource(expectedVersion) {
  return `
import assert from 'node:assert/strict';

const expectedExports = ${JSON.stringify(expectedRuntimeExports)};
const api = await import('bailinghub/kernel-api/v1');
assert.deepEqual(Object.keys(api).sort(), expectedExports, 'Kernel Host API runtime export snapshot drifted');

const hostConfig = api.loadConfig({ mode: 'kernel-host' });
assert.notEqual(hostConfig.root, process.cwd(), 'Kernel Host config must not treat consumer cwd as Core root');
assert.equal(hostConfig.server.token, '', 'Kernel Host defaults must not inherit a standalone server token');

const manifest = api.BAILINGHUB_CORE_ARTIFACT_V1;
assert.equal(manifest.packageName, 'bailinghub');
assert.equal(manifest.version, ${JSON.stringify(expectedVersion)});
assert.ok(Array.isArray(manifest.migrations) && manifest.migrations.length > 0);
assert.equal(manifest.latestMigration, manifest.migrations.at(-1)?.filename);
assert.deepEqual(manifest.retiredMigrations, ${JSON.stringify(expectedRetiredMigrations)});
assert.match(manifest.manifestSha256, /^[a-f0-9]{64}$/);
const activeMigrationNames = new Set(manifest.migrations.map((migration) => migration.filename));
for (const migration of manifest.migrations) {
  assert.match(migration.filename, /^\\d{3}_.+\\.sql$/);
  assert.match(migration.checksumSha256, /^[a-f0-9]{64}$/);
}
for (const migration of manifest.retiredMigrations) {
  assert.equal(activeMigrationNames.has(migration.filename), false);
  assert.equal(migration.replay, 'never');
}
assert.equal(typeof api.migrateBailingHubCoreSchema, 'function');

await assert.rejects(
  import('bailinghub/src/app/kernel'),
  (error) => error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'package exports must block direct imports of Core internals',
);
`;
}

const tempRoot = mkdtempSync(join(tmpdir(), 'bailinghub-package-artifact-'));
try {
  const packDirectory = join(tempRoot, 'pack');
  mkdirSync(packDirectory);
  const packedOutput = run(
    npmCommand,
    ['pack', '--json', '--silent', '--pack-destination', packDirectory],
    root,
  );
  const manifest = parsePackManifest(packedOutput);

  const files = new Set(manifest.files.map((item) => String(item.path ?? '')));
  const missing = requiredFiles.filter((file) => !files.has(file));
  if (missing.length > 0) {
    throw new Error(`npm Core artifact 缺少运行所需文件：${missing.join(', ')}`);
  }

  const tarballName = String(manifest.filename ?? '');
  if (basename(tarballName) !== tarballName || !/^bailinghub-[0-9A-Za-z_.-]+\.tgz$/.test(tarballName)) {
    throw new Error('npm pack 返回了不安全的制品文件名');
  }
  const tarballPath = join(packDirectory, tarballName);
  if (!existsSync(tarballPath)) throw new Error(`npm pack 未生成制品：${tarballName}`);

  const tsxVersion = packageJson.dependencies?.tsx;
  if (typeof tsxVersion !== 'string' || tsxVersion.length === 0) {
    throw new Error('package.json 必须把 tsx 声明为 Core 的运行依赖');
  }
  const consumerDirectory = join(tempRoot, 'consumer');
  mkdirSync(consumerDirectory);
  writeFileSync(join(consumerDirectory, 'package.json'), `${JSON.stringify({
    name: 'bailinghub-package-artifact-consumer',
    private: true,
    type: 'module',
    dependencies: {
      bailinghub: pathToFileURL(tarballPath).href,
      tsx: tsxVersion,
    },
  }, null, 2)}\n`);
  run(
    npmCommand,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    consumerDirectory,
  );
  run(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', consumerSmokeSource(String(manifest.version ?? ''))],
    consumerDirectory,
  );

  console.log(
    `✓ npm Core artifact passed (${manifest.entryCount ?? manifest.files.length} files, ` +
    `${requiredFiles.length} required files, ${expectedRuntimeExports.length} stable runtime exports)`,
  );
} catch (error) {
  console.error('npm Core artifact check failed', error);
  process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
