// 工具插座运行时治理核心——设计与安全边界见 docs/TOOLS_DESIGN.md
// 职责：消费 ToolDefinition → 白名单/主体/审批/限流/审计/签名 → 给大脑可调用的运行时句柄。
// 中枢只做 reach（白名单/风险闸/限流/签名/审计）；authority（这个人能不能做）永远由业务侧验签后裁决。
import { createHash, createHmac } from 'node:crypto';
import type { ToolProvider } from './types';
import { schemaAtPath, schemaTypes, valueMatchesSchemaType, type ToolConfirmCondition, type ToolDefinition } from './tool-definition';
import { toolSummary } from './tool-definition';

/** 路由 allow 白名单匹配：精确 scope 或前缀通配（"tenant.staff.*"）。 */
export function scopeAllowed(scope: string, allow: string[]): boolean {
  for (const a of allow) {
    if (a === scope) return true;
    if (a.endsWith('.*') && scope.startsWith(a.slice(0, -1))) return true;
    if (a === '*') return true;
  }
  return false;
}

/**
 * 工具通道唯一签名（工具调用 + spec 拉取共用同一套构造）：
 *   `sha256=` + HMAC_SHA256(secret, "<ts>.<METHOD>.<path?query>.<sha256hex(body)>.<On-Behalf-Of>.<Job-Id>")
 * 返回值已含方案标签前缀 `sha256=`，可直接作 X-Bailing-Signature 头值。
 *
 * - 标签 `sha256` 是【算法名】不是版本号（GitHub webhook 同款约定）；构造细节见 CONTRACT §2.4b。
 * - On-Behalf-Of + Job-Id 并入签名材料，杜绝"窗口内重放合法请求、只改这两个头换租户/绕幂等"。
 * - spec 拉取无操作主体/任务：onBehalfOf/jobId 传空串即可（同一套构造、尾部为空）。
 */
export function signToolCall(secret: string, ts: number, method: string, pathWithQuery: string, body: string, onBehalfOf = '', jobId = ''): string {
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const mac = createHmac('sha256', secret).update(`${ts}.${method}.${pathWithQuery}.${bodyHash}.${onBehalfOf}.${jobId}`).digest('hex');
  return `sha256=${mac}`;
}

/** 调用参数的规范化哈希：递归按键名排序后 JSON 化再 sha256。审批单按它精确匹配"当时那个调用"（键序不同不算换动作）。 */
export function argsHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args ?? {}), 'utf8').digest('hex');
}
function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map((item) => canonicalJsonArrayValue(item)).join(',')}]`;
  if (typeof v === 'object') {
    const record = v as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => !isJsonOmitted(record[key])).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

function canonicalJsonArrayValue(v: unknown): string {
  return isJsonOmitted(v) ? 'null' : canonicalJson(v);
}

function isJsonOmitted(v: unknown): boolean {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

function normalizeToolArgs(args: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  try {
    // 以实际 HTTP JSON 语义为准：对象中的 undefined 被省略、数组中的 undefined 变为 null。
    // 审批快照、幂等哈希和外发请求必须消费同一份规范化参数。
    const encoded = JSON.stringify(args);
    if (!encoded) return { ok: false, error: 'tool_args_not_json_object' };
    const decoded: unknown = JSON.parse(encoded);
    if (!isRecord(decoded)) return { ok: false, error: 'tool_args_not_json_object' };
    return { ok: true, args: decoded };
  } catch {
    return { ok: false, error: 'tool_args_not_json_serializable' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- 限流（进程内滑窗，三层：每任务 max_calls 由调用方计数 / 每工具 ACC execution.rate_limit / 工具源总闸）----
export class LocalSlidingWindowRateLimiter {
  private readonly buckets = new Map<string, number[]>();
  private lastSweepAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, perMin: number): boolean {
    if (perMin <= 0) return false;
    const now = this.now();
    this.sweep(now);
    const timestamps = (this.buckets.get(key) ?? []).filter((timestamp) => now - timestamp < 60_000);
    if (timestamps.length >= perMin) {
      this.buckets.set(key, timestamps);
      return true;
    }
    timestamps.push(now);
    this.buckets.set(key, timestamps);
    return false;
  }

  bucketCount(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    if (now - this.lastSweepAt < 60_000) return;
    this.lastSweepAt = now;
    for (const [key, timestamps] of this.buckets) {
      const active = timestamps.filter((timestamp) => now - timestamp < 60_000);
      if (active.length) this.buckets.set(key, active);
      else this.buckets.delete(key);
    }
  }
}

const localRateLimiter = new LocalSlidingWindowRateLimiter();
function allowRate(key: string, perMin: number): boolean {
  return !localRateLimiter.consume(key, perMin);
}

/** 渐进式披露阈值：白名单内工具数 ≤ 此值全量内联（省一次往返）；超过则目录+按需取定义（防几百个工具定义灌爆上下文）。 */
export const TOOL_INLINE_MAX = 12;

/**
 * 审计落库单字段封顶（字节）。log_payload 打开且非敏感工具时，工具入参/响应**全量**入审计（远高于回流给模型的 truncateBytes，
 * 二者是不同关注点：truncateBytes 控"喂模型的上下文预算"，这里控"可追溯的审计留存"）。封顶仅防异常大响应撑爆 bz_audit；
 * 真实字节数始终另记 resp_bytes/args_bytes，超封顶记 *_truncated=true，绝不静默丢。64KB 覆盖绝大多数业务响应。
 */
export const AUDIT_MAX_BYTES = 65536;

/** 大脑可用的工具运行时：清单（喂 LLM）+ 受治理的调用句柄。由 server 在派发时装配并注入 AdapterContext。 */
export interface ToolRuntime {
  /** OpenAI function-calling 形态的工具清单 */
  llmTools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  maxCalls: number;
  /** 工具数 > TOOL_INLINE_MAX 时启用渐进披露：大脑先看目录，用哪个再取完整定义 */
  progressive: boolean;
  /** 工具语义检索可用（工具源配了 embedding 凭证且已建索引）：装配方注入了 retrieveNames，retrieve() 可用。
   * 优先级高于 progressive——适配器有它就按用户问题预载相关工具 + search_tools 检索更多，而不是甩一份目录让模型自己翻。 */
  retrievalMode: boolean;
  /** 轻目录（渐进披露第一段）：每条 ~20 token，无参数 schema */
  catalog: Array<{ name: string; summary: string; scope: string; risk: string; confirm_required: boolean }>;
  /** 重跑时的"已批准调用清单"提示（审批车道 B：批准后自动重跑，大脑须按原样执行批准的调用）；无则 undefined */
  approvedNote?: string;
  /** 渐进披露第二段：按名取完整定义（看菜单不点菜：不计入 max_calls，审计 tool_lookup）。未知名忽略。 */
  lookup(names: string[]): Promise<ToolRuntime['llmTools']>;
  /** 工具语义检索：按一句自然语言意图召回最相关的工具定义（双闸内排序，不计 max_calls）。
   * 返回 null = 检索运行时不可用（索引未建/凭证不可用/embedding 临时挂）→ 调用方应降级回 progressive。retrievalMode=false 时不存在。 */
  retrieve?(query: string): Promise<ToolRuntime['llmTools'] | null>;
  /** 受闸调用：白名单复核→风险闸→限流→审计(fail-closed)→签名外发。返回回流 LLM 的文本（错误也以文本回流）。 */
  invoke(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; status: number }>;
}

/**
 * 多工具源组合器：模型只看到一份工具面，调用时按工具名路由回所属工具源。
 * 工具名必须在路由内全局唯一；上下文装配层会在运行前拒绝冲突，避免误调到错误业务系统。
 */
export function composeToolRuntimes(runtimes: ToolRuntime[], maxCalls: number, approvedNote?: string): ToolRuntime {
  const owner = new Map<string, ToolRuntime>();
  for (const runtime of runtimes) {
    for (const tool of runtime.llmTools) {
      const name = tool.function.name;
      if (owner.has(name)) throw new Error(`工具名冲突 ${name}：同一路由的多工具源必须使用全局唯一 operationId`);
      owner.set(name, runtime);
    }
  }
  const llmTools = runtimes.flatMap((runtime) => runtime.llmTools);
  const catalog = runtimes.flatMap((runtime) => runtime.catalog);
  const retrievalMode = runtimes.length > 0 && runtimes.every((runtime) => runtime.retrievalMode && !!runtime.retrieve);
  return {
    llmTools,
    maxCalls,
    progressive: llmTools.length > TOOL_INLINE_MAX,
    retrievalMode,
    catalog,
    approvedNote,
    async lookup(names) {
      const wanted = [...new Set(names.map(String))].slice(0, 20);
      const groups = await Promise.all(runtimes.map((runtime) => runtime.lookup(wanted)));
      return groups.flat();
    },
    ...(retrievalMode ? {
      async retrieve(query: string) {
        const groups = await Promise.all(runtimes.map((runtime) => runtime.retrieve!(query).catch(() => null)));
        if (groups.some((group) => group === null)) return null;
        const seen = new Set<string>();
        return groups.flatMap((group) => group ?? []).filter((tool) => {
          if (seen.has(tool.function.name)) return false;
          seen.add(tool.function.name);
          return true;
        });
      },
    } : {}),
    async invoke(name, args) {
      const runtime = owner.get(name);
      if (!runtime) return { ok: false, text: `工具 ${name} 不在本路由白名单内，调用被拒。`, status: 0 };
      return runtime.invoke(name, args);
    },
  };
}

/** 审批车道句柄：由 server 接到 bz_tool_approvals + 送达插座。不注入时风险闸按未配置审批承接处理（一律拦）。 */
export interface ApprovalDeps {
  /** 查"已批准且未消费"的同快照审批单并原子消费；消费成功返回单号，否则 null */
  consumeApproved(tool: string, hash: string): Promise<number | null>;
  /** 查同快照 pending 单（去重：同一调用别重复开单） */
  findPending(tool: string, hash: string): Promise<number | null>;
  /** 查本任务同工具"已批准未消费"单（不限参数）——重跑时大脑参数漂移的纠偏依据 */
  findApprovedAnyArgs(tool: string): Promise<{ id: number; args_json: string } | null>;
  /** 开 pending 单，返回单号 */
  create(snap: ApprovalIntentSnap): Promise<number>;
  /** 推送审批人（送达插座）；失败不阻塞——单已在库里，控制台照样能批。summary=ACC approval.prompt 渲染后的人话动作描述 */
  notify(approvalId: number, snap: ApprovalIntentSnap): Promise<void>;
}

export interface ApprovalIntentSnap {
  tool: string;
  scope: string;
  risk: string;
  policy: string;
  reason: string;
  method: string;
  path: string;
  args_json: string;
  args_hash: string;
  summary?: string;
  confirm_when?: ConfirmHit;
}

export interface ToolRuntimeDeps {
  provider: ToolProvider;
  allowedTools: ToolDefinition[];   // 已过双闸的清单
  maxCalls: number;
  onBehalfOf: string;               // metadata[subject_field]，可空串
  conversation?: string;            // 来源会话坐标 <渠道名>:<收件人>（X-Bailing-Conversation），供业务批准后 /send 回流；可空
  jobId: string;
  clientAppId: string;
  truncateBytes: number;            // 工具结果回流截断（默认 8192）
  approvedNote?: string;            // 重跑时已批准调用清单提示
  approvals?: ApprovalDeps;         // 不注入 = high/confirm 一律拦
  audit(event: string, detail: Record<string, unknown>): Promise<void>; // 写审计；抛错=调用不放行（fail-closed）
  /** 工具语义检索（装配层注入；不注入 = 不启用检索，退回 progressive）：一句意图 → 召回工具名（已是双闸内、按相关度排序）。
   * 返回 null = 检索运行时不可用（索引/凭证/embedding 临时挂）→ retrieve() 透传 null 让适配器降级。本层不碰 embedding，只收名单。 */
  retrieveNames?: (query: string) => Promise<string[] | null>;
  /** 多工具源聚合后总工具数超过阈值时，装配层可强制小工具源也开启检索句柄。 */
  retrievalMode?: boolean;
  /** 工具调用幂等账本（装配层注入；不注入=不去重）：同 job 内"副作用工具"(非只读、非声明幂等)已成功执行过的相同调用，
   * 在 job 重试/崩溃恢复整单重跑时返回上次结果、不重复执行（防写操作重复扣款）。get 命中=已执行过；put 在真发出后登记。 */
  idempotency?: {
    get(tool: string, argsHash: string): Promise<{ ok: boolean; status: number; text: string } | null>;
    put(tool: string, argsHash: string, res: { ok: boolean; status: number; text: string }): Promise<void>;
  };
  /** 集中限速器：返回 true = 已触发限流；不注入时退回进程内滑窗。 */
  rateLimit?: (bucket: string, limit: number, windowSec: number) => Promise<boolean>;
}

export function buildToolRuntime(d: ToolRuntimeDeps): ToolRuntime {
  const byName = new Map(d.allowedTools.map((t) => [t.name, t]));
  const llmTools = d.allowedTools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: `${t.description}（scope:${t.scope}${t.readonly ? '，只读' : ''}${hasConditionalConfirm(t) ? '，部分参数需审批' : ''}）`, parameters: t.inputSchema },
  }));
  // 检索模式：工具数超内联阈值 + 装配层注入了 retrieveNames（工具源配了 embedding 且有索引）才启用。
  const retrievalMode = !!d.retrieveNames && (d.retrievalMode ?? d.allowedTools.length > TOOL_INLINE_MAX);
  return {
    llmTools,
    maxCalls: d.maxCalls,
    progressive: d.allowedTools.length > TOOL_INLINE_MAX,
    retrievalMode,
    catalog: d.allowedTools.map((t) => ({ name: t.name, summary: toolSummary(t), scope: t.scope, risk: t.risk, confirm_required: t.confirmRequired || hasConditionalConfirm(t) })),
    approvedNote: d.approvedNote,
    async lookup(names) {
      const want = new Set(names.map(String).slice(0, 20));
      const found = llmTools.filter((x) => want.has(x.function.name));
      // 看菜单不点菜：不计 max_calls；审计留痕但非 fail-closed（只读元操作）
      await d.audit('tool_lookup', { names: [...want], found: found.map((x) => x.function.name) }).catch(() => undefined);
      return found;
    },
    ...(retrievalMode ? {
      async retrieve(query: string) {
        const names = await d.retrieveNames!(query).catch(() => null);
        if (names === null) return null; // 检索运行时不可用 → 透传降级信号
        // 保留相关度顺序（retrieveNames 已按分数排序），映射回完整定义
        const found = names.map((n) => llmTools.find((x) => x.function.name === n)).filter(Boolean) as ToolRuntime['llmTools'];
        await d.audit('tools_retrieved', { query: query.slice(0, 120), picked: found.map((x) => x.function.name) }).catch(() => undefined);
        return found;
      },
    } : {}),
    async invoke(name, args) {
      const t = byName.get(name);
      // 闸1：白名单复核（与清单装配解耦的独立校验——清单多吐了也走不到执行）
      if (!t) return { ok: false, text: `工具 ${name} 不在本路由白名单内，调用被拒。`, status: 0 };
      const normalized = normalizeToolArgs(args);
      if (!normalized.ok) {
        await d.audit('tool_blocked', { tool: name, scope: t.scope, reason: normalized.error }).catch(() => undefined);
        return { ok: false, text: `工具 ${name} 参数不是合法 JSON 对象，调用已拒绝。请按工具参数 schema 重新传参。`, status: 0 };
      }
      const callArgs = normalized.args;
      // 闸1.5：主体闸——ACC subject.required 的工具必须有操作主体（装配层已过滤看不见，这里防绕过双闸兜底）
      if (t.requiresSubject && !d.onBehalfOf) {
        await d.audit('tool_blocked', { tool: name, scope: t.scope, reason: 'requires-subject：任务无操作主体' }).catch(() => undefined);
        return { ok: false, text: `工具 ${name} 需要明确的操作主体，当前任务没有可信身份（如匿名访客）。请告知用户登录后再操作或走人工流程。`, status: 0 };
      }
      // 闸1.8：幂等账本——同 job 内"副作用工具"(非只读、非声明幂等)已执行过的相同调用，重试/崩溃恢复重跑时直接返回上次结果，
      //   不重复执行（防写操作重复扣款）。放在审批闸之前：否则重跑时已消费的审批单会被当成"无批准"再次触发待审批，把重跑卡死。
      const sideEffecting = !t.readonly && !t.idempotent;
      const idemHash = sideEffecting && d.idempotency ? argsHash(callArgs) : '';
      if (idemHash) {
        const cached = await d.idempotency!.get(name, idemHash).catch(() => null);
        if (cached) {
          await d.audit('tool_call_deduped', { tool: name, scope: t.scope, status: cached.status, reason: '同 job 已执行过相同调用，返回上次结果（防重试/恢复重复副作用）' }).catch(() => undefined);
          return { ok: cached.ok, text: cached.text, status: cached.status };
        }
      }
      // 闸2：风险闸 + 审批车道（B 方案：先撤再来）。high / confirm-required 的调用：
      //   有"已批准未消费"的同快照单 → 原子消费后放行；没有 → 开 pending 单推审批人，本次调用拒绝（任务正常收尾，批准后自动重跑）。
      //   批准按 job+tool+args_hash 精确匹配——批的是"那一次调用"，重跑换参数/换动作 = 重新走审批。
      let approvalId: number | null = null;
      const confirmCheck = firstConfirmHit(t, callArgs);
      if (confirmCheck.error) {
        await d.audit('tool_blocked', { tool: name, scope: t.scope, reason: confirmCheck.error }).catch(() => undefined);
        return { ok: false, text: `工具 ${name} 的审批条件参数类型不符合声明，调用已拒绝。请按工具参数 schema 重新传参。`, status: 0 };
      }
      const confirmHit = confirmCheck.hit;
      const needsApproval = t.risk === 'high' || t.confirmRequired || !!confirmHit;
      if (needsApproval) {
        if (!d.approvals) { // 未接审批车道（理论不发生，server 总会注入）：一律拦
          await d.audit('tool_blocked', { tool: name, scope: t.scope, reason: approvalReason(t, confirmHit) }).catch(() => undefined);
          return { ok: false, text: `工具 ${name} 属于需人工确认的高风险操作，当前不允许自动执行。请告知用户走人工流程。`, status: 0 };
        }
        const hash = argsHash(callArgs);
        approvalId = await d.approvals.consumeApproved(name, hash);
        if (approvalId === null) {
          const pendingId = await d.approvals.findPending(name, hash);
          if (pendingId !== null) {
            return { ok: false, text: `该操作已有待审批单（编号 ${pendingId}），请勿重复提交。请结束任务并告知用户：操作待人工审批。`, status: 0 };
          }
          // 参数漂移纠偏：同工具已有"已批准未消费"单但参数对不上（大脑重跑没按原样发，如 {id:25} 漂成 {name:"周杰伦"}）。
          // 不开新单空转审批——把批准的精确参数怼回去让大脑当场重发；安全零降级：执行仍只认精确匹配的原子消费。
          const drifted = await d.approvals.findApprovedAnyArgs(name);
          if (drifted) {
            await d.audit('tool_args_drift', { tool: name, approval_id: drifted.id, got_args: JSON.stringify(callArgs).slice(0, 500) }).catch(() => undefined);
            return { ok: false, text: `该工具已有人工批准的调用（审批单 ${drifted.id}），但你本次的参数与批准的不一致。请立即按批准的参数原样重新调用：${name} 参数 ${drifted.args_json}（一字不改，不要再确认）。`, status: 0 };
          }
          const argsJson = JSON.stringify(callArgs);
          const reason = approvalReason(t, confirmHit);
          const summary = t.confirmPrompt ? t.confirmPrompt.replace(/\{(\w+)\}/g, (_, k) => String(callArgs[k] ?? `{${k}}`)) : undefined;
          const snap: ApprovalIntentSnap = {
            tool: name, scope: t.scope, risk: t.risk, policy: approvalPolicy(t, confirmHit), reason,
            method: t.method, path: t.path, args_json: argsJson.slice(0, 4096), args_hash: hash,
            ...(summary ? { summary } : {}),
            ...(confirmHit ? { confirm_when: confirmHit } : {}),
          };
          const id = await d.approvals.create(snap);
          await d.audit('tool_approval_pending', { approval_id: id, tool: name, scope: t.scope, risk: t.risk, confirm_required: t.confirmRequired, ...(confirmHit ? { confirm_when: confirmHit } : {}) }).catch(() => undefined);
          await d.approvals.notify(id, { ...snap, args_json: argsJson.slice(0, 1000) }).catch(() => undefined);
          return { ok: false, text: `工具 ${name} 属于需人工审批的操作，已提交审批单（编号 ${id}）。请结束本次任务并告知用户：该操作已提交人工审批，批准后系统会自动继续执行。`, status: 0 };
        }
        // 走到这 = 批准单已消费，放行执行（审计带 approval_id 闭环留痕）
      }
      // 闸3：限流（每工具 + 工具源总闸）
      const toolLimited = d.rateLimit
        ? await d.rateLimit(`tool:${d.provider.name}:${name}`, t.rateLimitPerMin, 60)
        : !allowRate(`tool:${d.provider.name}:${name}`, t.rateLimitPerMin);
      const providerLimited = d.rateLimit
        ? await d.rateLimit(`provider:${d.provider.name}`, d.provider.rate_limit_per_min, 60)
        : !allowRate(`provider:${d.provider.name}`, d.provider.rate_limit_per_min);
      if (toolLimited || providerLimited) {
        return { ok: false, text: `工具 ${name} 触发限流，稍后再试。`, status: 429 };
      }
      // 组装请求：path/header/query/body 各归其位；GET 未标位置的参数仍回落 query。
      const query = new URLSearchParams();
      const bodyObj: Record<string, unknown> = {};
      const headers: Record<string, string> = {};
      let path = t.path;
      for (const [k, v] of Object.entries(callArgs)) {
        if (v === undefined || v === null) continue;
        const where = t.paramIn[k] ?? (t.method === 'GET' ? 'query' : 'body');
        if (where === 'path') path = path.replace(new RegExp(`\\{${escapeRegExp(k)}\\}`, 'g'), encodeURIComponent(String(v)));
        else if (where === 'header') headers[k] = String(v);
        else if (where === 'query') query.set(k, String(v));
        else bodyObj[k] = v;
      }
      const qs = query.toString();
      const pathWithQuery = path + (qs ? `?${qs}` : '');
      const body = t.method === 'GET' ? '' : JSON.stringify(bodyObj);
      const ts = Math.floor(Date.now() / 1000);
      // 工具调用签名（把 On-Behalf-Of + Job-Id 钉进 HMAC）。签名材料里的主体/任务必须与下面实际发出的头逐字一致（同源）。
      const subjectHeader = d.onBehalfOf || '';
      const sigHeader = signToolCall(d.provider.secret, ts, t.method, pathWithQuery, body, subjectHeader, d.jobId); // 已含 sha256= 前缀

      // 闸4：审计 fail-closed——账记不下来就不放行。ACC audit.sensitive 工具强制只记键名（优先级高于工具源 log_payload）。
      // logFull 时入参全量入审计（封顶 AUDIT_MAX_BYTES，超出记 args_truncated；真实字节数 args_bytes 始终记）。
      const logFull = d.provider.log_payload && !t.sensitive;
      const argsStr = JSON.stringify(callArgs);
      const argsLog = logFull
        ? { args: argsStr.slice(0, AUDIT_MAX_BYTES), args_bytes: argsStr.length, ...(argsStr.length > AUDIT_MAX_BYTES ? { args_truncated: true } : {}) }
        : { args: JSON.stringify(Object.keys(callArgs)) };
      await d.audit('tool_call', {
        provider: d.provider.name, tool: name, scope: t.scope, method: t.method, path: t.path,
        on_behalf_of: d.onBehalfOf || null, signature_scheme: 'sha256=', ...argsLog,
        ...(approvalId !== null ? { approval_id: approvalId } : {}),
      });

      const started = Date.now();
      const timeoutMs = t.timeoutMs || d.provider.timeout_ms || 10000; // ACC execution.timeout_ms 单工具覆盖（慢接口放宽），缺省工具源超时
      let status = 0; let fullText = '';
      try {
        const r = await fetch(d.provider.base_url.replace(/\/+$/, '') + pathWithQuery, {
          method: t.method,
          headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            'x-bailing-timestamp': String(ts),
            'x-bailing-signature': sigHeader,
            'x-bailing-job-id': d.jobId,
            'x-bailing-client': d.clientAppId,
            ...(subjectHeader ? { 'x-bailing-on-behalf-of': subjectHeader } : {}),
            // 来源会话坐标（非签名材料）：业务侧自审批批准后据此 /send 回流到原会话；收件人权威仍以已验签的 on-behalf-of 为准
            ...(d.conversation ? { 'x-bailing-conversation': d.conversation } : {}),
            'x-bailing-tool-scope': t.scope,
            ...headers,
          },
          body: body || undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = r.status;
        fullText = await r.text();
      } catch (e) {
        fullText = `调用失败：${e instanceof Error && e.name === 'TimeoutError' ? `超时（${timeoutMs}ms）` : String(e)}`;
      }
      // 回流给模型的：受上下文预算 truncateBytes 截断（与审计留存解耦）
      const text = fullText.slice(0, d.truncateBytes);
      const ok = status >= 200 && status < 300;
      // 审计留存：logFull 记全量响应（封顶 AUDIT_MAX_BYTES，超出记 resp_truncated）；resp_bytes 始终记真实字节数。
      const respLog = logFull
        ? { resp: fullText.slice(0, AUDIT_MAX_BYTES), resp_bytes: fullText.length, ...(fullText.length > AUDIT_MAX_BYTES ? { resp_truncated: true } : {}) }
        : { resp: `<${fullText.length} bytes>`, resp_bytes: fullText.length };
      await d.audit('tool_result', { tool: name, status, ok, duration_ms: Date.now() - started, ...respLog }).catch(() => undefined);
      const retText = text || `（HTTP ${status} 空响应）`;
      // 幂等登记：真发出去了（拿到 HTTP 响应，status≠0，副作用可能已发生）才登记，重跑直接复用此结果；
      // 网络失败(status=0)不登记——请求很可能没到达业务，留给重试，避免"没执行却被永久跳过"。
      if (idemHash && status !== 0) await d.idempotency!.put(name, idemHash, { ok, status, text: retText }).catch(() => undefined);
      return { ok, text: retText, status };
    },
  };
}

function hasConditionalConfirm(t: ToolDefinition): boolean {
  return Array.isArray(t.confirmWhen) && t.confirmWhen.length > 0;
}

function approvalReason(t: ToolDefinition, hit: ConfirmHit | null): string {
  if (t.risk === 'high') return 'risk=high';
  if (t.confirmRequired) return 'confirm-required';
  return hit?.reason ?? 'confirm-when';
}

function approvalPolicy(t: ToolDefinition, hit: ConfirmHit | null): string {
  if (t.risk === 'high') return 'risk_high';
  if (t.confirmRequired) return 'confirm_required';
  if (hit) return 'confirm_when';
  return 'unknown';
}

export interface ConfirmHit {
  param: string;
  op: string;
  value?: unknown;
  actual?: unknown;
  reason: string;
}

interface ConfirmCheck {
  hit: ConfirmHit | null;
  error?: string;
}

function firstConfirmHit(tool: ToolDefinition, args: Record<string, unknown>): ConfirmCheck {
  for (const cond of tool.confirmWhen ?? []) {
    const result = matchConfirmCondition(cond, args, tool.inputSchema);
    if (result && 'error' in result) return { hit: null, error: result.error };
    if (result) return { hit: result };
  }
  return { hit: null };
}

function matchConfirmCondition(
  cond: ToolConfirmCondition,
  args: Record<string, unknown>,
  inputSchema: Record<string, unknown>,
): ConfirmHit | { error: string } | null {
  const actual = valueAtPath(args, cond.param);
  const exists = actual !== undefined && actual !== null;
  const schema = schemaAtPath(inputSchema, cond.param);
  if (!schema) return { error: `confirm_when_missing_schema:${cond.param}` };
  if (!schemaTypes(schema).length) return { error: `confirm_when_untyped_schema:${cond.param}` };
  if (actual !== undefined && !valueMatchesSchemaType(actual, schema)) {
    return { error: `confirm_when_argument_type:${cond.param}` };
  }
  const base = (): ConfirmHit => ({
    param: cond.param,
    op: cond.op,
    ...('value' in cond ? { value: cond.value } : {}),
    ...(exists ? { actual } : {}),
    reason: cond.label || `confirm_when: ${cond.param} ${cond.op}${'value' in cond ? ` ${String(cond.value)}` : ''}`,
  });
  switch (cond.op) {
    case 'exists': return exists ? base() : null;
    case '>': return numericMatch(actual, cond.value, (a, b) => a > b, cond.param, base);
    case '>=': return numericMatch(actual, cond.value, (a, b) => a >= b, cond.param, base);
    case '<': return numericMatch(actual, cond.value, (a, b) => a < b, cond.param, base);
    case '<=': return numericMatch(actual, cond.value, (a, b) => a <= b, cond.param, base);
    case '==': return valueEquals(actual, cond.value) ? base() : null;
    case '!=': return !valueEquals(actual, cond.value) ? base() : null;
    case 'in': {
      if (!Array.isArray(cond.value)) return { error: `confirm_when_invalid_in:${cond.param}` };
      if (actual !== undefined && !cond.value.some((value) => sameJsonType(actual, value))) return { error: `confirm_when_argument_type:${cond.param}` };
      return cond.value.some((value) => valueEquals(actual, value)) ? base() : null;
    }
    case 'contains': {
      const contained = containsValue(actual, cond.value, cond.param);
      if (typeof contained === 'object') return contained;
      return contained ? base() : null;
    }
  }
  return null;
}

function valueAtPath(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.').filter(Boolean)) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function numericMatch(
  a: unknown,
  b: unknown,
  cmp: (x: number, y: number) => boolean,
  param: string,
  onMatch: () => ConfirmHit,
): ConfirmHit | { error: string } | null {
  if (a === undefined) return null;
  if (typeof a !== 'number' || !Number.isFinite(a) || typeof b !== 'number' || !Number.isFinite(b)) {
    return { error: `confirm_when_argument_type:${param}` };
  }
  return cmp(a, b) ? onMatch() : null;
}

function valueEquals(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

function sameJsonType(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return a === null && b === null;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b);
  return typeof a === typeof b;
}

function containsValue(actual: unknown, expected: unknown, param: string): boolean | { error: string } {
  if (Array.isArray(actual)) return actual.some((v) => valueEquals(v, expected));
  if (actual === undefined) return false;
  if (typeof actual !== 'string' || typeof expected !== 'string') return { error: `confirm_when_argument_type:${param}` };
  return actual.includes(expected);
}
