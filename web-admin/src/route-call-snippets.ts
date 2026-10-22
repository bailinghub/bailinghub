export interface SnippetClient {
  app_id: string;
  enabled: boolean;
  allowed_routes?: string[];
}

export interface SnippetRoute {
  route_key: string;
  name?: string;
  session_policy?: string;
  session_key_field?: string;
  delivery?: { type?: string; to_field?: string };
}

export function canCallRoute(client: SnippetClient, routeKey: string | undefined): boolean {
  if (client.enabled !== true || !routeKey) return false;
  return client.allowed_routes?.includes('*') === true || client.allowed_routes?.includes(routeKey) === true;
}

function shellLiteral(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function phpLiteral(value: string): string { return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

function demoMetadata(route: SnippetRoute, sessionValue: string): Record<string, string> {
  const entries: Array<[string, string]> = [];
  if (route.session_policy === 'per_key' && route.session_key_field) entries.push([route.session_key_field, sessionValue]);
  if (route.delivery?.type === 'channel' && route.delivery.to_field) entries.push([route.delivery.to_field, '<收件人id>']);
  return Object.fromEntries(entries);
}

/** Only public connection identifiers enter snippets; credentials are read at runtime. */
export function buildRouteCallSnippets(route: SnippetRoute, client: SnippetClient, hubOrigin: string): Record<'curl' | 'node' | 'python' | 'php' | 'skill', string> {
  const base = hubOrigin.replace(/\/$/, '');
  const runUrl = base + '/run';
  const metadata = demoMetadata(route, 'demo-1');
  const payload = {
    request_id: client.app_id + '_demo-1', route: route.route_key,
    input: '联调测试内容', metadata,
  };
  const shellTokenCheck = ': "${BAILING_CLIENT_TOKEN:?请先设置所选接入方的完整 Token 到 BAILING_CLIENT_TOKEN}"';
  const shellHeader = '-H "Authorization: Bearer ${BAILING_CLIENT_TOKEN}"';
  const queryCommand = `curl ${shellHeader} ${shellLiteral(base + '/jobs/<job_id>')}`;
  const credentialNote = '在运行此代码的终端或服务端配置 BAILING_CLIENT_TOKEN，值为所选接入方的完整 Token，不是列表掩码。';

  const curl = `# ${credentialNote}
${shellTokenCheck}

# 触发；同一业务事件复用 request_id，新事件请更换唯一编号。
curl -m 2 -X POST ${shellLiteral(runUrl)} \\
  -H 'Content-Type: application/json' \\
  ${shellHeader} \\
  -d ${shellLiteral(JSON.stringify(payload))}

# 查询结果（把 <job_id> 换成上一步返回的 job_id）
${queryCommand}`;

  const node = `// ${credentialNote}
// 运行于 Node.js 服务端（ES module），不要放进浏览器前端。
// 同一业务事件复用 request_id，新事件请更换唯一编号。
const clientToken = process.env.BAILING_CLIENT_TOKEN;
if (!clientToken) throw new Error('请先设置 BAILING_CLIENT_TOKEN');

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 2000);

try {
  const response = await fetch(${JSON.stringify(runUrl)}, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + clientToken,
    },
    body: JSON.stringify(${JSON.stringify(payload, null, 2).replace(/\n/g, '\n    ')}),
    signal: controller.signal,
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const data = await response.json();
  console.log(data.job_id, data.status);
  // 需要查询结果时，用返回的 job_id 调 GET /jobs/{job_id}，沿用同一 Token。
} catch (err) {
  // 接入方自行记录失败；不自动重复触发任务。
  console.error('bailing trigger failed', err);
} finally {
  clearTimeout(timeout);
}`;

  const python = `# ${credentialNote}
# pip install requests
# 同一业务事件复用 request_id，新事件请更换唯一编号。
import os
import requests

client_token = os.environ.get("BAILING_CLIENT_TOKEN")
if not client_token:
    raise ValueError("请先设置 BAILING_CLIENT_TOKEN")

payload = ${JSON.stringify(payload, null, 4)}

try:
    response = requests.post(
        ${JSON.stringify(runUrl)},
        json=payload,
        headers={"Authorization": "Bearer " + client_token},
        timeout=2,
    )
    response.raise_for_status()
    print(response.json())
except requests.RequestException as exc:
    # 接入方自行记录失败；不自动重复触发任务。
    print("bailing trigger failed", exc)`;

  const fn = 'bailing_' + route.route_key.replace(/[^a-z0-9]+/gi, '_');
  const metadataExample = Object.entries(metadata).map(([key, value]) => `${phpLiteral(key)} => ${phpLiteral(value)}`).join(', ');
  const php = `<?php
// ${credentialNote}
// 在业务事件点调用：${fn}('本次业务事件唯一号', '任务内容', [${metadataExample}]);
// 同一业务事件复用 request_id，新事件请更换唯一编号。
function ${fn}(string $requestId, string $input, array $metadata = []): void
{
    $clientToken = getenv('BAILING_CLIENT_TOKEN');
    if ($clientToken === false || $clientToken === '') {
        error_log('bailing trigger skipped: 请先设置 BAILING_CLIENT_TOKEN');
        return;
    }
    try {
        $ch = curl_init(${phpLiteral(runUrl)});
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode([
                'request_id' => ${phpLiteral(client.app_id + '_')} . $requestId,
                'route'      => ${phpLiteral(route.route_key)},
                'input'      => $input,
                'metadata'   => (object) $metadata,
            ], JSON_UNESCAPED_UNICODE),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Authorization: Bearer ' . $clientToken],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 1,
            CURLOPT_TIMEOUT        => 2,
        ]);
        $result = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if ($result === false || $status >= 400) {
            error_log('bailing trigger failed: HTTP ' . $status);
        }
        curl_close($ch);
    } catch (\\Throwable $e) {
        // 不记录请求头、Token 或完整请求参数。
        error_log('bailing trigger failed');
    }
}`;

  const skillPayload = { ...payload, request_id: client.app_id + '_<本次事件唯一号>', input: '<任务内容>', metadata: demoMetadata(route, '<业务编号>') };
  const skill = `# Agent Skill: bailing-${route.route_key}

调用百灵中枢路由 ${JSON.stringify(route.route_key)} 完成本场景任务。
运行前由用户在受信本机或服务端环境配置 BAILING_CLIENT_TOKEN，使用接入方 ${JSON.stringify(client.app_id)} 的完整 Token。
不要要求用户把 Token 发进对话，不读取或回显 Token，不将它写入代码、日志或仓库。

派单（返回 202 + job_id）：

\`\`\`bash
${shellTokenCheck}
curl -m 5 -X POST ${shellLiteral(runUrl)} \\
  -H 'Content-Type: application/json' \\
  ${shellHeader} \\
  -d ${shellLiteral(JSON.stringify(skillPayload))}
\`\`\`

- request_id 是幂等键：用本次业务事件的唯一编号，同一事件重试复用该编号。
- 查询结果时，将 <job_id> 替换为派单返回值：

\`\`\`bash
${shellTokenCheck}
${queryCommand}
\`\`\`
`;

  return { curl, node, python, php, skill };
}
