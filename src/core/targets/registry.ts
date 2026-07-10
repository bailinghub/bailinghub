// 调度目标插座板：target 的特性(在哪执行/是否无状态/是否要项目/超时)由 bz_targets 注册表驱动，不写死在代码。
// 新执行器接入 = 后台注册一行(kind=executor) + 自带执行器来认领（web/connect/executor.mjs 或任意实现），中枢代码零改动。
// inhub 类 target 在中枢进程内执行，必须由组合根显式 registerTargetAdapter。
// core 只维护插座表和目标特性，不 import 具体云厂商/模型适配器。
import type { TargetAdapter } from './adapter';
import type { TargetDef } from '../contracts/types';

export interface TargetRegistryStore {
  targets: { list(): Promise<TargetDef[]> };
}

/** inhub 适配器（中枢进程内执行）。executor 类 target 不需要：执行器自带实现。 */
const ADAPTERS: Record<string, TargetAdapter> = {};

/** 由 app 组合根注册内置 inhub 适配器；第三方 executor 目标不需要注册代码适配器。 */
export function registerTargetAdapter(name: string, adapter: TargetAdapter): void {
  ADAPTERS[name] = adapter;
}

/** 内置目标（无 DB 时的兜底；DB 注册表加载后以 DB 为准、同名覆盖）。executor 类目标全部走后台注册，内核不预设。 */
const BUILTIN: TargetDef[] = [
  { name: 'llm', kind: 'inhub', stateless: true, needs_project: false, timeout_ms: 120000, enabled: true },
];

let registry = new Map<string, TargetDef>(BUILTIN.map((t) => [t.name, t]));
let registryStore: TargetRegistryStore | null = null;

/** 由运行时组合根注入配置仓储；registry 本身不依赖 runtime 单例。 */
export function bindTargetRegistryStore(store: TargetRegistryStore | null): void {
  registryStore = store;
}

/** 用 DB 注册表刷新插座板（server 启动时 + 每 60s + 后台改动后调用）。 */
export function setTargets(rows: TargetDef[]): void {
  const next = new Map<string, TargetDef>(BUILTIN.map((t) => [t.name, t]));
  for (const r of rows) next.set(r.name, r);
  registry = next;
}

/** 从 DB 注册表刷新插座板（server 启动 + 每 60s + 后台目标 CRUD 后调用）。DB 抖动时保留上一份缓存，不影响调度。 */
export async function refreshTargets(): Promise<void> {
  if (!registryStore) return;
  try { setTargets(await registryStore.targets.list()); }
  catch { /* DB 抖动用上一份缓存/内置兜底 */ }
}

export function listTargetDefs(): TargetDef[] {
  return [...registry.values()];
}

export function getTargetDef(name: string): TargetDef | null {
  return registry.get(name) ?? null;
}

export function getAdapter(target: string): TargetAdapter | null {
  return ADAPTERS[target] ?? null;
}

/** 是否为远端执行器目标（由执行器拉取认领，而非中枢内执行） */
export function isRemoteExecutorTarget(target: string): boolean {
  return registry.get(target)?.kind === 'executor';
}

/** 中枢是否认识该 target */
export function isKnownTarget(target: string): boolean {
  return registry.has(target);
}

export function targetEnabled(target: string): boolean {
  return registry.get(target)?.enabled !== false;
}

/** 该 target 是否需要 project（目录） */
export function targetNeedsProject(target: string): boolean {
  return registry.get(target)?.needs_project === true;
}

/** 无状态大脑（自身无会话记忆）：派活时必须从对话总账装配上下文；有状态大脑只在会话缓存未命中时装配。 */
export function targetIsStateless(target: string): boolean {
  return registry.get(target)?.stateless === true;
}

/** inhub 执行超时（毫秒）：路由 target_config.timeout_ms > 注册表 timeout_ms > 默认 120s */
export function targetTimeoutMs(target: string, targetConfig: Record<string, unknown>): number {
  const fromRoute = Number(targetConfig['timeout_ms']);
  if (fromRoute > 0) return fromRoute;
  const fromDef = registry.get(target)?.timeout_ms ?? 0;
  return fromDef > 0 ? fromDef : 120000;
}
