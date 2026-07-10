export interface ToolEmbeddingSnapshot {
  tool_name: string;
  text_hash: string;
  model: string;
  dim: number;
}

export interface ToolEmbeddingUpsert {
  provider: string;
  tool_name: string;
  scope: string;
  text: string;
  text_hash: string;
  model: string;
  dim: number;
  embedding: Buffer;
  updated_at: string;
}

export interface ToolEmbeddingVectorRow {
  tool_name: string;
  scope: string;
  embedding: Buffer;
}

export interface ToolEmbeddingRepository {
  listSnapshot(provider: string): Promise<ToolEmbeddingSnapshot[]>;
  deleteProvider(provider: string): Promise<void>;
  upsert(row: ToolEmbeddingUpsert): Promise<void>;
  deleteTools(provider: string, names: string[]): Promise<void>;
  listVectors(provider: string): Promise<ToolEmbeddingVectorRow[]>;
}
