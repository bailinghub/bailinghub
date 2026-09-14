
export interface AgentArtifactRecord {
  upload_id: string;
  session_id: string;
  workspace: string;
  request_hash: string;
  storage_hash: string;
  bucket_name: string;
  object_key: string;
  metadata: { client_conversation_id: string; client_turn_id: string; name: string; mime: string; bytes: number; sha256: string; run_id?: string };
  state: 'pending' | 'ready';
  url?: string;
}

/** Contains no credentials or file bytes. Replays keep the original destination and object. */
export class AgentArtifactRepository {
  constructor(private readonly poolOf: () => any) {}
  async get(sessionId: string, uploadId: string): Promise<AgentArtifactRecord | null> {
    const [rows] = await this.poolOf().query('SELECT record_json,state,url FROM bz_agent_artifacts WHERE session_id=? AND upload_id=?', [sessionId, uploadId]);
    if (!rows[0]) return null;
    const value = typeof rows[0].record_json === 'string' ? JSON.parse(rows[0].record_json) : rows[0].record_json;
    return { ...value, state: rows[0].state, ...(rows[0].url ? { url: rows[0].url } : {}) };
  }
  async reserve(value: AgentArtifactRecord): Promise<AgentArtifactRecord> {
    await this.poolOf().query('INSERT INTO bz_agent_artifacts (session_id,upload_id,record_json,state) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE upload_id=VALUES(upload_id)',
      [value.session_id, value.upload_id, JSON.stringify(value), 'pending']);
    return (await this.get(value.session_id, value.upload_id))!;
  }
  async ready(sessionId: string, uploadId: string, url: string): Promise<void> {
    await this.poolOf().query("UPDATE bz_agent_artifacts SET state='ready',url=? WHERE session_id=? AND upload_id=? AND state='pending'", [url, sessionId, uploadId]);
  }
}
