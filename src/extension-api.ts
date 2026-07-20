// Extension API: stable, injectable building blocks for custom deployments.
// Do not export OSS default wrappers or runtime singletons from this file.

export { loadConfig } from './core/config/config';
export type { AppConfig, MysqlConfig } from './core/config/config';
export type { AlertRule, AuditEntry, AudiencePolicy, Channel, ChatEntry, Client, Credential, ExecutorToken, Job, JobRating, JobStatus, NormalizedPrincipal, ProjectReg, Route, RunRequest, StorageBucket, TargetDef, ToolApproval, ToolProvider } from './core/contracts/types';
export type { PageRule } from './core/platform/pagecontext';
export type { RuntimeStateStore } from './core/state/state-contracts';
export type {
  AdminRepositoryContract,
  AlertRuleRepositoryContract,
  ApprovalLedgerContract,
  ChannelRepositoryContract,
  ChatConfigRepositoryContract,
  ClientRepositoryContract,
  ConfigStore,
  ConfigStoreContract,
  ConversationLedgerContract,
  CredentialRepositoryContract,
  DeliveryDlqLedgerContract,
  ExecutorLedgerContract,
  ExecutorTokenRepositoryContract,
  KbDatasourceRepositoryContract,
  KnowledgeRepositoryContract,
  ObservabilityLedgerContract,
  ProjectRepositoryContract,
  RateLimitLedgerContract,
  RouteRepositoryContract,
  StorageBucketRepositoryContract,
  TargetRepositoryContract,
  ToolCallLedgerContract,
  ToolEmbeddingRepositoryContract,
  ToolProviderRepositoryContract,
} from './infrastructure/config/configstore';

export {
  OSS_EDITION,
  SINGLE_SCOPE_CAPABILITY,
  SINGLE_SCOPE_ID,
  SINGLE_SCOPE_KIND,
  SingleScopeResolver,
  assertSingleScope,
  createRuntimeContext,
  isSingleScope,
  singleScope,
  systemActor,
} from './core/edition';
export type {
  ConsoleCapabilities,
  RuntimeActor,
  RuntimeContext,
  RuntimeScope,
  RuntimeSource,
  ScopeResolveInput,
  ScopeResolver,
  StoreFactory,
} from './core/edition';

export { createRuntimeComposition, registerBuiltinTargetAdapters } from './app/runtime-composition';
export type { RuntimeComposition, RuntimeCompositionEdition } from './app/runtime-composition';

export { createBailingHttpServer } from './app/http-server';
export type { BailingHttpServer, BailingHttpServerDeps } from './app/http-server';

export { createRuntimeContextHelpers } from './app/runtime-context';
export type { RuntimeContextHelperDeps, RuntimeContextHelpers } from './app/runtime-context';

export { createEngineRuntime } from './app/engine';
export type { EngineRuntime, EngineRuntimeDeps, LaunchGuardDecision } from './app/engine';
export type { LaunchSpec } from './core/runtime/launch-runtime';
export { CHAT_STREAM_PROTOCOL, InMemoryJobStreamBroker } from './core/runtime/job-stream';
export type { InMemoryJobStreamOptions, JobStreamBroker, JobStreamEvent, JobStreamEventInput, JobStreamReadResult } from './core/runtime/job-stream';

export { initializeRuntimeLifecycleFor, scheduleBootRecoveryFor, startRuntimeSchedulersFor } from './app/runtime-lifecycle';
export type { RuntimeLifecycleDeps, RuntimeSchedulers } from './app/runtime-lifecycle';

export { completeTraceEntry } from './core/runtime/trace-runtime';
export { refreshTargets, setTargets } from './core/targets/registry';

export { authenticateFor, handleLoginFor, handleLogoutFor, namedRateLimitedFor, rateLimitedFor } from './app/auth';
export type { AuthRuntimeDeps, Principal } from './app/auth';

export { handlePublicHttpFor } from './routes/public';
export type { PublicHttpDeps } from './routes/public';

export { handlePrivateHttpFor } from './routes/private';
export type { PrivateHttpDeps } from './routes/private';

export { handleAdminApiFor } from './routes/admin';
export type { AdminApiDeps } from './routes/admin';

export { handleAdminRuntimeApiFor } from './routes/admin-runtime';
export type { AdminRuntimeApiDeps } from './routes/admin-runtime';

export { handleAdminAccessApiFor } from './routes/admin-access';
export type { AdminAccessApiDeps } from './routes/admin-access';

export { handleAdminChatApiFor } from './routes/admin-chat';
export type { AdminChatApiDeps } from './routes/admin-chat';

export { handleAdminDispatchConfigApiFor } from './routes/admin-dispatch-config';
export type { AdminDispatchConfigApiDeps } from './routes/admin-dispatch-config';

export { handleAdminInfraApiFor } from './routes/admin-infra';
export type { AdminInfraApiDeps } from './routes/admin-infra';

export { handleAdminKbApiFor } from './routes/admin-kb';
export type { AdminKbApiDeps } from './routes/admin-kb';

export { handleAdminToolProviderApiFor } from './routes/admin-tool-providers';
export type { AdminToolProviderApiDeps } from './routes/admin-tool-providers';

export { handleRunFor } from './routes/run';
export type { RunApiDeps } from './routes/run';

export { handleSendFor } from './routes/send';
export type { SendApiDeps } from './routes/send';

export { handleExecutorClaimFor, handleExecutorHeartbeatFor, handleExecutorResultFor } from './routes/executor';
export type { ExecutorApiDeps } from './routes/executor';

export { handleApprovalDecisionFor } from './routes/approvals';
export type { ApprovalDecisionDeps } from './routes/approvals';

export {
  handleChatConfigFor,
  handleChatFor,
  handleChatEventsFor,
  handleChatRateFor,
  handleChatThreadFor,
  handleChatUploadFor,
  serveChatDemoFor,
} from './routes/chat';
export type { ChatApiDeps } from './routes/chat';

export { handleKbIngestFor, handleKbIngestListFor, handleKbSearchFor } from './routes/kb';
export type { KbApiDeps } from './routes/kb';

export { handleWecomInboundFor } from './routes/wecom';
export type { WecomApiDeps } from './routes/wecom';

export {
  assembleToolRuntimeFor,
  conversationAddrOf,
  embedConfigOf,
  getAuthzProbe,
  handleToolDefsFor,
  handleToolInvokeFor,
  maxCallsOf,
  probeAuthorizeFor,
  refreshProviderSpecFor,
  reindexToolProviderIndexFor,
  resolveAllowedToolsFor,
  resolveSendChannelsFor,
  retrievalOptsOf,
  retrievalProbeFor,
  runSendMessageFor,
  runSpecAutoRefreshFor,
  sendToolDef,
  subjectOf,
  toolsForWorkItemFor,
} from './app/tools-runtime';
export type { AllowedToolContext, AuthzProbeResult, ToolProxyDeps } from './app/tools-runtime';
