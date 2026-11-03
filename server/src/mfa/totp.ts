import crypto from 'node:crypto';

/**
 * TOTP（RFC 6238）与恢复码。
 *
 * 不引依赖：HOTP 就是 HMAC-SHA1 加一段动态截断，base32 也只有编码/解码两个方向。
 * 这里刻意**不**支持可配置的算法/位数：SHA1 + 6 位 + 30 秒是所有认证器 App
 * 的默认，允许改反而会造出「服务端设了 SHA256、手机 App 只认 SHA1」这类
 * 只有用户自己倒霉的故障。需要更强的东西请用 Passkey。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

/* ------------------------------------------------------------------ base32 */

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* --------------------------------------------------------------------- hotp */

/** RFC 4226 §5.3 的动态截断：取偏移量指向的 4 字节，抹掉符号位 */
function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  // counter 可能超过 2^32（2106 年之后），高 32 位也要写
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24)
    | (mac[offset + 1] << 16)
    | (mac[offset + 2] << 8)
    | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function counterAt(ms = Date.now()): number {
  return Math.floor(ms / 1000 / PERIOD);
}

export function totp(secret: string, at: number = Date.now()): string {
  return hotp(base32Decode(secret), counterAt(at));
}

export interface TotpMatch {
  /** 命中的时间步；写回数据库用于拒绝同一个码的第二次使用 */
  step: number;
  /** 与服务端时钟相差几个步长，便于日志里看出「手机慢了两分钟」 */
  drift: number;
}

/**
 * 校验用户输入的码。
 *
 * 允许 ±1 个步长（30 秒）：客户端时钟和服务端差半分钟是常态，
 * 不放宽的话用户会在整分钟边界上莫名其妙地失败。窗口不能再大，
 * 否则一个 6 位码的有效期就变成 90 秒，暴力破解的搜索空间被放大三倍。
 *
 * `lastStep` 是上次成功用掉的步长：同一个码（或窗口内重叠的旧码）不能用第二次。
 */
export function verifyTotp(
  secret: string,
  code: string,
  opts: { at?: number; window?: number; lastStep?: number | null } = {},
): TotpMatch | null {
  const input = String(code || '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(input)) return null;

  const key = base32Decode(secret);
  const current = counterAt(opts.at);
  const window = opts.window ?? 1;

  // 常数时间比较：先算出所有候选步长的码，再用 timingSafeEqual 逐个比
  const given = Buffer.from(input, 'utf8');
  let match: TotpMatch | null = null;
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(key, step), 'utf8');
    if (timingSafeEqual(given, expected) && !match) match = { step, drift: d };
  }
  if (!match) return null;

  // 重放：同一个步长已经用过，或者比上次成功用的还早 —— 都拒绝
  if (opts.lastStep != null && match.step <= opts.lastStep) return null;
  return match;
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ otpauth */

export function generateSecret(bytes = 20): string {
  // 160 bit 是 RFC 4226 推荐长度，也正好是 32 个 base32 字符
  return base32Encode(crypto.randomBytes(bytes));
}

/** 认证器 App 认这个 URI；前端把它做成「在 App 里手动输入」的提示 */
export function otpauthUri(secret: string, account: string, issuer = 'Studio BaaS'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ------------------------------------------------------------ recovery codes */

// 去掉 0/O/1/I/L：这几个字符在纸质清单上抄错率最高
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 10): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let s = '';
    for (let j = 0; j < 8; j++) s += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    out.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return out;
}

/**
 * 恢复码是 40 bit 以上的随机串，不需要 bcrypt 那样的慢哈希；
 * sha256 足够，且可以在一次查询里比对一批。
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

export function normalizeRecoveryCode(code: string): string {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
