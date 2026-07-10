// 企微回调加解密纯函数单测（零依赖：node:test + node:assert）。
// 覆盖：签名（字典序无关）、AES 加解密往返、URL 验证（验签 + corpid 复核）、XML 字段抽取。
// 这是「中枢直接当企微接收消息回调」的安全边界，验签或解密回归 = 伪造消息可进 / 真消息进不来。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { wecomBuildReply, wecomDecrypt, wecomEncrypt, wecomSign, wecomVerifyUrl, wecomXmlField } from './wecom-crypto';

// 合法 EncodingAESKey = 43 字符（补一个 '=' 后 base64 解码为 32 字节）。32 随机字节的 base64 恰为 44 字符末尾一个 '='，去掉即得。
function makeAesKey(): string {
  return randomBytes(32).toString('base64').replace(/=$/, '');
}
const TOKEN = 'tok-测试';
const CORPID = 'wwtestcorp123';

test('wecomSign: 确定性 + 字典序无关（参数顺序不影响结果）+ sha1 hex 形态', () => {
  const s1 = wecomSign(TOKEN, '1700000000', 'noncexyz', 'ENCRYPTBLOB');
  assert.equal(s1, wecomSign(TOKEN, '1700000000', 'noncexyz', 'ENCRYPTBLOB'));
  // 四元素先排序再拼接 → 调换 timestamp/nonce 入参位置结果不变
  assert.equal(s1, wecomSign(TOKEN, 'noncexyz' as string, '1700000000' as string, 'ENCRYPTBLOB'));
  assert.match(s1, /^[0-9a-f]{40}$/);
});

test('wecomEncrypt → wecomDecrypt 往返还原消息体与 receiveId', () => {
  const key = makeAesKey();
  const msg = '<xml><Content><![CDATA[你好，中枢]]></Content></xml>';
  const enc = wecomEncrypt(key, msg, CORPID);
  const { message, receiveId } = wecomDecrypt(key, enc);
  assert.equal(message, msg);
  assert.equal(receiveId, CORPID);
});

test('wecomDecrypt: 用错 key 无法还原（要么抛要么得不到原文）', () => {
  const enc = wecomEncrypt(makeAesKey(), 'secret-body', CORPID);
  let recovered = '';
  try { recovered = wecomDecrypt(makeAesKey(), enc).message; } catch { recovered = '<<threw>>'; }
  assert.notEqual(recovered, 'secret-body');
});

test('aesKeyOf: 长度不对的 EncodingAESKey 抛错（防把别的串当 key 填进来）', () => {
  assert.throws(() => wecomEncrypt('too-short', 'x', CORPID), /32 字节/);
});

test('wecomVerifyUrl: 验签通过 + corpid 匹配 → 返回明文 echostr', () => {
  const key = makeAesKey();
  const plain = 'echo-明文-1234567890';
  const echostr = wecomEncrypt(key, plain, CORPID);
  const ts = '1700000000';
  const nonce = 'n0nce';
  const sig = wecomSign(TOKEN, ts, nonce, echostr);
  assert.equal(wecomVerifyUrl(TOKEN, key, sig, ts, nonce, echostr, CORPID), plain);
});

test('wecomVerifyUrl: 签名不符 → null（拒绝伪造）', () => {
  const key = makeAesKey();
  const echostr = wecomEncrypt(key, 'x', CORPID);
  assert.equal(wecomVerifyUrl(TOKEN, key, 'deadbeef', '1700000000', 'n', echostr, CORPID), null);
});

test('wecomVerifyUrl: corpid 不匹配 → null（receiveId 复核挡掉别家应用）', () => {
  const key = makeAesKey();
  const ts = '1700000000', nonce = 'n';
  const echostr = wecomEncrypt(key, 'x', CORPID);
  const sig = wecomSign(TOKEN, ts, nonce, echostr);
  assert.equal(wecomVerifyUrl(TOKEN, key, sig, ts, nonce, echostr, 'ww-OTHER-corp'), null);
});

test('wecomBuildReply 产出可被对端验签 + 解密回原文（自洽往返）', () => {
  const key = makeAesKey();
  const reply = wecomBuildReply(TOKEN, key, CORPID, 'user-001', '回复正文 with ]]> 边界');
  const encrypt = wecomXmlField(reply, 'Encrypt');
  const sig = wecomXmlField(reply, 'MsgSignature');
  const ts = wecomXmlField(reply, 'TimeStamp');
  const nonce = wecomXmlField(reply, 'Nonce');
  assert.equal(wecomSign(TOKEN, ts, nonce, encrypt), sig, '回复信封签名应自洽');
  const inner = wecomDecrypt(key, encrypt).message;
  assert.match(inner, /回复正文/);
  assert.doesNotMatch(inner, /]]>回复/, ']]> 应被转义，不得提前闭合 CDATA');
});

test('wecomXmlField: CDATA 与裸值都能取，缺字段返回空串', () => {
  assert.equal(wecomXmlField('<xml><A><![CDATA[hi]]></A></xml>', 'A'), 'hi');
  assert.equal(wecomXmlField('<xml><A>bare</A></xml>', 'A'), 'bare');
  assert.equal(wecomXmlField('<xml><A>x</A></xml>', 'B'), '');
});
