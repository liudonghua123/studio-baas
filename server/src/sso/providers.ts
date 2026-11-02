import crypto from 'node:crypto';
import { db, now, uid } from '../db.js';
import { bus } from '../events.js';
import { encryptSecret, decryptSecret, maskSecret, isEncrypted } from '../secrets.js';

/**
 * 身份源（SSO provider）的持久化与配置校验。
 *
 * 一条记录 = 一个「登录方式」。config 整体存 JSON，其中密码类字段
 * （clientSecret / bindPassword）在写入前用 AES-GCM 加密，读出来再解；
 * 对外的任何接口都不会返回明文，只给「是否已配置 + 尾号」。
 */

export type ProviderType = 'oauth2' | 'oidc' | 'cas' | 'ldap';
export const PROVIDER_TYPES: { id: ProviderType; label: string; hint: string }[] = [
  { id: 'oidc', label: 'OpenID Connect', hint: 'Keycloak / Entra ID / Auth0 / Okta / Google' },
  { id: 'oauth2', label: 'OAuth 2.0', hint: 'Any OAuth2 authorization-code provider' },
  { id: 'cas', label: 'CAS', hint: 'Apereo CAS 2.0 / 3.0 service tickets' },
  { id: 'ldap', label: 'LDAP', hint: 'OpenLDAP / Active Directory (direct bind)' },
];

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string[];
  emailField?: string;
  nameField?: string;
  idField?: string;
  /** 追加到授权 URL 的参数，例如 `{"prompt":"consent"}` */
  extraParams?: Record<string, string>;
  usePkce?: boolean;
  /** 换 token 时把 client_secret 放表单（默认）还是放 Authorization: Basic */
  tokenAuth?: 'post' | 'basic';
}

export interface OidcConfig {
  issuer: string;
  discovery: boolean;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  jwksUri?: string;
  emailField?: string;
  nameField?: string;
  extraParams?: Record<string, string>;
  tokenAuth?: 'post' | 'basic';
}

export interface CasConfig {
  serverUrl: string;
  /** 2.0 用 /serviceValidate，3.0 用 /p3/serviceValidate（会返回更多属性） */
  version: '2' | '3';
  emailAttribute?: string;
  nameAttribute?: string;
}

export interface LdapConfigStored {
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
}

export type ProviderConfig = OAuth2Config | OidcConfig | CasConfig | LdapConfigStored;

export interface AuthProvider {
  id: string;
  projectId: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  defaultRole: string | null;
  /** 只允许这些邮箱域登录（空 = 不限制），企业场景常用来挡住个人邮箱 */
  allowedDomains: string[];
  trustEmail: boolean;
  config: ProviderConfig;
  createdAt: string;
  updatedAt: string;
}

const SECRET_FIELDS: Partial<Record<ProviderType, string[]>> = {
  oauth2: ['clientSecret'],
  oidc: ['clientSecret'],
  ldap: ['bindPassword'],
  cas: [],
};

const REQUIRED: Record<ProviderType, string[]> = {
  oauth2: ['clientId', 'authorizeUrl', 'tokenUrl', 'userinfoUrl'],
  oidc: ['clientId', 'issuer'],
  cas: ['serverUrl'],
  ldap: ['url', 'baseDn', 'userFilter'],
};

export function assertProviderType(t: unknown): ProviderType {
  if (!PROVIDER_TYPES.some((x) => x.id === t)) throw new Error(`Unknown provider type: ${t}`);
  return t as ProviderType;
}

/**
 * 校验 + 归一化。缺必填字段直接报错（带着字段名），
 * 而不是等到用户点登录时才炸在某个 fetch 里。
 */
export function normalizeConfig(type: ProviderType, raw: any): ProviderConfig {
  const cfg = { ...(raw || {}) } as any;

  for (const field of REQUIRED[type]) {
    if (!String(cfg[field] ?? '').trim()) throw new Error(`Missing required field: ${field}`);
  }

  if (type === 'oauth2' || type === 'oidc') {
    cfg.clientId = String(cfg.clientId).trim();
    cfg.scopes = normalizeScopes(cfg.scopes, type === 'oidc' ? ['openid', 'email', 'profile'] : ['email', 'profile']);
    cfg.emailField = cfg.emailField || 'email';
    cfg.nameField = cfg.nameField || 'name';
    if (type === 'oauth2') {
      if (!cfg.usePkce) cfg.usePkce = true;      // 默认开 PKCE：支持的服务端不会因此拒绝，不支持的会忽略
      cfg.idField = cfg.idField || 'sub';
    } else {
      cfg.discovery = cfg.discovery !== false;
      cfg.issuer = String(cfg.issuer).trim().replace(/\/+$/, '');
      if (!cfg.discovery) {
        for (const f of ['authorizeUrl', 'tokenUrl', 'jwksUri']) {
          if (!String(cfg[f] ?? '').trim()) throw new Error(`Missing required field: ${f} (discovery is off)`);
        }
      }
    }
  }

  if (type === 'cas') {
    cfg.serverUrl = String(cfg.serverUrl).trim().replace(/\/+$/, '');
    cfg.version = cfg.version === '2' ? '2' : '3';
    cfg.emailAttribute = cfg.emailAttribute || 'mail';
    cfg.nameAttribute = cfg.nameAttribute || 'displayName';
  }

  if (type === 'ldap') {
    cfg.url = String(cfg.url).trim();
    if (!/^ldaps?:\/\//i.test(cfg.url)) throw new Error('LDAP url must start with ldap:// or ldaps://');
    cfg.userFilter = String(cfg.userFilter).trim();
    if (!/^\(.+\)$/.test(cfg.userFilter)) {
      throw new Error('userFilter must be a full LDAP filter, e.g. (uid={{username}})');
    }
    cfg.attrEmail = cfg.attrEmail || 'mail';
    cfg.attrName = cfg.attrName || 'cn';
    cfg.startTls = !!cfg.startTls;
    cfg.tlsSkipVerify = !!cfg.tlsSkipVerify;
  }

  return cfg as ProviderConfig;
}

function normalizeScopes(v: unknown, fallback: string[]): string[] {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : fallback;
  const out = list.map((s) => String(s).trim()).filter(Boolean);
  return out.length ? Array.from(new Set(out)) : fallback;
}

/* ------------------------------------------------------------- storage */
function rowToProvider(r: any): AuthProvider {
  let config: any = {};
  try { config = JSON.parse(r.config || '{}'); } catch { config = {}; }
  return {
    id: r.id, projectId: r.projectId, type: r.type, name: r.name,
    enabled: !!r.enabled, defaultRole: r.defaultRole || null,
    allowedDomains: safeArray(config.allowedDomains),
    trustEmail: config.trustEmail !== false,
    config: config as ProviderConfig,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

function safeArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
}

/** 内部使用：把密文字段解密，供真正的认证流程读取 */
export function decryptConfig(type: ProviderType, cfg: any): any {
  const out = { ...cfg };
  for (const field of SECRET_FIELDS[type] || []) {
    const stored = String(out[field] || '');
    if (!stored) { out[field] = ''; continue; }
    if (isEncrypted(stored)) {
      const plain = decryptSecret(stored);
      if (plain === null) throw new Error(`Cannot decrypt ${field}: STUDIO_SECRET_KEY changed. Re-enter it in settings.`);
      out[field] = plain;
    }
  }
  return out;
}

/** 对外（管理员）：抹掉秘密，只留「有没有配」+ 尾号 */
export function publicView(p: AuthProvider) {
  const config: any = { ...p.config };
  const secrets: Record<string, { set: boolean; preview: string }> = {};
  for (const field of SECRET_FIELDS[p.type] || []) {
    const stored = String(config[field] || '');
    let plain = '';
    if (stored) {
      if (isEncrypted(stored)) plain = decryptSecret(stored) || '';
      else plain = stored;
    }
    secrets[field] = { set: !!stored, preview: plain ? maskSecret(plain) : '' };
    delete config[field];
  }
  return {
    id: p.id, projectId: p.projectId, type: p.type, name: p.name,
    enabled: p.enabled, defaultRole: p.defaultRole,
    allowedDomains: p.allowedDomains, trustEmail: p.trustEmail,
    config, secrets, createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

/** 登录页用：只要「有哪些按钮」，不含任何配置 */
export function publicList(projectId: string) {
  const rows = db.prepare(
    'SELECT id, type, name FROM authProviders WHERE projectId=? AND enabled=1 ORDER BY createdAt ASC',
  ).all(projectId) as any[];
  return rows.map((r) => ({ id: r.id, type: r.type, name: r.name }));
}

export function listProviders(projectId: string): AuthProvider[] {
  const rows = db.prepare('SELECT * FROM authProviders WHERE projectId=? ORDER BY createdAt ASC').all(projectId) as any[];
  return rows.map(rowToProvider);
}

export function getProvider(projectId: string, id: string): AuthProvider | null {
  const r = db.prepare('SELECT * FROM authProviders WHERE projectId=? AND id=?').get(projectId, id) as any;
  return r ? rowToProvider(r) : null;
}

/** 回调里没有会话，只能按 id 取；state 里已经记录了 projectId，用于交叉校验 */
export function getProviderById(id: string): AuthProvider | null {
  const r = db.prepare('SELECT * FROM authProviders WHERE id=?').get(id) as any;
  return r ? rowToProvider(r) : null;
}

export interface ProviderInput {
  type?: string;
  name?: string;
  enabled?: boolean;
  defaultRole?: string | null;
  allowedDomains?: string[];
  trustEmail?: boolean;
  config?: Record<string, unknown>;
}

export function createProvider(projectId: string, input: ProviderInput): AuthProvider {
  const type = assertProviderType(input.type);
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Provider name is required');

  const raw = { ...(input.config || {}) } as any;
  const cfg = normalizeConfig(type, raw);

  // 秘密字段：加密后存
  for (const field of SECRET_FIELDS[type] || []) {
    if (String(raw[field] ?? '')) (cfg as any)[field] = encryptSecret(String(raw[field]));
  }
  (cfg as any).allowedDomains = safeArray(input.allowedDomains ?? raw.allowedDomains);
  (cfg as any).trustEmail = input.trustEmail !== false;

  const id = uid('idp_');
  db.prepare(
    'INSERT INTO authProviders (id,projectId,type,name,enabled,config,defaultRole,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)',
  ).run(id, projectId, type, name, input.enabled === false ? 0 : 1, JSON.stringify(cfg), input.defaultRole ?? 'viewer', now(), now());

  bus.publish({ type: 'auth', action: 'provider.create', resource: name });
  return getProvider(projectId, id)!;
}

export function updateProvider(projectId: string, id: string, input: ProviderInput): AuthProvider | null {
  const cur = getProvider(projectId, id);
  if (!cur) return null;

  const type = input.type ? assertProviderType(input.type) : cur.type;
  const merged: any = { ...cur.config, ...(input.config || {}) };

  // 空的 secret 表示「不改」，而不是「清空」—— UI 从来拿不到明文，无法回填
  for (const field of SECRET_FIELDS[type] || []) {
    const incoming = (input.config || {})[field];
    if (incoming === undefined || incoming === null || incoming === '') {
      merged[field] = (cur.config as any)[field] || '';
    } else {
      merged[field] = encryptSecret(String(incoming));
    }
  }
  if (input.allowedDomains !== undefined) merged.allowedDomains = safeArray(input.allowedDomains);
  if (input.trustEmail !== undefined) merged.trustEmail = !!input.trustEmail;

  const cfg = normalizeConfig(type, merged);
  db.prepare('UPDATE authProviders SET type=?,name=?,enabled=?,config=?,defaultRole=?,updatedAt=? WHERE id=? AND projectId=?').run(
    type,
    input.name !== undefined ? String(input.name) : cur.name,
    input.enabled === undefined ? (cur.enabled ? 1 : 0) : input.enabled ? 1 : 0,
    JSON.stringify(cfg),
    input.defaultRole !== undefined ? input.defaultRole : cur.defaultRole,
    now(), id, projectId,
  );
  bus.publish({ type: 'auth', action: 'provider.update', resource: cur.name });
  return getProvider(projectId, id);
}

export function deleteProvider(projectId: string, id: string): boolean {
  const cur = getProvider(projectId, id);
  if (!cur) return false;
  // 身份映射一起删：否则重建同 id 的源会「继承」旧绑定
  db.transaction(() => {
    db.prepare('DELETE FROM authIdentities WHERE providerId=?').run(id);
    db.prepare('DELETE FROM authStates WHERE providerId=?').run(id);
    db.prepare('DELETE FROM authProviders WHERE id=? AND projectId=?').run(id, projectId);
  })();
  bus.publish({ type: 'auth', action: 'provider.delete', resource: cur.name });
  return true;
}

/* --------------------------------------------------------------- state */
export interface AuthState {
  id: string;
  providerId: string;
  projectId: string;
  verifier: string | null;
  nonce: string | null;
  returnTo: string | null;
  appOrigin: string | null;
  callbackUrl: string | null;
  expiresAt: string;
}

export function createState(providerId: string, projectId: string, extra: {
  verifier?: string; nonce?: string; returnTo?: string; appOrigin?: string; callbackUrl?: string;
}): string {
  // 顺手清掉过期行，避免表无限增长（启动 10 分钟内没人登录也不会有残留）
  db.prepare('DELETE FROM authStates WHERE expiresAt < ?').run(now());
  const id = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare(
    `INSERT INTO authStates (id,providerId,projectId,verifier,nonce,returnTo,appOrigin,callbackUrl,createdAt,expiresAt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, providerId, projectId, extra.verifier || null, extra.nonce || null, extra.returnTo || null,
    extra.appOrigin || null, extra.callbackUrl || null, now(), expiresAt);
  return id;
}

/**
 * 取出并删除。一次授权只能换一次 code —— 重放同一个 state 必须失败，
 * 否则攻击者拿到回调 URL 就能反复兑换。
 */
export function consumeState(id: string): AuthState | null {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM authStates WHERE id=?').get(id) as any;
  if (!row) return null;
  db.prepare('DELETE FROM authStates WHERE id=?').run(id);
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  return {
    id: row.id, providerId: row.providerId, projectId: row.projectId,
    verifier: row.verifier, nonce: row.nonce, returnTo: row.returnTo,
    appOrigin: row.appOrigin, callbackUrl: row.callbackUrl, expiresAt: row.expiresAt,
  };
}

/** 只允许站内相对路径，杜绝 `returnTo=https://evil.com` 这种开放重定向 */
export function safeReturnTo(v: unknown): string {
  const s = String(v || '/');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return '/';
  return s;
}
