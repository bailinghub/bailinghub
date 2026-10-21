/** Client-reported execution facts are continuation data, never verified evidence
 * or system instructions. Keep this projection independent from audit storage. */
export const AGENT_EXECUTION_SUMMARY_SCHEMA = 'bailing.authorization-execution-summary.v1';
const INVOCATION_ID = /^[0-9a-f]{64}$/;
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const STATES = new Set(['executed', 'business_rejected', 'awaiting_approval', 'denied',
  'rejected_before_dispatch', 'reconciliation_required', 'in_progress', 'outcome_unknown', 'not_dispatched']);
const UNRESOLVED = new Set(['awaiting_approval', 'in_progress', 'reconciliation_required', 'outcome_unknown']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Recognizes only the explicit new client format; ordinary assistant text keeps
 * its existing behavior. Callers must not apply this to user messages. */
export function projectAgentExecutionMemory(content: string, maximum: number): {
  content: string;
  kind: 'authorization_execution_summary';
  source: 'agent_client';
  trust: 'reference_only';
  truncated: boolean;
} | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return undefined; }
  if (!isRecord(parsed) || parsed['schema_version'] !== AGENT_EXECUTION_SUMMARY_SCHEMA) return undefined;
  const raw = Array.isArray(parsed['invocations']) ? parsed['invocations'] : [];
  const claimedTotal = Number.isSafeInteger(parsed['total_invocations']) && Number(parsed['total_invocations']) >= 0
    ? Math.min(Number(parsed['total_invocations']), 1_000_000_000) : 0;
  const total = Math.max(claimedTotal, raw.length);
  const summary = {
    schema_version: AGENT_EXECUTION_SUMMARY_SCHEMA,
    source: 'agent_client',
    trust: 'reference_only',
    total_invocations: total,
    omitted_invocations: total,
    invocations: [] as Array<Record<string, unknown>>,
  };
  const metadata = { kind: 'authorization_execution_summary', source: 'agent_client', trust: 'reference_only' } as const;
  if (JSON.stringify(summary).length > maximum) {
    return { ...metadata, content: 'Execution facts omitted by memory budget.', truncated: true };
  }
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry['invocation_id'] !== 'string' || !INVOCATION_ID.test(entry['invocation_id']) || seen.has(entry['invocation_id'])) continue;
    seen.add(entry['invocation_id']);
    const state = typeof entry['last_known_state'] === 'string' && STATES.has(entry['last_known_state'])
      ? entry['last_known_state'] : 'outcome_unknown';
    const fact = {
      invocation_id: entry['invocation_id'],
      ...(typeof entry['tool'] === 'string' && TOOL_NAME.test(entry['tool']) ? { tool: entry['tool'] } : {}),
      last_known_state: state,
      ...(UNRESOLVED.has(state) ? { next_action: 'inspect_original' } : {}),
    };
    summary.invocations.push(fact);
    summary.omitted_invocations = total - summary.invocations.length;
    if (JSON.stringify(summary).length > maximum) {
      summary.invocations.pop();
      summary.omitted_invocations = total - summary.invocations.length;
      break;
    }
  }
  return { ...metadata, content: JSON.stringify(summary), truncated: summary.omitted_invocations > 0 };
}
