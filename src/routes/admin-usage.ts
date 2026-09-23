import { referencePricing } from '../modules/usage/pricing';
import { serviceAvailability } from '../modules/usage/service-availability';
import { validateModelToolConfig } from '../modules/usage/model-tools';
import { getUsageDeletionRepository, usageDeletionId, type UsageResourceKind } from '../modules/usage/usage-deletion';
import { getBillingRepository } from '../modules/usage/billing-repository';
import { handleAdminBillingUsage } from './admin-billing-usage';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { can, type Principal } from '../app/auth';
import { readBody, send } from '../app/http';
import type { UsageServiceConfig } from '../modules/usage/contracts';
import { usageAssert } from '../modules/usage/errors';
import { getUsageIdentity, usageFields, usageKey, usageString } from '../modules/usage/identity';
import { USAGE_CAPABILITIES, usageHttpError, usagePage, usageRequestKey, usageRevision } from '../modules/usage/http';
import type { UsageRepository } from '../modules/usage/repository';

/** Console uses domain services too; ordinary usage credentials never gain admin permissions. */
export async function handleAdminUsageApiFor(repository: UsageRepository | null | undefined, method: string, path: string,
  req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<boolean> {
  if (path !== '/admin/api/usage' && !path.startsWith('/admin/api/usage/')) return false;
  try {
    usageAssert(principal.kind === 'admin' && can(principal, method === 'GET' ? 'usage:read' : 'usage:write'), 'USAGE_FORBIDDEN', '当前账号没有用户与用量管理权限。', 403);
    if (path === '/admin/api/usage' && method === 'GET') { send(res, 200, { ...USAGE_CAPABILITIES, supported: Boolean(repository && await getUsageIdentity(repository).ready() && await getBillingRepository(repository).ready()) }); return true; }
    usageAssert(repository, 'USAGE_UNSUPPORTED', '此实例尚未配置用量模块。', 503);
    const identity = getUsageIdentity(repository), url = new URL(req.url ?? path, 'http://bailing.local');
    usageAssert(await identity.ready(), 'USAGE_UNSUPPORTED', '用量模块尚未就绪，请核对版本与迁移。', 503);
    if (await handleAdminBillingUsage(repository, method, path, req, res, principal)) return true;
    const query = url.searchParams;
    if (path.startsWith('/admin/api/usage/pricing/')) {
      usageAssert(can(principal, 'usage:issuers'), 'USAGE_FORBIDDEN', '参考价格设置需要模型服务管理权限。', 403);
      const prices = referencePricing(repository);
      if (method === 'GET' && ['/admin/api/usage/pricing/models','/admin/api/usage/pricing/endpoints'].includes(path)) {
        const kind = query.get('kind'); usageAssert(kind === 'chat' || kind === 'image', 'USAGE_INVALID_INPUT', '参考目录类型无效。', 400);
        const model = query.get('model_id') ?? undefined;
        if (path.endsWith('/endpoints')) usageAssert(model, 'USAGE_INVALID_INPUT', '请选择参考模型。', 400);
        send(res,200,await prices.catalog(kind, path.endsWith('/endpoints') ? model : undefined)); return true;
      }
      if (method === 'POST' && path.endsWith('/sync')) {
        const b = usageFields(await readBody(req,2048), ['kind','model_id'], ['kind','model_id']);
        usageAssert(b.kind === 'chat' || b.kind === 'image', 'USAGE_INVALID_INPUT', '参考目录类型无效。', 400);
        send(res,200,await prices.catalog(b.kind, usageString(b.model_id,'model_id',191),true)); return true;
      }
      send(res,404,{error:'not_found'}); return true;
    }

    const deletion = path.match(/^\/admin\/api\/usage\/(issuers|accounts)\/([^/]+)(\/deletion-preview)?$/);
    if (deletion && ((!deletion[3] && method === 'DELETE') || (deletion[3] && method === 'GET'))) {
      const kind: UsageResourceKind = deletion[1] === 'issuers' ? 'issuer' : 'account';
      if (kind === 'issuer') usageAssert(can(principal, 'usage:issuers'), 'USAGE_FORBIDDEN', '身份来源删除与关联预览需要身份来源管理权限。', 403);
      const id = usageDeletionId(deletion[2]!, kind), resources = getUsageDeletionRepository(repository);
      if (deletion[3]) send(res, 200, await resources.preview(kind, id));
      else {
        const body = usageFields(await readBody(req, 4096), ['request_key','expected_revision'], ['request_key','expected_revision']);
        send(res, 200, await resources.remove({ kind, id, requestKey: usageRequestKey(body), expectedRevision: usageRevision(body.expected_revision), actor: principal.username ?? 'admin-token' }));
      }
      return true;
    }
    if (path === '/admin/api/usage/issuers') {
      usageAssert(can(principal, 'usage:issuers'), 'USAGE_FORBIDDEN', '需要身份来源管理权限。', 403);
      if (method === 'GET') send(res, 200, { items: await identity.listIssuers() });
      else if (method === 'POST') send(res, 200, await identity.createIssuer(await readBody(req, 16 * 1024)));
      else send(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const issuer = path.match(/^\/admin\/api\/usage\/issuers\/([A-Za-z0-9_.:-]+)\/control$/);
    if (issuer && method === 'POST') {
      usageAssert(can(principal, 'usage:issuers'), 'USAGE_FORBIDDEN', '需要身份来源管理权限。', 403);
      const body = usageFields(await readBody(req, 4096), ['expected_revision', 'state', 'rotate'], ['expected_revision', 'state']);
      usageAssert(body.state === 'active' || body.state === 'suspended', 'USAGE_INVALID_INPUT', '状态不正确。', 400);
      usageAssert(body.rotate === undefined || typeof body.rotate === 'boolean', 'USAGE_INVALID_INPUT', '轮换参数不正确。', 400);
      send(res, 200, await identity.controlIssuer(issuer[1]!, usageRevision(body.expected_revision), body.state, body.rotate === true)); return true;
    }
    if (path === '/admin/api/usage/services') {
      if (method === 'GET') send(res, 200, { items: await Promise.all((await repository.listServices()).map(async service => {
        const [availability, quote] = await Promise.all([
          serviceAvailability(repository, service), referencePricing(repository).inspect(service.config.pricing),
        ]);
        // Public reference prices are safe for usage readers. Editing bindings still requires usage:issuers.
        return {...service, availability, reference_price: quote.price ?? null};
      })) });
      else if (method === 'POST') {
        usageAssert(can(principal, 'usage:issuers'), 'USAGE_FORBIDDEN', '模型服务配置需要身份与服务管理权限。', 403);
        const body = usageFields(await readBody(req, 16 * 1024), ['id', 'label', 'expected_revision', 'state', 'config'], ['id', 'label', 'expected_revision', 'config']);
        usageAssert(body.state === undefined || body.state === 'active' || body.state === 'suspended', 'USAGE_INVALID_INPUT', '状态不正确。', 400);
        const config = body.config as UsageServiceConfig;
        usageAssert(config && typeof config === 'object', 'USAGE_INVALID_INPUT', '模型服务配置无效。', 400);
        validateModelToolConfig(config);
        const existing = await repository.getService(usageKey(body.id, 'id'));
        if ((body.state ?? existing?.state ?? 'active') === 'active' && config.tool?.adapter !== 'pending')
          await referencePricing(repository).snapshot(config.pricing);
        send(res, 200, await repository.putService({ id: usageKey(body.id, 'id'), label: usageString(body.label, 'label'), expectedRevision: usageRevision(body.expected_revision), state: body.state as 'active' | 'suspended' | undefined, config: body.config as UsageServiceConfig }));
      } else send(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const service = path.match(/^\/admin\/api\/usage\/services\/([^/]+)(\/references)?$/);
    if (service && ((!service[2] && method === 'DELETE') || (service[2] && method === 'GET'))) {
      usageAssert(can(principal, 'usage:issuers'), 'USAGE_FORBIDDEN', '查看模型占用或删除服务需要身份与服务管理权限。', 403);
      let id: string;
      try { id = decodeURIComponent(service[1]!); }
      catch { usageAssert(false, 'USAGE_INVALID_INPUT', '模型服务标识格式不正确。', 400); }
      if (service[2]) { send(res, 200, await repository.serviceReferences(usageKey(id, 'id'))); return true; }
      const body = usageFields(await readBody(req, 4096), ['expected_revision', 'request_key'], ['expected_revision', 'request_key']);
      send(res, 200, await repository.deleteService({ id: usageKey(id, 'id'),
        expectedRevision: usageRevision(body.expected_revision), requestId: usageRequestKey(body), actor: principal.username ?? 'admin-token' }));
      return true;
    }
    if (path === '/admin/api/usage/accounts') {
      if (method === 'GET') {
        const view = query.get('view') ?? 'current';
        usageAssert(['current', 'archived'].includes(view), 'USAGE_INVALID_INPUT', '账户视图不正确。', 400);
        const page = usagePage(query, ['view']); const result = await repository.listAccounts({ limit: page.limit, before: page.cursor ?? undefined, archived: view === 'archived' });
        send(res, 200, { items: result.items, next_cursor: result.nextCursor });
      } else if (method === 'POST') {
        const body = usageFields(await readBody(req, 8192), ['request_key', 'source_id', 'kind', 'label', 'user_id'], ['request_key', 'source_id', 'kind', 'label', 'user_id']);
        usageAssert(body.kind === 'personal' || body.kind === 'organization', 'USAGE_INVALID_INPUT', '请选择个人或组织账户。', 400);
        await identity.requireUsageUser(usageKey(body.user_id, 'user_id'));
        send(res, 200, await repository.createAccount({ requestId: usageRequestKey(body), sourceOwner: 'hub', sourceId: usageKey(body.source_id, 'source_id'), kind: body.kind, label: usageString(body.label, 'label'), userId: usageKey(body.user_id, 'user_id') }));
      } else send(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    const restore = path.match(/^\/admin\/api\/usage\/accounts\/([A-Za-z0-9_.:-]+)\/restore$/);
    if (restore && method === 'POST') {
      const body = usageFields(await readBody(req, 4096), ['request_key','expected_revision'], ['request_key','expected_revision']);
      send(res, 200, await getUsageDeletionRepository(repository).restoreAccount({ id: restore[1]!, requestKey: usageRequestKey(body), expectedRevision: usageRevision(body.expected_revision), actor: principal.username ?? 'admin-token' })); return true;
    }
    const member = path.match(/^\/admin\/api\/usage\/accounts\/([A-Za-z0-9_.:-]+)\/members\/([A-Za-z0-9_.:-]+)$/);
    if (member && method === 'PUT') {
      const body = usageFields(await readBody(req, 4096), ['request_key', 'state', 'expected_revision'], ['request_key', 'state', 'expected_revision']);
      usageAssert(body.state === 'active' || body.state === 'revoked', 'USAGE_INVALID_INPUT', '成员状态不正确。', 400);
      if (body.state === 'active') await identity.requireUsageUser(member[2]!);
      send(res, 200, await repository.setMembership({ requestId: usageRequestKey(body), accountId: member[1]!, userId: member[2]!, state: body.state, expectedRevision: usageRevision(body.expected_revision), actor: principal.username ?? 'admin-token' })); return true;
    }
    const account = path.match(/^\/admin\/api\/usage\/accounts\/([A-Za-z0-9_.:-]+)(\/control)?$/);
    if (account && method === 'GET' && !account[2]) {
      const saved = await repository.getAccount(account[1]!, true);
      usageAssert(saved, 'USAGE_RESOURCE_NOT_FOUND', '账户不存在或已删除。', 404);
      const [members] = await repository.getPool().query('SELECT user_id AS userId,state,revision FROM bz_usage_members WHERE account_id=? ORDER BY user_id LIMIT 500', [account[1]!]);
      send(res, 200, { account: saved, members }); return true;
    }
    if (account?.[2] && method === 'POST') {
      const body = usageFields(await readBody(req, 4096), ['request_key','expected_revision','state'], ['request_key','expected_revision','state']);
      usageAssert(body.state === 'active' || body.state === 'suspended', 'USAGE_INVALID_INPUT', '状态不正确。', 400);
      send(res, 200, await repository.setAccountState({ requestId: usageRequestKey(body), accountId: account[1]!, expectedRevision: usageRevision(body.expected_revision), state: body.state, actor: principal.username ?? 'admin-token' })); return true;
    }
    send(res, 404, { error: 'not_found' });
  } catch (error) { usageHttpError(res, error); }
  return true;
}
