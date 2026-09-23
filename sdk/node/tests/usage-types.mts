import { UsageIssuerClient, UsageIssuerError, type BillingPlan, type BillingGrant, type BillingSummary } from '@bailinghub/connect/usage';

// Compile-only public package entrypoint check. This function is never called.
async function billingTypes(client: UsageIssuerClient) {
  const plans: BillingPlan[] = (await client.listBillingPlans()).items;
  const login = await client.exchangeSession({ request_key: 'login', tenant: 'example', subject: 'user', service_id: 'text', model_access: 'token_gateway' });
  const grant: BillingGrant = await client.grantBillingPlan(login.session.accountId, { request_key: 'grant', plan_id: 'monthly', expected_revision: 0 });
  const summary: BillingSummary = await client.getBillingSummary(grant.accountId);
  await client.controlBillingPlan(grant.accountId, { request_key: 'pause', expected_revision: grant.revision, state: 'suspended' });
  await client.revokeUser({ tenant: 'example', subject: 'user' });
  const allowance: number | undefined = plans[0]?.config.periodAllowanceUsd;
  // @ts-expect-error A billing grant requires the original request key.
  await client.grantBillingPlan(grant.accountId, { plan_id: 'monthly', expected_revision: 0 });
  // @ts-expect-error Old token plan methods are not compatibility aliases.
  await client.listTokenPlans();
  // @ts-expect-error The summary exposes dollar amounts, not an old token balance.
  const obsolete = summary.availableTokens;
  return { summary, allowance, obsolete };
}
void billingTypes;
const error = new UsageIssuerError('USAGE_REVISION_CONFLICT', 409, 'rejected', 'grant');
const outcome: 'unknown' | 'rejected' = error.outcome;
void outcome;
