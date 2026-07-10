import { CHANNEL_SECRET_KEYS } from '../core/config/config-codec';

export function maskKey(key: string): string {
  return key.length > 9 ? `${key.slice(0, 5)}…${key.slice(-4)}` : '…';
}

/** 渠道 config 出后台前掩码密钥字段（编辑时留空=保留，详见 upsertChannel）。 */
export function maskChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const k of CHANNEL_SECRET_KEYS) { if (out[k]) out[k] = maskKey(String(out[k])); }
  return out;
}
