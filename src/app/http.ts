// HTTP 请求/响应底层管线：JSON / 原始 body 读取、统一 send、控制台静态托管、访客 IP。
// 纯插管、无业务逻辑、无 runtime 单例依赖。需要实例目录的能力由调用方显式传入。
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export function now(): string { return new Date().toISOString(); }
export function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
export function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

export class PayloadTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(readonly maxBytes: number) {
    super(`payload too large: max ${maxBytes} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

export const DEFAULT_JSON_BODY_MAX_BYTES = Number(process.env.BAILING_JSON_BODY_MAX_BYTES ?? 1024 * 1024) || 1024 * 1024;

export async function readBody(req: IncomingMessage, maxBytes = DEFAULT_JSON_BODY_MAX_BYTES): Promise<Record<string, unknown>> {
  return readBodyCapped(req, maxBytes);
}

/** 带上限的 body 读取：累计超 maxBytes 立即抛错，防超大 JSON/base64 灌爆内存。 */
export async function readBodyCapped(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new PayloadTooLargeError(maxBytes);
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}
export function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
/** 原始 body（企微回调是 XML 不是 JSON）。带上限防灌爆。 */
export async function readRawBody(req: IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new PayloadTooLargeError(maxBytes);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// ---- 控制台静态托管（web/console = web-admin 的 Vite 构建产物；页面壳公开，数据 API 照常走鉴权）----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.map': 'application/json',
};

export function serveConsoleFromRoot(root: string, urlPath: string, res: ServerResponse, head = false): void {
  const consoleDir = join(root, 'web', 'console');
  const rel = urlPath.replace(/^\/console\/?/, '');
  let file = resolve(consoleDir, rel || 'index.html');
  if (!file.startsWith(consoleDir)) { send(res, 404, { error: 'not found' }); return; } // 防路径穿越
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(consoleDir, 'index.html'); // SPA fallback
  if (!existsSync(file)) { send(res, 404, { error: '控制台未构建（web-admin: npm run build）' }); return; }
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // 带 hash 的静态资源可长缓存；index.html 必须每次取（不然发版后还是旧壳）
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
  });
  res.end(head ? undefined : readFileSync(file));
}
/** 访客 IP（经 EdgeOne/nginx 转发取 XFF 首跳）。 */
export function ipOf(req: IncomingMessage): string {
  return ((req.headers['x-forwarded-for'] ?? '').toString().split(',')[0] || req.socket.remoteAddress || '?').trim();
}
