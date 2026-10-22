import type { PricingBinding } from './pricing';
import type { ModelToolConfig } from './model-tools';
import type { PoolConnection } from "mysql2/promise";
export interface UsageActor {
  userId: string;
  accountId: string;
  sessionId: string;
  serviceId?: string;
  modelAccess?: "service" | "token_gateway";
}
export type UsageActorValidator = (connection: PoolConnection, actor: UsageActor) => Promise<void>;
export interface UsageAccount {
  id: string;
  kind: "personal" | "organization";
  label: string;
  state: "active" | "suspended" | "archived";
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export interface UsageServiceConfig {
  purpose?: "chat" | "tool";
  pricing?: PricingBinding;
  tool?: ModelToolConfig;
  credential: string;
  model: string;
  providerScope: string;
  maxInputBytes: number;
  /** Operator service ceiling, not the model vendor's maximum capability. */
  maxOutputTokens: number;
  /** Explicit output policy is an all-or-none group; absent means legacy behavior. */
  defaultOutputTokens?: number;
  outputTokenParameter?: 'max_tokens' | 'max_completion_tokens';
  outputBudgetScope?: 'completion_total' | 'final_answer';
  /** Verified vendor maximum for the configured parameter/scope; unknown remains absent. */
  modelMaxOutputTokens?: number;
  timeoutMs: number;
  /** Operator-verified model metadata; absence means unknown, never a guessed context window. */
  contextWindowTokens?: number;
  inputModalities?: ('text' | 'image')[];
}
export interface UsageService {
  id: string;
  label: string;
  state: "active" | "suspended";
  revision: number;
  config: UsageServiceConfig;
}
export interface CreateUsageAccountInput {
  requestId: string;
  sourceOwner: string;
  sourceId: string;
  kind: "personal" | "organization";
  label: string;
  userId: string;
}
