/**
 * 浏览器端的 WebAuthn 胶水层。
 *
 * 服务端返回的 options 里，所有二进制字段都是 base64url 文本（JSON 没有
 * 字节类型），而 `navigator.credentials` 要的是 ArrayBuffer。这里负责
 * 两个方向的转换，顺便把返回的 credential 拍平成可 POST 的 JSON。
 *
 * 这里刻意不做任何「降级」：不支持 WebAuthn 的浏览器就不显示 Passkey 按钮，
 * 而不是偷偷退回只输密码 —— 那会让用户以为自己开了第二因素。
 */

/**
 * 除了 API 存在，还要求当前主机名是域名：WebAuthn 不接受 IP，
 * 用 IP 打开控制台时按钮会点了报错，不如不显示。
 * localhost 是规范允许的特例，所以单列。
 */
function isIpHost(host: string): boolean {
  if (!host) return true;
  if (host.includes(':')) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export function passkeysSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.PublicKeyCredential === 'undefined') return false;
  if (typeof navigator.credentials?.create !== 'function') return false;
  const host = window.location.hostname;
  return host === 'localhost' || !isIpHost(host);
}

function toBuf(value: string): Uint8Array {
  const s = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function fromBuf(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 把服务端的 creation options 转成 create() 认识的形状 */
function hydrateCreation(options: any): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: toBuf(options.challenge),
    user: { ...options.user, id: toBuf(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((c: any) => ({ ...c, id: toBuf(c.id) })),
  };
}

function hydrateRequest(options: any): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: toBuf(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((c: any) => ({ ...c, id: toBuf(c.id) })),
  };
}

export interface SerializedCredential {
  id: string;
  rawId: string;
  type: string;
  clientDataJSON: string;
  attestationObject?: string;
  authenticatorData?: string;
  signature?: string;
  userHandle?: string | null;
  transports?: string[];
  attachment?: string;
}

export async function createPasskey(options: any): Promise<SerializedCredential> {
  const cred = await navigator.credentials.create({ publicKey: hydrateCreation(options) }) as PublicKeyCredential | null;
  if (!cred) throw new Error('The authenticator did not return a credential');
  const res = cred.response as AuthenticatorAttestationResponse;

  const transports = typeof res.getTransports === 'function' ? res.getTransports() : [];
  return {
    id: cred.id,
    rawId: fromBuf(cred.rawId),
    type: cred.type,
    clientDataJSON: fromBuf(res.clientDataJSON),
    attestationObject: fromBuf(res.attestationObject),
    transports,
    attachment: (cred as any).authenticatorAttachment || undefined,
  };
}

export async function getAssertion(options: any): Promise<SerializedCredential> {
  const cred = await navigator.credentials.get({ publicKey: hydrateRequest(options) }) as PublicKeyCredential | null;
  if (!cred) throw new Error('The authenticator did not return an assertion');
  const res = cred.response as AuthenticatorAssertionResponse;

  return {
    id: cred.id,
    rawId: fromBuf(cred.rawId),
    type: cred.type,
    clientDataJSON: fromBuf(res.clientDataJSON),
    authenticatorData: fromBuf(res.authenticatorData),
    signature: fromBuf(res.signature),
    userHandle: res.userHandle ? fromBuf(res.userHandle) : null,
    attachment: (cred as any).authenticatorAttachment || undefined,
  };
}

/** 把 WebAuthn 的 DOMException 翻成人话；用户最常遇到的是「取消」和「超时」 */
export function explainWebauthnError(e: any): string {
  const name = e?.name || '';
  if (name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out. Try again and approve it on your device.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (name === 'NotSupportedError') return 'This browser or device cannot create a passkey.';
  if (name === 'SecurityError') return 'Passkeys need HTTPS (or localhost) — check the address you are using.';
  return e?.message || String(e);
}
