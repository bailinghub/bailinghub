// 企业微信回调加解密（标准 WXBizMsgCrypt，零依赖，纯 node:crypto 复刻）。
// 作用：让中枢直接当企微自建应用的「接收消息」回调地址——GET 验 URL（echostr）、POST 验签+AES 解密、被动回复加密。
// 材料：Token（验签）、EncodingAESKey（43 字符 → AES-256 key）、corpid（自建应用的 receiveid）。
// 算法常量：AES-256-CBC，IV = key 前 16 字节，PKCS#7 填充块长 32，msg_signature = sha1(字典序拼接 [token,timestamp,nonce,encrypt])。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// EncodingAESKey(43字符) → 32 字节 AES-256 key（企微规定补一个 '=' 再 base64 解码）
function aesKeyOf(encodingAesKey: string): Buffer {
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  if (key.length !== 32) throw new Error(`EncodingAESKey 解码后应为 32 字节，实际 ${key.length}（请确认填的是 43 位 EncodingAESKey）`);
  return key;
}

/** msg_signature = sha1( sort([token, timestamp, nonce, encrypt]) 拼接 )。GET/POST/被动回复三处通用。 */
export function wecomSign(token: string, timestamp: string, nonce: string, encrypt: string): string {
  return createHash('sha1').update([token, timestamp, nonce, encrypt].sort().join('')).digest('hex');
}

/** 取 XML 字段（兼容 <Tag><![CDATA[..]]></Tag> 与 <Tag>裸值</Tag>）。 */
export function wecomXmlField(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`));
  return m ? (m[1] ?? m[2] ?? '').trim() : '';
}

/** 解密企微密文：返回内层明文 XML + receiveId（自建应用即 corpid，可用于二次校验）。 */
export function wecomDecrypt(encodingAesKey: string, encrypted: string): { message: string; receiveId: string } {
  const key = aesKeyOf(encodingAesKey);
  const iv = key.subarray(0, 16);
  const d = createDecipheriv('aes-256-cbc', key, iv);
  d.setAutoPadding(false); // 企微用 PKCS#7 块长 32，非标准 16，手工去填充
  let buf = Buffer.concat([d.update(Buffer.from(encrypted, 'base64')), d.final()]);
  const pad = buf[buf.length - 1] ?? 0;
  if (pad > 0 && pad <= 32) buf = buf.subarray(0, buf.length - pad);
  // [16 随机字节][4 字节大端长度][消息体][receiveId]
  const msgLen = buf.readUInt32BE(16);
  const message = buf.subarray(20, 20 + msgLen).toString('utf8');
  const receiveId = buf.subarray(20 + msgLen).toString('utf8');
  return { message, receiveId };
}

/** 加密（被动回复用）：[16 随机][4 长度][消息][receiveId] → PKCS#7(块32) → AES-256-CBC → base64。 */
export function wecomEncrypt(encodingAesKey: string, message: string, receiveId: string): string {
  const key = aesKeyOf(encodingAesKey);
  const iv = key.subarray(0, 16);
  const msg = Buffer.from(message, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length, 0);
  let buf = Buffer.concat([randomBytes(16), len, msg, Buffer.from(receiveId, 'utf8')]);
  const padLen = 32 - (buf.length % 32); // 对齐即补整块 32（PKCS#7）
  buf = Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
  const c = createCipheriv('aes-256-cbc', key, iv);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(buf), c.final()]).toString('base64');
}

/** GET URL 验证：验签通过则解密 echostr 返回明文（原样回显给企微）；失败返回 null。 */
export function wecomVerifyUrl(token: string, aesKey: string, msgSig: string, ts: string, nonce: string, echostr: string, corpid?: string): string | null {
  if (!echostr || wecomSign(token, ts, nonce, echostr) !== msgSig) return null;
  try {
    const { message, receiveId } = wecomDecrypt(aesKey, echostr);
    if (corpid && receiveId && receiveId !== corpid) return null;
    return message;
  } catch { return null; }
}

/** 被动回复文本消息：组装加密信封 XML（直接作为回调 HTTP 响应体返回）。 */
export function wecomBuildReply(token: string, aesKey: string, corpid: string, toUser: string, text: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(8).toString('hex');
  const safe = String(text).replace(/]]>/g, ']] >'); // 防 CDATA 提前闭合
  const inner = `<xml><ToUserName><![CDATA[${toUser}]]></ToUserName><FromUserName><![CDATA[${corpid}]]></FromUserName>`
    + `<CreateTime>${ts}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${safe}]]></Content></xml>`;
  const encrypt = wecomEncrypt(aesKey, inner, corpid);
  const sig = wecomSign(token, ts, nonce, encrypt);
  return `<xml><Encrypt><![CDATA[${encrypt}]]></Encrypt><MsgSignature><![CDATA[${sig}]]></MsgSignature>`
    + `<TimeStamp>${ts}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}
