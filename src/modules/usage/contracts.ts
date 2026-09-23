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
  maxOutputTokens: number;
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
