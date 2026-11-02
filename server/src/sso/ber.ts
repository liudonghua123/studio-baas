/**
 * 最小 BER/DER 编解码器 —— 只为 LDAP v3 服务。
 *
 * 为什么不用 ldapjs：本项目运行时依赖只有 4 个（express / better-sqlite3 /
 * cors / multer），为了一个登录方式拖进一棵依赖树不划算；而 LDAP 需要的
 * 编码面窄得可怜（整数、字符串、布尔、序列、上下文标签）。
 *
 * 这里只实现**确定性长度**编码（DER 风格），LDAP 服务端全部接受。
 */

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  OCTET: 0x04,
  ENUM: 0x0a,
  SEQUENCE: 0x30,
  SET: 0x31,
};

/** 上下文标签：[n]，构造型用于 &、|、! 等复合结构 */
export const ctx = (n: number, constructed = false) => 0x80 | (constructed ? 0x20 : 0) | n;
/** 应用标签：[APPLICATION n]，LDAP 的每个协议操作都是它 */
export const app = (n: number, constructed = true) => 0x40 | (constructed ? 0x20 : 0) | n;

function encodeLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), encodeLength(body.length), body]);
}

export function int(n: number, tag = TAG.INTEGER): Buffer {
  const bytes: number[] = [];
  let v = Math.max(0, Math.floor(n));
  do { bytes.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  // 最高位为 1 时要补 0x00，否则会被读成负数
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(tag, Buffer.from(bytes));
}

export const string = (s: string) => tlv(TAG.OCTET, Buffer.from(s, 'utf8'));
export const boolean = (b: boolean) => tlv(TAG.BOOLEAN, Buffer.from([b ? 0xff : 0x00]));
export const seq = (...parts: Buffer[]) => tlv(TAG.SEQUENCE, ...parts);

export interface Tlv {
  tag: number;
  value: Buffer;
  /** 整个 TLV（含头）在原始 buffer 里的长度 */
  size: number;
}

/**
 * 从 buf[0..] 读一个 TLV。
 * 数据不完整（TCP 半包）返回 null —— 调用方应该等更多字节，而不是报错。
 */
export function readTlv(buf: Buffer, offset = 0): Tlv | null {
  if (buf.length < offset + 2) return null;
  const tag = buf[offset];
  let p = offset + 1;
  let len = buf[p++];
  if (len & 0x80) {
    const n = len & 0x7f;
    // 0x80 是「不定长」，LDAP 不用；>4 字节的长度意味着流已经错位
    if (n === 0 || n > 4) throw new Error('Malformed BER length');
    if (buf.length < p + n) return null;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  if (buf.length < p + len) return null;
  return { tag, value: buf.subarray(p, p + len), size: p + len - offset };
}

/** 解析 SEQUENCE 的子元素列表 */
export function children(t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let off = 0;
  while (off < t.value.length) {
    const c = readTlv(t.value, off);
    if (!c) throw new Error('Truncated BER sequence');
    out.push(c);
    off += c.size;
  }
  return out;
}

export const asInt = (t: Tlv): number => {
  let v = 0;
  for (const b of t.value) v = v * 256 + b;
  return v;
};
export const asString = (t: Tlv): string => t.value.toString('utf8');

/**
 * RFC 4515 过滤器转义。
 * 不转义的话，用户名里的 `*` 会把「精确匹配」变成通配符，
 * `)(` 甚至能改写整个过滤器的结构 —— 这就是 LDAP 注入。
 */
export function escapeFilter(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\5c'; break;
      case '*': out += '\\2a'; break;
      case '(': out += '\\28'; break;
      case ')': out += '\\29'; break;
      case '\0': out += '\\00'; break;
      default: out += ch;
    }
  }
  return out;
}

/* ------------------------------------------------------------- filters */
export type Filter =
  | { type: 'and' | 'or'; items: Filter[] }
  | { type: 'not'; item: Filter }
  | { type: 'eq' | 'ge' | 'le' | 'approx'; attr: string; value: string }
  | { type: 'present'; attr: string }
  | { type: 'sub'; attr: string; initial: string; any: string[]; final: string };

const FILTER_TAGS = { and: 0xa0, or: 0xa1, not: 0xa2, eq: 0xa3, sub: 0xa4, ge: 0xa5, le: 0xa6, present: 0x87, approx: 0xa8 };

/**
 * 解析 RFC 4515 过滤器子集：`(&(a=b)(c=*x*)(!(d=e)))`。
 * 覆盖目录服务里 99% 的实际用法；遇到不支持的操作符直接报错，
 * 而不是「猜一个」然后静默匹配到错误的条目。
 */
export function parseFilter(input: string): Filter {
  let i = 0;
  const src = input.trim();

  const parse = (): Filter => {
    if (src[i] !== '(') throw new Error(`Invalid LDAP filter at ${i}: expected "("`);
    i++;
    let node: Filter;
    if (src[i] === '&' || src[i] === '|') {
      const kind = src[i] === '&' ? 'and' : 'or';
      i++;
      const items: Filter[] = [];
      while (src[i] === '(') items.push(parse());
      if (!items.length) throw new Error('Empty AND/OR in LDAP filter');
      node = { type: kind, items };
    } else if (src[i] === '!') {
      i++;
      node = { type: 'not', item: parse() };
    } else {
      const start = i;
      while (i < src.length && src[i] !== ')' && src[i] !== '=' && src[i] !== '~' && src[i] !== '>' && src[i] !== '<') i++;
      const attr = src.slice(start, i).trim();
      let op = '';
      if (src.startsWith('>=', i)) { op = 'ge'; i += 2; }
      else if (src.startsWith('<=', i)) { op = 'le'; i += 2; }
      else if (src.startsWith('~=', i)) { op = 'approx'; i += 2; }
      else if (src[i] === '=') { op = 'eq'; i += 1; }
      else throw new Error(`Unsupported LDAP filter operator near "${src.slice(i, i + 6)}"`);

      const vStart = i;
      while (i < src.length && src[i] !== ')') i++;
      const raw = src.slice(vStart, i);
      if (!attr) throw new Error('LDAP filter is missing an attribute name');

      if (op === 'eq' && raw === '*') node = { type: 'present', attr };
      else if (op === 'eq' && raw.includes('*')) {
        const parts = raw.split('*');
        node = {
          type: 'sub', attr,
          initial: parts[0], any: parts.slice(1, -1).filter(Boolean), final: parts[parts.length - 1],
        };
      } else node = { type: op as 'eq' | 'ge' | 'le' | 'approx', attr, value: unescapeFilter(raw) };
    }
    if (src[i] !== ')') throw new Error('Unbalanced "(" in LDAP filter');
    i++;
    return node;
  };

  const f = parse();
  if (i !== src.length) throw new Error(`Trailing characters in LDAP filter: "${src.slice(i)}"`);
  return f;
}

function unescapeFilter(s: string): string {
  return s.replace(/\\([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

export function encodeFilter(f: Filter): Buffer {
  switch (f.type) {
    case 'and':
    case 'or':
      return tlv(FILTER_TAGS[f.type], ...f.items.map(encodeFilter));
    case 'not':
      return tlv(FILTER_TAGS.not, encodeFilter(f.item));
    case 'present':
      return tlv(FILTER_TAGS.present, Buffer.from(f.attr, 'utf8'));
    case 'sub': {
      const parts: Buffer[] = [];
      if (f.initial) parts.push(tlv(ctx(0), Buffer.from(escapeFilter(f.initial), 'utf8')));
      for (const a of f.any) parts.push(tlv(ctx(1), Buffer.from(escapeFilter(a), 'utf8')));
      if (f.final) parts.push(tlv(ctx(2), Buffer.from(escapeFilter(f.final), 'utf8')));
      // [4] 是 IMPLICIT 标签，直接替换 SEQUENCE 头：内容 = 属性名 + 子串序列
      return tlv(FILTER_TAGS.sub, string(f.attr), tlv(TAG.SEQUENCE, ...parts));
    }
    default:
      // AttributeValueAssertion = SEQUENCE { 属性名 OCTET STRING, 断言值 OCTET STRING }
      // 两个字段都必须各自带 0x04 标签，直接拼裸字节会让服务端把长度读错位
      return tlv(FILTER_TAGS[f.type], string(f.attr), string(f.value));
  }
}
