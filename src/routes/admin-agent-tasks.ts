import type { IncomingMessage, ServerResponse } from 'node:http';
import { can, type Principal } from '../app/auth';
import { readBody, PayloadTooLargeError, send } from '../app/http';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import { AgentTaskControlError } from '../core/runtime/agent-task-control';
import { createAdminAgentTaskFor, listAdminAgentTasksFor, getAdminAgentTaskFor, controlAdminAgentTaskFor, taskErrorStatus } from '../app/agent-task-control';

/** Authenticated operator surface. There is deliberately no Agent-bearer create/control API. */
export async function handleAdminAgentTasksApiFor(
  config: ConfigStoreContract, method: string, path: string, req: IncomingMessage, res: ServerResponse, principal: Principal,
): Promise<boolean> {
  if (path !== '/admin/api/agent-tasks' && !path.startsWith('/admin/api/agent-tasks/')) return false;
  if (principal.kind !== 'admin' || !can(principal, method === 'GET' ? 'clients:read' : 'clients:write')) {
    send(res, 403, { error: 'forbidden', message: '当前身份无任务控制权限。' }); return true;
  }
  const query = new URL(req.url ?? path, 'http://bailing.local').searchParams;
  const match = path.match(/^\/admin\/api\/agent-tasks\/([0-9a-f-]+)(\/control)?$/i);
  try {
    const actor = principal.username ?? 'admin-token';
    if (path === '/admin/api/agent-tasks' && method === 'GET') send(res, 200, await listAdminAgentTasksFor(config, query));
    else if (path === '/admin/api/agent-tasks' && method === 'POST') send(res, 200, await createAdminAgentTaskFor(config, actor, await readBody(req, 64 * 1024)));
    else if (match && !match[2] && method === 'GET') send(res, 200, await getAdminAgentTaskFor(config, match[1]!, query));
    else if (match?.[2] === '/control' && method === 'POST') send(res, 200, await controlAdminAgentTaskFor(config, actor, match[1]!, await readBody(req, 4096)));
    else send(res, 404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof AgentTaskControlError) send(res, taskErrorStatus(error), { error: error.code, message: error.message });
    else if (error instanceof PayloadTooLargeError) send(res, 413, { error: 'TASK_INVALID_INPUT', message: '请求过大。' });
    else if (error instanceof SyntaxError) send(res, 400, { error: 'TASK_INVALID_INPUT', message: '请求必须是有效 JSON。' });
    else send(res, 503, { error: 'TASK_UNAVAILABLE', message: '任务记录暂时不可用，请使用原请求重试。' });
  }
  return true;
}
