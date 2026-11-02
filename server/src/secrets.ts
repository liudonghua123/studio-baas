import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 静态密钥加密（AES-256-GCM）。
 *
 * 身份源的 clientSecret / bindPassword 必须落库才能无人值守地续期 token，
 * 但明文入库意味着「拿到 studio.db 就等于拿到企业目录的绑定账号」。
 * 这里做一层信封加密：库里只存密文，密钥来自环境变量或本地密钥文件。
 *
 *   STUDIO_SECRET_KEY=<32 字节，hex/base64/base64url 均可>   ← 生产用
 *   data/.secret-key                                        ← 缺省时自动生成，0600
 *
 * 密文格式：`v1.<iv>.<tag>.<ciphertext>`，全部 base64url。
 * 带版本前缀是为了以后换算法/换密钥时能平滑迁移：v1 解不开就走重新输入。
 */

const PREFIX = 'v1';

let cachedKey: Buffer | null = null;

function keyFromEnv(raw: string): Buffer | null {
  const s = raw.trim();
  if (!s) return null;
  // 允许三种写法，都要求解出来是 32 字节；否则退化为口令派生，避免有人塞了个短串就以为安全
  const attempts: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(s)) attempts.push(Buffer.from(s, 'hex'));
  attempts.push(Buffer.from(s, 'base64'));
  attempts.push(Buffer.from(s, 'base64url'));
  for (const b of attempts) if (b.length === 32) return b;
  // 口令：用固定盐 scrypt 派生（不是 KDF 的最佳实践，但比明文强得多，且不引入依赖）
  return crypto.scryptSync(s, 'studio-baas-secret', 32);
}

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const env = process.env.STUDIO_SECRET_KEY;
  if (env) {
    const k = keyFromEnv(env);
    if (k) { cachedKey = k; return k; }
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = process.env.DATA_DIR || path.resolve(here, '../data');
  const file = path.join(dir, '.secret-key');
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const k = keyFromEnv(raw);
    if (k) { cachedKey = k; return k; }
  } catch { /* 首次启动，下面生成 */ }

  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
    // writeFileSync 的 mode 只在创建时生效；显式 chmod 兜住「文件已存在但权限宽」的情况
    fs.chmodSync(file, 0o600);
  } catch { /* 只读文件系统：至少本次进程内可用 */ }
  cachedKey = key;
  return key;
}

export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (b: Buffer) => b.toString('base64url');
  return `${PREFIX}.${b64(iv)}.${b64(tag)}.${b64(ct)}`;
}

/** 解不开（换了密钥 / 文件被改）时返回 null，调用方应把它当成「需要重新配置」 */
export function decryptSecret(blob: string): string | null {
  if (!blob) return '';
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const [, iv, tag, ct] = parts;
    const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

export const isEncrypted = (v: unknown): boolean =>
  typeof v === 'string' && v.startsWith(`${PREFIX}.`) && v.split('.').length === 4;

/** 给 UI 看的提示：只暴露尾部 4 位，够管理员确认「填的是哪一个」 */
export function maskSecret(plain: string): string {
  if (!plain) return '';
  return plain.length <= 4 ? '••••' : `••••${plain.slice(-4)}`;
}
