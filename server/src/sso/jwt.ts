import crypto from 'node:crypto';

/**
 * OIDC 的 id_token 校验，零依赖。
 *
 * 只接受非对称算法：`alg: none` 和 HS256 都是经典的签名绕过手法
 * （把公钥当 HMAC 密钥用，或者干脆不签名），这里一律拒绝。
 */

export interface JwtParts {
  header: Record<string, any>;
  payload: Record<string, any>;
  signingInput: string;
  signature: Buffer;
}

export function decodeJwt(token: string): JwtParts {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const json = (s: string) => {
    try { return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); }
    catch { throw new Error('Malformed id_token payload'); }
  };
  return {
    header: json(parts[0]),
    payload: json(parts[1]),
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url'),
  };
}

const ALGS: Record<string, { hash: string; pss?: boolean; ec?: boolean }> = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true }, PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
};

export interface Jwk { kty: string; kid?: string; use?: string; alg?: string; n?: string; e?: string; crv?: string; x?: string; y?: string }

export function verifySignature(token: string, jwk: Jwk): boolean {
  const { header, signingInput, signature } = decodeJwt(token);
  const spec = ALGS[String(header.alg)];
  if (!spec) return false;                       // none / HS* / 未知算法：直接不接受
  if (jwk.alg && jwk.alg !== header.alg) return false;

  let key: crypto.KeyObject;
  try { key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' }); }
  catch { return false; }

  try {
    const opts: crypto.VerifyKeyObjectInput = { key };
    if (spec.pss) {
      opts.padding = crypto.constants.RSA_PKCS1_PSS_PADDING;
      opts.saltLength = crypto.constants.RSA_PSS_SALTLEN_DIGEST;
    }
    if (spec.ec) opts.dsaEncoding = 'ieee-p1363';
    return crypto.verify(spec.hash, Buffer.from(signingInput), opts, signature);
  } catch { return false; }
}

/* --------------------------------------------------------------- caches */
interface Cached<T> { value: T; at: number }
const TTL = 10 * 60_000;
const cache = new Map<string, Cached<unknown>>();

export async function fetchJson<T = any>(url: string, timeoutMs = 8000): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Cached<T> | undefined;
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await load();
  cache.set(key, { value, at: Date.now() });
  return value;
}

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
}

/** `.well-known/openid-configuration`，按 issuer 缓存；显式 issuer 必须与文档一致（防混合攻击） */
export async function discover(issuer: string): Promise<OidcMetadata> {
  const base = issuer.replace(/\/+$/, '');
  const doc = await cached(`disc:${base}`, () =>
    fetchJson<OidcMetadata>(`${base}/.well-known/openid-configuration`));
  if (doc.issuer && doc.issuer.replace(/\/+$/, '') !== base) {
    throw new Error(`Discovery issuer mismatch: expected ${base}, got ${doc.issuer}`);
  }
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new Error('Discovery document is missing authorization/token endpoints');
  }
  return doc;
}

export async function getJwks(uri: string, kid?: string): Promise<Jwk[]> {
  const load = async () => {
    const doc = await fetchJson<{ keys: Jwk[] }>(uri);
    return Array.isArray(doc.keys) ? doc.keys : [];
  };
  const keys = await cached(`jwks:${uri}`, load);
  if (kid && !keys.some((k) => k.kid === kid)) {
    // 密钥轮换：缓存里没有这个 kid 时强制刷新一次
    cache.delete(`jwks:${uri}`);
    return cached(`jwks:${uri}`, load);
  }
  return keys;
}

export interface VerifyOptions {
  jwksUri?: string;
  jwks?: Jwk[];
  issuer?: string;
  audience?: string;
  nonce?: string;
  /** 允许的时钟偏移（秒） */
  clockSkew?: number;
}

/**
 * 校验签名 + 标准声明。任何一项不满足都抛错，调用方**不得**吞掉后继续用 payload。
 */
export async function verifyIdToken(token: string, opts: VerifyOptions): Promise<Record<string, any>> {
  const { header, payload } = decodeJwt(token);
  if (!ALGS[String(header.alg)]) throw new Error(`Unsupported id_token algorithm: ${header.alg}`);

  const keys = opts.jwksUri ? await getJwks(opts.jwksUri, header.kid) : opts.jwks || [];
  const pick = () => keys.filter((k) => (!k.use || k.use === 'sig') && (!header.kid || !k.kid || k.kid === header.kid));
  let candidates = pick();
  if (!candidates.length) throw new Error('No matching signing key for id_token');

  if (!candidates.some((k) => verifySignature(token, k))) {
    // 服务端换了密钥但 kid 没变（或本地缓存比轮换旧）：强制刷新一次再验。
    // 只重试一次，不能让一个伪造 token 变成无限拉 JWKS 的杠杆。
    if (!opts.jwksUri) throw new Error('Invalid id_token signature');
    cache.delete(`jwks:${opts.jwksUri}`);
    const fresh = await getJwks(opts.jwksUri, header.kid);
    candidates = fresh.filter((k) => (!k.use || k.use === 'sig') && (!header.kid || !k.kid || k.kid === header.kid));
    if (!candidates.some((k) => verifySignature(token, k))) throw new Error('Invalid id_token signature');
  }

  const skew = (opts.clockSkew ?? 60) * 1000;
  const nowMs = Date.now();
  if (opts.issuer && String(payload.iss || '').replace(/\/+$/, '') !== opts.issuer.replace(/\/+$/, '')) {
    throw new Error(`Unexpected id_token issuer: ${payload.iss}`);
  }
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (opts.audience && !aud.includes(opts.audience)) throw new Error('id_token audience mismatch');
  if (typeof payload.exp !== 'number' || payload.exp * 1000 + skew < nowMs) throw new Error('id_token has expired');
  if (typeof payload.iat === 'number' && payload.iat * 1000 - skew > nowMs + 60_000) {
    throw new Error('id_token was issued in the future');
  }
  // nonce 把 id_token 绑到本次授权请求上，缺了它就可以被重放到别的会话里
  if (opts.nonce && payload.nonce !== opts.nonce) throw new Error('id_token nonce mismatch');
  return payload;
}

/** PKCE：S256 challenge */
export const pkceChallenge = (verifier: string) =>
  crypto.createHash('sha256').update(verifier).digest('base64url');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function clearJwksCache() {
  for (const k of cache.keys()) if (k.startsWith('jwks:')) cache.delete(k);
}
