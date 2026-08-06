import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER_TAG_RE = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseRequestedLatest(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('requested latest must be empty, true, or false');
}

function normalizeReleaseTag(value) {
  const raw = String(value ?? '');
  const match = SEMVER_TAG_RE.exec(raw);
  if (!match) throw new Error(`image tag must be an exact semantic version: ${raw || '<empty>'}`);
  const prerelease = match[4] ?? '';
  if (prerelease.split('.').some((identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier))) {
    throw new Error(`image tag has an invalid numeric prerelease identifier: ${raw}`);
  }
  return {
    tag: `${match[1]}.${match[2]}.${match[3]}${prerelease ? `-${prerelease}` : ''}`,
    prerelease: prerelease.length > 0,
  };
}

export function resolveImageReleasePolicy({ tag, requestedLatest } = {}) {
  const release = normalizeReleaseTag(tag);
  const requested = parseRequestedLatest(requestedLatest);
  return Object.freeze({
    tag: release.tag,
    prerelease: release.prerelease,
    // A prerelease can never move the stable channel, even if a manual run asks for it.
    pushLatest: release.prerelease ? false : (requested ?? true),
  });
}

function readCliFlag(argv, name) {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may only be provided once`);
  if (indexes.length === 0) return undefined;
  const value = argv[indexes[0] + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function runCli() {
  const argv = process.argv.slice(2);
  const known = new Set(['--tag', '--requested-latest']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name || !known.has(name)) throw new Error(`unknown image release policy argument: ${name ?? '<empty>'}`);
    if (index + 1 >= argv.length) throw new Error(`${name} requires a value`);
  }
  const result = resolveImageReleasePolicy({
    tag: readCliFlag(argv, '--tag'),
    requestedLatest: readCliFlag(argv, '--requested-latest'),
  });
  process.stdout.write([
    `tag=${result.tag}`,
    `prerelease=${String(result.prerelease)}`,
    `push_latest=${String(result.pushLatest)}`,
    '',
  ].join('\n'));
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry && fileURLToPath(import.meta.url) === entry) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
