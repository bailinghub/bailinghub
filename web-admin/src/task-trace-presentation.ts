export type TraceSeverity = 'info' | 'warning' | 'error';
export type TraceStage = 'launch' | 'context' | 'execution' | 'tool' | 'approval' | 'delivery' | 'summary' | 'recovery' | 'channel' | 'config' | 'system' | string;
export interface TraceEvent {
  ts: string;
  event: string;
  stage?: TraceStage;
  severity?: TraceSeverity;
  title?: string;
  summary?: string;
  detail?: Record<string, unknown>;
  source?: 'local_agent' | 'hub_governance';
  tool_job_id?: string;
}
export interface TracePayload {
  job: any;
  trace: { summary?: any; events: TraceEvent[] };
  lookup?: any;
  debug_bundle?: any;
  debug_report?: string;
}
export function statusType(st: string): 'success' | 'danger' | 'info' | 'warning' {
  if (st === 'done' || st === 'completed') return 'success';
  if (st === 'error' || st === 'rejected' || st === 'failed') return 'danger';
  if (st === 'running' || st === 'dispatched' || st === 'preparing' || st === 'context_ready') return 'warning';
  return 'info';
}
const jobStatusLabels: Record<string, string> = {
  queued: '等待执行', dispatched: '已派发', running: '执行中', done: '已完成', error: '执行错误', rejected: '已拒绝',
};
const traceStatusLabels: Record<string, string> = {
  ...jobStatusLabels,
  completed: '已完成', failed: '失败', cancelled: '已取消', preparing: '准备中', context_ready: '上下文已就绪',
};
export function jobStatusLabel(status?: string | null): string {
  const raw = typeof status === 'string' ? status.trim() : '';
  return Object.hasOwn(jobStatusLabels, raw) ? jobStatusLabels[raw]! : raw || '未记录';
}
export function traceStatusLabel(st: string): string {
  return Object.hasOwn(traceStatusLabels, st) ? traceStatusLabels[st]! : st;
}
// 显示安全上限：审计要全量可追溯，但极端大内容（如几 MB 响应）整段塞进 DOM 会卡；
// 200K 字符够覆盖正常审计内容，超出才尾部标注（真实留存在后端审计，这里只是展示护栏）。
const SAFE_MAX = 200000;
export function cap(s: string): string {
  return s.length > SAFE_MAX ? s.slice(0, SAFE_MAX) + `\n…[显示已达上限 ${SAFE_MAX} 字符，完整内容见后端审计 / 重跑导出]` : s;
}
export function detailLen(d: unknown): number {
  const t = JSON.stringify(d ?? {});
  return t === '{}' ? 0 : t.length;
}
// 折叠态的预览（一行）：内容多时点箭头看 fullDetail 全量
export function shortDetail(d: unknown): string {
  const t = JSON.stringify(d ?? {});
  return t === '{}' ? '' : (t.length > 200 ? t.slice(0, 200) + ' …' : t);
}
// 展开态：全量、易读的 pretty JSON（不截断，仅受 SAFE_MAX 展示护栏）
export function fullDetail(d: unknown): string {
  return cap(JSON.stringify(d ?? {}, null, 2));
}
export function traceTitle(a: TraceEvent): string {
  return a.title || a.event;
}
export function traceSummaryText(a: TraceEvent): string {
  return a.summary || '';
}
const STAGE_LABEL: Record<string, string> = {
  launch: '入口',
  context: '上下文',
  execution: '执行',
  tool: '工具',
  approval: '审批',
  delivery: '送达',
  summary: '摘要',
  recovery: '恢复',
  channel: '渠道',
  config: '配置',
  system: '系统',
};
export function traceStageLabel(stage?: string): string {
  return STAGE_LABEL[stage || ''] || stage || '系统';
}
export function traceStageType(stage?: string): 'success' | 'danger' | 'info' | 'warning' | 'primary' {
  if (stage === 'tool') return 'primary';
  if (stage === 'approval' || stage === 'recovery') return 'warning';
  if (stage === 'delivery' || stage === 'summary') return 'success';
  if (stage === 'context' || stage === 'execution') return 'info';
  return 'info';
}
export function traceSeverityType(severity?: string): 'success' | 'danger' | 'info' | 'warning' {
  if (severity === 'error') return 'danger';
  if (severity === 'warning') return 'warning';
  return 'info';
}
// 工具摘要：详情抽屉与会话轨迹共用
export function fmtTools(t: any): string {
  if (!t || !t.provider) return '未挂工具';
  const allow = Array.isArray(t.allow) ? t.allow.join(' / ') : '';
  return `工具源 ${t.provider}（放行 scope：${allow || '无'}；单任务上限 ${t.max_calls ?? 5}）`;
}
// ---- 会话标签：把内部的 channel / principal_id / scope_key 翻成人可读的通用主体 ----
// 接入方：业务接入方名 > 网页入口名 > 渠道解析（企微/控制台）
export function partyLabel(t: any): string {
  const ch = String(t.channel || '');
  if (ch.startsWith('agent:')) return `智能体客户端 · ${t.client_name || ch.slice(6) || '未知接入方'}`;
  if (t.client_name) return t.client_name;
  if (t.entry_name) return t.entry_name;
  if (ch.startsWith('chat:')) return '网页聊天';
  if (ch.startsWith('wecom:')) return '企微·' + ch.slice(6);
  if (ch === 'admin') return '控制台/自测';
  if (ch === 'hub') return '中枢';
  return ch || '—';
}
export function partyVisible(t: any): boolean {
  return partyLabel(t) !== '—';
}
export function partyType(t: any): 'success' | 'warning' | 'primary' | 'info' | 'danger' {
  const ch = String(t.channel || '');
  if (ch.startsWith('agent:')) return 'primary';
  if (t.client_name) return 'success';
  if (ch.startsWith('wecom:')) return 'primary';
  if (ch.startsWith('chat:')) return 'warning';
  return 'info';
}
// 身份：principal_id 是接入方传入的业务主体编码，中枢不推断它的业务含义。
// 例如 uid:t1:u1621 只说明它是一个稳定主体，不等价于中枢能判断出“租户/用户”。
export function whoLabel(t: any): string {
  const p = String(t.principal_id || '');
  if (p.startsWith('uid:')) {
    const body = p.slice(4);
    return body ? `身份 ${body}` : '身份';
  }
  if (p.startsWith('visitor:')) return '访客 ' + p.slice(8, 16);
  if (p.startsWith('wxuid:')) return '企微 ' + p.slice(6);
  if (p) return p;
  const sc = String(t.scope_key || '');
  if (sc.startsWith('req:')) return '单次任务 ' + sc.slice(4, 16);
  return sc ? sc.slice(-24) : '匿名';
}
export function identityTitle(t: any): string {
  const p = String(t.principal_id || '');
  const sc = String(t.scope_key || '');
  return [p ? `principal_id: ${p}` : '', sc ? `scope_key: ${sc}` : ''].filter(Boolean).join('\n');
}
