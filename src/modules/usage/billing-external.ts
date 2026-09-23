import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, send } from '../../app/http';
import { usageAssert } from './errors';
import { authenticateUsageIssuerRequest, getUsageIdentity, usageFields, usageKey } from './identity';
import { getBillingRepository } from './billing-repository';
import type { UsageRepository } from './repository';

/** External products can use the same plan/grant implementation with explicit source ownership. */
export async function handleExternalBillingUsage(repository: UsageRepository, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const match = url.pathname.match(/^\/usage\/v1\/external\/billing\/accounts\/([A-Za-z0-9_.:-]+)\/(summary|grant|control)$/);
  const plans = url.pathname === '/usage/v1/external/billing/plans';
  if (!match && !plans) return false;
  const identity = getUsageIdentity(repository), tokens = getBillingRepository(repository);
  usageAssert(await tokens.ready(), 'USAGE_UNSUPPORTED', '美元套餐尚未就绪。', 503);
  const { issuer } = await authenticateUsageIssuerRequest(identity, req, req.method === 'GET' ? 'usage:read' : 'entitlements:write');
  if (plans) {
    usageAssert(req.method === 'GET', 'USAGE_INVALID_INPUT', '使用只读套餐目录。', 405);
    send(res, 200, { items: (await tokens.listPlans()).filter(plan => plan.config.serviceIds.every(id => issuer.serviceIds.includes(id))) }); return true;
  }
  const [, accountId, action] = match!;
  const summary = await tokens.summary(accountId!);
  if (req.method === 'GET' && action === 'summary') {
    // Account ownership must be proven even when no new billing grant exists yet.
    await identity.requireIssuerAccount(issuer, accountId!);
    send(res, 200, summary); return true;
  }
  usageAssert(req.method === 'POST' && (action === 'grant' || action === 'control'), 'USAGE_INVALID_INPUT', '不支持的套餐操作。', 405);
  const body = await readBody(req, 8192);
  if (action === 'grant') {
    const fields = usageFields(body, ['request_key','plan_id','expected_revision','starts_at'], ['request_key','plan_id','expected_revision']);
    const plan = (await tokens.listPlans()).find(p => p.id === usageKey(fields.plan_id, 'plan_id'));
    usageAssert(plan, 'USAGE_NOT_FOUND', '套餐不存在。', 404);
    usageAssert(plan.config.serviceIds.every(id => issuer.serviceIds.includes(id)), 'USAGE_FORBIDDEN', '此来源未获准发放该套餐。', 403);
  }
  await identity.requireIssuerAccount(issuer, accountId!);
  if (action === 'grant') usageAssert(issuer.permissions.includes('allowance:grant'), 'USAGE_FORBIDDEN', '开通额度还需要 allowance:grant 权限。', 403);
  send(res, 200, action === 'grant' ? await tokens.grant(accountId!, body, `issuer:${issuer.id}`) : await tokens.control(accountId!, body, `issuer:${issuer.id}`));
  return true;
}
