export type SmokeStatus = 'pass' | 'fail' | 'skip';

export interface SmokeCheck {
  name: string;
  status: SmokeStatus;
  detail?: string;
}

export interface SmokeReport {
  hub: string;
  started_at: string;
  finished_at: string;
  pass: number;
  fail: number;
  skip: number;
  checks: SmokeCheck[];
  run?: {
    route?: string;
    request_id?: string;
    job_id?: string;
    status?: string;
  };
}

export interface SmokeRequestResult {
  status: number;
  json: any;
  text: string;
}

export type SmokeRequest = (method: string, path: string, opts?: { token?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }) => Promise<SmokeRequestResult>;

export interface SmokeOptions {
  hub: string;
  adminToken?: string;
  adminHeaders?: Record<string, string>;
  tenantId?: string;
  runRoute?: string;
  runToken?: string;
  runInput?: string;
  waitMs?: number;
  pollMs?: number;
  request?: SmokeRequest;
}

function terminalStatus(status: string): boolean {
  return ['done', 'error', 'rejected'].includes(status);
}

function short(s: string, limit = 180): string {
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

export function createSmokeRequest(hub: string): SmokeRequest {
  const base = hub.replace(/\/+$/, '');
  return async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* static html/js */ }
    return { status: r.status, json, text };
  };
}

export async function runHubSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const hub = options.hub.replace(/\/+$/, '');
  const req: SmokeRequest = options.request ?? createSmokeRequest(hub);
  const checks: SmokeCheck[] = [];
  const startedAt = new Date().toISOString();
  const waitMs = options.waitMs ?? 15_000;
  const pollMs = options.pollMs ?? 500;
  const run: SmokeReport['run'] = {};

  const add = (name: string, status: SmokeStatus, detail?: string): void => {
    checks.push({ name, status, ...(detail ? { detail } : {}) });
  };
  const pass = (name: string): void => add(name, 'pass');
  const fail = (name: string, detail?: string): void => add(name, 'fail', detail);
  const skip = (name: string, detail?: string): void => add(name, 'skip', detail);
  const scopedPath = (path: string): string => {
    const tenantId = options.tenantId?.trim();
    if (!tenantId) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}tenant=${encodeURIComponent(tenantId)}`;
  };

  try {
    const health = await req('GET', '/health');
    health.status === 200 && health.json?.status === 'ok'
      ? pass('health 返回 ok')
      : fail('health 返回 ok', `${health.status} ${short(health.text)}`);
  } catch (e) {
    fail('health 返回 ok', (e as Error).message);
  }

  try {
    const consolePage = await req('GET', '/console/');
    consolePage.status === 200 && consolePage.text.includes('<div id="app">')
      ? pass('控制台入口可访问')
      : fail('控制台入口可访问', `HTTP ${consolePage.status}`);
  } catch (e) {
    fail('控制台入口可访问', (e as Error).message);
  }

  try {
    const schema = await req('GET', '/schemas/config/route.schema.json');
    schema.status === 200 && schema.json?.title
      ? pass('公开 route schema 可访问')
      : fail('公开 route schema 可访问', `HTTP ${schema.status}`);
  } catch (e) {
    fail('公开 route schema 可访问', (e as Error).message);
  }

  const adminHeaders = options.adminHeaders && Object.keys(options.adminHeaders).length ? options.adminHeaders : undefined;
  const adminAvailable = options.adminToken !== undefined || adminHeaders !== undefined;
  const adminOpts = { token: options.adminToken, headers: adminHeaders };
  if (!adminAvailable) {
    skip('管理 API smoke', '未提供 admin token');
  } else {
    try {
      const version = await req('GET', scopedPath('/admin/api/version'), adminOpts);
      version.status === 200 && !!version.json?.app?.name
        ? pass('版本 API 可访问')
        : fail('版本 API 可访问', `HTTP ${version.status}`);
    } catch (e) {
      fail('版本 API 可访问', (e as Error).message);
    }

    try {
      const diagnostics = await req('GET', scopedPath('/admin/api/config-diagnostics'), { ...adminOpts, timeoutMs: 20_000 });
      diagnostics.status === 200 && typeof diagnostics.json?.errors === 'number' && Array.isArray(diagnostics.json?.diagnostics)
        ? pass('系统体检 API 可访问')
        : fail('系统体检 API 可访问', `HTTP ${diagnostics.status}`);
    } catch (e) {
      fail('系统体检 API 可访问', (e as Error).message);
    }

    try {
      const preview = await req('POST', scopedPath('/admin/api/routes/auto-preview'), {
        ...adminOpts,
        body: { input: 'smoke route auto preview', metadata: {}, principal: { id: 'smoke-user', roles: ['smoke'] } },
      });
      preview.status === 200 && Array.isArray(preview.json?.rows)
        ? pass('route=auto 预演 API 可访问')
        : fail('route=auto 预演 API 可访问', `HTTP ${preview.status}`);
    } catch (e) {
      fail('route=auto 预演 API 可访问', (e as Error).message);
    }
  }

  if (!options.runRoute) {
    skip('/run + trace smoke', '未设置 runRoute');
  } else if (!options.runToken) {
    skip('/run + trace smoke', '未提供 runToken');
  } else {
    const requestId = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    run.route = options.runRoute;
    run.request_id = requestId;
    try {
      const created = await req('POST', scopedPath('/run'), {
        token: options.runToken,
        body: {
          request_id: requestId,
          route: options.runRoute,
          source: 'smoke',
          input: options.runInput || 'smoke test: 查询订单 SO-1001 并创建售后工单',
          metadata: {
            visitor_uid: `smoke-${requestId}`,
            operator_uid: 'demo-user-001',
            principal: { id: 'smoke-user', roles: ['smoke'] },
          },
        },
      });
      if (created.status === 202 && created.json?.job_id) {
        run.job_id = created.json.job_id;
        pass('/run 建单成功');
      } else {
        fail('/run 建单成功', `HTTP ${created.status} ${short(JSON.stringify(created.json ?? created.text))}`);
      }
    } catch (e) {
      fail('/run 建单成功', (e as Error).message);
    }

    if (run.job_id) {
      const deadline = Date.now() + waitMs;
      let last: any = null;
      while (Date.now() < deadline) {
        const got = await req('GET', scopedPath(`/jobs/${encodeURIComponent(run.job_id)}`), { token: options.runToken, timeoutMs: 10_000 }).catch((e) => ({ status: 0, json: null, text: (e as Error).message }));
        last = got.json;
        const status = String(got.json?.status ?? '');
        if (status) run.status = status;
        if (terminalStatus(status)) break;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      terminalStatus(run.status ?? '')
        ? pass('/run 任务进入终态')
        : fail('/run 任务进入终态', `当前状态 ${run.status || last?.status || 'unknown'}`);

      if (adminAvailable) {
        try {
          const trace = await req('GET', scopedPath(`/admin/api/runs/trace?request_id=${encodeURIComponent(requestId)}`), { ...adminOpts, timeoutMs: 20_000 });
          trace.status === 200 && !!trace.json?.debug_bundle?.diagnosis
            ? pass('按 request_id 可追溯 debug_bundle')
            : fail('按 request_id 可追溯 debug_bundle', `HTTP ${trace.status}`);
          trace.status === 200 && trace.json?.debug_bundle?.redaction?.applied === true
            ? pass('debug_bundle 默认脱敏')
            : fail('debug_bundle 默认脱敏', '缺少 redaction.applied=true');
        } catch (e) {
          fail('按 request_id 可追溯 debug_bundle', (e as Error).message);
        }
      } else {
        skip('trace debug_bundle smoke', '未提供 admin token');
      }
    }
  }

  const passCount = checks.filter((c) => c.status === 'pass').length;
  const failCount = checks.filter((c) => c.status === 'fail').length;
  const skipCount = checks.filter((c) => c.status === 'skip').length;
  return {
    hub,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    pass: passCount,
    fail: failCount,
    skip: skipCount,
    checks,
    ...(run.route || run.job_id ? { run } : {}),
  };
}
