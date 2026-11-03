import crypto from 'node:crypto';
import { cborBytes, cborInt, cborMap, cborText, decodeCbor, type CborValue } from './cbor.js';

/**
 * WebAuthn / Passkey 的服务端一半。
 *
 * 浏览器负责生成密钥、签名；服务端要做的三件事：
 *   1. 确认 clientDataJSON 里的 challenge 和 origin 是**我们**发的那个；
 *   2. 从 authData 里取出 COSE 公钥，转成 Node 能用的 KeyObject；
 *   3. 认证时用这把公钥验 `authData || sha256(clientDataJSON)`。
 *
 * 只支持 attestation = none / packed 的公钥提取，不做证书链验证：
 * 控制台不是需要证明「认证器型号」的场景，验了也只会让自签设备装不上。
 * 真正的信任来自「这把公钥是用户登录后亲手注册的」。
 */

export interface RegistrationResponse {
  id: string;
  rawId: string;
  type: string;
  clientDataJSON: string;
  attestationObject: string;
  transports?: string[];
  /** 'platform' | 'cross-platform'，仅用于界面展示 */
  attachment?: string;
}

export interface AssertionResponse {
  id: string;
  rawId: string;
  type: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle?: string | null;
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  algorithm: number;
  counter: number;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

const b64u = (b: Buffer) => b.toString('base64url');

function fromB64u(s: string): Buffer {
  if (typeof s !== 'string' || !s) throw new Error('Missing base64url data');
  return Buffer.from(s, 'base64url');
}

/* ------------------------------------------------------------------ client */

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

/**
 * clientDataJSON 是浏览器写的，内容我们不能改，但必须逐条核对。
 * `type` 防「拿注册的签名去登录」，`challenge` 防重放，`origin` 防钓鱼站点
 * 拿着自己的 challenge 骗用户签名。
 */
function checkClientData(raw: string, expected: { type: string; challenge: string; origin: string }): ClientData {
  let data: ClientData;
  try {
    data = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new Error('clientDataJSON is not valid JSON');
  }
  if (data.type !== expected.type) throw new Error(`Unexpected ceremony type "${data.type}"`);
  if (data.origin !== expected.origin) throw new Error(`Origin "${data.origin}" does not match "${expected.origin}"`);
  // challenge 在 JSON 里是 base64url 文本；两边都解码成字节再比，避免填充差异
  const got = fromB64u(data.challenge);
  const want = fromB64u(expected.challenge);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    throw new Error('Challenge does not match the one we issued');
  }
  return data;
}

/* ----------------------------------------------------------------- authData */

interface ParsedAuthData {
  rpIdHash: Buffer;
  flags: number;
  counter: number;
  aaguid?: string;
  credentialId?: Buffer;
  coseKey?: CborValue;
}

function parseAuthData(buf: Buffer): ParsedAuthData {
  if (buf.length < 37) throw new Error('authenticatorData is too short');
  const out: ParsedAuthData = {
    rpIdHash: buf.subarray(0, 32),
    flags: buf[32],
    counter: buf.readUInt32BE(33),
  };
  let pos = 37;
  if (out.flags & FLAG_AT) {
    if (buf.length < pos + 18) throw new Error('authenticatorData is missing attested credential data');
    out.aaguid = buf.subarray(pos, pos + 16).toString('hex');
    const idLen = buf.readUInt16BE(pos + 16);
    pos += 18;
    if (buf.length < pos + idLen) throw new Error('authenticatorData credential id is truncated');
    out.credentialId = buf.subarray(pos, pos + idLen);
    pos += idLen;
    // 剩下的就是 COSE 公钥；后面可能还有 extensions（标志位 0x80），这里不解析
    out.coseKey = decodeCbor(buf.subarray(pos));
  }
  return out;
}

/* --------------------------------------------------------------- COSE → JWK */

interface CoseKeyInfo {
  jwk: crypto.JsonWebKey;
  algorithm: number;
  kty: 'EC' | 'RSA' | 'OKP';
}

/**
 * COSE Key（RFC 8152）→ JWK。
 *
 * 只接受非对称算法。`alg` 与我们支持的曲线必须一致：一张声明 ES256
 * 却给了 P-384 公钥的证书，验签必然失败，不如在注册时就说清楚。
 */
export function coseToJwk(cose: CborValue): CoseKeyInfo {
  const map = cborMap(cose, 'COSE key');
  const kty = cborInt(map.get(1), 'kty');

  if (kty === 2) {
    const crv = cborInt(map.get(-1), 'crv');
    const x = cborBytes(map.get(-2), 'x');
    const y = cborBytes(map.get(-3), 'y');
    const curves: Record<number, { name: string; alg: number; size: number }> = {
      1: { name: 'P-256', alg: -7, size: 32 },
      2: { name: 'P-384', alg: -35, size: 48 },
      3: { name: 'P-521', alg: -36, size: 66 },
    };
    const c = curves[crv];
    if (!c) throw new Error(`Unsupported EC curve ${crv}`);
    if (x.length !== c.size || y.length !== c.size) throw new Error(`EC point is not ${c.size} bytes`);
    return {
      jwk: { kty: 'EC', crv: c.name, x: b64u(x), y: b64u(y) },
      algorithm: c.alg,
      kty: 'EC',
    };
  }

  if (kty === 3) {
    const n = cborBytes(map.get(-1), 'n');
    const e = cborBytes(map.get(-2), 'e');
    return {
      jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) },
      algorithm: -257, // RS256：WebAuthn 里最常见的 RSA 选项
      kty: 'RSA',
    };
  }

  if (kty === 1) {
    const crv = cborInt(map.get(-1), 'crv');
    const x = cborBytes(map.get(-2), 'x');
    if (crv !== 6) throw new Error(`Unsupported OKP curve ${crv}`);
    return {
      jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(x) },
      algorithm: -8,
      kty: 'OKP',
    };
  }

  throw new Error(`Unsupported COSE key type ${kty}`);
}

function importPublicKey(jwk: crypto.JsonWebKey): crypto.KeyObject {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/* ------------------------------------------------------------- registration */

export interface RegistrationResult {
  credentialId: string;
  publicKey: string;
  algorithm: number;
  counter: number;
  transports: string[];
  aaguid: string | null;
}

export function verifyRegistration(input: {
  response: RegistrationResponse;
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
}): RegistrationResult {
  const { response } = input;
  if (response.type !== 'public-key') throw new Error('Unexpected credential type');

  checkClientData(response.clientDataJSON, {
    type: 'webauthn.create',
    challenge: input.expectedChallenge,
    origin: input.expectedOrigin,
  });

  const attestation = cborMap(decodeCbor(fromB64u(response.attestationObject)), 'attestationObject');
  const fmt = cborText(attestation.get('fmt'), 'fmt');
  if (fmt !== 'none' && fmt !== 'packed' && fmt !== 'fido-u2f' && fmt !== 'tpm' && fmt !== 'apple') {
    throw new Error(`Unsupported attestation format "${fmt}"`);
  }
  const authData = cborBytes(attestation.get('authData'), 'authData');
  const parsed = parseAuthData(authData);

  if (!(parsed.flags & FLAG_UP)) throw new Error('User presence flag was not set');
  if (!(parsed.flags & FLAG_AT)) throw new Error('Registration response has no attested credential');
  if (!parsed.credentialId || !parsed.coseKey) throw new Error('Registration response is missing the credential');

  const rpIdHash = crypto.createHash('sha256').update(input.rpId).digest();
  if (!rpIdHash.equals(parsed.rpIdHash)) {
    throw new Error(`Credential was created for relying party "${input.rpId}", not this host`);
  }

  const cose = coseToJwk(parsed.coseKey);
  // 先验证公钥真的能导入，避免存进去一个永远验不了签的垃圾
  importPublicKey(cose.jwk);

  const credentialId = b64u(parsed.credentialId);
  if (credentialId !== response.id && credentialId !== response.rawId) {
    // 两个字段都该是同一个 id 的 base64url；不一致说明客户端在拼数据
    const same = (a: string, b: string) => {
      try { return fromB64u(a).equals(fromB64u(b)); } catch { return false; }
    };
    if (!same(credentialId, response.id) && !same(credentialId, response.rawId)) {
      throw new Error('Credential id in authenticatorData does not match the response');
    }
  }

  return {
    credentialId,
    publicKey: JSON.stringify(cose.jwk),
    algorithm: cose.algorithm,
    counter: parsed.counter,
    transports: Array.isArray(response.transports) ? response.transports.filter((t) => typeof t === 'string') : [],
    aaguid: parsed.aaguid && parsed.aaguid !== '0'.repeat(32) ? parsed.aaguid : null,
  };
}

/* ------------------------------------------------------------- authentication */

export function verifyAssertion(input: {
  response: AssertionResponse;
  expectedChallenge: string;
  expectedOrigin: string;
  rpId: string;
  credential: StoredCredential;
}): { counter: number } {
  const { response, credential } = input;
  if (response.type !== 'public-key') throw new Error('Unexpected credential type');

  const rawId = fromB64u(response.rawId || response.id);
  if (b64u(rawId) !== credential.credentialId) throw new Error('This credential does not belong to the account');

  checkClientData(response.clientDataJSON, {
    type: 'webauthn.get',
    challenge: input.expectedChallenge,
    origin: input.expectedOrigin,
  });

  const authData = fromB64u(response.authenticatorData);
  const parsed = parseAuthData(authData);

  if (!(parsed.flags & FLAG_UP)) throw new Error('User presence flag was not set');

  const rpIdHash = crypto.createHash('sha256').update(input.rpId).digest();
  if (!rpIdHash.equals(parsed.rpIdHash)) throw new Error('Assertion is scoped to a different relying party');

  const clientHash = crypto.createHash('sha256').update(fromB64u(response.clientDataJSON)).digest();
  const signed = Buffer.concat([authData, clientHash]);

  const key = importPublicKey(JSON.parse(credential.publicKey) as crypto.JsonWebKey);
  const signature = fromB64u(response.signature);
  if (!verifySignature(key, credential.algorithm, signed, signature)) {
    throw new Error('Signature verification failed');
  }

  // 克隆检测：认证器每次签名都会递增计数器。存的和新的都是 0 表示这台设备
  // 不实现计数器（很多平台 passkey 就是这样），此时没法判断，放行。
  const prev = credential.counter || 0;
  if (prev > 0 || parsed.counter > 0) {
    if (parsed.counter <= prev) {
      throw new Error('Authenticator counter did not increase — the key may have been cloned');
    }
  }

  return { counter: parsed.counter };
}

function verifySignature(key: crypto.KeyObject, algorithm: number, data: Buffer, signature: Buffer): boolean {
  // WebAuthn 的 ECDSA 签名是 ASN.1 DER，正好是 Node 的默认格式；不要传 ieee-p1363
  const alg = algorithm === -7 ? 'sha256'
    : algorithm === -35 ? 'sha384'
    : algorithm === -36 ? 'sha512'
    : algorithm === -257 ? 'sha256'
    : algorithm === -258 ? 'sha384'
    : algorithm === -259 ? 'sha512'
    : algorithm === -8 ? null
    : null;

  try {
    if (algorithm === -8) return crypto.verify(null, data, key, signature);
    if (!alg) return false;
    return crypto.verify(alg, data, key, signature);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ options builders */

export function makeCreationOptions(input: {
  rpId: string;
  rpName: string;
  userId: string;
  userName: string;
  displayName: string;
  challenge: string;
  exclude: { credentialId: string; transports: string[] }[];
}) {
  return {
    rp: { id: input.rpId, name: input.rpName },
    // user.id 必须是字节串的 base64url；用本地 userId 的 utf8 就够，稳定且不泄露邮箱
    user: {
      id: Buffer.from(input.userId, 'utf8').toString('base64url'),
      name: input.userName,
      displayName: input.displayName,
    },
    challenge: input.challenge,
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
      { type: 'public-key', alg: -8 },
    ],
    timeout: 60_000,
    attestation: 'none',
    authenticatorSelection: {
      // residentKey=preferred：支持常驻密钥的设备会顺手做成 passkey，
      // 不支持的老密钥也还能用，不必二选一
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
    excludeCredentials: input.exclude.map((c) => ({
      type: 'public-key',
      id: c.credentialId,
      transports: c.transports,
    })),
  };
}

export function makeRequestOptions(input: {
  rpId: string;
  challenge: string;
  allow: { credentialId: string; transports: string[] }[];
}) {
  return {
    rpId: input.rpId,
    challenge: input.challenge,
    timeout: 60_000,
    userVerification: 'preferred',
    allowCredentials: input.allow.map((c) => ({
      type: 'public-key',
      id: c.credentialId,
      transports: c.transports,
    })),
  };
}

/** rpId 是域名，不是 origin：`https://a.example:8443` → `a.example` */
export function rpIdOf(origin: string): string {
  try { return new URL(origin).hostname; } catch { return ''; }
}
