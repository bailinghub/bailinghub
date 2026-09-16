import { createHash, createHmac } from 'node:crypto';
import type { StorageBucket } from '../../core/contracts/types';

const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
/** OSS V4 PUT signing; no query parameters. Public asset URLs do not contain this signature. */
export function ossPutHeaders(bucket: StorageBucket, key: string, body: Buffer, contentType: string, now = new Date()): Record<string, string> {
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const date = timestamp.slice(0, 8);
  const region = bucket.region.replace(/^oss-/, '');
  const scope = `${date}/${region}/oss/aliyun_v4_request`;
  const headers: Record<string, string> = { 'content-type': contentType,
    'content-md5': createHash('md5').update(body).digest('base64'),
    'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', 'x-oss-date': timestamp, 'x-oss-object-acl': 'public-read' };
  const canonical = `PUT\n/${encode(bucket.bucket)}/${key.split('/').map(encode).join('/')}\n\n` +
    Object.keys(headers).sort().map(k => `${k}:${headers[k]}\n`).join('') + '\n\nUNSIGNED-PAYLOAD';
  const stringToSign = `OSS4-HMAC-SHA256\n${timestamp}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
  let signingKey: Buffer = Buffer.from(`aliyun_v4${bucket.secret_key}`);
  for (const part of [date, region, 'oss', 'aliyun_v4_request']) signingKey = createHmac('sha256', signingKey).update(part).digest();
  headers.authorization = `OSS4-HMAC-SHA256 Credential=${bucket.access_key}/${scope},Signature=${createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`;
  return headers;
}
