// 渠道出站原语：把一条消息经「渠道注册表(bz_channels)」的凭证推给某收件人，按 channel.kind 分发。
// 这是中枢「送达」能力的通用底座——系统告警(sendAlert)是第一个调用方；未来业务侧出站(带 token 调"发给渠道A用户A")
// 是另一个调用方，另加 client↔channel 授权治理即可，共用本原语。接飞书/钉钉=这里加一个 case，调用方零改动。
// 不建任何 job、不过 LLM、逐字送达——正式通知所见即所得；与「执行器拉取(wecom-notify)」那套解耦（内部告警不再走它）。
import { sendWecomText, sendWecomMedia, sendWecomCard, uploadWecomMedia } from '../adapters/channels/wecom-api';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface ChannelSendResult { ok: boolean; error?: string }

/** 卡片（企微 textcard：标题+描述+跳转+按钮）。仅对支持卡片的渠道（企微）生效；其它渠道回退发 text。 */
export interface ChannelCard { type?: string; title: string; description?: string; url: string; btntxt?: string }
/** 出站消息体：纯文本传 string；带图片/附件/卡片传对象。images 是「业务能访问到的 URL」，中枢拉取→上传渠道→投递。
 * files 每项二选一：`{url,name?}`（已托管文件，中枢拉取）或 `{content,name}`（内联文本内容，如执行器生成的 .md 报告，中枢直接成文件，无需先托管）。 */
export interface ChannelMessage { text?: string; images?: string[]; files?: { url?: string; name?: string; content?: string; mime?: string }[]; card?: ChannelCard }

/** 拉取业务给的 URL 成二进制（带超时 + 大小封顶）。失败返回 {error}，不抛。 */
async function fetchBinary(url: string, maxBytes = 20 * 1024 * 1024): Promise<{ buf: Buffer; mime: string } | { error: string }> {
  if (!/^https?:\/\//i.test(url)) return { error: 'URL 必须是 http(s)' };
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return { error: `拉取失败 HTTP ${r.status}` };
    const ab = await r.arrayBuffer();
    if (!ab.byteLength) return { error: '内容为空' };
    if (ab.byteLength > maxBytes) return { error: `超过 ${Math.round(maxBytes / 1048576)}MB 上限` };
    const mime = ((r.headers.get('content-type') || '').split(';')[0] || '').trim() || 'application/octet-stream';
    return { buf: Buffer.from(ab), mime };
  } catch (e) { return { error: `拉取异常 ${String(e instanceof Error ? e.message : e).slice(0, 80)}` }; }
}
/** 给上传素材取个带扩展名的文件名（企微 media/upload 需要）：优先 URL 末段，其次按 mime/类型兜底。 */
function fileNameFor(url: string, mime: string, kind: 'image' | 'file'): string {
  try { const base = (new URL(url).pathname.split('/').pop() || '').trim(); if (base && /\.[a-z0-9]{1,8}$/i.test(base)) return base; } catch { /* ignore */ }
  if (kind === 'image') { const ext = mime.includes('png') ? 'png' : mime.includes('gif') ? 'gif' : mime.includes('webp') ? 'webp' : 'jpg'; return `image.${ext}`; }
  return 'attachment.bin';
}
/** 按文件名扩展名猜 mime（内联内容附件用；发 file 主要靠文件名扩展名，mime 给个合理值即可）。 */
function mimeByName(name: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const m: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', log: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml', pdf: 'application/pdf' };
  return m[ext] || 'application/octet-stream';
}

/**
 * 渠道会话 scope（与各渠道「入站」逐字一致）。主动出站(/send)写历史时必须用它，
 * 才能落到「用户从该渠道发消息进来时会命中的那个 thread」——差一个字符就接不上历史、追问失忆。
 * 当前仅 wecom：与 wecom.ts flushWecom 的 `wecom:${账号}:${用户id}` 完全一致（kind==='wecom'）。
 * 单一来源，杜绝入站/出站漂移。
 */
export function channelScopeKey(kind: string, channelName: string, recipient: string): string {
  return `${kind}:${channelName}:${recipient}`.slice(0, 191);
}

/** 经 channelName 渠道把消息推给 recipient（渠道原生 id）。message 传 string=纯文本，或对象带 images/files。
 * 渠道不存在/停用/类型不支持/凭证缺失/附件拉取失败 → ok:false + 原因（调用方负责审计）。 */
export async function channelSendFor(config: ConfigStoreContract | null, channelName: string, recipient: string, message: string | ChannelMessage): Promise<ChannelSendResult> {
  if (!config) return { ok: false, error: '无 mysql 后端' };
  if (!recipient) return { ok: false, error: '收件人为空' };
  const msg: ChannelMessage = typeof message === 'string' ? { text: message } : (message ?? {});
  const text = (msg.text ?? '').trim();
  const images = (msg.images ?? []).filter(Boolean);
  const files = (msg.files ?? []).filter((f) => f && (f.url || typeof f.content === 'string'));
  const card = msg.card && msg.card.title && msg.card.url ? msg.card : undefined;
  if (!text && !images.length && !files.length && !card) return { ok: false, error: '正文/附件/卡片均为空' };
  const ch = await config.channels.get(channelName);
  if (!ch || !ch.enabled) return { ok: false, error: `渠道 ${channelName} 不存在或已停用` };

  if (ch.kind === 'wecom') {
    const cc = ch.config ?? {};
    const corpid = String(cc['corpid'] ?? '').trim();
    const secret = String(cc['secret'] ?? '').trim();
    const agentid = String(cc['agentid'] ?? '').trim();
    if (!corpid || !secret || !agentid) {
      return { ok: false, error: `渠道 ${channelName} 缺出站凭证（需 corpid/secret/agentid，主动推必填）` };
    }
    // 先把所有附件 拉取→上传换 media_id（任一失败即整体中止、一条不发，尽量避免「文字发了图没发」的半截投递）。
    const media: { kind: 'image' | 'file'; mediaId: string }[] = [];
    for (const url of images) {
      const got = await fetchBinary(url);
      if ('error' in got) return { ok: false, error: `图片 ${url}：${got.error}` };
      const up = await uploadWecomMedia(corpid, secret, 'image', got.buf, fileNameFor(url, got.mime, 'image'), got.mime);
      if (!up.ok || !up.mediaId) return { ok: false, error: `图片上传失败：${up.error}` };
      media.push({ kind: 'image', mediaId: up.mediaId });
    }
    for (const f of files) {
      let buf: Buffer; let mime: string; let fname: string;
      if (typeof f.content === 'string') {                 // 内联文本内容（如执行器生成的 .md 报告）：直接成字节，无需先托管 URL
        buf = Buffer.from(f.content, 'utf8');
        if (buf.byteLength > 20 * 1024 * 1024) return { ok: false, error: `附件 ${f.name || ''} 超过 20MB 上限` };
        fname = f.name || 'file.txt';
        mime = f.mime || mimeByName(fname);
      } else {                                              // 已托管 URL：中枢拉取
        const got = await fetchBinary(f.url!);
        if ('error' in got) return { ok: false, error: `附件 ${f.url}：${got.error}` };
        buf = got.buf; mime = f.mime || got.mime; fname = f.name || fileNameFor(f.url!, mime, 'file');
      }
      const up = await uploadWecomMedia(corpid, secret, 'file', buf, fname, mime);
      if (!up.ok || !up.mediaId) return { ok: false, error: `附件上传失败：${up.error}` };
      media.push({ kind: 'file', mediaId: up.mediaId });
    }
    // 发送：卡片优先（card 是 text 的富形态，企微支持时发卡片、text 仅作降级/入历史，不重复发）→ 否则文字 → 各图片 → 各文件（企微每条只能一个类型）。
    if (card) {
      const r = await sendWecomCard(corpid, secret, agentid, recipient, card);
      if (!r.ok) return { ok: false, error: `企微 textcard errcode=${r.errcode} ${r.errmsg}` };
    } else if (text) {
      const r = await sendWecomText(corpid, secret, agentid, recipient, text);
      if (!r.ok) return { ok: false, error: `企微 errcode=${r.errcode} ${r.errmsg}` };
    }
    for (const m of media) {
      const r = await sendWecomMedia(corpid, secret, agentid, recipient, m.kind, m.mediaId);
      if (!r.ok) return { ok: false, error: `企微${m.kind} errcode=${r.errcode} ${r.errmsg}（部分内容可能已送达）` };
    }
    return { ok: true };
  }
  return { ok: false, error: `渠道类型 ${ch.kind} 暂不支持主动出站` };
}
