// 调度目标插座板：target 的特性(在哪执行/是否无状态/是否要项目/超时)由 bz_targets 注册表驱动，不写死在代码。
// 新执行器接入 = 后台注册一行(kind=executor) + 自带执行器来认领（web/connect/executor.mjs 或任意实现），中枢代码零改动。
// inhub 类 target 在中枢进程内执行，必须由组合根显式 registerTargetAdapter。
// core 只维护插座表和目标特性，不 import 具体云厂商/模型适配器。
import type { TargetAdapter } from './adapter';
import type { TargetDef } from '../contracts/types';

export interface TargetRegistryStore {
  targets: { list(): Promise<TargetDef[]> };
}

/** 内置目标（无 DB 时的兜底；DB 注册表加载后以 DB 为准、同名覆盖）。executor 类目标全部走后台注册，内核不预设。 */
const BUILTIN: TargetDef[] = [
  { name: 'llm', kind: 'inhub', stateless: true, needs_project: false, timeout_ms: 120000, enabled: true },
];

/**
 * 一个运行内核自己的目标插座板。
 *
 * 这里必须是实例对象，不能由模块级变量承载：商业宿主会在同一 Node 进程里装配多个
 * 逻辑内核，每个内核连接自己的原版 Core 数据库。若共用 registry/store，后初始化的
 * 租户会覆盖先初始化租户的 target 定义，造成跨租户错误派活。
 */
export class TargetRegistry {
  private readonly adapters = new Map<string, TargetAdapter>();
  private registry = new Map<string, TargetDef>(BUILTIN.map((target) => [target.name, target]));
  private store: TargetRegistryStore | null = null;

  /** inhub 适配器由组合根注册；executor 类 target 不需要代码适配器。 */
  registerAdapter(name: string, adapter: TargetAdapter): void {
    this.adapters.set(name, adapter);
  }

  bindStore(store: TargetRegistryStore | null): void {
    this.store = store;
  }

  setTargets(rows: TargetDef[]): void {
    const next = new Map<string, TargetDef>(BUILTIN.map((target) => [target.name, target]));
    for (const row of rows) next.set(row.name, row);
    this.registry = next;
  }

  /** DB 抖动时保留上一份缓存，不影响当前内核调度。 */
  async refresh(): Promise<void> {
    if (!this.store) return;
    try { this.setTargets(await this.store.targets.list()); }
    catch { /* DB 抖动用上一份缓存/内置兜底 */ }
  }

  list(): TargetDef[] {
    return [...this.registry.values()];
  }

  get(name: string): TargetDef | null {
    return this.registry.get(name) ?? null;
  }

  getAdapter(target: string): TargetAdapter | null {
    return this.adapters.get(target) ?? null;
  }

  isRemoteExecutor(target: string): boolean {
    return this.registry.get(target)?.kind === 'executor';
  }

  isKnown(target: string): boolean {
    return this.registry.has(target);
  }

  enabled(target: string): boolean {
    return this.registry.get(target)?.enabled !== false;
  }

  needsProject(target: string): boolean {
    return this.registry.get(target)?.needs_project === true;
  }

  isStateless(target: string): boolean {
    return this.registry.get(target)?.stateless === true;
  }

  timeoutMs(target: string, targetConfig: Record<string, unknown>): number {
    const fromRoute = Number(targetConfig['timeout_ms']);
    if (fromRoute > 0) return fromRoute;
    const fromDef = this.registry.get(target)?.timeout_ms ?? 0;
    return fromDef > 0 ? fromDef : 120000;
  }
}

/** OSS 默认包装继续使用这一实例；可嵌入宿主必须为每个 Kernel 创建自己的 TargetRegistry。 */
export const defaultTargetRegistry = new TargetRegistry();

/** 由 app 组合根注册内置 inhub 适配器；第三方 executor 目标不需要注册代码适配器。 */
export function registerTargetAdapter(name: string, adapter: TargetAdapter): void {
  defaultTargetRegistry.registerAdapter(name, adapter);
}

/** 由运行时组合根注入配置仓储；registry 本身不依赖 runtime 单例。 */
export function bindTargetRegistryStore(store: TargetRegistryStore | null): void {
  defaultTargetRegistry.bindStore(store);
}

/** 用 DB 注册表刷新插座板（server 启动时 + 每 60s + 后台改动后调用）。 */
export function setTargets(rows: TargetDef[]): void {
  defaultTargetRegistry.setTargets(rows);
}

/** 从 DB 注册表刷新插座板（server 启动 + 每 60s + 后台目标 CRUD 后调用）。DB 抖动时保留上一份缓存，不影响调度。 */
export async function refreshTargets(): Promise<void> {
  await defaultTargetRegistry.refresh();
}

export function listTargetDefs(): TargetDef[] {
  return defaultTargetRegistry.list();
}

export function getTargetDef(name: string): TargetDef | null {
  return defaultTargetRegistry.get(name);
}

export function getAdapter(target: string): TargetAdapter | null {
  return defaultTargetRegistry.getAdapter(target);
}

/** 是否为远端执行器目标（由执行器拉取认领，而非中枢内执行） */
export function isRemoteExecutorTarget(target: string): boolean {
  return defaultTargetRegistry.isRemoteExecutor(target);
}

/** 中枢是否认识该 target */
export function isKnownTarget(target: string): boolean {
  return defaultTargetRegistry.isKnown(target);
}

export function targetEnabled(target: string): boolean {
  return defaultTargetRegistry.enabled(target);
}

/** 该 target 是否需要 project（目录） */
export function targetNeedsProject(target: string): boolean {
  return defaultTargetRegistry.needsProject(target);
}

/** 无状态大脑（自身无会话记忆）：派活时必须从对话总账装配上下文；有状态大脑只在会话缓存未命中时装配。 */
export function targetIsStateless(target: string): boolean {
  return defaultTargetRegistry.isStateless(target);
}

/** inhub 执行超时（毫秒）：路由 target_config.timeout_ms > 注册表 timeout_ms > 默认 120s */
export function targetTimeoutMs(target: string, targetConfig: Record<string, unknown>): number {
  return defaultTargetRegistry.timeoutMs(target, targetConfig);
}
