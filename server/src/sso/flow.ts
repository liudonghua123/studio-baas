import { db, now, uid } from '../db.js';
import { bus } from '../events.js';
import * as members from '../members.js';
import { issueSession } from '../store.js';
import { ldapAuthenticate } from './ldap.js';
import {
  discover, pkceChallenge, randomToken, verifyIdToken,
  type OidcMetadata,
} from './jwt.js';
import {
  createState, decryptConfig, safeReturnTo,
  type AuthProvider, type AuthState, type CasConfig, type LdapConfigStored, type OAuth2Config, type OidcConfig,
} from './providers.js';

/**
 * 一次 SSO 登录的完整生命周期：start → IdP → callback → 本地会话。
 *
 * 每条出站路径都带超时，每个入站回调都校验 state，每个 token 都验签。
 * 这里没有「为了跑通先放宽一点」的分支 —— 认证代码里没有一个安全的默认值
 * 比「严格但偶尔配错」更危险。
 */

export interface SsoProfile {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  raw: Record<string, unknown>;
}

export interface SsoSession {
  userId: string;
  sessionId: string;
  secret: string;
  expiresAt: string;
  name: string;
  email: string;
  provider: string;
  role: string | null;
  /** 首次登录时自动加入项目，前端可以据此提示「已按默认角色加入」 */
  joined: boolean;
  isNewUser: boolean;
}

const TIMEOUT = 10_000;

function basicAuth(id: string, secret: string) {
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

/* ------------------------------------------------------------- start */
export interface StartInput {
  appOrigin: string;
  returnTo: string;
  callbackUrl: string;
}

export interface StartResult {
  url: string;
  state: string;
}

export function buildAuthorizeUrl(provider: AuthProvider, input: StartInput): StartResult {
  const cfg = decryptConfig(provider.type, provider.config);

  if (provider.type === 'ldap') throw new Error('LDAP providers do not use a redirect — POST credentials to /login');

  const verifier = randomToken(32);
  const nonce = provider.type === 'oidc' ? randomToken(16) : null;
  const state = createState(provider.id, provider.projectId, {
    verifier, nonce: nonce || undefined,
    returnTo: safeReturnTo(input.returnTo), appOrigin: input.appOrigin,
    // redirect_uri 必须与换 token 时逐字节一致，CAS 的 service 同理，所以存下来而不是回调时重算
    callbackUrl: input.callbackUrl,
  });

  if (provider.type === 'cas') {
    // CAS 协议本身没有 state：把 state 塞进 service 的查询串里，
    // 服务端会原样带回来（校验 ticket 时也必须用这同一个 service 字符串）
    const url = new URL(`${cfg.serverUrl}/login`);
    url.searchParams.set('service', casService(input.callbackUrl, state));
    return { url: url.toString(), state };
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: input.callbackUrl,
    state,
  });

  if (provider.type === 'oidc') {
    const o = cfg as OidcConfig;
    if (!o.authorizeUrl) {
      // 走 discovery 的源必须先 resolveEndpoints()，否则这里拼不出授权地址
      throw new Error('Authorize endpoint is not resolved — call startFlow() instead of buildAuthorizeUrl()');
    }
    params.set('scope', (o.scopes || ['openid']).join(' '));
    if (nonce) params.set('nonce', nonce);
    for (const [k, v] of Object.entries(o.extraParams || {})) params.set(k, String(v));
    params.set('code_challenge', pkceChallenge(verifier));
    params.set('code_challenge_method', 'S256');
    return { url: withQuery(o.authorizeUrl, params), state };
  }

  const o = cfg as OAuth2Config;
  params.set('scope', (o.scopes || []).join(' '));
  if (o.usePkce !== false) {
    params.set('code_challenge', pkceChallenge(verifier));
    params.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(o.extraParams || {})) params.set(k, String(v));
  return { url: withQuery(o.authorizeUrl, params), state };
}

/**
 * 同步版本只能拿到「配置里写死的」端点。OIDC 开了 discovery 但没填 authorizeUrl 时，
 * 由 startFlow() 先解析元数据再拼 URL。
 */

function withQuery(base: string, params: URLSearchParams): string {
  const url = new URL(base);
  for (const [k, v] of params) url.searchParams.set(k, v);
  return url.toString();
}

/** CAS 的 service 参数：回调地址 + 本次授权的 state，必须两端逐字一致 */
function casService(callbackUrl: string, state: string): string {
  const sep = callbackUrl.includes('?') ? '&' : '?';
  return `${callbackUrl}${sep}state=${encodeURIComponent(state)}`;
}

/** OIDC 的端点解析（可能在 buildAuthorizeUrl 之前异步完成） */
export async function resolveEndpoints(provider: AuthProvider): Promise<Partial<OidcMetadata>> {
  if (provider.type !== 'oidc') return {};
  const cfg = decryptConfig(provider.type, provider.config) as OidcConfig;
  if (cfg.discovery) {
    const meta = await discover(cfg.issuer);
    return { ...meta, authorization_endpoint: cfg.authorizeUrl || meta.authorization_endpoint };
  }
  return {
    issuer: cfg.issuer,
    authorization_endpoint: cfg.authorizeUrl!,
    token_endpoint: cfg.tokenUrl!,
    userinfo_endpoint: cfg.userinfoUrl,
    jwks_uri: cfg.jwksUri!,
  };
}

export async function startFlow(provider: AuthProvider, input: StartInput): Promise<StartResult> {
  if (provider.type === 'oidc') {
    const cfg = decryptConfig(provider.type, provider.config) as OidcConfig;
    if (cfg.discovery && !cfg.authorizeUrl) {
      const meta = await discover(cfg.issuer);
      const patched: AuthProvider = {
        ...provider,
        config: { ...provider.config, authorizeUrl: meta.authorization_endpoint } as any,
      };
      return buildAuthorizeUrl(patched, input);
    }
  }
  return buildAuthorizeUrl(provider, input);
}

/* ---------------------------------------------------------- callback */
export interface CallbackInput {
  code?: string;
  state?: string;
  ticket?: string;
  callbackUrl: string;
}

export interface CallbackResult {
  session: SsoSession;
  returnTo: string;
  appOrigin: string;
}

export async function handleCallback(provider: AuthProvider, input: CallbackInput, row: AuthState): Promise<CallbackResult> {
  // state 由调用方 consumeState() 一次性取走；这里再校验归属，防止 A 源的回调被塞进 B 源
  if (row.providerId !== provider.id) throw new Error('Authentication state does not belong to this provider');

  const cfg = decryptConfig(provider.type, provider.config);
  // 回调时用「发起时记录的」redirect_uri：两者不一致，IdP 会直接拒绝换 code
  const redirectUri = row.callbackUrl || input.callbackUrl;
  let profile: SsoProfile;

  if (provider.type === 'cas') {
    profile = await validateCas(cfg as CasConfig, String(input.ticket || ''), casService(redirectUri, row.id));
  } else {
    const code = String(input.code || '');
    if (!code) throw new Error('Authorization code is missing');

    const endpoints = await resolveEndpoints(provider);
    const tokenUrl = (cfg as OAuth2Config).tokenUrl || endpoints.token_endpoint;
    if (!tokenUrl) throw new Error('Token endpoint is not configured');

    const kind = provider.type as 'oauth2' | 'oidc';
    const tokens = await exchangeCode(kind, cfg, endpoints, code, redirectUri, row.verifier);
    profile = await resolveProfile(kind, cfg, endpoints, tokens, row.nonce);
  }

  if (!profile.subject) throw new Error('Identity provider did not return a subject');

  const email = String(profile.email || '').trim().toLowerCase();
  if (provider.allowedDomains.length) {
    const domain = email.split('@')[1] || '';
    if (!provider.allowedDomains.includes(domain)) {
      throw new Error(`Email domain "${domain}" is not allowed by this provider`);
    }
  }

  const outcome = provisionUser(provider, profile);
  const session = issueSession(outcome.userId);
  const role = members.roleOf(provider.projectId, outcome.userId);

  db.prepare('UPDATE authIdentities SET lastLoginAt=? WHERE providerId=? AND subject=?')
    .run(now(), provider.id, profile.subject);

  return {
    session: {
      ...session,
      provider: provider.name,
      role,
      joined: outcome.joined,
      isNewUser: outcome.isNewUser,
    },
    returnTo: safeReturnTo(row.returnTo),
    appOrigin: row.appOrigin || '',
  };
}

/* ------------------------------------------------------------ tokens */
async function exchangeCode(
  type: 'oauth2' | 'oidc',
  cfg: any,
  endpoints: Partial<OidcMetadata>,
  code: string,
  redirectUri: string,
  verifier: string | null,
): Promise<Record<string, any>> {
  const tokenUrl = cfg.tokenUrl || endpoints.token_endpoint;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
  });
  if (verifier) body.set('code_verifier', verifier);

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  // 有的服务端只认 Basic（RFC 6749 §2.3.1），有的只认表单字段；按配置走，默认 post
  if (cfg.clientSecret) {
    if (cfg.tokenAuth === 'basic') headers.authorization = basicAuth(cfg.clientId, cfg.clientSecret);
    else body.set('client_secret', cfg.clientSecret);
  }

  const res = await fetch(tokenUrl, {
    method: 'POST', headers, body,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token endpoint rejected the code (${res.status}): ${text.slice(0, 200)}`);
  try { return JSON.parse(text); }
  catch { throw new Error('Token endpoint did not return JSON'); }
}

async function resolveProfile(
  type: 'oauth2' | 'oidc',
  cfg: any,
  endpoints: Partial<OidcMetadata>,
  tokens: Record<string, any>,
  nonce: string | null,
): Promise<SsoProfile> {
  let claims: Record<string, any> = {};
  let verified = false;

  if (type === 'oidc' && tokens.id_token) {
    claims = await verifyIdToken(String(tokens.id_token), {
      jwksUri: endpoints.jwks_uri || cfg.jwksUri,
      issuer: endpoints.issuer || cfg.issuer,
      audience: cfg.clientId,
      nonce: nonce || undefined,
    });
    verified = claims.email_verified === true;
  }

  // userinfo 往往比 id_token 多出 name / email；拿不到就退回 claims
  const userinfoUrl = cfg.userinfoUrl || endpoints.userinfo_endpoint;
  if (userinfoUrl && tokens.access_token) {
    try {
      const info = await fetchUserinfo(userinfoUrl, String(tokens.access_token));
      // sub 以 id_token 为准：userinfo 的 sub 理论上相同，但不该由它决定账号绑定
      claims = { ...claims, ...info, sub: claims.sub ?? info.sub };
      if (info.email_verified === true) verified = true;
    } catch (e) {
      if (type === 'oidc' && Object.keys(claims).length) {
        // 已经有验签过的 id_token，userinfo 失败不致命
      } else throw e;
    }
  }

  const emailField = cfg.emailField || 'email';
  const nameField = cfg.nameField || 'name';
  const subject = String(claims.sub ?? claims[cfg.idField || 'sub'] ?? claims.id ?? '');
  const rawEmail = claims[emailField];
  const email = String(rawEmail ?? '');
  const display = claims[nameField] ?? claims.preferred_username ?? claims.username ?? email.split('@')[0] ?? '';
  const name = String(display || '');

  // OIDC 里只有 email_verified=true 才允许「按邮箱并入已有账号」；
  // OAuth2 没有这个声明，默认不并（除非管理员显式打开 trustEmail）
  return { subject, email, emailVerified: verified, name: name || email, raw: claims };
}

async function fetchUserinfo(url: string, accessToken: string): Promise<Record<string, any>> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!res.ok) throw new Error(`Userinfo endpoint returned ${res.status}`);
  return (await res.json()) as Record<string, any>;
}

/* --------------------------------------------------------------- CAS */
async function validateCas(cfg: CasConfig, ticket: string, service: string): Promise<SsoProfile> {
  if (!ticket) throw new Error('CAS ticket is missing');
  const base = cfg.version === '3' ? `${cfg.serverUrl}/p3/serviceValidate` : `${cfg.serverUrl}/serviceValidate`;
  const url = new URL(base);
  url.searchParams.set('service', service);
  url.searchParams.set('ticket', ticket);
  if (cfg.version === '3') url.searchParams.set('format', 'JSON');

  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  const text = await res.text();
  if (!res.ok) throw new Error(`CAS validation failed (${res.status})`);

  let user = '';
  const attrs: Record<string, string[]> = {};

  const failMatch = text.match(/<cas:authenticationFailure[^>]*code="([^"]*)"[^>]*>([\s\S]*?)<\/cas:authenticationFailure>/i);
  if (failMatch) throw new Error(`CAS rejected the ticket: ${unescapeXml(failMatch[2].trim())} (${failMatch[1]})`);

  if (cfg.version === '3' && text.trim().startsWith('{')) {
    const doc = JSON.parse(text);
    const svc = doc?.serviceResponse;
    if (svc?.authenticationFailure) {
      throw new Error(`CAS rejected the ticket: ${svc.authenticationFailure.code || ''}`);
    }
    const success = svc?.authenticationSuccess || {};
    user = String(success.user || '');
    for (const [k, v] of Object.entries(success.attributes || {})) {
      attrs[k] = Array.isArray(v) ? (v as any[]).map(String) : [String(v)];
    }
  } else {
    const userMatch = text.match(/<cas:user[^>]*>([\s\S]*?)<\/cas:user>/i);
    if (!userMatch) throw new Error('CAS response did not contain a user');
    user = unescapeXml(userMatch[1].trim());
    const attrsBlock = text.match(/<cas:attributes>([\s\S]*?)<\/cas:attributes>/i);
    if (attrsBlock) {
      for (const m of attrsBlock[1].matchAll(/<cas:([\w.-]+)(?:\s[^>]*)?>([\s\S]*?)<\/cas:\1>/gi)) {
        (attrs[m[1]] ||= []).push(unescapeXml(m[2].trim()));
      }
    }
  }

  if (!user) throw new Error('CAS did not return a username');

  const email = attrs[cfg.emailAttribute || 'mail']?.[0]
    // 没有 mail 属性时合成一个稳定地址：CAS 只保证用户名唯一，用它做主键更可靠
    || `${user}@${new URL(cfg.serverUrl).hostname}`;
  const name = attrs[cfg.nameAttribute || 'displayName']?.[0] || user;

  return { subject: user, email, emailVerified: true, name, raw: { user, ...attrs } };
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/* -------------------------------------------------------------- LDAP */
export async function handleLdapLogin(provider: AuthProvider, username: string, password: string): Promise<SsoSession> {
  const cfg = decryptConfig(provider.type, provider.config) as LdapConfigStored;
  const profile = await ldapAuthenticate(cfg, username, password);

  if (provider.allowedDomains.length && profile.email) {
    const domain = profile.email.split('@')[1] || '';
    if (!provider.allowedDomains.includes(domain)) throw new Error(`Email domain "${domain}" is not allowed`);
  }
  if (!profile.email) throw new Error('Directory entry has no email attribute — check the attribute mapping');

  const outcome = provisionUser(provider, {
    subject: profile.subject, email: profile.email, emailVerified: true,
    name: profile.name, raw: profile.raw,
  });
  const session = issueSession(outcome.userId);
  db.prepare('UPDATE authIdentities SET lastLoginAt=? WHERE providerId=? AND subject=?')
    .run(now(), provider.id, profile.subject);

  return {
    ...session, provider: provider.name,
    role: members.roleOf(provider.projectId, outcome.userId),
    joined: outcome.joined, isNewUser: outcome.isNewUser,
  };
}

/* --------------------------------------------------------- provisioning */
interface Provisioned { userId: string; isNewUser: boolean; joined: boolean }

/**
 * 外部身份 → 本地用户。
 *
 * 绑定顺序：先看 (providerId, subject)，再看邮箱。
 * 「按邮箱并入已有账号」只在 IdP 明确保证邮箱已验证时允许 ——
 * 否则任何人注册一个 `admin@corp.com` 的账号，就能接管本地同名的管理员。
 */
function provisionUser(provider: AuthProvider, profile: SsoProfile): Provisioned {
  const email = profile.email.toLowerCase();

  const identity = db.prepare(
    'SELECT * FROM authIdentities WHERE providerId=? AND subject=?',
  ).get(provider.id, profile.subject) as any;

  let userId = identity?.userId as string | undefined;
  let isNewUser = false;

  if (userId && !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) {
    // 本地用户被删了：身份映射成了孤儿，清掉重新走一遍
    db.prepare('DELETE FROM authIdentities WHERE id=?').run(identity.id);
    userId = undefined;
  }

  if (!userId) {
    const existing = email ? db.prepare('SELECT * FROM users WHERE email=?').get(email) as any : null;

    if (existing) {
      // trustEmail 是管理员对企业目录的显式信任声明；OIDC 则要求 email_verified
      const canLink = provider.trustEmail && (profile.emailVerified || provider.type !== 'oidc');
      if (!canLink) {
        throw new Error(
          'An account with this email already exists. Sign in with your password first, then link the provider, '
          + 'or ask the identity provider to assert a verified email.',
        );
      }
      userId = existing.id;
    } else {
      userId = uid('usr_');
      db.prepare(
        `INSERT INTO users (id,name,email,passwordHash,status,emailVerified,labels,prefs,createdAt,lastLoginAt)
         VALUES (?,?,?,NULL,'active',?,?,?,?,?)`,
      ).run(
        userId, profile.name || email || profile.subject, email,
        profile.emailVerified ? 1 : 0,
        JSON.stringify(['sso', provider.type]), '{}', now(), now(),
      );
      isNewUser = true;
    }

    db.prepare(
      'INSERT INTO authIdentities (id,userId,providerId,subject,email,data,lastLoginAt,createdAt) VALUES (?,?,?,?,?,?,?,?)',
    ).run(uid('idt_'), userId, provider.id, profile.subject, email, JSON.stringify(profile.raw), now(), now());
  } else {
    db.prepare('UPDATE users SET lastLoginAt=?, emailVerified=MAX(COALESCE(emailVerified,0),?) WHERE id=?')
      .run(now(), profile.emailVerified ? 1 : 0, userId!);
  }

  const localUserId = userId!;
  let joined = false;
  if (!members.roleOf(provider.projectId, localUserId) && provider.defaultRole) {
    try {
      members.addMember(provider.projectId, { userId: localUserId, role: provider.defaultRole });
      joined = true;
    } catch { /* 并发首登时可能刚好被另一个请求加进去，忽略 */ }
  }

  bus.publish({ type: 'auth', action: isNewUser ? 'sso.signup' : 'sso.login', resource: provider.name });
  return { userId: localUserId, isNewUser, joined };
}

/** 给管理界面用：某个身份源下已绑定多少账号 */
export function identityCount(providerId: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM authIdentities WHERE providerId=?').get(providerId) as any).c;
}
