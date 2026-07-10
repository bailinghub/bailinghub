import type { ToolEmbeddingRepository, ToolEmbeddingSnapshot, ToolEmbeddingUpsert, ToolEmbeddingVectorRow } from '../../services/tool-index-repository';

export class MysqlToolEmbeddingRepository implements ToolEmbeddingRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async listSnapshot(provider: string): Promise<ToolEmbeddingSnapshot[]> {
    const [rows] = await this.pool.query('SELECT tool_name,text_hash,model,dim FROM bz_tool_embeddings WHERE provider=?', [provider]);
    return (rows as any[]).map((r) => ({
      tool_name: String(r.tool_name),
      text_hash: String(r.text_hash),
      model: String(r.model),
      dim: Number(r.dim),
    }));
  }

  async deleteProvider(provider: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_tool_embeddings WHERE provider=?', [provider]);
  }

  async upsert(row: ToolEmbeddingUpsert): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_tool_embeddings (provider,tool_name,scope,text,text_hash,model,dim,embedding,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE scope=VALUES(scope),text=VALUES(text),text_hash=VALUES(text_hash),model=VALUES(model),dim=VALUES(dim),embedding=VALUES(embedding),updated_at=VALUES(updated_at)',
      [row.provider, row.tool_name, row.scope, row.text, row.text_hash, row.model, row.dim, row.embedding, row.updated_at],
    );
  }

  async deleteTools(provider: string, names: string[]): Promise<void> {
    if (!names.length) return;
    const ph = names.map(() => '?').join(',');
    await this.pool.query(`DELETE FROM bz_tool_embeddings WHERE provider=? AND tool_name IN (${ph})`, [provider, ...names]);
  }

  async listVectors(provider: string): Promise<ToolEmbeddingVectorRow[]> {
    const [rows] = await this.pool.query('SELECT tool_name,scope,embedding FROM bz_tool_embeddings WHERE provider=?', [provider]);
    return (rows as any[]).map((r) => ({
      tool_name: String(r.tool_name),
      scope: String(r.scope ?? ''),
      embedding: r.embedding as Buffer,
    }));
  }
}
