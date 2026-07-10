// 媒体存储适配（聊天图片/语音/附件落盘或落桶取永久 URL）。
// 默认 local：开箱即用，写到本机 data/uploads 并由 /uploads/* 公开读取；生产可切 COS，oss/s3 预留。
// 设计：业务桶则 URL 即业务 CDN 地址（加商品零转存），中枢桶/本地存储则中枢掌控留存；URL 永久不清理，供完整追溯 + 多模态读图/听音。
// COS 请求签名(q-sign-algorithm=sha1)按官方算法手写(零依赖,避免上线 npm install)。
// ⚠ 签名为纯计算、本机无真桶可验——首次接真桶上传若 403，对照 COS 返回的 XML 报文核对 host/header-list 即可。
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import type { StorageBucket } from '../../core/contracts/types';

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
  'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'text/tab-separated-values': 'tsv', 'text/html': 'html',
  'text/x-log': 'log', 'text/x-ini': 'ini', 'text/x-conf': 'conf',
  'application/json': 'json', 'application/x-ndjson': 'jsonl', 'application/xml': 'xml', 'text/xml': 'xml',
  'application/yaml': 'yaml', 'application/x-yaml': 'yaml', 'text/yaml': 'yaml',
  'application/sql': 'sql',
  'application/pdf': 'pdf',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-rar-compressed': 'rar', 'application/x-7z-compressed': '7z',
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [`.${ext}`, mime]));

// 上传约束（聊天上传 / 企微入站图片共用）：可落桶的媒体 MIME 与原始请求体上限。
export const UPLOAD_MIME = /^image\/(png|jpe?g|webp|gif)$/;
export const AUDIO_UPLOAD_MIME = /^audio\/(webm|mpeg|mp3|mp4|x-m4a|wav|x-wav|ogg|flac)$/;
export const FILE_UPLOAD_MIME = /^(text\/(plain|markdown|csv|tab-separated-values|html|xml|yaml|x-log|x-ini|x-conf)|application\/(json|x-ndjson|xml|ya?ml|x-yaml|sql|pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.presentationml\.presentation|zip|x-zip-compressed|x-rar-compressed|x-7z-compressed))$/;
export const UPLOAD_MAX_BYTES = 9 * 1024 * 1024; // 原始请求体上限 ≈ 6.5MB 文件（base64 膨胀 ~33%）
export const AUDIO_UPLOAD_MAX_BYTES = 16 * 1024 * 1024; // 原始请求体上限 ≈ 12MB 录音
export const FILE_UPLOAD_MAX_BYTES = 28 * 1024 * 1024; // 原始请求体上限 ≈ 20MB 文件
export const LOCAL_UPLOAD_URL_PREFIX = '/uploads';
export const LOCAL_UPLOAD_DIR = 'data/uploads';

export function localStorageBucket(publicBaseUrl: string): StorageBucket {
  return {
    name: 'local',
    kind: 'local',
    region: '',
    bucket: 'local',
    access_key: '',
    secret_key: '',
    public_base_url: publicBaseUrl.replace(/\/+$/, '') + LOCAL_UPLOAD_URL_PREFIX,
    path_prefix: 'bailing/chat',
    enabled: true,
    description: '内置本地媒体存储',
  };
}

export function storageBucketForRuntime(bucket: StorageBucket | null | undefined, publicBaseUrl: string): StorageBucket {
  if (!bucket || !bucket.enabled) return localStorageBucket(publicBaseUrl);
  if (bucket.kind !== 'local') return bucket;
  const local = localStorageBucket(publicBaseUrl);
  return {
    ...bucket,
    bucket: bucket.bucket || local.bucket,
    public_base_url: bucket.public_base_url || local.public_base_url,
    path_prefix: bucket.path_prefix || local.path_prefix,
  };
}

// COS urlencode：除 A-Za-z0-9-_.~ 外全部百分号编码，大写十六进制（encodeURIComponent 不编码 !'()* ，补上）
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
function sha1hex(s: string): string { return createHash('sha1').update(s, 'utf8').digest('hex'); }
function hmacSha1hex(key: string, s: string): string { return createHmac('sha1', key).update(s, 'utf8').digest('hex'); }

function cosHost(b: StorageBucket): string {
  if (b.endpoint) return b.endpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return `${b.bucket}.cos.${b.region}.myqcloud.com`;
}

/** COS 请求签名（签 host + content-type + x-cos-acl）。返回 Authorization 头值。 */
function cosAuth(b: StorageBucket, method: string, key: string, signedHeaders: Record<string, string>, nowSec: number): string {
  const start = nowSec - 60, end = nowSec + 900;
  const keyTime = `${start};${end}`;
  const signKey = hmacSha1hex(b.secret_key, keyTime);
  const lowerKeys = Object.keys(signedHeaders).map((k) => k.toLowerCase()).sort();
  const headerList = lowerKeys.join(';');
  const httpHeaders = lowerKeys.map((k) => `${rfc3986(k)}=${rfc3986(signedHeaders[k]!)}`).join('&');
  const fmt = `${method.toLowerCase()}\n/${key}\n\n${httpHeaders}\n`;       // 无 query → HttpParameters 段为空
  const stringToSign = `sha1\n${keyTime}\n${sha1hex(fmt)}\n`;
  const signature = hmacSha1hex(signKey, stringToSign);
  return `q-sign-algorithm=sha1&q-ak=${b.access_key}&q-sign-time=${keyTime}&q-key-time=${keyTime}` +
    `&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`;
}

/** 生成对象键：<prefix>/<entry>/<32hex>.<ext>，全安全字符（无需再 urlencode）。 */
export function objectKey(b: StorageBucket, entryKey: string, mime: string): string {
  const ext = EXT[mime] || 'bin';
  const prefix = (b.path_prefix || 'bailing/chat').replace(/^\/+|\/+$/g, '');
  const safeEntry = entryKey.replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'chat';
  return `${prefix}/${safeEntry}/${randomBytes(16).toString('hex')}.${ext}`;
}

function localUploadBase(root: string): string {
  return resolve(root, LOCAL_UPLOAD_DIR);
}

export function localObjectFile(root: string, key: string): { file: string; contentType: string } | null {
  const clean = key.replace(/^\/+/, '');
  if (!clean || clean.includes('..') || clean.includes('\\')) return null;
  const base = localUploadBase(root);
  const file = resolve(base, clean);
  if (!file.startsWith(base + '/')) return null;
  return { file, contentType: MIME_BY_EXT[extname(file).toLowerCase()] ?? 'application/octet-stream' };
}

/** 上传字节到存储，返回永久公开 URL。local 开箱即用；cos 已实现；oss/s3 预留。 */
export async function putObject(b: StorageBucket, key: string, body: Buffer, contentType: string, opts: { root?: string } = {}): Promise<string> {
  if (b.kind === 'local') {
    if (!opts.root) throw new Error('本地媒体存储需要 root');
    const target = localObjectFile(opts.root, key);
    if (!target) throw new Error('本地媒体存储 key 非法');
    await mkdir(dirname(target.file), { recursive: true });
    await writeFile(target.file, body);
    const base = (b.public_base_url || LOCAL_UPLOAD_URL_PREFIX).replace(/\/+$/, '');
    return `${base}/${key}`;
  }
  if (b.kind !== 'cos') throw new Error(`对象存储类型 ${b.kind} 暂未实现（当前支持 cos）`);
  const host = cosHost(b);
  const signed = { host, 'content-type': contentType, 'x-cos-acl': 'public-read' };
  const auth = cosAuth(b, 'put', key, signed, Math.floor(Date.now() / 1000));
  const r = await fetch(`https://${host}/${key}`, {
    method: 'PUT',
    headers: { authorization: auth, 'content-type': contentType, 'x-cos-acl': 'public-read' },
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (r.status < 200 || r.status >= 300) {
    const t = (await r.text().catch(() => '')).slice(0, 300);
    throw new Error(`COS PUT ${r.status}: ${t}`);
  }
  const base = (b.public_base_url || `https://${host}`).replace(/\/+$/, '');
  return `${base}/${key}`;
}
