#!/usr/bin/env node
// 百灵中枢 · 验签/签名参考实现（Node ≥ 18，零依赖，仅 node:crypto）。
// 任意语言照此翻 ~40 行即可对接，无需读 PHP。生产可直接复制本文件，或据此实现。
//
// 签名方案统一为 `sha256=`（算法名，非版本号；GitHub webhook 同款约定）。构造见 CONTRACT.md §2.4b：
//   工具调用 / spec 拉取： "sha256=" + HMAC_SHA256(secret, "<ts>.<METHOD>.<path?query>.<sha256hex(body)>.<On-Behalf-Of>.<Job-Id>")
//   回调 / webhook 送达：  "sha256=" + HMAC_SHA256(secret, "<毫秒ts>.<原始body>")      ← 时间戳是毫秒，构造更短（无 method/path/主体）
// 直接 `node bailing-tool-verify.mjs` 跑自检：比对下方冻结测试向量（与 CONTRACT §2.4b、bailing-tool-verify.py 逐字一致）。
// 自检通过 = 你的 canonical 串拼对了，可放心连真 hub。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmacHex = (secret, msg) => createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
const eq = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** 工具调用签名材料的 HMAC（不含前缀）。spec 拉取把 onBehalfOf/jobId 留空即可（同一套构造、尾部为空）。 */
function toolMac(secret, { ts, method, pathWithQuery, body = '', onBehalfOf = '', jobId = '' }) {
  return hmacHex(secret, `${ts}.${method.toUpperCase()}.${pathWithQuery}.${sha256hex(body)}.${onBehalfOf}.${jobId}`);
}

/** 生成工具调用签名头值（"sha256=..."）。业务侧一般只需 verifyToolCall；本函数便于自检与调试。 */
export function signToolCall(secret, fields) { return `sha256=${toolMac(secret, fields)}`; }

/**
 * 验工具调用签名。true = 确实是中枢发的——**之后仍须按 onBehalfOf 用你自己的权限表做授权裁决（验签 ≠ 授权）**。
 * 关键：必须用收到的【原始 body 字节】算 sha256（中枢「签所发即所发」），别把 JSON 重新序列化后再签。
 */
export function verifyToolCall(secret, { method, pathWithQuery, body = '', timestamp, signature, onBehalfOf = '', jobId = '', windowSec = 300 }) {
  if (!signature || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) >= windowSec) return false; // 时间窗防重放
  return eq(signToolCall(secret, { ts: timestamp, method, pathWithQuery, body, onBehalfOf, jobId }), signature);
}

/**
 * 独立授权探针端点参考实现。中枢刷新工具源时会用不存在的 subject 探测它；
 * 正确行为是验签通过、authorize 返回 false，即 {authorized:false}。
 */
export function authzProbeResponse(secret, { method, pathWithQuery, body = '', timestamp, signature, onBehalfOf = '', jobId = '' }, authorize) {
  const ok = verifyToolCall(secret, { method, pathWithQuery, body, timestamp, signature, onBehalfOf, jobId });
  if (!ok) return { status: 401, body: { authorized: false, error: 'bad_signature' } };
  let subject = onBehalfOf;
  try {
    const parsed = body ? JSON.parse(body) : {};
    if (parsed && typeof parsed.subject === 'string') subject = parsed.subject;
  } catch {
    subject = onBehalfOf;
  }
  let authorized = false;
  try { authorized = !!authorize(subject); } catch { authorized = false; }
  return { status: 200, body: { authorized } };
}

/** 验回调 / webhook 送达签名（毫秒时间戳，构造 = "<ts>.<原始body>"）。 */
export function verifyCallback(secret, { rawBody, timestamp, signature, windowMs = 300_000 }) {
  if (!signature || Math.abs(Date.now() - Number(timestamp)) >= windowMs) return false;
  return eq(`sha256=${hmacHex(secret, `${timestamp}.${rawBody}`)}`, signature);
}

// ---------- 自检：直接运行本文件即比对冻结测试向量 ----------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const SECRET = 'bailing-test-secret';
  const cases = [
    ['工具调用',
      signToolCall(SECRET, { ts: 1718000000, method: 'POST', pathWithQuery: '/goods/create', body: '{"title":"test","price":9.9}', onBehalfOf: '179:1', jobId: 'job-test-001' }),
      'sha256=6deb8dbd54268eee4631129b442acbc9797431642473326a10a5b0826431aae5'],
    ['spec 拉取（空体/空主体/空任务）',
      signToolCall(SECRET, { ts: 1718000000, method: 'GET', pathWithQuery: '/bailing/tools.json' }),
      'sha256=505ab99763cd20b50ba4066ee2ac315fe6af12a8638e7dabef63508abddedc74'],
    ['回调（毫秒时间戳）',
      `sha256=${hmacHex(SECRET, '1718000000000.{"kind":"delivery","job_id":"job-test-001","status":"done"}')}`,
      'sha256=ca81d247422d926be3066f065a8c92a1beaffc6f37f01ef7d3e2c47b46f63210'],
  ];
  let bad = 0;
  for (const [name, got, want] of cases) {
    const ok = got === want;
    console.log(`${ok ? '✓' : '✗'} ${name}\n    ${got}`);
    if (!ok) { bad++; console.log(`    期望 ${want}`); }
  }
  const probeTs = String(Math.floor(Date.now() / 1000));
  const probeBody = '{"subject":"__bailing_authz_probe__:nobody","reason":"bailing-authz-probe","expect":"deny"}';
  const probeSig = signToolCall(SECRET, { ts: probeTs, method: 'POST', pathWithQuery: '/bailing/authz-probe', body: probeBody });
  const probe = authzProbeResponse(SECRET, {
    method: 'POST',
    pathWithQuery: '/bailing/authz-probe',
    body: probeBody,
    timestamp: probeTs,
    signature: probeSig,
  }, (subject) => subject !== '__bailing_authz_probe__:nobody');
  const probeOk = probe.status === 200 && probe.body.authorized === false;
  console.log(`${probeOk ? '✓' : '✗'} 授权探针默认拒绝`);
  if (!probeOk) bad++;
  console.log(bad ? `\n${bad} 个向量不匹配——实现与契约不一致。` : '\n全部匹配 ✓ 实现与 CONTRACT §2.4b 一致，可连真 hub。');
  process.exit(bad ? 1 : 0);
}
