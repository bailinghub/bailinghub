import type { AgentSubjectDisplay } from './types';

export type SubjectDisplayValidation =
  | { ok: true; value: AgentSubjectDisplay | null }
  | { ok: false };

/** A bounded presentation label, treated as data rather than identity or instructions. */
export function validateAgentSubjectDisplay(value: unknown): SubjectDisplayValidation {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.name !== 'string') return { ok: false };
  const name = record.name.trim();
  // Check controls before trimming so a tab/newline is not silently accepted.
  if (!name || name.length > 120 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ud800-\udfff]/u.test(record.name)) return { ok: false };
  return { ok: true, value: { name } };
}

/** Old/malformed presentation data must not break an otherwise valid authorization. */
export function readAgentSubjectDisplay(value: unknown): AgentSubjectDisplay | null {
  let decoded = value;
  if (typeof value === 'string') {
    try { decoded = JSON.parse(value) as unknown; }
    catch { return null; }
  }
  const checked = validateAgentSubjectDisplay(decoded);
  return checked.ok ? checked.value : null;
}

export function agentSubjectDisplayView(value: unknown): {
  subject_display: AgentSubjectDisplay | null;
  subject_display_status: 'provided' | 'missing';
} {
  const display = readAgentSubjectDisplay(value);
  return { subject_display: display, subject_display_status: display ? 'provided' : 'missing' };
}
