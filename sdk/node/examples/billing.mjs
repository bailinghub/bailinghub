import { UsageIssuerClient } from '../src/usage.mjs';

/** Invoke after authenticating a user in your own backend. No network call occurs on import. */
export async function prepareBillingPlan({ baseUrl, issuerToken, identity, loginRequestKey, serviceId, planId, orderRequestKey }) {
  const issuer = new UsageIssuerClient({ baseUrl, issuerToken });
  const login = await issuer.exchangeSession({
    ...identity, request_key: loginRequestKey, service_id: serviceId, model_access: 'token_gateway',
  });
  const accountId = login.session.accountId;
  const summary = await issuer.getBillingSummary(accountId);
  // Persist this exact body with your order before calling grantBillingPlan.
  const grantInput = { request_key: orderRequestKey, plan_id: planId, expected_revision: summary.grant?.revision ?? 0 };
  return { credential: login.credential, session: login.session, accountId, grantInput };
}

/** Submit the saved input, including its original revision. Do not prepare it again on retry. */
export async function applyBillingPlan({ baseUrl, issuerToken, accountId, grantInput }) {
  const issuer = new UsageIssuerClient({ baseUrl, issuerToken });
  await issuer.grantBillingPlan(accountId, grantInput);
  return (await issuer.getBillingSummary(accountId)).presentation;
}
