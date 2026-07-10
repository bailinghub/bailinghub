// 后台基础设施配置 API：模型凭证、对象存储、渠道和告警规则。
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  prepareAlertRuleConfig,
  prepareChannelConfig,
  prepareCredentialConfig,
  prepareStorageBucketConfig,
} from '../core/config/config-models';
import { errMsg, readBody, send } from '../app/http';
import type { AlertRule, Channel, Credential, StorageBucket } from '../core/contracts/types';
import { verifyCredentialConnection, type CredentialVerifyCapability } from '../core/runtime/credential-verify';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { maskChannelConfig, maskKey } from './admin-format';

export interface AdminInfraApiDeps {
  configStore: ConfigStoreContract | null;
}

export async function handleAdminInfraApiFor(
  deps: AdminInfraApiDeps,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (!deps.configStore) return false;
  const configStore = deps.configStore;

  // ---- 模型凭证（key 入库不回显：列表只出掩码，编辑留空=保留原 key）----
  if (path === '/admin/api/credentials') {
    if (method === 'GET') {
      const list = await configStore.credentials.list();
      send(res, 200, list.map((c) => ({ ...c, api_key: maskKey(c.api_key) })));
      return true;
    }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<Credential>;
      const prepared = prepareCredentialConfig(b);
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      try {
        await configStore.credentials.upsert(prepared.value);
      } catch (e) { send(res, 400, { error: errMsg(e) }); return true; }
      send(res, 200, { ok: true });
      return true;
    }
  }
  const credentialVerifyMatch = path.match(/^\/admin\/api\/credentials\/([^/]+)\/verify$/);
  if (credentialVerifyMatch && method === 'POST') {
    const name = decodeURIComponent(credentialVerifyMatch[1] ?? '');
    const cred = await configStore.credentials.get(name);
    if (!cred) { send(res, 404, { error: '凭证不存在' }); return true; }
    if (!cred.enabled) { send(res, 200, { ok: false, message: '凭证已禁用，未发起验证' }); return true; }
    const b = (await readBody(req)) as Record<string, unknown>;
    const rawCapability = String(b['capability'] ?? (cred.kind === 'embedding' ? 'embedding' : 'chat'));
    const capability: CredentialVerifyCapability =
      rawCapability === 'embedding' || rawCapability === 'vision' || rawCapability === 'chat' ? rawCapability : 'chat';
    const model = String(b['model'] ?? cred.default_model ?? '').trim();
    const got = await verifyCredentialConnection({
      credential: cred,
      capability,
      model,
      timeout_ms: Number(b['timeout_ms'] ?? 30000),
    });
    send(res, 200, got);
    return true;
  }
  if (path.startsWith('/admin/api/credentials/') && method === 'DELETE') {
    await configStore.credentials.delete(decodeURIComponent(path.slice('/admin/api/credentials/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  // ---- 对象存储登记（聊天图片落桶；secret_key 入库不回显，编辑留空=保留原值）----
  if (path === '/admin/api/storage-buckets') {
    if (method === 'GET') {
      const list = await configStore.storageBuckets.list();
      // SecretId 与 SecretKey 同属云凭证、合起来即整桶访问权，均掩码（编辑留空=保留原值）
      send(res, 200, list.map((b) => ({ ...b, access_key: maskKey(b.access_key), secret_key: maskKey(b.secret_key) })));
      return true;
    }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<StorageBucket>;
      const prepared = prepareStorageBucketConfig(b);
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      try {
        await configStore.storageBuckets.upsert(prepared.value);
      } catch (e) { send(res, 400, { error: errMsg(e) }); return true; }
      send(res, 200, { ok: true });
      return true;
    }
  }
  if (path.startsWith('/admin/api/storage-buckets/') && method === 'DELETE') {
    await configStore.storageBuckets.delete(decodeURIComponent(path.slice('/admin/api/storage-buckets/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  // ---- 入站消息渠道（通用：企微等；config 含平台密钥，GET 掩码）----
  if (path === '/admin/api/channels') {
    if (method === 'GET') {
      const list = await configStore.channels.list();
      send(res, 200, list.map((c) => ({ ...c, config: maskChannelConfig(c.config) })));
      return true;
    }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<Channel>;
      const prepared = await prepareChannelConfig(b, { isNew: async (name) => !(await configStore.channels.get(name)) });
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      try {
        await configStore.channels.upsert(prepared.value);
      } catch (e) { send(res, 400, { error: errMsg(e) }); return true; }
      send(res, 200, { ok: true });
      return true;
    }
  }
  if (path.startsWith('/admin/api/channels/') && method === 'DELETE') {
    await configStore.channels.delete(decodeURIComponent(path.slice('/admin/api/channels/'.length)));
    send(res, 200, { ok: true });
    return true;
  }

  // ---- 告警通知规则（系统告警→渠道→收件人；channelSend 直推，不建任务）----
  if (path === '/admin/api/alert-rules') {
    if (method === 'GET') { send(res, 200, await configStore.alertRules.list()); return true; }
    if (method === 'POST') {
      const b = (await readBody(req)) as Partial<AlertRule>;
      const prepared = await prepareAlertRuleConfig(b, { channelExists: async (name) => !!(await configStore.channels.get(name)) });
      if (!prepared.ok) { send(res, 400, { error: prepared.error }); return true; }
      await configStore.alertRules.upsert(prepared.value);
      send(res, 200, { ok: true });
      return true;
    }
  }
  if (path.startsWith('/admin/api/alert-rules/') && method === 'DELETE') {
    const id = Number(decodeURIComponent(path.slice('/admin/api/alert-rules/'.length)));
    if (id) await configStore.alertRules.delete(id);
    send(res, 200, { ok: true });
    return true;
  }

  return false;
}
