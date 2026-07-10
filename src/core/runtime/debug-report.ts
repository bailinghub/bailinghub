function val(v: unknown, fallback = '-'): string {
  if (v === null || v === undefined || v === '') return fallback;
  return String(v);
}

function arr(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Record<string, any> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
}

function severityLabel(s: string): string {
  if (s === 'error') return '错误';
  if (s === 'warning') return '提醒';
  return '信息';
}

export function renderDebugReport(bundle: Record<string, any>): string {
  const identifiers = obj(bundle.identifiers);
  const dispatch = obj(bundle.dispatch);
  const outcome = obj(bundle.outcome);
  const counts = obj(bundle.counts);
  const redaction = obj(bundle.redaction);
  const diagnosis = arr(bundle.diagnosis);
  const errors = diagnosis.filter((d) => d?.severity === 'error');
  const warnings = diagnosis.filter((d) => d?.severity === 'warning');
  const primary = errors[0] ?? warnings[0] ?? diagnosis[0] ?? null;
  const lines: string[] = [];

  lines.push('# 百灵中枢排障报告');
  lines.push('');
  lines.push(`生成时间：${val(bundle.generated_at)}`);
  lines.push(`脱敏状态：${redaction.applied ? '已脱敏' : '未声明'}${Array.isArray(redaction.rules) ? `（${redaction.rules.join(' / ')}）` : ''}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  if (primary) {
    lines.push(`- ${severityLabel(String(primary.severity))}：${val(primary.title)}`);
    if (primary.detail) lines.push(`- 细节：${primary.detail}`);
    if (primary.next_action) lines.push(`- 建议：${primary.next_action}`);
  } else {
    lines.push('- 未发现明确诊断项，请结合 trace 时间线继续查看。');
  }
  lines.push('');
  lines.push('## 标识');
  lines.push('');
  lines.push(`- job_id：${val(identifiers.job_id)}`);
  lines.push(`- request_id：${val(identifiers.request_id)}`);
  lines.push(`- route：${val(identifiers.route_key)}`);
  lines.push(`- client：${val(identifiers.client_app_id)}`);
  lines.push(`- thread：${val(identifiers.thread_id)}`);
  lines.push(`- principal：${val(identifiers.principal_id)}`);
  lines.push('');
  lines.push('## 运行状态');
  lines.push('');
  lines.push(`- status：${val(outcome.status || dispatch.status)}`);
  lines.push(`- target：${val(dispatch.target)}`);
  lines.push(`- executor：${val(dispatch.executor_id)}`);
  lines.push(`- run_after：${val(dispatch.run_after)}`);
  lines.push(`- claimed_at：${val(dispatch.claimed_at)}`);
  lines.push(`- lease_until：${val(dispatch.lease_until)}`);
  if (outcome.error) lines.push(`- error：${outcome.error}`);
  lines.push('');
  lines.push('## 计数');
  lines.push('');
  lines.push(`- trace events：${val(counts.audit_events, '0')}`);
  lines.push(`- trace errors：${val(counts.trace_errors, '0')}`);
  lines.push(`- trace warnings：${val(counts.trace_warnings, '0')}`);
  lines.push(`- approvals：${val(counts.approvals, '0')}`);
  lines.push(`- delivery DLQ：${val(counts.delivery_dlq, '0')}`);
  lines.push(`- messages：${val(counts.messages, '0')}`);
  lines.push('');
  if (diagnosis.length) {
    lines.push('## 诊断项');
    lines.push('');
    for (const d of diagnosis) {
      lines.push(`- [${severityLabel(String(d.severity))}] ${val(d.title)} (${val(d.code)})`);
      if (d.detail) lines.push(`  细节：${d.detail}`);
      if (d.next_action) lines.push(`  建议：${d.next_action}`);
    }
    lines.push('');
  }
  const preview = val(outcome.result_preview, '');
  if (preview) {
    lines.push('## 结果预览');
    lines.push('');
    lines.push('```text');
    lines.push(preview.slice(0, 2000));
    lines.push('```');
    lines.push('');
  }
  lines.push('## 下一步');
  lines.push('');
  lines.push('- 若报告显示租约、执行器或队列问题，优先查看控制台「执行器」和「系统体检」。');
  lines.push('- 若报告显示工具、审批或送达问题，优先查看本 job 的 trace 时间线、审批意图和送达死信。');
  lines.push('- 本报告只基于脱敏排障包生成；需要原始内容时仅限授权后台查看。');
  return lines.join('\n');
}
