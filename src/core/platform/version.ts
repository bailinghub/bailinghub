import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONTRACT_VERSIONS = {
  boundary: 'bailing.contract.v2.13',
  clientApi: 'bailing.client-api.v1',
  toolDefinition: 'bailing.tool-definition.v1',
  approvalIntent: 'bailing.approval-intent.v1',
  approvalDecision: 'bailing.approval-decision.v1',
  chatStream: 'bailing.chat.stream.v1',
  widgetApi: '1',
};

interface PackageMeta {
  name: string;
  version: string;
  private?: boolean;
}

function packageMeta(root: string): PackageMeta {
  const raw = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Partial<PackageMeta>;
  return {
    name: String(raw.name ?? 'bailinghub'),
    version: String(raw.version ?? '0.0.0'),
    private: raw.private,
  };
}

function readBuildInfo(root: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'build-info.json'), 'utf8')) as { build?: Record<string, unknown> };
    return raw.build && typeof raw.build === 'object' ? raw.build : {};
  } catch {
    return {};
  }
}

export function sqlMigrationFiles(root: string): string[] {
  return readdirSync(join(root, 'sql')).filter((f) => f.endsWith('.sql')).sort();
}

function gitValue(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function buildMeta(root: string): Record<string, unknown> {
  const fileInfo = readBuildInfo(root);
  const commit =
    process.env.BAILING_BUILD_COMMIT ||
    process.env.GITHUB_SHA ||
    (typeof fileInfo.commit === 'string' ? fileInfo.commit : null) ||
    gitValue(root, ['rev-parse', '--short=12', 'HEAD']);
  const buildTime =
    process.env.BAILING_BUILD_TIME ||
    (typeof fileInfo.build_time === 'string' ? fileInfo.build_time : null) ||
    (process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString() : null) ||
    null;
  return {
    commit,
    branch: process.env.BAILING_BUILD_BRANCH || (typeof fileInfo.branch === 'string' ? fileInfo.branch : null) || gitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    build_time: buildTime,
  };
}

export function buildVersionInfo(root: string, appliedMigrations?: string[]): Record<string, unknown> {
  const sqlFiles = sqlMigrationFiles(root);
  const applied = appliedMigrations?.slice().sort();
  return {
    app: packageMeta(root),
    build: buildMeta(root),
    runtime: {
      node: process.version,
    },
    contracts: CONTRACT_VERSIONS,
    migrations: {
      latest: sqlFiles.at(-1) ?? null,
      total: sqlFiles.length,
      ...(applied ? {
        applied: applied.length,
        latest_applied: applied.at(-1) ?? null,
        pending: sqlFiles.filter((f) => !applied.includes(f)),
      } : {}),
    },
  };
}
