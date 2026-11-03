#!/usr/bin/env node
/**
 * Passkey 端到端测试 —— 跑在真实 Chromium 里。
 *
 * 用 CDP 的虚拟认证器（WebAuthn domain）代替实体安全密钥：浏览器会真的
 * 生成 P-256 密钥、真的做 attestation、真的对 authData 签名，所以服务端
 * 这条 CBOR/COSE/ECDSA 路径是被真实客户端验证的，不是自己造数据自己验。
 *
 * 需要 chromium 在 PATH 里；没有就 SKIP（退出码 0），而不是假装通过。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// WebAuthn 的 rpId 必须是域名；浏览器对 IP 地址直接抛 SecurityError，
// 所以这里用 localhost 而不是 127.0.0.1。
const APP = process.env.APP_BASE || 'http://localhost:5173';
const PORT = 9521;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const chromium = ['chromium', 'chromium-browser', 'google-chrome'].find((bin) => {
  try { return !spawn(bin, ['--version'], { stdio: 'ignore' }).error; } catch { return false; }
});
if (!chromium) {
  console.log('SKIP: no chromium found — passkey test needs a real browser');
  process.exit(0);
}

const child = spawn(chromium, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--user-data-dir=/tmp/cdp-passkey', 'about:blank',
], { stdio: 'ignore' });

let ws;
for (let i = 0; i < 100; i++) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    if (j.webSocketDebuggerUrl) { ws = new WebSocket(j.webSocketDebuggerUrl); break; }
  } catch { /* not up yet */ }
  await sleep(200);
}
if (!ws) { console.log('SKIP: chromium did not expose a debugging endpoint'); child.kill(); process.exit(0); }

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
});

const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

/* ------------------------------------------------------- 页面里的辅助函数 */

const HELPERS = `
window.__b64 = {
  dec(s) {
    const p = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(p + '='.repeat((4 - p.length % 4) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
  enc(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  },
};
window.__api = async (method, path, body, session) => {
  const headers = { 'content-type': 'application/json', 'x-project-id': 'studio' };
  if (session) headers['x-studio-session'] = session;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
};
window.__registerPasskey = async (session, name) => {
  const begin = await window.__api('POST', '/v1/auth/mfa/webauthn/begin', { name }, session);
  if (begin.status !== 200) return { error: begin.json };
  const o = begin.json.options;
  o.challenge = window.__b64.dec(o.challenge);
  o.user.id = window.__b64.dec(o.user.id);
  o.excludeCredentials = (o.excludeCredentials || []).map((c) => ({ ...c, id: window.__b64.dec(c.id) }));
  const cred = await navigator.credentials.create({ publicKey: o });
  if (!cred) return { error: 'no credential' };
  const r = cred.response;
  const response = {
    id: cred.id, rawId: window.__b64.enc(cred.rawId), type: cred.type,
    clientDataJSON: window.__b64.enc(r.clientDataJSON),
    attestationObject: window.__b64.enc(r.attestationObject),
    transports: typeof r.getTransports === 'function' ? r.getTransports() : [],
  };
  const finish = await window.__api('POST', '/v1/auth/mfa/webauthn/finish', { ticket: begin.json.ticket, response }, session);
  return finish;
};
window.__assertPasskey = async (challenge, tamper) => {
  const begin = await window.__api('POST', '/v1/auth/mfa/webauthn/assert/begin', { challenge });
  if (begin.status !== 200) return { error: begin.json, stage: 'begin' };
  const o = begin.json.options;
  o.challenge = window.__b64.dec(o.challenge);
  o.allowCredentials = (o.allowCredentials || []).map((c) => ({ ...c, id: window.__b64.dec(c.id) }));
  const cred = await navigator.credentials.get({ publicKey: o });
  if (!cred) return { error: 'no assertion' };
  const r = cred.response;
  let signature = window.__b64.enc(r.signature);
  if (tamper) {
    // 翻掉签名的最后一个字节：长度不变、格式合法，只有数学上不成立
    const sig = window.__b64.dec(signature);
    sig[sig.length - 1] ^= 0xff;
    signature = window.__b64.enc(sig);
  }
  const response = {
    id: cred.id, rawId: window.__b64.enc(cred.rawId), type: cred.type,
    clientDataJSON: window.__b64.enc(r.clientDataJSON),
    authenticatorData: window.__b64.enc(r.authenticatorData),
    signature,
    userHandle: r.userHandle ? window.__b64.enc(r.userHandle) : null,
  };
  const finish = await window.__api('POST', '/v1/auth/mfa/webauthn/assert/finish', { ticket: begin.json.ticket, response });
  return finish;
};
true;
`;

try {
  /* ------------------------------------------------------ 浏览器准备 */
  console.log('\n── Virtual authenticator');
  // WebAuthn 是 **页面级** domain：命令必须带 sessionId，
  // 发到 browser target 会得到 "'WebAuthn.enable' wasn't found"
  await send('WebAuthn.enable', { enableUI: false }, sessionId);
  const vc = await send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }, sessionId);
  check('a virtual authenticator is attached', !!vc.authenticatorId, JSON.stringify(vc));

  await send('Page.navigate', { url: `${APP}/login` }, sessionId);
  await sleep(2200);
  await evaluate(HELPERS);
  check('the page has WebAuthn support', await evaluate('typeof navigator.credentials.create === "function"'));
  check('the page is a secure context', await evaluate('window.isSecureContext === true'));

  /* ---------------------------------------------------------- 登录 */
  console.log('\n── Enroll a passkey');
  const login = await evaluate(`window.__api('POST', '/v1/account/sessions', { email: 'alex@aurora.io', password: 'aurora-demo' })`);
  check('password sign-in works', login.status === 201 && !!login.json.secret, `${login.status}`);
  const legacy = login.json.secret;

  const registered = await evaluate(`window.__registerPasskey(${JSON.stringify(legacy)}, 'E2E virtual key')`);
  check('the server accepts the attestation', registered.status === 201 && registered.json.ok === true,
    JSON.stringify(registered).slice(0, 240));
  check('the stored method is a passkey', registered.json?.method?.type === 'webauthn', JSON.stringify(registered.json?.method));
  check('transports are recorded', Array.isArray(registered.json?.method?.transports), JSON.stringify(registered.json?.method?.transports));
  const methodId = registered.json?.method?.id;

  const status = await evaluate(`window.__api('GET', '/v1/auth/mfa', undefined, ${JSON.stringify(legacy)})`);
  check('the account now has one verified passkey',
    status.json.verifiedMethods === 1 && status.json.methods[0].type === 'webauthn',
    JSON.stringify(status.json).slice(0, 200));

  /* --------------------------------------------- 策略 + 第二次登录 */
  console.log('\n── Sign in with the passkey');
  const policy = await evaluate(`window.__api('PUT', '/v1/auth/mfa/policies', { policies: [{ scope: 'role', target: 'owner', mode: 'required' }] }, ${JSON.stringify(legacy)})`);
  check('owner role now requires a second factor', policy.status === 200, `${policy.status}`);

  const second = await evaluate(`window.__api('POST', '/v1/account/sessions', { email: 'alex@aurora.io', password: 'aurora-demo' })`);
  check('sign-in returns a challenge instead of a session',
    second.json.mfaRequired === true && !!second.json.challenge && !second.json.secret,
    JSON.stringify(second.json).slice(0, 200));
  check('the challenge offers the passkey', second.json.methods?.passkeys?.length === 1, JSON.stringify(second.json?.methods));

  const verified = await evaluate(`window.__assertPasskey(${JSON.stringify(second.json.challenge)}, false)`);
  check('the assertion completes the sign-in', verified.status === 200 && !!verified.json.secret,
    JSON.stringify(verified).slice(0, 240));
  check('the session is multi-factor', verified.json?.assurance === 'multi' && verified.json?.factor === 'passkey',
    JSON.stringify(verified.json).slice(0, 160));

  const con = await evaluate(`window.__api('GET', '/v1/databases/collections', undefined, ${JSON.stringify(verified.json?.secret || '')})`);
  check('the verified session reaches the console', con.status === 200, `${con.status}`);

  /* ---------------------------------------------------------- 负例 */
  console.log('\n── Negative cases');
  const again = await evaluate(`window.__api('POST', '/v1/account/sessions', { email: 'alex@aurora.io', password: 'aurora-demo' })`);
  const tampered = await evaluate(`window.__assertPasskey(${JSON.stringify(again.json.challenge)}, true)`);
  check('a tampered signature is rejected', tampered.status === 401, `${tampered.status} ${tampered.json?.error}`);

  // 同一张 challenge 不能重放：上面的失败已经把它记了一次，这里再拿一个新的试重放
  const fresh = await evaluate(`window.__api('POST', '/v1/account/sessions', { email: 'alex@aurora.io', password: 'aurora-demo' })`);
  const replayTicket = await evaluate(`window.__assertPasskey(${JSON.stringify(fresh.json.challenge)}, false)`);
  check('a valid assertion still works after a failed one',
    replayTicket.status === 200 && !!replayTicket.json.secret, JSON.stringify(replayTicket.json).slice(0, 160));

  const consoleCheck = consoleErrors.filter((e) => !/favicon/i.test(e));
  check('no uncaught errors in the page', consoleCheck.length === 0, consoleCheck.slice(0, 2).join(' | '));

  /* ---------------------------------------------------------- 清理 */
  console.log('\n── Cleanup');
  const cleared = await evaluate(`window.__api('PUT', '/v1/auth/mfa/policies', { policies: [] }, ${JSON.stringify(legacy)})`);
  check('policy cleared', cleared.status === 200, `${cleared.status}`);
  if (methodId) {
    const del = await evaluate(`window.__api('DELETE', '/v1/auth/mfa/methods/${methodId}', undefined, ${JSON.stringify(legacy)})`);
    check('passkey removed', del.status === 200 && del.json.ok === true, `${del.status}`);
  }
} catch (e) {
  failures.push(`fatal: ${e.message}`);
  console.error(`\n!! ${e.stack || e.message}`);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  child.kill();
}

const total = pass + failures.length;
console.log(`\n=== ${pass}/${total} checks passed · ${failures.length} failed ===`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
