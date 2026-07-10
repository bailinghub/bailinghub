import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// 密码哈希边界：Node 内置 scrypt，零运行时依赖。
// Profile 与编码一同写入存储值，后续提高成本不会让不同版本的部署互相误验。
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 3;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }, (error, derived) => {
      if (error) { reject(error); return; }
      resolve(Buffer.from(derived));
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = (await derive(password, salt)).toString('hex');
  return `s2$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [version, n, r, p, salt, hash] = stored.split('$');
  if (
    version !== 's2'
    || Number(n) !== SCRYPT_N
    || Number(r) !== SCRYPT_R
    || Number(p) !== SCRYPT_P
    || !/^[0-9a-f]{32}$/i.test(salt ?? '')
    || !/^[0-9a-f]{128}$/i.test(hash ?? '')
  ) return false;
  const calc = await derive(password, salt!);
  const ref = Buffer.from(hash!, 'hex');
  return calc.length === ref.length && timingSafeEqual(calc, ref);
}
