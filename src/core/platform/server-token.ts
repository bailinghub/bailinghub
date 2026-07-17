const MIN_EXTERNAL_TOKEN_LENGTH = 24;

const KNOWN_WEAK_TOKENS = new Set([
  'bailing',
  'bailing-dev-admin-token-change-me',
  'change-me',
  'changeme',
  'replace-me',
  'replace_with_a_long_random_secret',
  'replace-with-a-long-random-secret',
  'secret',
  'token',
]);

export function isLoopbackHost(host: string): boolean {
  const normalized = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '::ffff:127.0.0.1'
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function allowsUnauthenticatedLocalDevelopment(env: 'development' | 'production', host: string): boolean {
  return env === 'development' && isLoopbackHost(host);
}

function normalizedWeakToken(token: string): string {
  return token.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * 本地回环开发可保持零配置；生产模式或任何非回环监听必须显式配置强 token。
 * 这条策略既保护管理 API，也保护所有从 server token 派生的 HMAC 凭证。
 */
export function assertServerTokenPolicy(input: {
  env: 'development' | 'production';
  host: string;
  token: string;
}): void {
  const token = String(input.token ?? '').trim();
  if (!token) {
    if (allowsUnauthenticatedLocalDevelopment(input.env, input.host)) return;
    throw new Error('BAILING_TOKEN 未配置：仅 development + 回环地址允许无 token 本地开发；生产或非回环监听必须设置强随机 token。');
  }

  const exposed = input.env === 'production' || !isLoopbackHost(input.host);
  if (!exposed) return;

  if (token.length < MIN_EXTERNAL_TOKEN_LENGTH || KNOWN_WEAK_TOKENS.has(normalizedWeakToken(token))) {
    throw new Error(`BAILING_TOKEN 不安全：生产或非回环监听至少需要 ${MIN_EXTERNAL_TOKEN_LENGTH} 个字符，且不能使用公开示例或占位值。`);
  }
}

/** 派生签名或凭证时再次 fail-closed，避免未来调用绕过配置加载入口。 */
export function requireServerToken(token: string, purpose: string): string {
  const value = String(token ?? '').trim();
  if (!value) throw new Error(`BAILING_TOKEN 未配置，无法${purpose}`);
  return value;
}
