import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AppConfig } from '../../core/config/config';
import type { ManagedRuntimeMaintenanceStateV1 } from '../../app/runtime-lifecycle';

export type KernelSchedulerModeV1 = 'standalone' | 'managed';

/**
 * The only human identity a trusted Host may inject into Core. Machine, Client,
 * Executor and server-token identities always remain owned by Core credentials.
 */
export interface KernelHostAdminSessionV1 {
  readonly kind: 'admin';
  readonly via: 'session';
  readonly username: string;
  readonly role?: string;
  readonly permissions: readonly string[];
}

export interface KernelIdentityProviderV1 {
  authenticate(req: IncomingMessage, url: URL): Promise<KernelHostAdminSessionV1 | null>;
  handleLogin?(req: IncomingMessage, res: ServerResponse): Promise<void>;
  handleLogout?(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/** Process-wide admission gate. Kernel-local queue lifecycle remains private. */
export interface KernelExecutionGateV1 {
  run<T>(task: () => Promise<T>): Promise<T>;
}

export interface KernelLaunchRequestV1 {
  readonly requestId: string;
  readonly routeKey: string | null;
  readonly target: string;
  readonly project: string | null;
  readonly profileName: string;
  readonly permission?: string;
  readonly source: string;
  readonly clientAppId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly callbackUrl?: string;
  readonly session: Readonly<{ sessionId: string; isContinue: boolean }>;
  readonly threadScope: string;
  readonly principalId: string | null;
  readonly channel: string;
}

export interface KernelLaunchGuardDecisionV1 {
  readonly ok: boolean;
  readonly reason?: string;
  readonly error?: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export type KernelJobStreamPhaseNameV1 = 'model' | 'tool';
export type KernelJobStreamResetReasonV1 = 'model_round' | 'tool_call' | 'retry' | 'fallback' | 'protocol_violation';
export type KernelJobStreamEventInputV1 =
  | { type: 'phase'; data: { name: KernelJobStreamPhaseNameV1; round: number } }
  | { type: 'reset'; data: { reason: KernelJobStreamResetReasonV1; round?: number } }
  | { type: 'delta'; data: { text: string; round: number } };
export type KernelJobStreamEventV1 = KernelJobStreamEventInputV1 & { seq: number; ts: string };

export interface KernelJobStreamReadResultV1 {
  events: KernelJobStreamEventV1[];
  truncated: boolean;
  latestSeq: number;
}

export interface KernelJobStreamBrokerV1 {
  publish(jobId: string, event: KernelJobStreamEventInputV1): KernelJobStreamEventV1;
  read(jobId: string, afterSeq?: number): KernelJobStreamReadResultV1;
  waitFor(jobId: string, afterSeq: number, timeoutMs: number): Promise<void>;
  seal(jobId: string): void;
}

export type KernelBrandingAssetKindV1 = 'logo' | 'favicon';

export interface KernelBrandingSnapshotV1 {
  site_name: string;
  browser_title: string;
  site_description: string;
  site_keywords: string[];
  login_heading: string;
  login_subheading: string;
  has_logo: boolean;
  has_favicon: boolean;
  revision: string;
  updated_at: string | null;
}

export interface KernelBrandingAssetV1 {
  contentType: string;
  data: Buffer;
  revision: string;
}

export interface KernelBrandingUpdateV1 {
  site_name?: unknown;
  browser_title?: unknown;
  site_description?: unknown;
  site_keywords?: unknown;
  login_heading?: unknown;
  login_subheading?: unknown;
  logo_data_url?: unknown;
  favicon_data_url?: unknown;
}

export interface KernelBrandingProviderV1 {
  readonly management: {
    source: 'local' | 'platform';
    writable: boolean;
    management_url?: string;
  };
  read(): Promise<KernelBrandingSnapshotV1>;
  readAsset(kind: KernelBrandingAssetKindV1): Promise<KernelBrandingAssetV1 | null>;
  update(input: KernelBrandingUpdateV1): Promise<KernelBrandingSnapshotV1>;
}

export interface KernelReadinessReportV1 {
  ready: boolean;
  checks: {
    state_backend: 'ok';
    database: 'ok' | 'skipped' | 'failed';
    migrations: { status: 'ok' | 'skipped' | 'pending' | 'failed'; pending: number };
  };
}

export interface KernelStandaloneServerV1 {
  server: Server;
  start(): Promise<void>;
  shutdown(signal: NodeJS.Signals | 'test'): Promise<void>;
  registerSignalHandlers(): void;
  isShuttingDown(): boolean;
}

export interface CreateBailingHubKernelInputV1 {
  /** Unique trusted identifier inside a Host process; never accept raw end-user input. */
  instanceKey: string;
  /** AppConfig remains an explicitly supported Kernel v1 configuration contract. */
  config: AppConfig;
  schedulerMode?: KernelSchedulerModeV1;
  identityProvider?: KernelIdentityProviderV1;
  brandingProvider?: KernelBrandingProviderV1;
  launchGuard?: (spec: KernelLaunchRequestV1) => Promise<KernelLaunchGuardDecisionV1> | KernelLaunchGuardDecisionV1;
  jobStream?: KernelJobStreamBrokerV1;
  executionQueue?: KernelExecutionGateV1;
  /** Host-owned due-state may outlive an evicted managed Kernel, but holds no Store/timer. */
  managedMaintenanceState?: ManagedRuntimeMaintenanceStateV1;
  /** Host may deny or rewrite DB-configured local project paths. */
  projectPathPolicy?: (input: { name: string; path: string }) => Promise<string | null> | string | null;
  /** Optional same-origin path prefix supplied by a trusted embedding host. */
  httpMountPath?: string;
  /** Disable local bootstrap explicitly; identityProvider also disables it unconditionally. */
  bootstrapLocalAdmin?: boolean;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface BailingHubKernelV1 {
  readonly instanceKey: string;
  readonly config: AppConfig;
  initialize(): Promise<void>;
  handle(req: IncomingMessage, res: ServerResponse, url?: URL): Promise<void>;
  /** Managed mode is Host-driven; standalone mode retains the native scheduler behavior. */
  tick(maxClaims?: number): Promise<number>;
  readiness(): Promise<KernelReadinessReportV1>;
  close(drainMs?: number): Promise<void>;
  createStandaloneServer(options?: { exit?: (code: number) => void }): KernelStandaloneServerV1;
  isClosing(): boolean;
}
