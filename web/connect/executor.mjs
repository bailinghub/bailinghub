#!/usr/bin/env node
// 百灵中枢 · 通用执行器（单文件 · 零依赖 · Node ≥ 18）
// 把任何本地智能体 / 命令行工具接成中枢的"大脑"：出站长轮询认领任务 → 喂给你的命令 → stdout 回报为结果。
// 全程只有本机 → 中枢的出站 HTTP，无需公网 IP、无需开端口、无需 WebSocket。
//
// 用法：
//   node executor.mjs --hub https://你的中枢地址 --token <执行器令牌：控制台「执行器」页签发> \
//     --targets my-agent --cmd 'claude -p'
//
// 例子：
//   --cmd 'claude -p'        让本机 Claude Code 当大脑（无头模式，stdin 进 prompt，stdout 出回答）
//   --cmd 'cat'              回声自测：原样返回任务内容，验证认领→回报链路
//   --cmd './my-agent.sh'    任何脚本：stdin 读任务 input，stdout 写结果，退出码非 0 = 失败
//
// 命令运行时可读的环境变量（按需取用，不取也能跑）：
//   BAILING_JOB_ID / BAILING_REQUEST_ID / BAILING_TARGET / BAILING_PROFILE
//   BAILING_SESSION_ID / BAILING_IS_CONTINUE（"1"=同会话续聊，可据此续接你自己的上下文）
//   BAILING_METADATA（JSON 字符串）/ BAILING_PROJECT_PATH（路由绑定项目时的代码目录）
//   BAILING_TOOLS（路由挂了业务工具时的清单 JSON）/ BAILING_TOOL_TOKEN / BAILING_TOOLS_URL
//     —— 你的大脑可 POST $BAILING_TOOLS_URL（Bearer $BAILING_TOOL_TOKEN，体 {"tool":"名称","arguments":{...}}）
//        经中枢统一代理调用业务接口（白名单/风险闸/限流/审计/签名全在中枢侧），响应 {ok,text,status}
//
// 可选参数：
//   --executor-id <名字>   控制台「执行器」里显示的身份，默认 主机名
//   --runtime <字符串>     自报「这是什么智能体/引擎」（如 codex-cli / my-agent），在控制台「执行器」页显示
//   --labels <a,b,c>       自定义标签，逗号分隔（便于识别这台机器的角色）
//   --wait-ms <毫秒>       长轮询挂起时长，默认 12000（中枢前有 CDN 时别超过其回源超时）
//   --timeout-ms <毫秒>    单任务硬超时，默认 0 = 不限（智能体任务可能要跑很久）

import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

function arg(name, fallback = '') {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const HUB = arg('hub').replace(/\/+$/, '');
const TOKEN = arg('token');
const TARGETS = arg('targets').split(',').map((s) => s.trim()).filter(Boolean);
const CMD = arg('cmd');
const EXECUTOR_ID = arg('executor-id', hostname());
const WAIT_MS = Number(arg('wait-ms', '12000'));
const TIMEOUT_MS = Number(arg('timeout-ms', '0'));
// 自报能力（可选）：这是什么智能体/引擎 + 标签。通用执行器跑任意命令，无「profile」概念，故只报 runtime/labels。
const CAPABILITIES = {};
{
  const rt = arg('runtime', '');
  const labels = arg('labels', '').split(',').map((s) => s.trim()).filter(Boolean);
  if (rt) CAPABILITIES.runtime = rt;
  if (labels.length) CAPABILITIES.labels = labels;
}

if (!HUB || !TOKEN || !TARGETS.length || !CMD) {
  console.error('用法：node executor.mjs --hub <中枢地址> --token <管理员token> --targets <目标名,可多个> --cmd <处理命令>');
  process.exit(1);
}
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const log = (m) => console.log(`[执行器] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 长轮询认领一个任务；无活/出错返回 null。 */
async function claim() {
  try {
    const r = await fetch(`${HUB}/executor/claim`, {
      method: 'POST', headers,
      body: JSON.stringify({ executor_id: EXECUTOR_ID, targets: TARGETS, wait_ms: WAIT_MS, ...(Object.keys(CAPABILITIES).length ? { capabilities: CAPABILITIES } : {}) }),
    });
    if (!r.ok) {
      const hint = r.status === 401 ? '（令牌不对或已停用：到控制台「执行器」页核对/重签 --token）'
        : r.status === 403 ? `（令牌有效，但没被授权认领「${TARGETS.join(',')}」：到控制台该令牌的「可认领 target」里加上）`
        : '';
      log(`claim 返回 ${r.status}${hint}，稍后重试`); return null;
    }
    return (await r.json()).job ?? null;
  } catch (e) { log(`claim 失败（中枢不可达？）：${e}`); return null; }
}

/** 回报结果（带轻重试；最终失败也无妨，中枢会把滞留任务自动重排）。 */
async function report(jobId, payload) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${HUB}/executor/result`, { method: 'POST', headers, body: JSON.stringify({ job_id: jobId, ...payload }) });
      if (r.ok) return;
    } catch { /* 下一轮重试 */ }
    await sleep(2000 * (i + 1));
  }
  log(`result 最终失败 job=${jobId}（中枢稍后会自动重排此任务）`);
}

/** 把任务喂给 --cmd：stdin = input，stdout = 结果文本，退出码非 0 = 失败（stderr 作错误信息）。 */
function runCmd(work) {
  return new Promise((done) => {
    const child = spawn('sh', ['-c', CMD], {
      env: {
        ...process.env,
        BAILING_JOB_ID: work.job_id, BAILING_REQUEST_ID: work.request_id ?? '',
        BAILING_TARGET: work.target ?? '', BAILING_PROFILE: work.profile ?? '',
        BAILING_SESSION_ID: work.session?.sessionId ?? '',
        BAILING_IS_CONTINUE: work.session?.isContinue ? '1' : '0',
        BAILING_METADATA: JSON.stringify(work.metadata ?? {}),
        BAILING_PROJECT_PATH: work.project_path ?? '',
        ...(work.tools ? {
          BAILING_TOOLS: JSON.stringify(work.tools.defs ?? []),
          BAILING_TOOL_TOKEN: work.tools.tool_token ?? '',
          BAILING_TOOLS_URL: `${HUB}${work.tools.invoke_url ?? ''}`,
        } : {}),
      },
    });
    let out = '', err = '', killed = false;
    const timer = TIMEOUT_MS > 0 ? setTimeout(() => { killed = true; child.kill('SIGKILL'); }, TIMEOUT_MS) : null;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); done({ ok: false, error: `命令启动失败：${e}` }); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killed) { done({ ok: false, error: `任务超时（${TIMEOUT_MS}ms），已终止` }); return; }
      done(code === 0 ? { ok: true, text: out.trim() } : { ok: false, error: (err.trim() || `命令退出码 ${code}`).slice(0, 2000) });
    });
    child.stdin.write(work.input ?? '');
    child.stdin.end();
  });
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log(`收到 ${sig}，处理完当前任务后退出`); });

/** 独立心跳：与认领循环解耦。执行器跑长任务时 runCmd 阻塞着 claim（claim 兼作心跳），靠这条定时器按 ~30s
 *  持续上报存活，使中枢按"执行器是否还活着"判离线/重排，而不是拿任务时长瞎猜——长任务是常态，不该被判掉线。 */
const HEARTBEAT_MS = 30_000;
const heartbeatTimer = setInterval(() => {
  fetch(`${HUB}/executor/heartbeat`, {
    method: 'POST', headers,
    body: JSON.stringify({ executor_id: EXECUTOR_ID, targets: TARGETS, ...(Object.keys(CAPABILITIES).length ? { capabilities: CAPABILITIES } : {}) }),
  }).catch(() => { /* 心跳尽力而为，失败下一拍再来 */ });
}, HEARTBEAT_MS);
heartbeatTimer.unref?.();

log(`启动 → 中枢 ${HUB}  executor=${EXECUTOR_ID}  targets=${TARGETS.join(',')}  cmd=${CMD}`);
while (!stopping) {
  const work = await claim();
  if (!work) { await sleep(800); continue; }
  log(`执行 ${work.job_id}  target=${work.target}`);
  const t0 = Date.now();
  const r = await runCmd(work);
  // 回带本次派发的 claim_token：中枢据此拒收"任务被重排后、原执行器迟到的过期回报"，防结果错配/重复
  const base = r.ok ? { ok: true, output: { text: r.text } } : { ok: false, output: {}, error: r.error };
  await report(work.job_id, work.claim_token ? { ...base, claim_token: work.claim_token } : base);
  log(`完成 ${work.job_id}  ok=${r.ok}  用时=${Date.now() - t0}ms`);
}
clearInterval(heartbeatTimer);
log('已退出');
