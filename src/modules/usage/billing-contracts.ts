import type { UsageActor, UsageServiceConfig } from './contracts';

export interface BillingAllowanceConfig {
  mode: 'credits' | 'periodic'; priceUsd: number;
  /** Required for periodic plans only; priceUsd remains the sale price. */
  periodAllowanceUsd?: number;
  periodUnit?: 'day' | 'week' | 'month';
  duration: { unit: 'day' | 'month' | 'forever'; count: number };
}
export interface PriceLine { billable: string; unit: 'token' | 'image' | 'megapixel' | 'second' | 'request'; costUsd: string; variant?: string }
export interface PriceTier { minPromptTokens: number; lines: PriceLine[] }
export interface PriceSnapshot { source: 'openrouter'; modelId: string; endpointId: string; currency: 'USD'; fetchedAt: number; lines: PriceLine[]; tiers?: PriceTier[] }
export interface BillingRate { planId: string; planRevision: number; multiplier: number; price: PriceSnapshot }
export interface BillingPlanConfig extends BillingAllowanceConfig { serviceIds: string[]; multiplier: number }
export interface BillingPlan {
  id: string; label: string; revision: number; state: 'active' | 'suspended';
  config: BillingPlanConfig; createdAt: number; updatedAt: number;
}
export interface BillingGrant {
  id: string; accountId: string; planId: string; planRevision: number; label: string;
  revision: number; state: 'active' | 'suspended'; sourceOwner: string;
  startsAt: number; expiresAt: number | null; config: BillingAllowanceConfig;
}
export interface BillingSummary {
  schema: 'bailing.billing-summary.v1'; accountId: string; grant: BillingGrant | null;
  plan: Pick<BillingPlan, 'id' | 'label' | 'revision'> & { serviceIds: string[]; multiplier: number } | null;
  availableUsd: number; consumedUsd: number; currentPeriodConsumedUsd: number;
  overageUsd: number; resetAt: number | null; expiresAt: number | null; pendingRequests: number;
  presentation: UsagePresentation;
}
/** Customer display only. Raw Token accounting remains an independent machine contract. */
export interface UsagePresentation {
  schema: 'bailing.usage-presentation.v1';
  kind: 'credits' | 'percentage' | 'none';
  state: 'active' | 'depleted' | 'not_started' | 'expired' | 'suspended' | 'unavailable';
  remaining: number | null; total: number | null; displayValue: string | null;
}
export interface TokenUsage { inputTokens: number; outputTokens: number; totalTokens: number }
export interface BillingRequest {
  id: string; operationId: string; accountId: string; userId: string; sessionId: string;
  serviceId: string; conversationId: string | null; turnId: string | null; requestHash: string;
  revision: number; state: 'admitted' | 'dispatch_committed' | 'completed' | 'unknown' | 'cancelled' | 'failed';
  resultState: 'pending' | 'complete' | 'unknown' | 'cancelled' | 'failed'; billingState: 'pending' | 'settled';
  serviceConfig: UsageServiceConfig; serviceRevision: number; model: string; fence: string | null;
  grantId: string; grantRevision: number; periodStart: number; periodEnd: number | null;
  billingRate: BillingRate;
  grantConfig: BillingAllowanceConfig; response: Record<string, unknown> | null; resultHash: string | null; usage: TokenUsage | null;
  rawUsage: Record<string, unknown> | null; referenceCostUsd: number | null; billedUsd: number | null; overageUsd: number | null; cancelledAt: number | null;
  createdAt: number; updatedAt: number; created?: boolean;
}
export interface BillingAdmissionInput {
  actor: UsageActor; operationId: string; serviceId: string; conversationId: string | null;
  turnId: string | null; requestHash: string; expectedServiceRevision: number;
  serviceConfig: UsageServiceConfig; model: string; priceSnapshot: PriceSnapshot;
}
export interface BillingCompletionInput {
  response: Record<string, unknown>; usage?: { inputTokens: number; outputTokens: number };
  rawUsage?: Record<string, unknown>; executionId?: string;
}
