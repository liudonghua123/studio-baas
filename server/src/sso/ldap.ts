import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { TAG, app, ctx, tlv, int, string, boolean, children, readTlv, asInt, asString, encodeFilter, parseFilter, escapeFilter, type Tlv } from './ber.js';

/**
 * LDAP v3 客户端（bind + search），零依赖。
 *
 * 只做登录需要的两件事：先用服务账号（或匿名）搜到用户 DN，
 * 再用**这个用户的 DN + 他输入的密码**重新 bind 一次。
 *
 * 第二步不能省：搜索结果只证明「目录里有这个人」，不证明「他知道密码」。
 * 而且必须显式拒绝空密码 —— 按 RFC 4513，空密码的 simple bind 会变成
 * 匿名绑定并成功，直接放行就等于「输入空密码即可登录」。
 */

export interface LdapConfig {
  url: string;
  startTls?: boolean;
  tlsSkipVerify?: boolean;
  baseDn: string;
  bindDn?: string;
  bindPassword?: string;
  userFilter: string;
  attrEmail: string;
  attrName: string;
  attrUsername?: string;
  timeoutMs?: number;
}

export interface LdapProfile {
  subject: string;
  username: string;
  email: string;
  name: string;
  raw: Record<string, string[]>;
}

export class LdapError extends Error {
  constructor(public code: number, message: string) {
    super(message || `LDAP error ${code}`);
    this.name = 'LdapError';
  }
}

/** 常见结果码 → 人话，避免把 "invalid credentials (49)" 直接甩给用户 */
const RESULT_MESSAGES: Record<number, string> = {
  0: 'success',
  1: 'operations error',
  32: 'no such object — check the base DN',
  34: 'invalid DN syntax',
  49: 'invalid credentials',
  50: 'insufficient access rights for the bind account',
  51: 'server is busy',
  52: 'server unavailable',
  53: 'server is unwilling to perform the operation',
  65: 'object class violation',
};

const describe = (code: number, diag: string) =>
  new LdapError(code, `${RESULT_MESSAGES[code] || `LDAP result ${code}`}${diag ? `: ${diag}` : ''}`);

class LdapConnection {
  private socket!: net.Socket | tls.TLSSocket;
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, (op: Tlv) => boolean>();
  private closed = false;

  constructor(private readonly cfg: LdapConfig) {}

  async connect(): Promise<void> {
    const url = new URL(this.cfg.url);
    const secure = url.protocol === 'ldaps:';
    if (url.protocol !== 'ldap:' && !secure) throw new Error(`Unsupported LDAP URL scheme: ${url.protocol}`);
    const host = url.hostname;
    const port = Number(url.port) || (secure ? 636 : 389);
    const timeout = this.cfg.timeoutMs ?? 8000;

    if (secure) {
      this.socket = tls.connect({ host, port, servername: host, rejectUnauthorized: !this.cfg.tlsSkipVerify });
      await withTimeout(once(this.socket, 'secureConnect'), timeout, 'LDAP TLS handshake timed out');
    } else {
      this.socket = net.connect({ host, port });
      await withTimeout(once(this.socket, 'connect'), timeout, 'LDAP connection timed out');
    }

    this.socket.setNoDelay(true);
    this.socket.on('data', this.onData);
    this.socket.on('error', (e) => this.failAll(e));
    this.socket.on('close', () => this.failAll(new Error('LDAP connection closed')));

    if (!secure && this.cfg.startTls) await this.startTls(host);
  }

  /** RFC 4511 §4.14：升到 TLS 必须在 bind 之前，且之后要重置缓冲区 */
  private async startTls(host: string): Promise<void> {
    const oid = '1.3.6.1.4.1.1466.20037';
    let code = -1;
    let diag = '';
    await this.send(tlv(app(23), tlv(ctx(0), Buffer.from(oid, 'utf8'))), (op) => {
      const c = children(op);
      code = asInt(c[0]);
      diag = c.length > 2 ? asString(c[2]) : '';
      return true;
    });
    if (code !== 0) throw describe(code, diag);

    this.socket.removeListener('data', this.onData);
    this.buf = Buffer.alloc(0);
    const upgraded = tls.connect({
      socket: this.socket as net.Socket, servername: host,
      rejectUnauthorized: !this.cfg.tlsSkipVerify,
    });
    await withTimeout(once(upgraded, 'secureConnect'), this.cfg.timeoutMs ?? 8000, 'STARTTLS handshake timed out');
    this.socket = upgraded;
    this.socket.on('data', this.onData);
    this.socket.on('error', (e) => this.failAll(e));
    this.socket.on('close', () => this.failAll(new Error('LDAP connection closed')));
  }

  private onData = (chunk: Buffer) => {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      let msg: Tlv | null;
      try { msg = readTlv(this.buf); } catch (e) { this.failAll(e as Error); return; }
      if (!msg) return;                    // 半包：等下一批字节
      this.buf = this.buf.subarray(msg.size);
      try {
        const kids = children(msg);
        const id = asInt(kids[0]);
        const handler = this.pending.get(id);
        if (handler && handler(kids[1])) this.pending.delete(id);
      } catch (e) { this.failAll(e as Error); return; }
    }
  };

  private failAll(err: Error) {
    this.closed = true;
    for (const [, h] of this.pending) {
      // 让等待方立刻失败：把错误伪装成一次「空操作完成」不可行，改为 reject 语义
      h(null as unknown as Tlv);
    }
    this.pending.clear();
    this.lastError = err;
  }

  private lastError: Error | null = null;

  private send(op: Buffer, onOp: (op: Tlv) => boolean): Promise<void> {
    if (this.closed) return Promise.reject(this.lastError || new Error('LDAP connection closed'));
    const id = this.nextId++;
    const packet = tlv(TAG.SEQUENCE, int(id), op);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('LDAP request timed out'));
      }, this.cfg.timeoutMs ?? 8000);
      this.pending.set(id, (opTlv) => {
        if (!opTlv) { clearTimeout(timer); reject(this.lastError || new Error('LDAP connection closed')); return true; }
        let done = false;
        try { done = onOp(opTlv); } catch (e) { clearTimeout(timer); reject(e as Error); return true; }
        if (done) { clearTimeout(timer); resolve(); }
        return done;
      });
      this.socket.write(packet);
    });
  }

  async bind(dn: string, password: string): Promise<void> {
    const op = tlv(app(0), int(3), string(dn), tlv(ctx(0), Buffer.from(password, 'utf8')));
    let code = 0;
    let diag = '';
    await this.send(op, (o) => {
      const c = children(o);
      code = asInt(c[0]);
      diag = c.length > 2 ? asString(c[2]) : '';
      return true;
    });
    if (code !== 0) throw describe(code, diag);
  }

  async search(base: string, filter: string, attributes: string[]): Promise<{ dn: string; attrs: Record<string, string[]> }[]> {
    const op = tlv(
      app(3),
      string(base),
      int(2, TAG.ENUM),          // scope: wholeSubtree —— 用户通常在 base 下面的 OU 里
      int(0, TAG.ENUM),          // derefAliases: never
      int(2),                    // sizeLimit: 2 就够判断「唯一」了
      int(0),                    // timeLimit
      boolean(false),            // typesOnly
      encodeFilter(parseFilter(filter)),
      tlv(TAG.SEQUENCE, ...attributes.map((a) => string(a))),
    );

    const entries: { dn: string; attrs: Record<string, string[]> }[] = [];
    let code = 0;
    let diag = '';

    await this.send(op, (o) => {
      if (o.tag === app(4)) {
        const c = children(o);
        const dn = asString(c[0]);
        const attrs: Record<string, string[]> = {};
        if (c[1]) {
          for (const attr of children(c[1])) {
            const parts = children(attr);
            attrs[asString(parts[0]).toLowerCase()] = parts[1] ? children(parts[1]).map(asString) : [];
          }
        }
        entries.push({ dn, attrs });
        return false;                    // 还有后续条目
      }
      if (o.tag === app(19)) return false;  // searchResultReference：不跟随
      // searchResultDone
      const c = children(o);
      code = asInt(c[0]);
      diag = c.length > 2 ? asString(c[2]) : '';
      return true;
    });

    // 4 = sizeLimitExceeded：我们故意只要 2 条，用来发现「匹配到多个人」
    if (code !== 0 && code !== 4) throw describe(code, diag);
    return entries;
  }

  async unbind(): Promise<void> {
    if (this.closed) return;
    // UnbindRequest 是 [APPLICATION 2] NULL：NULL 是原始类型，不能带构造位（0x42 而不是 0x62）
    try { this.socket.write(tlv(TAG.SEQUENCE, int(this.nextId++), tlv(app(2, false)))); } catch { /* 已经断了 */ }
    this.closed = true;
    setTimeout(() => this.socket.destroy(), 50).unref?.();
  }

  destroy() {
    this.closed = true;
    try { this.socket?.destroy(); } catch { /* ignore */ }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * 用用户名 + 密码完成一次目录认证。
 * 任何「找不到人」「密码不对」都收敛成同一条错误，避免用户名枚举。
 */
export async function ldapAuthenticate(cfg: LdapConfig, username: string, password: string): Promise<LdapProfile> {
  const user = String(username || '').trim();
  // 空密码必须先拦：绑定空密码在 LDAP 里等价于匿名绑定，服务端会返回 success
  if (!user || !String(password || '')) throw new Error('Invalid username or password');

  const conn = new LdapConnection(cfg);
  try {
    await conn.connect();

    // 1. 服务账号（没配就匿名）搜人
    if (cfg.bindDn) await conn.bind(cfg.bindDn, cfg.bindPassword || '');
    else await conn.bind('', '');

    const filter = cfg.userFilter.includes('{{username}}')
      ? cfg.userFilter.replace(/\{\{username\}\}/g, escapeLdapValue(user))
      : `(${cfg.userFilter}=${escapeLdapValue(user)})`;

    const attrs = Array.from(new Set([cfg.attrEmail, cfg.attrName, ...(cfg.attrUsername ? [cfg.attrUsername] : [])]));
    const found = await conn.search(cfg.baseDn, filter, attrs);
    if (found.length === 0) throw new Error('Invalid username or password');
    if (found.length > 1) throw new Error('Directory search matched more than one account — tighten the user filter');

    // 2. 以这个人的身份重新绑定 —— 这一步才是真正的密码校验
    await conn.bind(found[0].dn, password);

    const pick = (key?: string) => (key ? found[0].attrs[key.toLowerCase()]?.[0] || '' : '');
    const profile: LdapProfile = {
      subject: found[0].dn,
      username: pick(cfg.attrUsername) || user,
      email: pick(cfg.attrEmail),
      name: pick(cfg.attrName) || pick(cfg.attrUsername) || user,
      raw: found[0].attrs,
    };
    return profile;
  } finally {
    await conn.unbind().catch(() => {});
    setTimeout(() => conn.destroy(), 200).unref?.();
  }
}

/** 管理界面的「测试连接」：只验证网络 + 服务账号绑定，不涉及任何用户口令 */
export async function ldapProbe(cfg: LdapConfig): Promise<{ ok: true; bindDn: string; baseDn: string }> {
  const conn = new LdapConnection(cfg);
  try {
    await conn.connect();
    const dn = cfg.bindDn || '';
    await conn.bind(dn, cfg.bindPassword || '');
    // 顺手确认 baseDn 存在，配错时能立刻发现，而不是等到第一个用户登录才报 32
    await conn.search(cfg.baseDn, '(objectClass=*)', ['objectClass']);
    return { ok: true, bindDn: dn || '(anonymous)', baseDn: cfg.baseDn };
  } finally {
    await conn.unbind().catch(() => {});
    setTimeout(() => conn.destroy(), 200).unref?.();
  }
}

/** 过滤器里的值必须转义，否则 `*` 变通配符、`)` 能改写整个表达式 */
function escapeLdapValue(v: string): string {
  return escapeFilter(v);
}
