/** Server-only business issuer API. USD billing and model identity are separate from business authorization. */
export interface UsageIssuerOptions {
  baseUrl: string;
  issuerToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
export interface UsageIdentityInput { tenant: string; subject: string; generation?: string }
export interface UsageExchangeInput extends UsageIdentityInput {
  request_key: string;
  service_id: string;
  account_id?: string;
  model_access?: 'service' | 'token_gateway';
}
export interface UsageSession {
  sessionId: string; userId: string; accountId: string; issuerId: string;
  serviceId: string; expiresAt: number; modelAccess?: 'service' | 'token_gateway';
}
export interface UsageExchangeResult {
  schema: 'bailing.usage-session.v1'; credential: string; session: UsageSession;
}
export interface BillingAllowanceConfig {
  mode: 'credits' | 'periodic';
  /** Sale price; also the allowance amount for credits plans. */
  priceUsd: number;
  /** Required and positive for periodic plans; absent for credits plans. */
  periodAllowanceUsd?: number;
  periodUnit?: 'day' | 'week' | 'month';
  duration: { unit: 'day' | 'month' | 'forever'; count: number };
}
export interface BillingPlanConfig extends BillingAllowanceConfig { serviceIds: string[]; multiplier: number }
export interface BillingPlan {
  id: string; label: string; revision: number; state: 'active' | 'suspended';
  config: BillingPlanConfig; createdAt: number; updatedAt: number;
}
export interface BillingGrantInput {
  request_key: string; plan_id: string; expected_revision: number; starts_at?: number;
}
export interface BillingControlInput { request_key: string; expected_revision: number; state: 'active' | 'suspended' }
export interface BillingGrant {
  id: string; accountId: string; planId: string; planRevision: number; label: string;
  revision: number; state: 'active' | 'suspended'; sourceOwner: string;
  startsAt: number; expiresAt: number | null; config: BillingAllowanceConfig;
}
export interface UsagePresentation {
  schema: 'bailing.usage-presentation.v1'; kind: 'credits' | 'percentage' | 'none';
  state: 'active' | 'depleted' | 'not_started' | 'expired' | 'suspended' | 'unavailable';
  remaining: number | null; total: number | null; displayValue: string | null;
}
export interface BillingSummary {
  schema: 'bailing.billing-summary.v1'; accountId: string; grant: BillingGrant | null;
  plan: Pick<BillingPlan, 'id' | 'label' | 'revision'> & { serviceIds: string[]; multiplier: number } | null;
  availableUsd: number; consumedUsd: number; currentPeriodConsumedUsd: number;
  overageUsd: number; resetAt: number | null; expiresAt: number | null; pendingRequests: number;
  presentation: UsagePresentation;
}
export interface UsageFeedback {
  schema?: string; code?: string; dispatch?: string; retryable?: boolean;
  next_action?: string; resetAt?: number; reset_at?: number;
}
export class UsageIssuerError extends Error {
  constructor(code: string, status: number | undefined, outcome: 'rejected' | 'unknown', requestKey?: string, feedback?: UsageFeedback);
  code: string; status: number | undefined; outcome: 'rejected' | 'unknown';
  requestKey: string | undefined; feedback?: UsageFeedback;
}
export class UsageIssuerClient {
  constructor(options: UsageIssuerOptions);
  exchangeSession(input: UsageExchangeInput): Promise<UsageExchangeResult>;
  revokeUser(input: UsageIdentityInput): Promise<{ revoked: true }>;
  listBillingPlans(): Promise<{ items: BillingPlan[] }>;
  grantBillingPlan(accountId: string, input: BillingGrantInput): Promise<BillingGrant>;
  controlBillingPlan(accountId: string, input: BillingControlInput): Promise<BillingGrant>;
  getBillingSummary(accountId: string): Promise<BillingSummary>;
}
