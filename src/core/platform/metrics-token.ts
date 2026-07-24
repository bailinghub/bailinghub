const MIN_METRICS_TOKEN_LENGTH = 24;

const KNOWN_WEAK_METRICS_TOKENS = new Set([
  'bailing',
  'change-me',
  'changeme',
  'metrics',
  'prometheus',
  'replace-me',
  'replace_with_a_long_random_secret',
  'replace-with-a-long-random-secret',
  'secret',
  'token',
]);

function normalizedWeakToken(token: string): string {
  return token.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Metrics expose operational state and therefore always require a dedicated
 * secret, including on loopback development deployments.
 */
export function assertMetricsTokenPolicy(input: {
  enabled: boolean;
  token: string;
  serverToken: string;
}): void {
  if (!input.enabled) return;
  const token = String(input.token ?? '').trim();
  if (
    token.length < MIN_METRICS_TOKEN_LENGTH
    || KNOWN_WEAK_METRICS_TOKENS.has(normalizedWeakToken(token))
  ) {
    throw new Error(
      `BAILING_METRICS_TOKEN 不安全：启用指标端点时至少需要 ${MIN_METRICS_TOKEN_LENGTH} 个字符，且不能使用公开示例或占位值。`,
    );
  }
  if (input.serverToken && token === input.serverToken.trim()) {
    throw new Error('BAILING_METRICS_TOKEN 必须与 BAILING_TOKEN 分离，不能复用管理根密钥。');
  }
}
