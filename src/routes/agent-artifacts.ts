import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '../app/http';
import { AgentToolApiError, type AgentToolAuthContext } from '../app/agent-tool-invocations';
import { ARTIFACT_MAX_BYTES } from '../core/config/artifact-config';
import { artifactError, artifactMetadata, readAgentArtifact, uploadAgentArtifact, type ArtifactDeps } from '../app/agent-artifacts';

export async function handleAgentArtifacts(deps: ArtifactDeps & { isPaused: () => boolean }, auth: AgentToolAuthContext, req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const m = path.match(/^\/agent-api\/v1\/workspaces\/([a-z0-9][a-z0-9_-]{1,63})\/artifacts\/([a-f0-9]{64})$/);
  if (!m) return false;
  try {
    if (req.method === 'GET') send(res, 200, await readAgentArtifact(deps, auth, m[1]!, m[2]!));
    else if (req.method === 'POST') {
      if (deps.isPaused()) artifactError(503, 'hub_paused');
      const raw = req.headers['x-bailing-artifact'];
      if (typeof raw !== 'string' || raw.length > 4096 || !/^[a-zA-Z0-9_-]+$/.test(raw)) artifactError(400, 'artifact_invalid_request');
      let value: unknown;
      try { value = JSON.parse(Buffer.from(raw as string, 'base64url').toString('utf8')); } catch { artifactError(400, 'artifact_invalid_request'); }
      const metadata = artifactMetadata(value);
      if (req.headers['content-type'] !== metadata.mime || (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== metadata.bytes)) artifactError(400, 'artifact_content_mismatch');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { const data = Buffer.from(chunk); size += data.length; if (size > Math.min(metadata.bytes, ARTIFACT_MAX_BYTES)) artifactError(413, 'artifact_too_large'); chunks.push(data); }
      send(res, 200, await uploadAgentArtifact(deps, auth, m[1]!, m[2]!, metadata, Buffer.concat(chunks)));
    } else send(res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    if (error instanceof AgentToolApiError) send(res, error.statusCode, { error: error.code });
    else send(res, 503, { error: 'artifact_storage_unavailable' });
  }
  return true;
}
