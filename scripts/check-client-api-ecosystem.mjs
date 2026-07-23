import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const modeArg = process.argv.indexOf('--mode');
const mode = modeArg >= 0 ? process.argv[modeArg + 1] : 'local';
if (!['local', 'clone'].includes(mode)) {
  throw new Error(`unsupported mode ${mode}; expected local or clone`);
}

const registry = JSON.parse(
  readFileSync(resolve(root, 'contracts/client-api/consumers.json'), 'utf8'),
);
const contractDir = resolve(root, registry.contract_dir);
if (!existsSync(resolve(contractDir, 'manifest.json'))) {
  throw new Error(`Client API manifest not found under ${contractDir}`);
}

const tempRoot = mode === 'clone'
  ? mkdtempSync(resolve(tmpdir(), 'bailing-client-api-consumers-'))
  : null;
const coordinatedRef = process.env.BAILING_CLIENT_API_CONSUMER_REF?.trim() || '';

function remoteHasBranch(repository, branch) {
  if (!branch) return false;
  try {
    execFileSync(
      'git',
      ['ls-remote', '--exit-code', '--heads', repository, branch],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

try {
  for (const consumer of registry.consumers) {
    const repositoryRoot = mode === 'clone'
      ? resolve(tempRoot, consumer.id)
      : resolve(root, consumer.local_path);
    if (mode === 'clone') {
      const ref = coordinatedRef && remoteHasBranch(consumer.repository, coordinatedRef)
        ? coordinatedRef
        : consumer.ref;
      console.log(`\n==> ${consumer.id}: cloning ${consumer.repository} at ${ref}`);
      execFileSync(
        'git',
        ['clone', '--depth', '1', '--branch', ref, consumer.repository, repositoryRoot],
        { stdio: 'inherit' },
      );
    }
    if (!existsSync(repositoryRoot)) {
      throw new Error(`${consumer.id}: repository not found at ${repositoryRoot}`);
    }
    const [command, ...args] = consumer.checker;
    console.log(`\n==> ${consumer.id}: ${command} ${args.join(' ')}`);
    execFileSync(command, [...args, '--contract-dir', contractDir], {
      cwd: repositoryRoot,
      stdio: 'inherit',
    });
  }
  console.log(`\nPASS: all Client API consumers accept the current core contract (${mode})`);
} finally {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
}
