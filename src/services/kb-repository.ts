import type { KbBase, KbDatasource, KbDoc } from '../core/contracts/types';

export interface KbBaseWithStats extends KbBase {
  doc_count: number;
  chunk_count: number;
}

export interface KbDocRecord extends KbDoc {
  content: string;
  content_hash: string;
}

export interface KbDocSourceSnapshot {
  doc_id: number;
  content_hash: string;
  status: KbDoc['status'];
}

export interface KbDocContentRecord {
  doc_id: number;
  title: string;
  content: string;
}

export interface KbChunkInsert {
  kb_id: string;
  doc_id: number;
  seq: number;
  content: string;
  embedding: Buffer;
  created_at: string;
}

export interface KbIndexRecord {
  id: number;
  doc_id: number;
  seq: number;
  content: string;
  title: string;
  embedding: Buffer;
}

export interface KnowledgeRepository {
  listBases(): Promise<KbBaseWithStats[]>;
  getBase(kbId: string): Promise<KbBase | null>;
  upsertBase(base: KbBase, now: string): Promise<void>;
  deleteBase(kbId: string): Promise<void>;
  listDocs(kbId: string): Promise<KbDoc[]>;
  insertDoc(kbId: string, title: string, content: string, contentHash: string, now: string): Promise<number>;
  getDocSourceSnapshot(kbId: string, sourceKey: string): Promise<KbDocSourceSnapshot | null>;
  updateDocForEmbedding(docId: number, title: string, content: string, contentHash: string, now: string): Promise<void>;
  insertDocBySourceKey(kbId: string, sourceKey: string, title: string, content: string, contentHash: string, now: string): Promise<number>;
  listSourceKeysByPrefix(kbId: string, prefix: string): Promise<Map<string, number>>;
  getDocIdBySourceKey(kbId: string, sourceKey: string): Promise<number | null>;
  getDoc(docId: number): Promise<KbDocRecord | null>;
  replaceChunks(docId: number, chunks: KbChunkInsert[]): Promise<void>;
  markDocReady(docId: number, chunkCount: number, now: string): Promise<void>;
  markDocError(docId: number, error: string, now: string): Promise<void>;
  deleteDoc(kbId: string, docId: number): Promise<void>;
  listDocsByIds(docIds: number[]): Promise<KbDocContentRecord[]>;
  listIndexRows(kbId: string): Promise<KbIndexRecord[]>;
}

export type KbDatasourceDraft =
  Omit<KbDatasource, 'ds_id' | 'last_sync_at' | 'last_status' | 'last_error' | 'last_stats'> & { ds_id?: number };

export type KbDatasourceListItem = Omit<KbDatasource, 'db_password'> & { doc_count: number };

export interface KbDatasourceRepository {
  list(kbId: string): Promise<KbDatasourceListItem[]>;
  get(dsId: number): Promise<KbDatasource | null>;
  create(input: KbDatasourceDraft & { db_password: string }, now: string): Promise<number>;
  update(dsId: number, input: KbDatasourceDraft & { db_password: string }, now: string): Promise<void>;
  delete(dsId: number): Promise<void>;
  markRunning(dsId: number, now: string): Promise<void>;
  markOk(dsId: number, stats: unknown): Promise<void>;
  markError(dsId: number, error: string, stats: unknown): Promise<void>;
  listDue(now: string): Promise<KbDatasource[]>;
}
