// OSS 默认工具治理运行面门面：这里才 re-export 默认 runtime 包装。
// 自定义部署应使用 tools-runtime.ts 的纯可注入导出。
export * from './tools-runtime';
export { assembleToolRuntime } from './tool-assembly-default';
export { resolveSendChannels, runSendMessage } from './builtin-tools-default';
export { handleToolDefs, handleToolInvoke, toolsForWorkItem } from './tool-proxy-default';
export { resolveAllowedTools } from './tool-context-default';
export {
  probeAuthorize,
  refreshProviderSpec,
  reindexToolProviderIndex,
  retrievalProbe,
  runSpecAutoRefresh,
} from './tool-specs-default';
