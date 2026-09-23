import type { IncomingMessage, ServerResponse } from 'node:http';
import { can, type Principal } from '../app/auth';
import { readBody, send } from '../app/http';
import { usageAssert } from '../modules/usage/errors';
import { usagePage, usageRequestKey, usageRevision } from '../modules/usage/http';
import { usageFields } from '../modules/usage/identity';
import { getUsageDeletionRepository, usageDeletionId } from '../modules/usage/usage-deletion';
import { getBillingRepository } from '../modules/usage/billing-repository';
import type { UsageRepository } from '../modules/usage/repository';
import { serviceAvailability } from '../modules/usage/service-availability';
import { validateBillingPlan, billingKey } from '../modules/usage/billing-ledger';

/** Caller has already verified Console identity and usage read/write permissions. */
export async function handleAdminBillingUsage(repository: UsageRepository, method: string, path: string,
  req: IncomingMessage, res: ServerResponse, principal: Principal): Promise<boolean> {
  if (!path.startsWith('/admin/api/usage/billing/')) return false;
  usageAssert(principal.kind === 'admin', 'USAGE_FORBIDDEN', '需要后台管理身份。', 403);
  const tokens = getBillingRepository(repository);
  usageAssert(await tokens.configurationReady(), 'USAGE_UNSUPPORTED', '套餐配置尚未就绪，请核对迁移。', 503);
  const billingReady = await tokens.ready();
  if (method !== 'GET') usageAssert(billingReady, 'USAGE_BILLING_UNSUPPORTED', '美元计费尚未就绪，请核对迁移。', 503);
  const query = new URL(req.url ?? path, 'http://local').searchParams;
  if (path === '/admin/api/usage/billing/plans') {
    if (method === 'GET') send(res, 200, { items: await tokens.listPlans(), billing_ready: billingReady, period_allowance_supported: true });
    else if (method === 'POST') {
      const body = usageFields(await readBody(req, 32 * 1024), ['id','label','expected_revision','state','config'], ['id','label','expected_revision','config']);
      const config = validateBillingPlan(body.config), id = billingKey(body.id);
      const [rows] = await repository.getPool().query<any[]>('SELECT config_json FROM bz_usage_billing_plans WHERE id=?', [id]);
      const raw = rows[0]?.config_json;
      const original = raw ? validateBillingPlan(typeof raw === 'string' ? JSON.parse(raw) : raw).serviceIds : [];
      // Existing selections may become unavailable later. Let the operator keep
      // or remove them while preventing a newly selected unusable service.
      for (const serviceId of config.serviceIds.filter(value => !original.includes(value))) {
        const service = await repository.getService(serviceId);
        usageAssert(service, 'USAGE_SERVICE_NOT_FOUND', '所选模型服务不存在。', 404);
        const ready = await serviceAvailability(repository, service);
        usageAssert(ready.state === 'ready', ready.code ?? 'USAGE_SERVICE_UNAVAILABLE', ready.message ?? '请先完成模型服务配置。', 409);
      }
      send(res, 200, await tokens.putPlan(body));
    }
    else send(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  const deletion = path.match(/^\/admin\/api\/usage\/billing\/plans\/([^/]+)(\/deletion-preview)?$/);
  if (deletion && ((!deletion[2] && method === 'DELETE') || (deletion[2] && method === 'GET'))) {
    const id = usageDeletionId(deletion[1]!, 'plan'), resources = getUsageDeletionRepository(repository);
    if (deletion[2]) send(res, 200, await resources.preview('plan', id));
    else {
      const body = usageFields(await readBody(req, 4096), ['request_key','expected_revision'], ['request_key','expected_revision']);
      send(res, 200, await resources.remove({ kind: 'plan', id, requestKey: usageRequestKey(body), expectedRevision: usageRevision(body.expected_revision), actor: principal.username ?? 'admin-billing' }));
    }
    return true;
  }
  const account = path.match(/^\/admin\/api\/usage\/billing\/accounts\/([A-Za-z0-9_.:-]+)\/(summary|grant|control|reset|requests)$/);
  if (!account) { send(res, 404, { error: 'not_found' }); return true; }
  const [, id, action] = account;
  if (method === 'GET' && action === 'summary') send(res, 200, await tokens.summary(id!));
  else if (method === 'GET' && action === 'requests') {
    usageAssert(billingReady, 'USAGE_BILLING_UNSUPPORTED', '原请求计量需要配套更新计费内核与迁移后查看。', 503);
    const { limit, cursor } = usagePage(query);
    const page = await tokens.listRequests(id!, { limit, cursor });
    send(res, 200, page);
  } else if (method === 'POST' && action === 'grant') {
    usageAssert(can(principal, 'usage:adjust'), 'USAGE_FORBIDDEN', '开通美元额度需要额度调整权限。', 403);
    send(res, 200, await tokens.grant(id!, await readBody(req, 8192), 'hub'));
  } else if (method === 'POST' && action === 'reset') {
    usageAssert(can(principal, 'usage:adjust'), 'USAGE_FORBIDDEN', '重置额度需要额度调整权限。', 403);
    const body = usageFields(await readBody(req, 4096), ['request_key','expected_revision'], ['request_key','expected_revision']);
    send(res, 200, await tokens.resetAllowance(id!, body, principal.username ?? 'admin-token'));
  } else if (method === 'POST' && action === 'control') send(res, 200, await tokens.control(id!, await readBody(req, 4096), 'hub'));
  else send(res, 405, { error: 'method_not_allowed' });
  return true;
}
