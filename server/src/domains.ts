import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { db, now, uid } from './db.js';
import { bus } from './events.js';
import { currentProjectId } from './context.js';

export interface FunctionDomain {
  id: string; projectId: string; functionId: string; hostname: string;
  status: 'pending' | 'verifying' | 'active' | 'failed';
  verificationToken: string; dnsRecord: string;
  sslStatus: 'pending' | 'issued' | 'failed';
  createdAt: string; verifiedAt: string | null; lastCheckAt: string | null;
  note?: string;
}

const fromRow = (r: any): FunctionDomain => ({
  id: r.id, projectId: r.projectId, functionId: r.functionId, hostname: r.hostname,
  status: r.status, verificationToken: r.verificationToken,
  dnsRecord: `studio-baas-verify=${r.verificationToken}`,
  sslStatus: r.sslStatus || 'pending',
  createdAt: r.createdAt, verifiedAt: r.verifiedAt, lastCheckAt: r.lastCheckAt,
});

export function listDomains(functionId: string): FunctionDomain[] {
  const rows = db.prepare('SELECT * FROM functionDomains WHERE functionId=? AND projectId=? ORDER BY createdAt ASC')
    .all(functionId, currentProjectId()) as any[];
  return rows.map(fromRow);
}

export function getDomain(id: string): FunctionDomain | null {
  const r = db.prepare('SELECT * FROM functionDomains WHERE id=? AND projectId=?').get(id, currentProjectId()) as any;
  return r ? fromRow(r) : null;
}

const HOST_RE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i;

export function addDomain(functionId: string, rawHost: string): FunctionDomain {
  const hostname = String(rawHost || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!HOST_RE.test(hostname)) throw new Error('Enter a valid hostname, e.g. api.example.com');
  if (db.prepare('SELECT 1 FROM functionDomains WHERE hostname=?').get(hostname)) {
    throw new Error(`${hostname} is already bound to a function in this instance`);
  }
  const id = uid('dom_');
  const token = crypto.randomBytes(12).toString('hex');
  db.prepare(`INSERT INTO functionDomains
    (id,projectId,functionId,hostname,status,verificationToken,sslStatus,createdAt,verifiedAt,lastCheckAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, currentProjectId(), functionId, hostname, 'pending', token, 'pending', now(), null, null,
  );
  bus.publish({ type: 'domain', action: 'add', resource: hostname });
  return getDomain(id)!;
}

/**
 * 校验域名归属：读取 TXT 记录 studio-baas-verify=<token>。
 * 本地演示没有真实 DNS 时（DOMAIN_VERIFY_MODE=simulate，默认）会直接置为 active，
 * 并在 note 里说明这是模拟签发——方便在没有域名的情况下走通整条链路。
 */
export async function verifyDomain(id: string): Promise<FunctionDomain> {
  const dom = getDomain(id);
  if (!dom) throw new Error('Domain not found');
  db.prepare("UPDATE functionDomains SET status='verifying', lastCheckAt=? WHERE id=?").run(now(), id);

  const mode = process.env.DOMAIN_VERIFY_MODE || 'simulate';
  let note = '';
  let ok = false;

  if (mode === 'strict') {
    try {
      const records = await dns.resolveTxt(dom.hostname);
      const flat = records.map((r) => r.join('')).map((s) => s.trim());
      ok = flat.includes(dom.dnsRecord);
      note = ok ? 'TXT record matched' : `No TXT record "${dom.dnsRecord}" found (got ${flat.length} records)`;
    } catch (e: any) {
      note = `DNS lookup failed: ${e.code || e.message}`;
    }
  } else {
    // 模拟模式：不发真实 DNS 查询，直接标记为已签发
    ok = true;
    note = 'Verified in simulate mode (no DNS lookup). Set DOMAIN_VERIFY_MODE=strict to require a TXT record.';
  }

  db.prepare('UPDATE functionDomains SET status=?,sslStatus=?,verifiedAt=?,note=? WHERE id=?').run(
    ok ? 'active' : 'failed', ok ? 'issued' : 'failed', ok ? now() : null, note, id,
  );
  bus.publish({ type: 'domain', action: ok ? 'verified' : 'failed', resource: dom.hostname });
  return getDomain(id)!;
}

export function removeDomain(id: string): boolean {
  const dom = getDomain(id);
  if (!dom) return false;
  db.prepare('DELETE FROM functionDomains WHERE id=?').run(id);
  bus.publish({ type: 'domain', action: 'remove', resource: dom.hostname });
  return true;
}

/** 供 Host 路由使用：查找当前实例上已激活的域名 */
export function activeDomainByHost(hostname: string): FunctionDomain | null {
  const host = hostname.toLowerCase().split(':')[0];
  const r = db.prepare("SELECT * FROM functionDomains WHERE hostname=? AND status='active'").get(host) as any;
  return r ? fromRow(r) : null;
}
