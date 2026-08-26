import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

export const PUBLIC_DENYLIST_JSON_ENV = 'BAILING_PUBLIC_DENYLIST_JSON';
export const PUBLIC_DENYLIST_FILE_ENV = 'BAILING_PUBLIC_DENYLIST_FILE';

export const genericPublicContentRules = Object.freeze([
  {
    name: 'private key',
    re: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |)PRIVATE KEY-----/,
  },
  {
    name: 'GitHub personal access token',
    re: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/,
  },
  {
    name: 'local user absolute path',
    re: /(?:^|[\s"'`=(])(?:\/Users\/[^/\s"'`]+\/|\/home\/[^/\s"'`]+\/|[A-Za-z]:\\Users\\[^\\\s"'`]+\\)/,
  },
]);

function parseExactValues(raw, sourceName) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${sourceName} must contain a JSON array of exact text values`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${sourceName} must contain a JSON array of exact text values`);
  }
  return parsed.map((value, index) => {
    if (typeof value !== 'string' || value.trim().length < 4) {
      throw new Error(`${sourceName} entry #${index + 1} must be a non-empty string of at least 4 characters`);
    }
    return value;
  });
}

function isInsideRoot(rootPath, candidatePath) {
  const rel = relative(rootPath, candidatePath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export function loadPrivateExactTextDenylist({ root = process.cwd(), env = process.env } = {}) {
  const values = [];
  const inlineJson = env[PUBLIC_DENYLIST_JSON_ENV];
  if (inlineJson) {
    values.push(...parseExactValues(inlineJson, PUBLIC_DENYLIST_JSON_ENV));
  }

  const file = env[PUBLIC_DENYLIST_FILE_ENV];
  if (file) {
    if (!isAbsolute(file)) {
      throw new Error(`${PUBLIC_DENYLIST_FILE_ENV} must point to an absolute path outside the repository`);
    }
    if (!existsSync(file)) {
      throw new Error(`${PUBLIC_DENYLIST_FILE_ENV} does not exist`);
    }
    const rootPath = realpathSync(root);
    const filePath = realpathSync(file);
    if (isInsideRoot(rootPath, filePath)) {
      throw new Error(`${PUBLIC_DENYLIST_FILE_ENV} must point outside the repository`);
    }
    values.push(...parseExactValues(readFileSync(filePath, 'utf8'), PUBLIC_DENYLIST_FILE_ENV));
  }

  return [...new Set(values)];
}

export function findPublicContentDenylistMatches(text, exactValues = [], { generic = true } = {}) {
  const matches = [];
  if (generic) {
    for (const rule of genericPublicContentRules) {
      if (rule.re.test(text)) matches.push(rule.name);
    }
  }
  exactValues.forEach((value, index) => {
    if (text.includes(value)) matches.push(`private exact text #${index + 1}`);
  });
  return [...new Set(matches)];
}
