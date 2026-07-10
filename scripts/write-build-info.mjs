import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const info = {
  app: {
    name: pkg.name ?? 'bailinghub',
    version: pkg.version ?? '0.0.0',
  },
  build: {
    commit: process.env.BAILING_BUILD_COMMIT || process.env.GITHUB_SHA || git(['rev-parse', '--short=12', 'HEAD']),
    branch: process.env.BAILING_BUILD_BRANCH || git(['rev-parse', '--abbrev-ref', 'HEAD']),
    build_time: process.env.BAILING_BUILD_TIME || new Date().toISOString(),
  },
};

writeFileSync(join(root, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`✓ build-info.json written (${info.app.name}@${info.app.version}, ${info.build.commit ?? 'no-commit'})`);
