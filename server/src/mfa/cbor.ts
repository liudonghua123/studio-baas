/**
 * 最小 CBOR 解码器（RFC 8949）。
 *
 * WebAuthn 只在两个地方用到 CBOR：attestationObject 与 COSE 公钥。
 * 两处都是「定长、小、结构固定」的 map/bytes/text/int，不需要流式、
 * 不需要 indefinite length、不需要浮点（公钥里不会出现）。所以这里只实现
 * WebAuthn 实际会发来的子集，遇到不支持的类型就明确报错 —— 比引入一个
 * 完整实现再也不用其中 80% 更可控。
 */

export class CborError extends Error {}

export type CborValue = number | string | Buffer | CborValue[] | Map<unknown, CborValue> | boolean | null;

interface Read {
  buf: Buffer;
  pos: number;
}

function need(r: Read, n: number) {
  if (r.pos + n > r.buf.length) throw new CborError(`CBOR truncated: needed ${n} bytes at offset ${r.pos}`);
}

function readUint(r: Read, info: number): number {
  if (info < 24) return info;
  if (info === 24) { need(r, 1); return r.buf[r.pos++]; }
  if (info === 25) { need(r, 2); const v = r.buf.readUInt16BE(r.pos); r.pos += 2; return v; }
  if (info === 26) { need(r, 4); const v = r.buf.readUInt32BE(r.pos); r.pos += 4; return v; }
  if (info === 27) {
    need(r, 8);
    const hi = r.buf.readUInt32BE(r.pos);
    const lo = r.buf.readUInt32BE(r.pos + 4);
    r.pos += 8;
    // JS 安全整数上限是 2^53；长度字段不可能超过这个量级，超出说明数据被篡改
    const v = hi * 2 ** 32 + lo;
    if (!Number.isSafeInteger(v)) throw new CborError('CBOR integer exceeds safe range');
    return v;
  }
  if (info === 31) throw new CborError('Indefinite-length CBOR is not supported');
  throw new CborError(`Reserved CBOR additional info ${info}`);
}

function readItem(r: Read, depth = 0): CborValue {
  if (depth > 16) throw new CborError('CBOR nesting too deep');
  need(r, 1);
  const initial = r.buf[r.pos++];
  const major = initial >> 5;
  const info = initial & 0x1f;

  switch (major) {
    case 0:
      return readUint(r, info);
    case 1: {
      const n = readUint(r, info);
      return -1 - n;
    }
    case 2: {
      const len = readUint(r, info);
      need(r, len);
      const out = r.buf.subarray(r.pos, r.pos + len);
      r.pos += len;
      return Buffer.from(out);
    }
    case 3: {
      const len = readUint(r, info);
      need(r, len);
      const out = r.buf.subarray(r.pos, r.pos + len).toString('utf8');
      r.pos += len;
      return out;
    }
    case 4: {
      const len = readUint(r, info);
      const arr: CborValue[] = [];
      for (let i = 0; i < len; i++) arr.push(readItem(r, depth + 1));
      return arr;
    }
    case 5: {
      const len = readUint(r, info);
      const map = new Map<unknown, CborValue>();
      for (let i = 0; i < len; i++) {
        const k = readItem(r, depth + 1);
        map.set(k, readItem(r, depth + 1));
      }
      return map;
    }
    case 6:
      // tag：语义标记，WebAuthn 用不到，跳过标记本身继续读值
      readUint(r, info);
      return readItem(r, depth + 1);
    case 7: {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 23) return undefined as unknown as CborValue;
      if (info === 25) {
        need(r, 2);
        const half = r.buf.readUInt16BE(r.pos); r.pos += 2;
        return halfToFloat(half);
      }
      if (info === 26) { need(r, 4); const v = r.buf.readFloatBE(r.pos); r.pos += 4; return v; }
      if (info === 27) { need(r, 8); const v = r.buf.readDoubleBE(r.pos); r.pos += 8; return v; }
      throw new CborError(`Unsupported CBOR simple value ${info}`);
    }
    default:
      throw new CborError(`Unsupported CBOR major type ${major}`);
  }
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x03ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

export function decodeCbor(buf: Buffer): CborValue {
  const r: Read = { buf, pos: 0 };
  const value = readItem(r);
  if (r.pos !== buf.length) throw new CborError(`Trailing ${buf.length - r.pos} bytes after CBOR item`);
  return value;
}

/** 取出 map 的字符串键；类型不对时直接报错，调用方不需要到处做类型收窄 */
export function cborMap(value: CborValue, what: string): Map<unknown, CborValue> {
  if (!(value instanceof Map)) throw new CborError(`${what} is not a CBOR map`);
  return value;
}

export function cborBytes(value: CborValue | undefined, what: string): Buffer {
  if (!Buffer.isBuffer(value)) throw new CborError(`${what} is not a CBOR byte string`);
  return value;
}

export function cborText(value: CborValue | undefined, what: string): string {
  if (typeof value !== 'string') throw new CborError(`${what} is not a CBOR text string`);
  return value;
}

export function cborInt(value: CborValue | undefined, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new CborError(`${what} is not a CBOR integer`);
  return value;
}
