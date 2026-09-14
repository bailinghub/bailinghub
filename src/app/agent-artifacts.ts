import { createHash } from 'node:crypto';
import type { StorageBucket } from '../core/contracts/types';
import { ARTIFACT_MAX_BYTES, ARTIFACT_MIMES, validateArtifactConfig } from '../core/config/artifact-config';
import { routeAgentClientConfig } from '../core/config/route-config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { AgentArtifactRecord } from '../infrastructure/config/config-agent-artifact-repository';
import { objectKey, putObject } from '../adapters/storage/object-storage';
import { AgentToolApiError, resolveAgentRouteFor, type AgentToolAuthContext } from './agent-tool-invocations';

export const ARTIFACT_SCHEMA = 'bailing.agent-artifact.v1';
export const artifactError = (status: number, code: string): never => { throw new AgentToolApiError(status, code, code); };
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const id = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
export function artifactMetadata(value: unknown): AgentArtifactRecord['metadata'] {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['client_conversation_id', 'client_turn_id', 'name', 'mime', 'bytes', 'sha256', 'run_id'].includes(k)) ||
    !id(v.client_conversation_id, 128) || !id(v.client_turn_id, 128) || !id(v.name, 128) || /[\\/]/.test(String(v.name)) ||
    !(ARTIFACT_MIMES as readonly unknown[]).includes(v.mime) || !Number.isInteger(v.bytes) || Number(v.bytes) < 1 || Number(v.bytes) > ARTIFACT_MAX_BYTES ||
    typeof v.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.sha256) || (v.run_id !== undefined && !/^[a-f0-9-]{36}$/.test(String(v.run_id)))) artifactError(400, 'artifact_invalid_request');
  return { client_conversation_id: String(v.client_conversation_id), client_turn_id: String(v.client_turn_id), name: String(v.name), mime: String(v.mime), bytes: Number(v.bytes), sha256: String(v.sha256), ...(v.run_id ? { run_id: String(v.run_id) } : {}) };
}
function storageHash(b: StorageBucket): string {
  return hash(JSON.stringify([b.name, b.kind, b.region, b.bucket, b.endpoint ?? '', b.public_base_url, b.path_prefix]));
}
function imageMatches(body: Buffer, mime: string): boolean {
  if (mime === 'image/png') return body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return body[0] === 255 && body[1] === 216 && body[2] === 255;
  return body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP';
}
function receipt(value: AgentArtifactRecord) {
  return { schema_version: ARTIFACT_SCHEMA, upload_id: value.upload_id, workspace: value.workspace,
    session_id: value.session_id, state: value.state, ...value.metadata, visibility: 'public',
    ...(value.state === 'ready' ? { url: value.url } : {}), next_action: value.state === 'ready' ? 'use_url' : 'retry_same_upload' };
}
export interface ArtifactDeps { configStore: ConfigStoreContract | null; root?: string; put?: typeof putObject }
export async function readAgentArtifact(deps: ArtifactDeps, auth: AgentToolAuthContext, workspace: string, uploadId: string) {
  await resolveAgentRouteFor(deps, auth, workspace);
  const repo = deps.configStore?.agentArtifacts;
  if (!repo) return artifactError(501, 'artifact_unsupported');
  const value = await repo.get(auth.session.session_id, uploadId);
  if (!value || value.workspace !== workspace) return artifactError(404, 'artifact_not_found');
  return receipt(value);
}
export async function uploadAgentArtifact(deps: ArtifactDeps, auth: AgentToolAuthContext, workspace: string, uploadId: string, input: unknown, body: Buffer) {
  const route = await resolveAgentRouteFor(deps, auth, workspace);
  const repo = deps.configStore?.agentArtifacts;
  if (!repo) return artifactError(501, 'artifact_unsupported');
  const policy = route.agent_client?.artifact_upload;
  if (!routeAgentClientConfig(route) || validateArtifactConfig(policy) || !policy?.enabled || !policy.bucket) return artifactError(403, 'artifact_upload_disabled');
  if (!/^[a-f0-9]{64}$/.test(uploadId)) return artifactError(400, 'artifact_invalid_request');
  const metadata = artifactMetadata(input);
  if (body.length !== metadata.bytes || hash(body) !== metadata.sha256) return artifactError(400, 'artifact_content_mismatch');
  if (!imageMatches(body, metadata.mime) || !(policy.allowed_mimes ?? [...ARTIFACT_MIMES] as readonly string[]).includes(metadata.mime)) return artifactError(415, 'artifact_type_not_allowed');
  if (body.length > (policy.max_bytes ?? ARTIFACT_MAX_BYTES)) return artifactError(413, 'artifact_too_large');
  if (metadata.run_id) {
    const run = await deps.configStore?.agentClientRuntime?.getRun(metadata.run_id, auth.session.session_id, auth.client.app_id);
    if (!run || run.session_id !== auth.session.session_id || run.route_key !== workspace || run.client_conversation_id !== metadata.client_conversation_id || run.client_turn_id !== metadata.client_turn_id) return artifactError(403, 'artifact_run_mismatch');
  }
  const requestHash = hash(JSON.stringify([workspace, metadata]));
  const old = await repo.get(auth.session.session_id, uploadId);
  if (old && old.request_hash !== requestHash) return artifactError(409, 'artifact_conflict');
  if (old?.state === 'ready') return receipt(old);
  if (old && old.bucket_name !== policy.bucket) return artifactError(409, 'artifact_storage_changed');
  const bucket = await deps.configStore!.storageBuckets.get(policy.bucket);
  if (!bucket?.enabled || !['local', 'cos', 'oss'].includes(bucket.kind)) return artifactError(503, 'artifact_storage_unavailable');
  let publicUrl: URL;
  try { publicUrl = new URL(bucket.public_base_url); } catch { return artifactError(503, 'artifact_storage_unavailable'); }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) return artifactError(503, 'artifact_storage_unavailable');
  if (bucket.kind !== 'local' && (!bucket.access_key || !bucket.secret_key || !bucket.bucket || !bucket.region)) return artifactError(503, 'artifact_storage_unavailable');
  const value = await repo.reserve({ upload_id: uploadId, session_id: auth.session.session_id, workspace, request_hash: requestHash,
    storage_hash: storageHash(bucket), bucket_name: bucket.name, object_key: objectKey(bucket, 'artifacts', metadata.mime), metadata, state: 'pending' });
  if (value.request_hash !== requestHash) return artifactError(409, 'artifact_conflict');
  if (value.state === 'ready') return receipt(value);
  if (value.storage_hash !== storageHash(bucket)) return artifactError(409, 'artifact_storage_changed');
  let url: string;
  try { url = await (deps.put ?? putObject)(bucket, value.object_key, body, metadata.mime, { root: deps.root }); }
  catch { return artifactError(503, 'artifact_upload_pending'); }
  // If this commit or its HTTP ACK is lost, the same immutable upload ID recovers the same object.
  try { await repo.ready(auth.session.session_id, uploadId, url); }
  catch { return artifactError(503, 'artifact_upload_pending'); }
  return receipt({ ...value, state: 'ready', url });
}
