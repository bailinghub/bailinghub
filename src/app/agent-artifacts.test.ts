import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readAgentArtifact, uploadAgentArtifact } from './agent-artifacts';
import type { AgentToolAuthContext } from './agent-tool-invocations';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentArtifactRecord } from '../infrastructure/config/config-agent-artifact-repository';
import { AgentArtifactRepository } from '../infrastructure/config/config-agent-artifact-repository';
import { localStorageBucket, putObject } from '../adapters/storage/object-storage';
import { rowStorageBucket } from '../core/config/config-codec';

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4mQAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(png).digest('hex');
const uid = 'a'.repeat(64);
export function artifactFixture() {
  const records = new Map<string, AgentArtifactRecord>();
  const session = { session_id: '123e4567-e89b-42d3-a456-426614174000', client_app_id: 'example-shop', principal: { id: 'operator', roles: [] }, allowed_routes: ['shop'], on_behalf_of: 'tenant:operator' };
  const auth = { session, client: { app_id: 'example-shop', allowed_routes: ['shop'], enabled: true } } as unknown as AgentToolAuthContext;
  const route = { route_key: 'shop', enabled: true, agent_client: { enabled: true, artifact_upload: { enabled: true, bucket: 'media', max_bytes: 6291456 } } };
  const bucket = { ...localStorageBucket('https://hub.example.com'), name: 'media' };
  const counters = { puts: 0, ready: 0, loseCommit: false };
  const store = { routes: { get: async (key: string) => key === 'shop' ? route : null }, storageBuckets: { get: async () => bucket },
    agentArtifacts: { get: async (s: string, id: string) => records.get(s + id) ?? null,
      reserve: async (r: AgentArtifactRecord) => { const key = r.session_id + r.upload_id; if (!records.has(key)) records.set(key, r); return records.get(key)!; },
      ready: async (s: string, id: string, url: string) => { if (counters.loseCommit) throw new Error('simulated commit failure'); counters.ready++; Object.assign(records.get(s + id)!, { state: 'ready', url }); },
    },
  } as unknown as ConfigStoreContract;
  const metadata = { name: 'generated.png', mime: 'image/png', bytes: png.length, sha256, client_conversation_id: 'conversation-one', client_turn_id: 'turn-one' };
  const deps = { configStore: store, put: async (...args: Parameters<typeof putObject>) => { counters.puts++; return `${args[0].public_base_url}/${args[1]}`; } };
  return { auth, route, bucket, store, records, counters, metadata, deps };
}
test('same upload ID recovers saved receipt after lost ACK; no extra object or business write', async () => {
  const fx = artifactFixture();
  const first = await uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png);
  const recovered = await readAgentArtifact(fx.deps, fx.auth, 'shop', uid);
  const repeated = await uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png);
  assert.deepEqual(first, recovered); assert.deepEqual(first, repeated);
  assert.equal(fx.counters.puts, 1); assert.equal(fx.records.size, 1);
  assert.equal(first.state, 'ready'); assert.ok(first.url); assert.equal('bucket_name' in first, false);
});
test('binary saved before receipt commit fails: retry writes only same bytes to same key', async () => {
  const fx = artifactFixture(); fx.counters.loseCommit = true;
  await assert.rejects(uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png), { code: 'artifact_upload_pending' });
  const key = [...fx.records.values()][0]!.object_key;
  assert.equal((await readAgentArtifact(fx.deps, fx.auth, 'shop', uid)).state, 'pending');
  fx.counters.loseCommit = false;
  await uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png);
  assert.equal([...fx.records.values()][0]!.object_key, key); assert.equal(fx.records.size, 1);
});
test('unselected route, another session, disabled upload and changed content fail closed', async () => {
  const fx = artifactFixture();
  await assert.rejects(uploadAgentArtifact(fx.deps, fx.auth, 'other', uid, fx.metadata, png), { code: 'route_not_allowed' });
  assert.equal(fx.counters.puts, 0);
  fx.route.agent_client.artifact_upload.enabled = false;
  await assert.rejects(uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png), { code: 'artifact_upload_disabled' });
  fx.route.agent_client.artifact_upload.enabled = true;
  await uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png);
  await assert.rejects(uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, { ...fx.metadata, name: 'changed.png' }, png), { code: 'artifact_conflict' });
  await assert.rejects(readAgentArtifact(fx.deps, { ...fx.auth, session: { ...fx.auth.session, session_id: 'different' } }, 'shop', uid), { code: 'artifact_not_found' });
});
test('destination changes, disabled storage and invalid bytes never silently choose another bucket', async () => {
  const fx = artifactFixture(); fx.counters.loseCommit = true;
  await assert.rejects(uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png));
  fx.bucket.path_prefix = 'changed';
  await assert.rejects(uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png), { code: 'artifact_storage_changed' });
  fx.bucket.enabled = false;
  await assert.rejects(uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png), { code: 'artifact_storage_unavailable' });
  assert.equal(fx.counters.puts, 1);
  await assert.rejects(uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, Buffer.from('bad')), { code: 'artifact_content_mismatch' });
});
test('local storage returns retrievable byte-identical image and keeps local kind when loaded', async () => {
  const fx = artifactFixture(); const root = await mkdtemp(join(tmpdir(), 'artifact-test-'));
  try {
    const result = await uploadAgentArtifact({ configStore: fx.store, root }, fx.auth, 'shop', uid, fx.metadata, png);
    const key = [...fx.records.values()][0]!.object_key;
    assert.deepEqual(await readFile(join(root, 'data/uploads', key)), png);
    assert.match(result.url!, /^https:\/\/hub.example.com\/uploads\//);
    assert.equal(rowStorageBucket({ ...fx.bucket, kind: 'local' }).kind, 'local');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('repository reserves immutable metadata and commits receipt without replacing identity', async () => {
  const queries: string[] = []; let row: any;
  const repo = new AgentArtifactRepository(() => ({ query: async (sql: string, args: any[]) => {
    queries.push(sql);
    if (sql.startsWith('INSERT') && !row) row = { record_json: args[2], state: 'pending', url: null };
    if (sql.startsWith('UPDATE')) { row.state = 'ready'; row.url = args[0]; }
    return [sql.startsWith('SELECT') ? (row ? [row] : []) : {}];
  } }));
  const fx = artifactFixture(); await uploadAgentArtifact(fx.deps, fx.auth, 'shop', uid, fx.metadata, png);
  const original = [...fx.records.values()][0]!;
  await repo.reserve(original); await repo.reserve({ ...original, object_key: 'changed' });
  await repo.ready(original.session_id, uid, 'https://cdn.example.com/image.png');
  assert.equal((await repo.get(original.session_id, uid))!.object_key, original.object_key);
  assert.equal((await repo.get(original.session_id, uid))!.state, 'ready');
  assert.ok(queries.every(q => !q.includes('DELETE')));
});
