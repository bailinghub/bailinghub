import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const supportedSdks = ['php', 'php7'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function run(command, args) {
  const result = spawnSync(command, args, { maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status}: ${String(result.stderr || result.stdout).slice(0, 8000)}`);
  }
  return result.stdout;
}

function sourceFiles(root, relative = '') {
  const files = [];
  for (const name of readdirSync(join(root, relative)).sort()) {
    if (/[\r\n\\]/.test(name)) throw new Error(`Unsupported SDK filename: ${JSON.stringify(name)}`);
    const path = relative ? `${relative}/${name}` : name;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`SDK source symlinks are not allowed: ${path}`);
    if (stat.isDirectory()) files.push(...sourceFiles(root, path));
    else if (stat.isFile()) files.push(path);
    else throw new Error(`SDK source contains a non-regular file: ${path}`);
  }
  return files.sort();
}

function lines(output) {
  const result = String(output).split('\n');
  if (result.at(-1) === '') result.pop();
  return result;
}

function archiveFiles(archive, prefix) {
  const names = lines(run('tar', ['-tzf', archive]));
  const details = lines(run('tar', ['-tvzf', archive]));
  if (names.length !== details.length) throw new Error('Archive listing and file types do not agree');
  const seen = new Set();
  const files = [];
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!normalized || /[\r\n\\]/.test(normalized)
      || posix.normalize(normalized) !== normalized
      || (normalized !== prefix && !normalized.startsWith(`${prefix}/`))) {
      throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
    }
    if (seen.has(normalized)) throw new Error(`Duplicate archive path: ${name}`);
    seen.add(normalized);
    const type = details[index]?.[0];
    if (type !== '-' && type !== 'd') throw new Error(`Archive links or special files are not allowed: ${name}`);
    if (type === '-') {
      if (normalized === prefix) throw new Error('Archive root must be a directory');
      files.push(normalized.slice(prefix.length + 1));
    }
  }
  return files.sort();
}

function regression(driver, sdkRoot, phpCommand, sdk) {
  const output = run(phpCommand, [driver, sdkRoot]);
  let result;
  try { result = JSON.parse(String(output)); }
  catch { throw new Error(`${sdk}: generator regression did not return JSON`); }
  if (result.sdk !== sdk || result.passed !== true || result.matrixCases !== 24
    || result.idempotenceCases !== 6 || !Array.isArray(result.errors) || result.errors.length !== 0
    || !Array.isArray(result.matrix) || result.matrix.length !== 24
    || !Array.isArray(result.idempotence) || result.idempotence.length !== 6
    || !Number.isInteger(result.checks) || result.checks < 100) {
    throw new Error(`${sdk}: generator regression is failed or incomplete`);
  }
  return result;
}

export function verifyPhpSdkArtifact({ root = defaultRoot, sdk, phpCommand = 'php' }) {
  if (!supportedSdks.includes(sdk)) throw new Error(`Unsupported PHP SDK: ${sdk}`);
  const source = join(root, 'sdk', sdk);
  const archiveRelative = `web/connect/bailing-connect-${sdk}.tgz`;
  const archive = join(root, archiveRelative);
  const prefix = `bailing-connect-${sdk}`;
  const expected = sourceFiles(source);
  const actual = archiveFiles(archive, prefix);
  const missing = expected.filter((file) => !actual.includes(file));
  const unexpected = actual.filter((file) => !expected.includes(file));
  if (missing.length || unexpected.length) {
    throw new Error(`${sdk}: archive file set differs from source; missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`);
  }

  const temp = mkdtempSync(join(tmpdir(), 'bailinghub-php-artifact-'));
  const extracted = join(temp, prefix);
  const files = [];
  try {
    for (const file of expected) {
      // Read each validated regular member to stdout, then write only our own
      // source-derived paths. Never let tar create paths, links, or devices.
      const bytes = run('tar', ['-xOzf', archive, '--', `${prefix}/${file}`]);
      const sourceBytes = readFileSync(join(source, file));
      if (!sourceBytes.equals(bytes)) throw new Error(`${sdk}: archive bytes differ from source: ${file}`);
      files.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) });
      const destination = join(extracted, file);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes, { mode: 0o600 });
    }
    const sourceDriver = join(source, 'tests', 'declaration-serialization.php');
    const artifactDriver = join(extracted, 'tests', 'declaration-serialization.php');
    const sourceRegression = regression(sourceDriver, source, phpCommand, sdk);
    const artifactRegression = regression(artifactDriver, extracted, phpCommand, sdk);
    return {
      sdk,
      archive: archiveRelative,
      archiveSha256: sha256(readFileSync(archive)),
      fileCount: files.length,
      files,
      sourceRegression,
      artifactRegression,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function options(argv) {
  const result = { root: defaultRoot, sdks: supportedSdks, phpCommand: 'php' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = argv[++index];
    if (!value) throw new Error(`Missing value for ${arg}`);
    if (arg === '--root') result.root = resolve(value);
    else if (arg === '--sdk' && supportedSdks.includes(value)) result.sdks = [value];
    else if (arg === '--php') result.phpCommand = value;
    else throw new Error(`Unsupported argument: ${arg} ${value}`);
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { root, sdks, phpCommand } = options(process.argv.slice(2));
    const artifacts = sdks.map((sdk) => verifyPhpSdkArtifact({ root, sdk, phpCommand }));
    process.stdout.write(`${JSON.stringify({ passed: true, artifacts }, null, 2)}\n`);
  } catch (error) {
    console.error(`PHP SDK artifact check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
