import type { KbBase, KbDatasource, KbDoc } from '../../core/contracts/types';
import type {
  KbBaseWithStats,
  KbChunkInsert,
  KbDatasourceDraft,
  KbDatasourceListItem,
  KbDatasourceRepository,
  KbDocContentRecord,
  KbDocRecord,
  KbDocSourceSnapshot,
  KbIndexRecord,
  KnowledgeRepository,
} from '../../services/kb-repository';

export class MysqlKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async listBases(): Promise<KbBaseWithStats[]> {
    const [rows] = await this.pool.query(
      'SELECT b.*, (SELECT COUNT(*) FROM bz_kb_docs d WHERE d.kb_id=b.kb_id) AS doc_count, ' +
        '(SELECT COUNT(*) FROM bz_kb_chunks c WHERE c.kb_id=b.kb_id) AS chunk_count ' +
        'FROM bz_kb_bases b ORDER BY b.kb_id',
    );
    return (rows as any[]).map((r) => ({ ...rowBase(r), doc_count: Number(r.doc_count), chunk_count: Number(r.chunk_count) }));
  }

  async getBase(kbId: string): Promise<KbBase | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_kb_bases WHERE kb_id=? LIMIT 1', [kbId]);
    return (rows as any[])[0] ? rowBase((rows as any[])[0]) : null;
  }

  async upsertBase(b: KbBase, now: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_kb_bases (kb_id,name,credential,model,dim,enabled,description,writers,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE name=VALUES(name),enabled=VALUES(enabled),description=VALUES(description),writers=VALUES(writers),updated_at=VALUES(updated_at)',
      [b.kb_id, b.name, b.credential, b.model, b.dim, b.enabled ? 1 : 0, b.description ?? null,
       b.writers && b.writers.length ? JSON.stringify(b.writers) : null, now, now],
    );
  }

  async deleteBase(kbId: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_kb_chunks WHERE kb_id=?', [kbId]);
    await this.pool.query('DELETE FROM bz_kb_docs WHERE kb_id=?', [kbId]);
    await this.pool.query('DELETE FROM bz_kb_datasources WHERE kb_id=?', [kbId]).catch(() => { /* 表未建时静默 */ });
    await this.pool.query('DELETE FROM bz_kb_bases WHERE kb_id=?', [kbId]);
  }

  async listDocs(kbId: string): Promise<KbDoc[]> {
    const [rows] = await this.pool.query(
      'SELECT doc_id,kb_id,source_key,title,status,error,chunk_count,created_at,updated_at FROM bz_kb_docs WHERE kb_id=? ORDER BY doc_id DESC',
      [kbId],
    );
    return (rows as any[]).map(rowDoc);
  }

  async insertDoc(kbId: string, title: string, content: string, contentHash: string, now: string): Promise<number> {
    const [r]: any = await this.pool.query(
      'INSERT INTO bz_kb_docs (kb_id,title,content,content_hash,status,chunk_count,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)',
      [kbId, title, content, contentHash, 'embedding', now, now],
    );
    return Number(r.insertId);
  }

  async getDocSourceSnapshot(kbId: string, sourceKey: string): Promise<KbDocSourceSnapshot | null> {
    const [rows] = await this.pool.query('SELECT doc_id,content_hash,status FROM bz_kb_docs WHERE kb_id=? AND source_key=? LIMIT 1', [kbId, sourceKey]);
    const r = (rows as any[])[0];
    return r ? { doc_id: Number(r.doc_id), content_hash: String(r.content_hash), status: r.status } : null;
  }

  async updateDocForEmbedding(docId: number, title: string, content: string, contentHash: string, now: string): Promise<void> {
    await this.pool.query(
      "UPDATE bz_kb_docs SET title=?,content=?,content_hash=?,status='embedding',error=NULL,updated_at=? WHERE doc_id=?",
      [title, content, contentHash, now, docId],
    );
  }

  async insertDocBySourceKey(kbId: string, sourceKey: string, title: string, content: string, contentHash: string, now: string): Promise<number> {
    const [r]: any = await this.pool.query(
      'INSERT INTO bz_kb_docs (kb_id,source_key,title,content,content_hash,status,chunk_count,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)',
      [kbId, sourceKey, title, content, contentHash, 'embedding', now, now],
    );
    return Number(r.insertId);
  }

  async listSourceKeysByPrefix(kbId: string, prefix: string): Promise<Map<string, number>> {
    const [rows] = await this.pool.query(
      "SELECT doc_id,source_key FROM bz_kb_docs WHERE kb_id=? AND source_key LIKE CONCAT(?,'%')",
      [kbId, prefix],
    );
    return new Map((rows as any[]).map((r) => [String(r.source_key), Number(r.doc_id)]));
  }

  async getDocIdBySourceKey(kbId: string, sourceKey: string): Promise<number | null> {
    const [rows] = await this.pool.query('SELECT doc_id FROM bz_kb_docs WHERE kb_id=? AND source_key=? LIMIT 1', [kbId, sourceKey]);
    const r = (rows as any[])[0];
    return r ? Number(r.doc_id) : null;
  }

  async getDoc(docId: number): Promise<KbDocRecord | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_kb_docs WHERE doc_id=? LIMIT 1', [docId]);
    const r = (rows as any[])[0];
    if (!r) return null;
    return { ...rowDoc(r), content: String(r.content ?? ''), content_hash: String(r.content_hash ?? '') };
  }

  async replaceChunks(docId: number, chunks: KbChunkInsert[]): Promise<void> {
    await this.pool.query('DELETE FROM bz_kb_chunks WHERE doc_id=?', [docId]);
    for (const c of chunks) {
      await this.pool.query(
        'INSERT INTO bz_kb_chunks (kb_id,doc_id,seq,content,embedding,created_at) VALUES (?,?,?,?,?,?)',
        [c.kb_id, c.doc_id, c.seq, c.content, c.embedding, c.created_at],
      );
    }
  }

  async markDocReady(docId: number, chunkCount: number, now: string): Promise<void> {
    await this.pool.query('UPDATE bz_kb_docs SET status=?,error=NULL,chunk_count=?,updated_at=? WHERE doc_id=?', ['ready', chunkCount, now, docId]);
  }

  async markDocError(docId: number, error: string, now: string): Promise<void> {
    await this.pool.query('UPDATE bz_kb_docs SET status=?,error=?,updated_at=? WHERE doc_id=?', ['error', error, now, docId]);
  }

  async deleteDoc(kbId: string, docId: number): Promise<void> {
    await this.pool.query('DELETE FROM bz_kb_chunks WHERE doc_id=?', [docId]);
    await this.pool.query('DELETE FROM bz_kb_docs WHERE doc_id=? AND kb_id=?', [docId, kbId]);
  }

  async listDocsByIds(docIds: number[]): Promise<KbDocContentRecord[]> {
    if (!docIds.length) return [];
    const [rows] = await this.pool.query(
      `SELECT doc_id,title,content FROM bz_kb_docs WHERE doc_id IN (${docIds.map(() => '?').join(',')})`,
      docIds,
    );
    return (rows as any[]).map((r) => ({ doc_id: Number(r.doc_id), title: String(r.title ?? ''), content: String(r.content ?? '') }));
  }

  async listIndexRows(kbId: string): Promise<KbIndexRecord[]> {
    const [rows] = await this.pool.query(
      'SELECT c.id,c.doc_id,c.seq,c.content,c.embedding,d.title FROM bz_kb_chunks c JOIN bz_kb_docs d ON d.doc_id=c.doc_id WHERE c.kb_id=?',
      [kbId],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      doc_id: Number(r.doc_id),
      seq: Number(r.seq),
      content: String(r.content),
      title: String(r.title ?? ''),
      embedding: r.embedding as Buffer,
    }));
  }
}

export class MysqlKbDatasourceRepository implements KbDatasourceRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(kbId: string): Promise<KbDatasourceListItem[]> {
    const [rows] = await this.pool.query(
      "SELECT d.*, (SELECT COUNT(*) FROM bz_kb_docs k WHERE k.kb_id=d.kb_id AND k.source_key LIKE CONCAT('ds', d.ds_id, ':%')) AS doc_count " +
        'FROM bz_kb_datasources d WHERE d.kb_id=? ORDER BY d.ds_id',
      [kbId],
    );
    return (rows as any[]).map((r) => {
      const x = rowDs(r);
      delete (x as any).db_password;
      return { ...x, doc_count: Number(r.doc_count) } as KbDatasourceListItem;
    });
  }

  async get(dsId: number): Promise<KbDatasource | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_kb_datasources WHERE ds_id=? LIMIT 1', [dsId]);
    return (rows as any[])[0] ? rowDs((rows as any[])[0]) : null;
  }

  async create(d: KbDatasourceDraft & { db_password: string }, now: string): Promise<number> {
    const [r]: any = await this.pool.query(
      'INSERT INTO bz_kb_datasources (kb_id,name,db_host,db_port,db_user,db_password,db_database,query_sql,key_field,title_field,content_template,interval_min,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [d.kb_id, d.name, d.db_host, d.db_port, d.db_user, d.db_password, d.db_database, d.query_sql, d.key_field, d.title_field,
       d.content_template, d.interval_min, d.enabled ? 1 : 0, now, now],
    );
    return Number(r.insertId);
  }

  async update(dsId: number, d: KbDatasourceDraft & { db_password: string }, now: string): Promise<void> {
    await this.pool.query(
      'UPDATE bz_kb_datasources SET name=?,db_host=?,db_port=?,db_user=?,db_password=?,db_database=?,query_sql=?,key_field=?,title_field=?,content_template=?,interval_min=?,enabled=?,updated_at=? WHERE ds_id=?',
      [d.name, d.db_host, d.db_port, d.db_user, d.db_password, d.db_database, d.query_sql, d.key_field, d.title_field,
       d.content_template, d.interval_min, d.enabled ? 1 : 0, now, dsId],
    );
  }

  async delete(dsId: number): Promise<void> {
    await this.pool.query('DELETE FROM bz_kb_datasources WHERE ds_id=?', [dsId]);
  }

  async markRunning(dsId: number, now: string): Promise<void> {
    await this.pool.query("UPDATE bz_kb_datasources SET last_sync_at=?, last_status='running', last_error=NULL WHERE ds_id=?", [now, dsId]);
  }

  async markOk(dsId: number, stats: unknown): Promise<void> {
    await this.pool.query("UPDATE bz_kb_datasources SET last_status='ok', last_error=NULL, last_stats=? WHERE ds_id=?", [JSON.stringify(stats), dsId]);
  }

  async markError(dsId: number, error: string, stats: unknown): Promise<void> {
    await this.pool.query("UPDATE bz_kb_datasources SET last_status='error', last_error=?, last_stats=? WHERE ds_id=?", [error, JSON.stringify(stats), dsId]);
  }

  async listDue(now: string): Promise<KbDatasource[]> {
    const [rows] = await this.pool.query(
      "SELECT * FROM bz_kb_datasources WHERE enabled=1 AND interval_min>0 AND (last_sync_at IS NULL OR last_sync_at < DATE_SUB(?, INTERVAL interval_min MINUTE))",
      [now],
    );
    return (rows as any[]).map(rowDs);
  }
}

function rowBase(r: any): KbBase {
  const w = r.writers ? (typeof r.writers === 'string' ? JSON.parse(r.writers) : r.writers) : [];
  return {
    kb_id: r.kb_id, name: r.name, credential: r.credential, model: r.model,
    dim: Number(r.dim), enabled: !!r.enabled, description: r.description ?? undefined,
    writers: Array.isArray(w) ? w : [],
  };
}

function rowDoc(r: any): KbDoc {
  return {
    doc_id: Number(r.doc_id), kb_id: r.kb_id, source_key: r.source_key ?? undefined, title: r.title, status: r.status,
    error: r.error ?? undefined, chunk_count: Number(r.chunk_count),
    created_at: r.created_at ? new Date(r.created_at).toISOString() : '',
    updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : '',
  };
}

function rowDs(r: any): KbDatasource {
  return {
    ds_id: Number(r.ds_id), kb_id: r.kb_id, name: r.name,
    db_host: r.db_host, db_port: Number(r.db_port ?? 3306), db_user: r.db_user, db_password: r.db_password, db_database: r.db_database,
    query_sql: r.query_sql, key_field: r.key_field, title_field: r.title_field, content_template: r.content_template,
    interval_min: Number(r.interval_min ?? 60), enabled: !!r.enabled,
    last_sync_at: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : undefined,
    last_status: r.last_status ?? undefined, last_error: r.last_error ?? undefined,
    last_stats: r.last_stats ? (typeof r.last_stats === 'string' ? JSON.parse(r.last_stats) : r.last_stats) : undefined,
  };
}
