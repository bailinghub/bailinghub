// 企业微信主动发消息（qyapi）：corpid+secret 换 access_token（缓存）→ message/send 推文本给成员。
// 用于"异步主动推"：llm/执行器回答超过企微回调 5s 被动窗口时，任务完成后由中枢主动把回复推回用户。
// ⚠ 调用来源 IP 必须在该应用的「企业可信IP」名单里，否则报 60020。中枢出口 IP=121.5.162.127。
// 用全局 fetch（Node ≥18），无第三方依赖。
const tokenCache = new Map<string, { token: string; exp: number }>();

async function getAccessToken(corpid: string, secret: string): Promise<string> {
  const key = `${corpid}:${secret}`;
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.exp) return cached.token;
  const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpid)}&corpsecret=${encodeURIComponent(secret)}`, { signal: AbortSignal.timeout(10000) });
  const j = (await r.json()) as { errcode?: number; errmsg?: string; access_token?: string; expires_in?: number };
  if (j.errcode || !j.access_token) throw new Error(`gettoken 失败 errcode=${j.errcode} errmsg=${j.errmsg}`);
  tokenCache.set(key, { token: j.access_token, exp: Date.now() + (Number(j.expires_in ?? 7200) - 120) * 1000 }); // 提前 2min 过期
  return j.access_token;
}

// 企微 text.content 硬上限约 2048 字节；超限会被客户端静默截断（errcode 仍 0，曾把 2472 字节的回复砍掉一半）。
// 单条按字节预算切分（留余量给分页角标），多条顺序发，让长回复完整送达——而不是 slice 截断丢内容。
export const WECOM_TEXT_SAFE_BYTES = 2000;     // 单条阈值（超此值的回复要分条/改主动推）
const WECOM_TEXT_CHUNK_BYTES = 1900;           // 切分粒度（< 阈值，给「（i/n）」角标留位）
const utf8len = (s: string): number => Buffer.byteLength(s, 'utf8');

/** 长文本按字节切成多条：优先按段落（空行）、其次换行、最后按字符（码点）硬切——绝不切断多字节字符。 */
export function splitWecomText(text: string, maxBytes = WECOM_TEXT_CHUNK_BYTES): string[] {
  if (utf8len(text) <= maxBytes) return [text];
  const out: string[] = [];
  let cur = '';
  const pushCur = (): void => { if (cur) { out.push(cur); cur = ''; } };
  for (const para of text.split(/(\n{2,})/)) {
    if (!para) continue;
    if (utf8len(cur + para) <= maxBytes) { cur += para; continue; }
    pushCur();
    if (utf8len(para) <= maxBytes) { cur = para; continue; }
    for (const line of para.split(/(\n)/)) {            // 段落超限：按行切
      if (!line) continue;
      if (utf8len(cur + line) <= maxBytes) { cur += line; continue; }
      pushCur();
      if (utf8len(line) <= maxBytes) { cur = line; continue; }
      let buf = '';                                      // 行超限：按字符硬切
      for (const ch of line) {
        if (utf8len(buf + ch) > maxBytes) { out.push(buf); buf = ''; }
        buf += ch;
      }
      cur = buf;
    }
  }
  pushCur();
  return out.filter((s) => s.length);
}

/** 推文本消息给成员。超字节上限自动分条顺序发（多条加「（i/n）」角标）。errcode=0 即成功；token 失效(40014/42001)自动刷新重试一次。 */
export async function sendWecomText(corpid: string, secret: string, agentid: string | number, touser: string, content: string): Promise<{ ok: boolean; errcode: number; errmsg: string }> {
  const parts = splitWecomText(String(content));
  const multi = parts.length > 1;
  const doSend = async (token: string, body: string): Promise<{ errcode: number; errmsg: string }> => {
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser, msgtype: 'text', agentid: Number(agentid), text: { content: body }, safe: 0 }),
      signal: AbortSignal.timeout(10000),
    });
    return (await r.json()) as { errcode: number; errmsg: string };
  };
  let token = await getAccessToken(corpid, secret);
  let last = { errcode: 0, errmsg: 'ok' };
  for (let i = 0; i < parts.length; i++) {
    const body = multi ? `（${i + 1}/${parts.length}）\n${parts[i]}` : parts[i]!;
    let j = await doSend(token, body);
    if (j.errcode === 40014 || j.errcode === 42001) { // token 失效：刷新重试本条
      tokenCache.delete(`${corpid}:${secret}`);
      token = await getAccessToken(corpid, secret);
      j = await doSend(token, body);
    }
    last = j;
    if (j.errcode !== 0) return { ok: false, errcode: j.errcode, errmsg: j.errmsg }; // 一条失败即停，不继续发后半段（避免缺头/乱序）
  }
  return { ok: last.errcode === 0, errcode: last.errcode, errmsg: last.errmsg };
}

/** 上传临时素材（media/upload）：出站图片/文件必须先换 media_id（有效 3 天）再发。multipart 用全局 FormData/Blob（Node ≥18）。token 失效刷新重试一次。永不抛。 */
export async function uploadWecomMedia(corpid: string, secret: string, type: 'image' | 'file' | 'voice' | 'video', buf: Buffer, filename: string, mime: string): Promise<{ ok: boolean; mediaId?: string; error?: string }> {
  const doUpload = async (token: string): Promise<{ errcode?: number; errmsg?: string; media_id?: string }> => {
    const form = new FormData();
    form.append('media', new Blob([buf], { type: mime || 'application/octet-stream' }), filename);
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=${type}`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(20000),
    });
    return (await r.json()) as { errcode?: number; errmsg?: string; media_id?: string };
  };
  try {
    let token = await getAccessToken(corpid, secret);
    let j = await doUpload(token);
    if (j.errcode === 40014 || j.errcode === 42001) { tokenCache.delete(`${corpid}:${secret}`); token = await getAccessToken(corpid, secret); j = await doUpload(token); }
    if (!j.media_id) return { ok: false, error: `media/upload errcode=${j.errcode} errmsg=${j.errmsg}` };
    return { ok: true, mediaId: j.media_id };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}

/** 推 image/file 消息给成员（用 media/upload 换来的 media_id）。token 失效刷新重试一次。 */
export async function sendWecomMedia(corpid: string, secret: string, agentid: string | number, touser: string, msgtype: 'image' | 'file', mediaId: string): Promise<{ ok: boolean; errcode: number; errmsg: string }> {
  const doSend = async (token: string): Promise<{ errcode: number; errmsg: string }> => {
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser, msgtype, agentid: Number(agentid), [msgtype]: { media_id: mediaId }, safe: 0 }),
      signal: AbortSignal.timeout(10000),
    });
    return (await r.json()) as { errcode: number; errmsg: string };
  };
  let token = await getAccessToken(corpid, secret);
  let j = await doSend(token);
  if (j.errcode === 40014 || j.errcode === 42001) {
    tokenCache.delete(`${corpid}:${secret}`);
    token = await getAccessToken(corpid, secret);
    j = await doSend(token);
  }
  return { ok: j.errcode === 0, errcode: j.errcode, errmsg: j.errmsg };
}

/** 推 textcard 卡片消息（标题+描述+跳转 URL+按钮文案）。touser 支持 `a|b|c` 多收件人。token 失效刷新重试一次。 */
export async function sendWecomCard(corpid: string, secret: string, agentid: string | number, touser: string, card: { title: string; description?: string; url: string; btntxt?: string }): Promise<{ ok: boolean; errcode: number; errmsg: string }> {
  const textcard = {
    title: String(card.title).slice(0, 128),          // 企微限制 ≤128 字节
    description: String(card.description ?? '').slice(0, 512), // ≤512 字节，支持 div.gray/.normal/.highlight + a 标签
    url: String(card.url),
    btntxt: (card.btntxt ? String(card.btntxt) : '详情').slice(0, 8), // 按钮文案 ≤4 个汉字
  };
  const doSend = async (token: string): Promise<{ errcode: number; errmsg: string }> => {
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser, msgtype: 'textcard', agentid: Number(agentid), textcard, safe: 0 }),
      signal: AbortSignal.timeout(10000),
    });
    return (await r.json()) as { errcode: number; errmsg: string };
  };
  let token = await getAccessToken(corpid, secret);
  let j = await doSend(token);
  if (j.errcode === 40014 || j.errcode === 42001) {
    tokenCache.delete(`${corpid}:${secret}`);
    token = await getAccessToken(corpid, secret);
    j = await doSend(token);
  }
  return { ok: j.errcode === 0, errcode: j.errcode, errmsg: j.errmsg };
}

/**
 * 下载企微临时素材（media/get）：入站图片消息只给 MediaId，凭 access_token 换二进制。
 * 成功→{ok,buf,mime}；接口报错时企微返回的是 JSON（errcode）而非二进制，据 content-type 区分。
 * token 失效(40014/42001)刷新重试一次。永不抛——失败返回 ok:false，调用方可回退 PicUrl。
 */
export async function getWecomMedia(corpid: string, secret: string, mediaId: string): Promise<{ ok: boolean; buf?: Buffer; mime?: string; error?: string }> {
  const doGet = async (token: string): Promise<{ json?: { errcode?: number; errmsg?: string }; buf?: Buffer; mime?: string }> => {
    const r = await fetch(`https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${encodeURIComponent(mediaId)}`, { signal: AbortSignal.timeout(15000) });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json') || ct.includes('text/plain')) {
      return { json: (await r.json().catch(() => ({}))) as { errcode?: number; errmsg?: string } };
    }
    return { buf: Buffer.from(await r.arrayBuffer()), mime: (ct.split(';')[0] || '').trim() || 'image/jpeg' };
  };
  try {
    let token = await getAccessToken(corpid, secret);
    let res = await doGet(token);
    if (res.json && (res.json.errcode === 40014 || res.json.errcode === 42001)) {
      tokenCache.delete(`${corpid}:${secret}`);
      token = await getAccessToken(corpid, secret);
      res = await doGet(token);
    }
    if (res.json) return { ok: false, error: `media/get errcode=${res.json.errcode} errmsg=${res.json.errmsg}` };
    if (!res.buf || !res.buf.length) return { ok: false, error: '素材为空' };
    return { ok: true, buf: res.buf, mime: res.mime };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}
