export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

export interface RedactionOptions {
  rules?: RedactionRule[];
  maxDepth?: number;
}

export interface RedactionSummary {
  applied: boolean;
  rules: string[];
}

export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  { name: 'email', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[REDACTED_EMAIL]' },
  { name: 'phone_cn', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g, replacement: '[REDACTED_PHONE]' },
  { name: 'id_card_cn', pattern: /(?<![0-9A-Za-z])\d{6}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/g, replacement: '[REDACTED_ID]' },
  { name: 'bearer_token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g, replacement: 'Bearer [REDACTED_TOKEN]' },
  { name: 'secret_like', pattern: /\b(?:sk|pk|ak|tk|eyJ)[A-Za-z0-9._~+/=-]{18,}\b/g, replacement: '[REDACTED_SECRET]' },
];

const SENSITIVE_KEY = /(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|authorization|cookie|credential)/i;

export function redactText(input: string, rules: RedactionRule[] = DEFAULT_REDACTION_RULES): string {
  let out = input;
  for (const r of rules) out = out.replace(r.pattern, r.replacement);
  return out;
}

export function redactValue<T>(value: T, opts: RedactionOptions = {}): T {
  const rules = opts.rules ?? DEFAULT_REDACTION_RULES;
  const maxDepth = opts.maxDepth ?? 12;
  return redactAny(value, rules, 0, maxDepth) as T;
}

export function redactionSummary(rules: RedactionRule[] = DEFAULT_REDACTION_RULES): RedactionSummary {
  return { applied: true, rules: rules.map((r) => r.name) };
}

function redactAny(value: unknown, rules: RedactionRule[], depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) return '[REDACTED_MAX_DEPTH]';
  if (typeof value === 'string') return redactText(value, rules);
  if (typeof value !== 'object' || value == null) return value;
  if (Array.isArray(value)) return value.map((x) => redactAny(x, rules, depth + 1, maxDepth));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? redactSensitiveValue(v) : redactAny(v, rules, depth + 1, maxDepth);
  }
  return out;
}

function redactSensitiveValue(value: unknown): unknown {
  if (value == null || value === '') return value;
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (typeof value === 'object') return '[REDACTED_SECRET_OBJECT]';
  return '[REDACTED_SECRET]';
}
