import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { BAILINGHUB_CORE_ARTIFACT_V1 as artifact } from '../kernel-api/v1/artifact';
import { checkReadinessFor } from '../app/readiness';
import { handleAdminApiFor, type AdminApiDeps } from './admin';

const checkedAt = '2026-01-01T01:02:03.000Z';
function fixture(fault: 'none' | 'state' | 'configuration' | 'checksum' | 'connection') {
  let probes = 0;
  const db = (side: string) => ({ query: async (sql: string) => {
    probes++;
    assert.ok(sql === 'SELECT 1' || sql.startsWith('SELECT filename, checksum_sha256'), 'probe stays read-only');
    if (fault === 'connection') throw new Error('private database password and host');
    if (sql === 'SELECT 1') return [[{ one: 1 }], []];
    const rows = artifact.migrations.map(m => ({ filename: m.filename, checksum_sha256: m.checksumSha256 }));
    if (fault === side) rows.pop();
    if (fault === 'checksum' && side === 'state') rows[0]!.checksum_sha256 = '0'.repeat(64);
    return [rows, []];
  } });
  const deps = {
    cfg: { root: '/unused', state: { backend: 'mysql' } },
    configStore: { db: db('configuration') }, stateStore: { schemaReadinessDb: db('state') }, now: () => checkedAt,
  } as unknown as AdminApiDeps;
  return { deps, probes: () => probes };
}
async function request(deps: AdminApiDeps, permissions: string[] = ['audit:read']) {
  let code = 0; let body = '';
  const res = { writeHead(status: number) { code = status; }, end(chunk: string) { body += chunk; } } as unknown as ServerResponse;
  const handled = await handleAdminApiFor(deps, 'GET', '/admin/api/readiness', {} as IncomingMessage, res,
    { kind: 'admin', via: 'session', username: 'reader', permissions });
  return { handled, code, body: JSON.parse(body) };
}

for (const fault of ['none', 'state', 'configuration', 'checksum', 'connection'] as const) {
  test(`console readiness agrees with runtime readiness (${fault}) and timestamps its report`, async () => {
    const { deps } = fixture(fault);
    const expected = await checkReadinessFor(deps.cfg, deps.configStore, deps.stateStore);
    const result = await request(deps);
    assert.equal(result.handled, true);
    assert.equal(result.code, 200, 'a failed probe is a report, not a failed request');
    assert.deepEqual(result.body, { ...expected, checked_at: checkedAt });
    assert.equal(result.body.ready, fault === 'none');
    assert.doesNotMatch(JSON.stringify(result.body), /password|private database/);
  });
}
test('readiness requires audit:read and denied requests do not query stores', async () => {
  const f = fixture('none');
  const result = await request(f.deps, ['runs:read']);
  assert.equal(result.code, 403);
  assert.equal(f.probes(), 0);
});
