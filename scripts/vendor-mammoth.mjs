import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const upstream = Object.freeze({
  name: 'mammoth', version: '1.12.0',
  tarball: 'https://registry.npmjs.org/mammoth/-/mammoth-1.12.0.tgz',
  integrity: 'sha512-cwnK1RIcRdDMi2HRx2EXGYlxqIEh0Oo3bLhorgnsVJi2UkbX1+jKxuBNR9PC5+JaX7EkmJxFPmo6mjLpqShI2w==',
});
const root = fileURLToPath(new URL('../', import.meta.url));
const vendor = 'vendor/mammoth-library';
const archiveName = 'bailinghub-mammoth-library-1.12.0-bailinghub.1.tgz';
const distributionPath = 'vendor/mammoth-library-distribution.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonText = value => `${JSON.stringify(value, null, 2)}\n`;

function filesUnder(path, prefix = '') {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${prefix}${entry.name}`);
    return entry.isDirectory() ? filesUnder(join(path, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`];
  }).sort();
}

// npm/gzip versions can encode identical files differently across platforms.
// Pin the distributed bytes, then verify their complete unpacked contents.
function checkArchive(directory, archive) {
  const temporary = mkdtempSync(join(tmpdir(), 'mammoth-archive-check-'));
  try {
    const expected = filesUnder(directory);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(entries, expected.map(file => `package/${file}`).sort(), 'Archive file inventory changed');
    const details = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert(details.every(line => line.startsWith('-')), 'Archive must contain only regular files');
    execFileSync('tar', ['-xzf', archive, '-C', temporary]);
    for (const file of expected) {
      assert.equal(digest(readFileSync(join(temporary, 'package', file))), digest(readFileSync(join(directory, file))), `Archive content differs: ${file}`);
    }
  } catch (error) { throw new Error(`Library archive does not match the reviewed source: ${error.message}`); }
  finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function libraryManifest(original) {
  const manifest = structuredClone(original);
  Object.assign(manifest, {
    name: '@bailinghub/mammoth-library', version: '1.12.0-bailinghub.1', private: true,
    description: 'BailingHub library-only distribution of Mammoth 1.12.0; no command-line interface',
  });
  for (const key of ['bin', 'scripts', 'devDependencies', 'volta']) delete manifest[key];
  delete manifest.dependencies.argparse;
  return manifest;
}

export function checkVendor(base = root) {
  const directory = join(base, vendor);
  const source = JSON.parse(readFileSync(join(directory, 'SOURCE.json'), 'utf8'));
  assert.deepEqual(source.upstream, upstream, 'Unexpected upstream identity');
  const actualFiles = filesUnder(directory).filter(file => file !== 'SOURCE.json');
  assert.deepEqual(actualFiles, Object.keys(source.files).sort(), 'Vendor file inventory changed');
  for (const file of actualFiles) assert.equal(digest(readFileSync(join(directory, file))), source.files[file], `Vendor source changed: ${file}`);
  const original = JSON.parse(readFileSync(join(directory, 'upstream-package.json'), 'utf8'));
  assert.equal(readFileSync(join(directory, 'package.json'), 'utf8'), jsonText(libraryManifest(original)), 'Library manifest is not the reviewed transformation');
  assert(actualFiles.every(file => /^(?:lib\/|browser\/|LICENSE$|package\.json$|upstream-package\.json$)/.test(file)), 'Non-library upstream file included');
  const distribution = JSON.parse(readFileSync(join(base, distributionPath), 'utf8'));
  assert.equal(distribution.file, archiveName, 'Unexpected library archive');
  assert.equal(digest(readFileSync(join(base, 'vendor', archiveName))), distribution.sha256, 'Library archive changed');
  checkArchive(directory, join(base, 'vendor', archiveName));
  const core = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'));
  const console = JSON.parse(readFileSync(join(base, 'web-admin/package.json'), 'utf8'));
  assert.equal(core.dependencies.mammoth, `file:vendor/${archiveName}`);
  assert.equal(console.dependencies.mammoth, `file:../vendor/${archiveName}`);
  assert.deepEqual(core.bundleDependencies, ['mammoth'], 'Core must bundle only the local library for npm consumers');
  const archiveIntegrity = `sha512-${createHash('sha512').update(readFileSync(join(base, 'vendor', archiveName))).digest('base64')}`;
  for (const [file, manifest] of [['package-lock.json', core], ['web-admin/package-lock.json', console]]) {
    const lock = JSON.parse(readFileSync(join(base, file), 'utf8'));
    const entry = lock.packages?.['node_modules/mammoth'];
    assert.equal(entry?.name, '@bailinghub/mammoth-library', `${file}: unexpected DOCX package`);
    assert.equal(entry?.version, '1.12.0-bailinghub.1', `${file}: unexpected DOCX version`);
    assert.equal(entry?.resolved, manifest.dependencies.mammoth, `${file}: unexpected DOCX source`);
    assert.equal(entry?.integrity, archiveIntegrity, `${file}: DOCX archive integrity mismatch`);
  }
  return { upstream, retainedFiles: actualFiles.length, package: libraryManifest(original).name };
}

async function upstreamFiles() {
  const response = await fetch(upstream.tarball, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Upstream download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, upstream.integrity, 'Upstream tarball integrity mismatch');
  const temporary = mkdtempSync(join(tmpdir(), 'mammoth-upstream-'));
  try {
    const archive = join(temporary, 'upstream.tgz');
    writeFileSync(archive, bytes);
    execFileSync('tar', ['-xzf', archive, '-C', temporary, 'package/lib', 'package/browser', 'package/LICENSE', 'package/package.json']);
    const extracted = join(temporary, 'package');
    const files = Object.fromEntries(filesUnder(extracted).map(file => [file, readFileSync(join(extracted, file))]));
    delete files['lib/main.js']; // CLI output handler is not part of this library distribution.
    files['upstream-package.json'] = files['package.json'];
    files['package.json'] = Buffer.from(jsonText(libraryManifest(JSON.parse(files['package.json']))));
    return files;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] ?? '--check';
  if (!['--check', '--verify-upstream', '--refresh'].includes(mode)) throw new Error('Expected --check, --verify-upstream or --refresh');
  if (mode !== '--check') {
    const files = await upstreamFiles();
    if (mode === '--refresh') {
      if (existsSync(join(root, vendor))) checkVendor();
      for (const [file, bytes] of Object.entries(files)) {
        const target = join(root, vendor, file);
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
      }
      writeFileSync(join(root, vendor, 'SOURCE.json'), jsonText({
        upstream,
        modification: 'Retain unmodified library/browser source and license; omit CLI, build/test files and argparse dependency. Custom package metadata only.',
        files: Object.fromEntries(Object.keys(files).sort().map(file => [file, digest(files[file])])),
      }));
      execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', join(root, 'vendor')], { cwd: join(root, vendor), stdio: 'pipe' });
      writeFileSync(join(root, distributionPath), jsonText({ file: archiveName, sha256: digest(readFileSync(join(root, 'vendor', archiveName))) }));
    } else {
      for (const [file, bytes] of Object.entries(files)) assert.equal(digest(readFileSync(join(root, vendor, file))), digest(bytes), `Upstream differs: ${file}`);
    }
  }
  console.log(JSON.stringify(checkVendor(), null, 2));
}
