// 公开 HTTP 面：健康检查、版本/schema、控制台静态资源、SDK 下载、widget 与网页聊天入口。
// 这里的端点都不走 admin/client 鉴权；安全边界由“只暴露公开资源”或各自的签名/Origin/限速实现。
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { send } from '../app/http';
import { LOCAL_UPLOAD_URL_PREFIX, localObjectFile } from '../adapters/storage/object-storage';
import { buildVersionInfo } from '../core/platform/version';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

const SITE_PATHS = new Set(['/product', '/features', '/governance', '/docs', '/opensource', '/partners', '/pricing']);
const EXECUTOR_SKILL_FILES = new Map<string, string>([
  ['/connect/skills/connect-bailinghub-executor/SKILL.md', 'SKILL.md'],
  ['/connect/skills/connect-bailinghub-executor/references/direct-protocol.md', 'references/direct-protocol.md'],
  ['/connect/skills/connect-bailinghub-executor/references/openclaw.md', 'references/openclaw.md'],
]);

function chatCors(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, last-event-id');
}

export interface PublicHttpDeps {
  cfg: AppConfig;
  configStore: ConfigStoreContract | null;
  queue: { stats(): Record<string, number> };
  isPaused: () => boolean;
  readiness?: () => Promise<{ ready: boolean; checks: Record<string, unknown> }>;
  operationalStatus?: () => Record<string, unknown>;
  serveConsole: (urlPath: string, res: ServerResponse, head?: boolean) => void;
  handleChat(req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void>;
  handleChatConfig(req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void>;
  handleChatEvents(req: IncomingMessage, res: ServerResponse, entryKey: string, jobId: string, url: URL): Promise<void>;
  handleChatThread(req: IncomingMessage, res: ServerResponse, entryKey: string, url: URL): Promise<void>;
  handleChatUpload(req: IncomingMessage, res: ServerResponse, entryKey: string): Promise<void>;
  handleChatRate(req: IncomingMessage, res: ServerResponse, entryKey: string, jobId: string): Promise<void>;
  serveChatDemo(res: ServerResponse, entryKey: string): void;
}

function serveStaticFile(res: ServerResponse, file: string, contentType: string, head: boolean, disposition?: string): void {
  if (!existsSync(file)) { send(res, 404, { error: 'not found' }); return; }
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-cache',
    ...(disposition ? { 'content-disposition': disposition } : {}),
  });
  res.end(head ? undefined : readFileSync(file));
}

function publicSchemaFile(root: string, rel: string): string {
  const primary = join(root, 'schemas', rel);
  if (existsSync(primary)) return primary;
  return join(dirname(root), 'bailinghub', 'schemas', rel);
}

function publicContractFile(root: string, rel: string): string {
  const primary = join(root, 'contracts', rel);
  if (existsSync(primary)) return primary;
  return join(dirname(root), 'bailinghub', 'contracts', rel);
}

function serveSourcePackage(deps: PublicHttpDeps, res: ServerResponse, head: boolean): void {
  const dir = mkdtempSync(join(tmpdir(), 'bailinghub-pack-'));
  try {
    execFileSync('npm', ['pack', '--silent', '--pack-destination', dir], {
      cwd: deps.cfg.root,
      env: { ...process.env, npm_config_cache: join(dir, 'npm-cache') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const file = readdirSync(dir).find((name) => name.endsWith('.tgz'));
    if (!file) { send(res, 500, { error: 'source package not generated' }); return; }
    const body = readFileSync(join(dir, file));
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'cache-control': 'no-cache',
      'content-disposition': 'attachment; filename="bailinghub-source.tgz"',
    });
    res.end(head ? undefined : body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function handlePublicHttpFor(deps: PublicHttpDeps, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const head = method === 'HEAD';
  const read = method === 'GET' || head;

  if (read && path === '/health') {
    if (head) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(); return true; }
    const version = buildVersionInfo(deps.cfg.root);
    send(res, 200, {
      status: 'ok',
      app: version.app,
      build: version.build,
      paused: deps.isPaused(),
      queue: deps.queue.stats(),
      backend: deps.cfg.state.backend,
      configBackend: !!deps.configStore,
      ...(deps.operationalStatus ? { observability: deps.operationalStatus() } : {}),
    });
    return true;
  }
  if (read && path === '/health/ready') {
    const report = deps.readiness
      ? await deps.readiness()
      : { ready: true, checks: { state_backend: 'ok' } };
    if (head) {
      res.writeHead(report.ready ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    send(res, report.ready ? 200 : 503, { status: report.ready ? 'ready' : 'not_ready', checks: report.checks });
    return true;
  }
  if (read && path === '/version') {
    if (head) { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(); return true; }
    send(res, 200, buildVersionInfo(deps.cfg.root));
    return true;
  }

  const mSchema = read ? path.match(/^\/schemas\/([A-Za-z0-9_.\/-]+\.schema\.json)$/) : null;
  if (mSchema) {
    const rel = mSchema[1]!;
    if (rel.includes('..')) { send(res, 400, { error: 'bad schema path' }); return true; }
    const f = publicSchemaFile(deps.cfg.root, rel);
    if (!existsSync(f)) { send(res, 404, { error: 'schema not found' }); return true; }
    res.writeHead(200, { 'content-type': 'application/schema+json; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(head ? undefined : readFileSync(f));
    return true;
  }

  const mContract = read ? path.match(/^\/contracts\/(client-api\/v[0-9]+\/[A-Za-z0-9_.-]+\.json)$/) : null;
  if (mContract) {
    const file = publicContractFile(deps.cfg.root, mContract[1]!);
    if (!existsSync(file)) { send(res, 404, { error: 'contract artifact not found' }); return true; }
    const isSchema = file.endsWith('.schema.json');
    res.writeHead(200, {
      'content-type': isSchema ? 'application/schema+json; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-cache',
    });
    res.end(head ? undefined : readFileSync(file));
    return true;
  }

  // favicon：公开页（演示页/控制台壳）会被浏览器自动请求，落到鉴权闸会冒 401 噪音。
  if (read && path === '/favicon.ico') { res.writeHead(204); res.end(); return true; }
  if (read && path.startsWith(LOCAL_UPLOAD_URL_PREFIX + '/')) {
    let key = '';
    try { key = decodeURIComponent(path.slice(LOCAL_UPLOAD_URL_PREFIX.length + 1)); }
    catch { send(res, 404, { error: 'not found' }); return true; }
    const target = localObjectFile(deps.cfg.root, key);
    if (!target || !existsSync(target.file)) { send(res, 404, { error: 'not found' }); return true; }
    res.writeHead(200, { 'content-type': target.contentType, 'cache-control': 'public, max-age=31536000, immutable' });
    res.end(head ? undefined : readFileSync(target.file));
    return true;
  }
  // /admin 页面进入新控制台；/admin/login、/admin/api/* 等 API 路径保持不变。
  if (read && path === '/admin') { res.writeHead(302, { location: '/console/' }); res.end(); return true; }
  // /console 页面壳无敏感数据，公开可取；登录/登出在鉴权闸门之前。
  if (read && (path === '/console' || path.startsWith('/console/'))) { deps.serveConsole(path, res, head); return true; }
  // 中枢实例不托管官网：根路径进入控制台，官网由 www.bailinghub.com 独立承载。
  if (read && path === '/') { res.writeHead(302, { location: '/console/' }); res.end(); return true; }
  if (read && (path === '/robots.txt' || path === '/sitemap.xml' || SITE_PATHS.has(path) || path.startsWith('/docs/') || path.startsWith('/site/'))) {
    send(res, 404, { error: 'site disabled' });
    return true;
  }

  if (read && path === '/connect/executor.mjs') {
    serveStaticFile(res, join(deps.cfg.root, 'web', 'connect', 'executor.mjs'), 'text/javascript; charset=utf-8', head);
    return true;
  }
  if (read && path === '/connect/openclaw-stdio.mjs') {
    serveStaticFile(res, join(deps.cfg.root, 'web', 'connect', 'openclaw-stdio.mjs'), 'text/javascript; charset=utf-8', head);
    return true;
  }
  const executorSkillFile = read ? EXECUTOR_SKILL_FILES.get(path) : undefined;
  if (executorSkillFile) {
    serveStaticFile(
      res,
      join(deps.cfg.root, 'web', 'connect', 'skills', 'connect-bailinghub-executor', executorSkillFile),
      'text/markdown; charset=utf-8',
      head,
    );
    return true;
  }
  if (read && path === '/install.sh') {
    serveStaticFile(res, join(deps.cfg.root, 'scripts', 'install.sh'), 'text/x-shellscript; charset=utf-8', head);
    return true;
  }
  if (read && path === '/connect/bailinghub-source.tgz') {
    serveSourcePackage(deps, res, head);
    return true;
  }
  const mSdk = read ? path.match(/^\/connect\/(bailing-connect-php7?\.tgz)$/) : null;
  if (mSdk) {
    serveStaticFile(res, join(deps.cfg.root, 'web', 'connect', mSdk[1]!), 'application/gzip', head, `attachment; filename="${mSdk[1]}"`);
    return true;
  }

  // ---- 聊天入口公开面（CORS 放开；"哪些站点能嵌"由服务端 Origin 白名单裁决）----
  if (path === '/widget.js' || path.startsWith('/chat/') || path.startsWith('/widget/demo/')) {
    chatCors(res);
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
  }
  if (read && path === '/widget.js') {
    serveStaticFile(res, join(deps.cfg.root, 'web', 'widget', 'widget.js'), 'text/javascript; charset=utf-8', head);
    return true;
  }
  const mChatDemo = method === 'GET' ? path.match(/^\/widget\/demo\/([a-z0-9_-]{4,32})$/) : null;
  if (mChatDemo) { deps.serveChatDemo(res, mChatDemo[1]!); return true; }
  const mChat = method === 'POST' ? path.match(/^\/chat\/([a-z0-9_-]{4,32})$/) : null;
  if (mChat) { await deps.handleChat(req, res, mChat[1]!); return true; }
  const mChatCfg = method === 'GET' ? path.match(/^\/chat\/([a-z0-9_-]{4,32})\/config$/) : null;
  if (mChatCfg) { await deps.handleChatConfig(req, res, mChatCfg[1]!); return true; }
  const mChatEvents = method === 'GET' ? path.match(/^\/chat\/([a-z0-9_-]{4,32})\/events\/([0-9a-f-]{36})$/) : null;
  if (mChatEvents) { await deps.handleChatEvents(req, res, mChatEvents[1]!, mChatEvents[2]!, url); return true; }
  const mChatThread = method === 'GET' ? path.match(/^\/chat\/([a-z0-9_-]{4,32})\/thread$/) : null;
  if (mChatThread) { await deps.handleChatThread(req, res, mChatThread[1]!, url); return true; }
  const mChatUpload = method === 'POST' ? path.match(/^\/chat\/([a-z0-9_-]{4,32})\/upload$/) : null;
  if (mChatUpload) { await deps.handleChatUpload(req, res, mChatUpload[1]!); return true; }
  const mChatRate = method === 'POST' ? path.match(/^\/chat\/([a-z0-9_-]{4,32})\/rate\/([0-9a-f-]{36})$/) : null;
  if (mChatRate) { await deps.handleChatRate(req, res, mChatRate[1]!, mChatRate[2]!); return true; }

  return false;
}
