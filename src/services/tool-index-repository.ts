export interface ToolEmbeddingSnapshot {
  tool_name: string;
  text_hash: string;
  model: string;
  dim: number;
}

export interface ToolEmbeddingSnapshotQuery {
  /** 数据库查询阶段的客户端超时；旧实现可忽略该可选参数。 */
  timeoutMs?: number;
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
  /** 新实现应回传坐标元数据；旧实现缺失时运行时会用 snapshot 复核后再使用向量。 */
  model?: string;
  dim?: number;
}

export interface ToolEmbeddingVectorQuery {
  model: string;
  dim: number;
  /** 数据库查询阶段的客户端超时；实现应尽量真正取消底层查询，而不是只在调用方放弃等待。 */
  timeoutMs?: number;
}

export interface ToolEmbeddingRepository {
  listSnapshot(provider: string, query?: ToolEmbeddingSnapshotQuery): Promise<ToolEmbeddingSnapshot[]>;
  deleteProvider(provider: string): Promise<void>;
  upsert(row: ToolEmbeddingUpsert): Promise<void>;
  deleteTools(provider: string, names: string[]): Promise<void>;
  /** 坐标系切换的原子替换；旧扩展仓储可暂不实现，但切换坐标时会明确拒绝非原子写入。 */
  replaceProvider?(provider: string, rows: ToolEmbeddingUpsert[]): Promise<void>;
  /** query 可选以保持旧扩展调用兼容；运行时服务始终传 model/dim/timeout。 */
  listVectors(provider: string, query?: ToolEmbeddingVectorQuery): Promise<ToolEmbeddingVectorRow[]>;
}
