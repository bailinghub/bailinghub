export const ARTIFACT_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const ARTIFACT_MAX_BYTES = 6 * 1024 * 1024;
export interface AgentArtifactConfig { enabled: boolean; bucket?: string; max_bytes?: number; allowed_mimes?: string[] }
export function validateArtifactConfig(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'artifact_upload 必须是对象';
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['enabled', 'bucket', 'max_bytes', 'allowed_mimes'].includes(k))) return 'artifact_upload 包含未声明字段';
  if (typeof v.enabled !== 'boolean') return 'artifact_upload.enabled 必须是布尔值';
  if (v.bucket !== undefined && (typeof v.bucket !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.bucket))) return 'artifact_upload.bucket 必须是存储登记名';
  if (v.enabled && !v.bucket) return '启用生成图片上传时必须明确选择媒体存储';
  if (v.max_bytes !== undefined && (!Number.isInteger(v.max_bytes) || Number(v.max_bytes) < 1 || Number(v.max_bytes) > ARTIFACT_MAX_BYTES)) return '图片大小上限必须在 1 字节至 6 MiB 之间';
  if (v.allowed_mimes !== undefined && (!Array.isArray(v.allowed_mimes) || !v.allowed_mimes.length || v.allowed_mimes.some(m => !(ARTIFACT_MIMES as readonly unknown[]).includes(m)))) return '支持的图片类型为 PNG、JPEG、WebP';
  return null;
}
