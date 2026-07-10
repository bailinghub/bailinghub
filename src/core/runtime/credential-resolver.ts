// 模型凭证解析：统一处理 config.json 与后台 bz_credentials 的优先级。
// 本模块不依赖 runtime 单例，方便 target/engine/memory 复用，也方便后续开源接入者替换凭证存储。
import type { AppConfig, LlmCredential } from '../config/config';
import type { Credential } from '../contracts/types';
import { llmTargetConfig, normalizeTargetConfig } from '../config/target-config';

export interface ResolvedLlmCredential extends LlmCredential {
  default_model?: string;
}

export interface CredentialStoreLike {
  get(name: string): Promise<Credential | null>;
  touch(name: string): Promise<void>;
}

export interface ResolvedCredentialRef {
  name: string;
  source: 'config' | 'db';
  credential: ResolvedLlmCredential;
}

function usableDbCredential(c: Credential | null): ResolvedLlmCredential | null {
  if (!c || !c.enabled || c.kind === 'embedding') return null;
  return { base_url: c.base_url, api_key: c.api_key, default_model: c.default_model };
}

export async function resolveLlmCredential(
  name: string,
  cfg: Pick<AppConfig, 'llmCredentials'>,
  store?: CredentialStoreLike | null,
): Promise<ResolvedCredentialRef | null> {
  const credName = String(name ?? '').trim();
  if (!credName) return null;
  const fileCred = cfg.llmCredentials[credName] as ResolvedLlmCredential | undefined;
  if (fileCred) return { name: credName, source: 'config', credential: fileCred };
  const dbCred = usableDbCredential(store ? await store.get(credName).catch(() => null) : null);
  if (!dbCred) return null;
  void store?.touch(credName).catch(() => { /* 观测字段 */ });
  return { name: credName, source: 'db', credential: dbCred };
}

/** 给 llm 本次运行的 target_config 注入 DB 凭证。
 * config.json 凭证不注入：适配器会直接从 ctx.cfg.llmCredentials 读取；DB 凭证只进本次内存，不落 job 快照/日志。 */
export async function injectLlmRuntimeCredentials(
  targetConfig: Record<string, unknown>,
  cfg: Pick<AppConfig, 'llmCredentials'>,
  store?: CredentialStoreLike | null,
): Promise<Record<string, unknown>> {
  let next = normalizeTargetConfig('llm', targetConfig);
  const llmCfg = llmTargetConfig(next);
  const brainCredName = llmCfg?.credential ?? '';
  const brain = brainCredName ? await resolveLlmCredential(brainCredName, cfg, store) : null;
  if (brain) {
    next = {
      ...next,
      _credential_source: brain.source,
      ...(brain.source === 'db' ? { _db_credential: brain.credential } : {}),
    };
  }

  const input = (llmTargetConfig(next)?.input ?? {}) as Record<string, unknown>;
  const injectInputCredential = async (key: 'image' | 'audio' | 'file'): Promise<void> => {
    const cfgPart = input[key] && typeof input[key] === 'object' && !Array.isArray(input[key]) ? input[key] as Record<string, unknown> : null;
    const credName = String(cfgPart?.credential ?? '').trim();
    if (!cfgPart || !credName || credName === brainCredName) return;
    const resolved = await resolveLlmCredential(credName, cfg, store);
    if (!resolved) return;
    next = {
      ...next,
      input: {
        ...((next.input && typeof next.input === 'object' && !Array.isArray(next.input)) ? next.input as Record<string, unknown> : {}),
        [key]: {
          ...cfgPart,
          _credential_source: resolved.source,
          ...(resolved.source === 'db' ? { _db_credential: resolved.credential } : {}),
        },
      },
    };
  };
  await injectInputCredential('image');
  await injectInputCredential('audio');
  await injectInputCredential('file');
  return next;
}

export async function resolveSummaryCredential(
  targetConfig: unknown,
  cfg: Pick<AppConfig, 'llmCredentials'>,
  store?: CredentialStoreLike | null,
): Promise<ResolvedCredentialRef | null> {
  const credName = llmTargetConfig(targetConfig)?.credential ?? '';
  return resolveLlmCredential(credName, cfg, store);
}
