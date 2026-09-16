import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Job } from '../core/contracts/types';
import { argsHash } from '../core/contracts/tools';

// A recovery snapshot is private execution material, never plaintext in job metadata or audit output.
// Rotating the instance token makes pending snapshots unreadable and fails closed.
function key(secret: string): Buffer {
  if (!secret) throw new Error('invocation_snapshot_key_unavailable');
  return createHash('sha256').update('bailing.agent.invocation.snapshot.v1\0').update(secret).digest();
}
function aad(job: Job): Buffer {
  return Buffer.from(JSON.stringify([job.job_id, job.request_id, job.client_app_id, job.agent_session_id,
    job.metadata.agent_run_id, job.metadata.agent_route, job.metadata.agent_tool,
    job.metadata.agent_args_hash, job.metadata.agent_execution_fingerprint]));
}
export function sealInvocationArguments(job: Job, args: Record<string, unknown>, secret: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret), nonce);
  cipher.setAAD(aad(job));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(args), 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}
export function openInvocationArguments(job: Job, secret: string): Record<string, unknown> | null {
  try {
    const parts = String(job.metadata.agent_frozen_arguments ?? '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const decipher = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(parts[1]!, 'base64url'));
    decipher.setAAD(aad(job));
    decipher.setAuthTag(Buffer.from(parts[2]!, 'base64url'));
    const raw = Buffer.concat([decipher.update(Buffer.from(parts[3]!, 'base64url')), decipher.final()]).toString('utf8');
    const args: unknown = JSON.parse(raw);
    if (!args || typeof args !== 'object' || Array.isArray(args) || argsHash(args as Record<string, unknown>) !== job.metadata.agent_args_hash) return null;
    return args as Record<string, unknown>;
  } catch { return null; }
}
