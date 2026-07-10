// 内置动作工具（非业务工具源）：让大脑/执行器在执行过程中**自己命名收件人**主动发消息——
// "完成了某件事，自己就知道发给谁"。中枢只持有渠道凭证 + 校验"这条路由准发哪些渠道"，
// 收件人是谁、发几次全由大脑当场决定，中枢不持有任何人↔身份映射（见 docs/CONTRACT.md §2.4c）。
// 复用 channelSend 出站原语 + /send 的入历史纪律（记 out、scope 共享、逐字投递）。
import { createHash } from 'node:crypto';
import type { Job } from '../core/contracts/types';
import { type ChannelMessage, channelScopeKey, channelSendFor } from './channels';
import { sendMessageConfig } from '../core/config/tools-config';
import { SEND_TOOL_NAME, type BuiltinToolDef } from '../core/targets/adapter';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export { SEND_MAX_CALLS, SEND_TOOL_NAME } from '../core/targets/adapter';

/**
 * 路由声明的「大脑可主动发哪些渠道」白名单：`tools.builtin.send_message.channels` = 渠道名数组，`['*']` = 所有启用渠道。
 * 返回**解析后确实存在且启用**的渠道名清单（'*' 展开成全部启用渠道）；未配置 / 无后端 / 无命中返回 []。
 * 这是唯一的发送闸：路由准发哪些渠道由中枢后台定，收件人由大脑当场给——中枢不枚举任何人。
 */
export async function resolveSendChannelsFor(config: ConfigStoreContract | null, tcfg: Record<string, unknown> | undefined): Promise<string[]> {
  const raw = sendMessageConfig(tcfg)?.channels ?? [];
  if (!raw.length || !config) return [];
  const enabled = (await config.channels.list().catch(() => [])).filter((c) => c.enabled).map((c) => c.name);
  if (raw.includes('*')) return enabled;
  return raw.filter((n) => enabled.includes(n));
}

/** 生成喂大脑的 send_message 工具定义。channels = 本路由允许发送的渠道清单（已解析）。 */
export function sendToolDef(channels: string[]): BuiltinToolDef {
  const list = channels.join(' / ');
  const multi = channels.length > 1;
  return {
    type: 'function',
    function: {
      name: SEND_TOOL_NAME,
      description: `主动给指定的人发送一条消息（经渠道送达，如企业微信），可附带文件（如审核报告）。当你完成了某件事、需要把结果或通知/报告发给某个人时调用——收件人由你指定，不是预先设定的。可用渠道：${list}。一次可发给多人。`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '收件人在该渠道的原生 id（企业微信即成员 UserID）；发给多人用竖线分隔，如 "ZhangSan|LiSi|WangWu"' },
          text: { type: 'string', description: '要发送的正文（纯文本；企业微信不渲染 Markdown，请用纯文本）。带附件时这里写一句说明，完整内容放 files。' },
          files: {
            type: 'array',
            description: '可选附件，用于把完整报告/文件发给对方（如代码审核报告）。最多 5 个。每项推荐用 {name, content}：name=带扩展名的文件名（如 "审核报告.md"），content=该文件的完整文本内容（你直接把报告全文放这里，中枢会生成文件发出去，无需你先上传到任何地方）。也可用 {name, url} 发一个已托管的文件。',
            items: { type: 'object', properties: { name: { type: 'string', description: '文件名，带扩展名，如 审核报告.md' }, content: { type: 'string', description: '文件的完整文本内容（生成的报告全文放这里）' }, url: { type: 'string', description: '已托管文件的 http(s) URL（与 content 二选一）' } }, required: ['name'] },
          },
          ...(multi ? { channel: { type: 'string', description: `走哪个渠道（只有一个可用渠道时可省略）`, enum: channels } } : {}),
        },
        required: ['to', 'text'],
      },
    },
  };
}

/**
 * 受治理执行 send_message：校验渠道白名单 → channelSend 投递 → 给每个收件人各自 thread 记一条 out（与 /send 同纪律）。
 * 返回回流给大脑的文本（成功失败都以文本回流，让大脑据此向用户解释）。永不抛。
 */
export async function runSendMessageFor(
  config: ConfigStoreContract | null,
  job: Job,
  allowedChannels: string[],
  args: Record<string, unknown>,
  audit?: (event: string, detail: Record<string, unknown>) => void,
): Promise<{ ok: boolean; text: string }> {
  if (!config) return { ok: false, text: '发送失败：中枢无 mysql 后端。' };
  if (!allowedChannels.length) return { ok: false, text: '本路由未开放任何可主动发送的渠道，无法发送。' };
  // 渠道：显式 channel 必须在白名单内；不给且只有一个允许渠道 → 默认它
  const reqCh = String(args['channel'] ?? '').trim();
  const channelName = reqCh || (allowedChannels.length === 1 ? allowedChannels[0]! : '');
  if (!channelName) return { ok: false, text: `请用 channel 参数指定渠道，可选：${allowedChannels.join(' / ')}。` };
  if (!allowedChannels.includes(channelName)) return { ok: false, text: `渠道 ${channelName} 不在本路由允许发送的范围内（可选：${allowedChannels.join(' / ')}）。` };
  // 收件人：string / 数组 / "A|B|C"。去重 + 封顶 1000（企微 touser 上限）。
  const toVal = args['to'];
  const rawList = Array.isArray(toVal) ? toVal.map((x) => String(x)) : String(toVal ?? '').split('|');
  const recipients = [...new Set(rawList.map((x) => x.trim()).filter(Boolean))].slice(0, 1000);
  if (!recipients.length) return { ok: false, text: '请用 to 参数指定收件人 id。' };
  const text = String(args['text'] ?? '').trim();
  // 附件：每项 {name, content} 内联文本（如生成的 .md 报告）或 {name, url} 已托管文件。最多 5 个。
  const files = (Array.isArray(args['files']) ? (args['files'] as unknown[]) : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      name: String(f['name'] ?? 'file').slice(0, 120),
      content: typeof f['content'] === 'string' ? (f['content'] as string) : undefined,
      url: typeof f['url'] === 'string' ? (f['url'] as string).trim() : undefined,
    }))
    .filter((f) => f.content !== undefined || f.url)
    .slice(0, 5);
  if (!text && !files.length) return { ok: false, text: '请用 text 给出正文，或用 files 附上要发送的文件。' };
  const ch = await config.channels.get(channelName);
  if (!ch || !ch.enabled) return { ok: false, text: `渠道 ${channelName} 不存在或已停用。` };
  const label = recipients.length === 1 ? recipients[0]! : `${recipients.length}人`;
  // 附件审计快照：每个文件记 名称 + 字节数 + 全文 sha256（可对账"对方收到的是不是这一份")+ 内容(封顶，超出以 sha256 为准)。
  // 落进 builtin_send 审计（按 job_id 可追溯）——这样从任务详情就能看到本次到底发了什么文件，不会出现"对方说收到另一份说不清"。
  const fileAudit = files.map((f) => f.content !== undefined
    ? { name: f.name, bytes: Buffer.byteLength(f.content, 'utf8'), sha256: createHash('sha256').update(f.content, 'utf8').digest('hex'), content: f.content.length > 16000 ? f.content.slice(0, 16000) + '…（已截断，完整内容以 sha256 为准）' : f.content }
    : { name: f.name, url: f.url });
  // 幂等：同 job 内"相同发送(渠道+收件人+正文+附件)"已发过 → 不重发（防 job 重试/崩溃恢复整单重跑导致重复发消息）。
  // 与业务工具共用 bz_tool_calls 账本（tool=send_message）。放在投递前查、成功后登记。
  const idemHash = createHash('sha256').update(JSON.stringify({
    c: channelName, to: [...recipients].sort(), text,
    files: fileAudit.map((f) => ('sha256' in f ? { n: f.name, h: (f as { sha256: string }).sha256 } : { n: f.name, u: (f as { url?: string }).url })),
  })).digest('hex');
  const prior = await config.toolCalls.get(job.job_id, SEND_TOOL_NAME, idemHash).catch(() => null);
  if (prior) {
    audit?.('builtin_send_deduped', { channel: channelName, to: label, reason: '同 job 已发过相同消息，跳过重发（防重试/恢复重复发送）' });
    return { ok: prior.ok, text: prior.text || `已发送（未重复发送）。` };
  }
  // 投递：多收件人渠道原生合并一次发（企微 touser 支持 "A|B|C"）；带文件则发对象
  const msg: ChannelMessage = { ...(text ? { text } : {}), ...(files.length ? { files } : {}) };
  const sent = await channelSendFor(config, channelName, recipients.join('|'), msg);
  if (!sent.ok) {
    audit?.('builtin_send_error', { channel: channelName, to: label, files: fileAudit, error: sent.error });
    return { ok: false, text: `发送失败：${sent.error}` };
  }
  // 入历史：给每个收件人各自 thread 记一条 out（channel='brain-send' ≠ 'hub' → 记忆层渲染为「系统通知→用户」）。附件以 [附件：名] 记录。
  const histContent = [text, ...files.map((f) => `[附件：${f.name}]`)].filter(Boolean).join('\n') || '（空）';
  try {
    await Promise.all(recipients.map(async (rcpt) => {
      const scope = channelScopeKey(ch.kind, ch.name, rcpt);
      const pid = (ch.kind === 'wecom' ? `wxuid:${rcpt}` : `${ch.kind}:${rcpt}`).slice(0, 64);
      const tid = await config.conversations.resolveThread(ch.route_key, scope, pid);
      await config.conversations.appendMessage({ thread_id: tid, direction: 'out', channel: 'brain-send', principal_id: pid, job_id: job.job_id, content: histContent });
    }));
  } catch { /* 历史可降级，不影响已送达 */ }
  audit?.('builtin_send', { channel: channelName, to: label, recipients: recipients.length, chars: text.length, files: fileAudit });
  const resultText = `已发送给 ${label}（渠道 ${channelName}）${files.length ? `，含 ${files.length} 个附件` : ''}。`;
  // 登记幂等：本次成功发送入账，重跑相同发送直接复用、不重发
  await config.toolCalls.put(job.job_id, SEND_TOOL_NAME, idemHash, { ok: true, status: 200, text: resultText }).catch(() => undefined);
  return { ok: true, text: resultText };
}
