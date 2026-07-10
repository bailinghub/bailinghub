// 工具治理运行面纯门面：只导出可注入实现，不绑定 OSS 默认 runtime。
// OSS 默认包装集中在 tools-runtime-default.ts。
export { assembleToolRuntimeFor } from './tool-assembly';
export { resolveSendChannelsFor, runSendMessageFor, sendToolDef } from './builtin-tools';
export { handleToolDefsFor, handleToolInvokeFor, toolsForWorkItemFor, type ToolProxyDeps } from './tool-proxy';
export {
  conversationAddrOf,
  embedConfigOf,
  maxCallsOf,
  resolveAllowedToolsFor,
  retrievalOptsOf,
  subjectOf,
  type AllowedToolContext,
} from './tool-context';
export {
  getAuthzProbe,
  probeAuthorizeFor,
  refreshProviderSpecFor,
  reindexToolProviderIndexFor,
  retrievalProbeFor,
  runSpecAutoRefreshFor,
  type AuthzProbeResult,
} from './tool-specs';
