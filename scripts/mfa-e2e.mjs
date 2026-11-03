#!/usr/bin/env node
/**
 * 二次认证端到端测试。
 *
 * 只对着真实 API 跑，不用 mock：TOTP 用 RFC 6238 的官方测试向量自检，
 * 策略改动走管理员接口，会话用真实登录换。Passkey 需要浏览器，
 * 在 scripts/passkey-e2e.mjs 里用 CDP 的虚拟认证器跑。
 *
 * 这个脚本会改数据库里的策略和方法，跑完自己清理（包括失败时）。
 */

import crypto from 'node:crypto';

const API = process.env.API_BASE || 'http://127.0.0.1:5174';
const PROJECT = process.env.PROJECT_ID || 'studio';
const OWNER = { email: 'alex@aurora.io', password: 'aurora-demo' };
const DEV = { email: 'lukas@fieldkit.co', password: 'aurora-demo' };

let pass = 0;
const failures = [];
let group = '';

function section(name) { group = name; console.log(`\n── ${name}`); }

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${group} / ${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/* --------------------------------------------------------------- HTTP */

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-project-id': PROJECT,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

const auth = (secret) => (secret ? { 'x-studio-session': secret } : {});

/* --------------------------------------------------------------- TOTP */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  const s = String(input).toUpperCase().replace(/[=\s-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of s) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error(`bad base32 ${ch}`);
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 独立实现，用来和服务端的实现互相对照 —— 两边都错的可能性远小于一边 */
function totpAt(secret, ms, digits = 6) {
  const counter = Math.floor(ms / 1000 / 30);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function verifyVectors() {
  // RFC 6238 附录 B（SHA1 行），密钥是 ASCII "12345678901234567890"
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const vectors = [
    [59_000, '94287082'],
    [1_111_111_109_000, '07081804'],
    [1_111_111_111_000, '14050471'],
    [1_234_567_890_000, '89005924'],
    [2_000_000_000_000, '69279037'],
    [20_000_000_000_000, '65353130'],
  ];
  section('RFC 6238 test vectors');
  for (const [ms, expected] of vectors) {
    const got = totpAt(secret, ms, 8);
    check(`T=${ms / 1000} → ${expected}`, got === expected, got);
  }
}

/* ------------------------------------------------------------------ 主流程 */

const created = { methods: [], users: [] };
let ownerSession = '';
let policiesBackup = [];

async function login(who) {
  let r = await api('POST', '/v1/account/sessions', { email: who.email, password: who.password });
  // 这个脚本会反复以同一个账号登录来验证不同分支，撞上限流是预期内的；
  // 等一轮再试，而不是把失败算到被测代码头上。
  if (r.status === 429) {
    const wait = Math.min(Number(r.json?.retryAfter || 30), 60) * 1000;
    console.log(`  · rate limited, waiting ${wait / 1000}s`);
    await new Promise((res) => setTimeout(res, wait + 500));
    r = await api('POST', '/v1/account/sessions', { email: who.email, password: who.password });
  }
  if (r.status !== 201) throw new Error(`login failed for ${who.email}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

async function cleanup() {
  try {
    for (const id of created.methods) {
      await api('DELETE', `/v1/auth/mfa/methods/${id}`, undefined, auth(ownerSession));
    }
    await api('PUT', '/v1/auth/mfa/policies', { policies: policiesBackup }, auth(ownerSession));
    for (const id of created.users) {
      await api('DELETE', `/v1/users/${id}`, undefined, auth(ownerSession));
    }
  } catch (e) {
    console.log(`  ! cleanup warning: ${e.message}`);
  }
}

async function main() {
  verifyVectors();

  /* --------------------------------------------------------- 准备 */
  section('Preparation');
  const health = await api('GET', '/v1/health');
  check('API is up', health.status === 200, `${health.status}`);

  const owner = await login(OWNER);
  ownerSession = owner.secret;
  check('password login issues a single-factor session',
    owner.status === undefined && owner.assurance === 'single' && !!owner.secret, JSON.stringify(owner).slice(0, 120));

  const pol = await api('GET', '/v1/auth/mfa/policies', undefined, auth(ownerSession));
  check('owner can read the policy', pol.status === 200 && Array.isArray(pol.json.policies), `${pol.status}`);
  policiesBackup = (pol.json.policies || []).map((p) => ({ scope: p.scope, target: p.target, mode: p.mode }));

  const before = await api('GET', '/v1/auth/mfa', undefined, auth(ownerSession));
  check('status starts empty', before.status === 200 && before.json.verifiedMethods === 0, JSON.stringify(before.json).slice(0, 120));

  /* ------------------------------------------------------ TOTP 绑定 */
  section('TOTP enrollment');
  const begin = await api('POST', '/v1/auth/mfa/totp/begin', { name: 'E2E phone' }, auth(ownerSession));
  const secret = begin.json?.secret || '';
  const methodId = begin.json?.methodId || '';
  check('begin returns a base32 secret', begin.status === 201 && /^[A-Z2-7]{32}$/.test(secret), secret);
  check('begin returns an otpauth URI', /^otpauth:\/\/totp\//.test(begin.json?.uri || ''), begin.json?.uri);
  if (methodId) created.methods.push(methodId);

  const listWhilePending = await api('GET', '/v1/auth/mfa', undefined, auth(ownerSession));
  check('an unconfirmed method is visible but not usable',
    listWhilePending.json.methods.some((m) => m.id === methodId && m.verified === false),
    JSON.stringify(listWhilePending.json.methods));

  const wrong = await api('POST', '/v1/auth/mfa/totp/confirm', { methodId, code: '000000' }, auth(ownerSession));
  check('confirming with a wrong code fails', wrong.status === 400, `${wrong.status} ${wrong.json?.error}`);

  const good = await api('POST', '/v1/auth/mfa/totp/confirm', { methodId, code: totpAt(secret, Date.now()) }, auth(ownerSession));
  check('confirming with the current code succeeds', good.status === 200 && good.json.recoveryCodes?.length === 10,
    JSON.stringify(good.json).slice(0, 160));
  const recovery = good.json?.recoveryCodes || [];

  const after = await api('GET', '/v1/auth/mfa', undefined, auth(ownerSession));
  check('method is now verified', after.json.verifiedMethods === 1, `${after.json.verifiedMethods}`);
  check('recovery codes are issued once', after.json.recoveryCodesLeft === 10, `${after.json.recoveryCodesLeft}`);

  const confirmTwice = await api('POST', '/v1/auth/mfa/totp/confirm', { methodId, code: totpAt(secret, Date.now()) }, auth(ownerSession));
  check('the same enrollment cannot be confirmed twice', confirmTwice.status === 400, `${confirmTwice.status}`);

  /* ------------------------------------------------------ 策略 */
  section('Policy');
  // owner 和 admin 都要求：owner 用于验证「已有因素 → 挑战」，admin 用于验证「没有因素 → 强制注册」
  const save = await api('PUT', '/v1/auth/mfa/policies', {
    policies: [
      { scope: 'role', target: 'owner', mode: 'required' },
      { scope: 'role', target: 'admin', mode: 'required' },
    ],
  }, auth(ownerSession));
  check('owner can require 2FA for a role', save.status === 200 && save.json.policies.length === 2, `${save.status}`);

  const list = await api('GET', '/v1/auth/mfa', undefined, auth(ownerSession));
  check('policy reflects on the current user', list.json.required === true && list.json.reason === 'role-required',
    `${list.json.reason} project=${list.json.projectId} role=${list.json.role}`);

  const dev = await login(DEV);
  const devSession = dev.secret;
  const devRead = await api('GET', '/v1/auth/mfa/policies', undefined, auth(devSession));
  check('a developer cannot read the policy', devRead.status === 403, `${devRead.status}`);
  const devWrite = await api('PUT', '/v1/auth/mfa/policies', { policies: [] }, auth(devSession));
  check('a developer cannot change the policy', devWrite.status === 403, `${devWrite.status}`);

  /* ------------------------------------------------- 第二次登录 */
  section('Sign-in challenge');
  const second = await login(OWNER);
  check('login now returns a challenge instead of a session',
    second.mfaRequired === true && !!second.challenge && !second.secret, JSON.stringify(second).slice(0, 160));
  check('the challenge lists the available method', second.methods?.totp === true, JSON.stringify(second.methods));
  if (second.mfaEnrollmentRequired) check('no session leaked through the enrollment branch', false, 'unexpected');

  const peek = await api('GET', `/v1/auth/mfa/challenge/${encodeURIComponent(second.challenge || '')}`);
  check('challenge lookup works without a session', peek.status === 200 && peek.json.methods.totp === true, `${peek.status}`);
  check('challenge lookup leaks no account identity',
    !JSON.stringify(peek.json).includes('alex@aurora.io') && !JSON.stringify(peek.json).includes('Alex'), JSON.stringify(peek.json).slice(0, 160));

  const badCode = await api('POST', '/v1/auth/mfa/verify', { challenge: second.challenge, code: '123456' });
  check('a wrong code is rejected', badCode.status === 401, `${badCode.status}`);

  // 绑定那一步已经用掉了「当前步长」的码，这里必须用下一窗口的。
  // 服务端允许 ±1 的漂移，所以不必真的等 30 秒。
  const nextCode = totpAt(secret, Date.now() + 30_000);
  const first = await api('POST', '/v1/auth/mfa/verify', { challenge: second.challenge, code: nextCode });
  check('a valid code completes the sign-in',
    first.status === 200 && !!first.json.secret && first.json.assurance === 'multi',
    JSON.stringify(first.json).slice(0, 160));
  check('the new session is flagged as verified', first.json.mfaVerified === true, JSON.stringify(first.json).slice(0, 120));

  const me = await api('GET', '/v1/auth/me', undefined, auth(first.json?.secret));
  check('the verified session reaches the console', me.status === 200 && me.json.principal.mfaVerified === true,
    JSON.stringify(me.json.principal));

  // 同一个 6 位码不能再换一次会话
  const again = await login(OWNER);
  const replay = await api('POST', '/v1/auth/mfa/verify', { challenge: again.challenge, code: nextCode });
  check('the same code cannot be reused', replay.status === 401, `${replay.status} ${replay.json?.error}`);

  // 恢复码
  const rec = await api('POST', '/v1/auth/mfa/verify', { challenge: again.challenge, code: recovery[0], method: 'recovery' });
  check('a recovery code works when the app is lost', rec.status === 200 && !!rec.json.secret, `${rec.status} ${rec.json?.error}`);
  const recAgain = await api('POST', '/v1/auth/mfa/verify', {
    challenge: (await login(OWNER)).challenge, code: recovery[0], method: 'recovery',
  });
  check('a recovery code is single use', recAgain.status === 401, `${recAgain.status}`);

  /* --------------------------------------------- 尝试次数与过期 */
  section('Brute force limits');
  const victim = await login(OWNER);
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/v1/auth/mfa/verify', { challenge: victim.challenge, code: '000001' });
    lastStatus = r.status;
  }
  check('the challenge dies after five wrong codes', lastStatus === 401, `${lastStatus}`);
  const dead = await api('POST', '/v1/auth/mfa/verify', {
    challenge: victim.challenge, code: totpAt(secret, Date.now() + 30_000),
  });
  check('a dead challenge cannot be resumed', dead.status === 401, `${dead.status}`);

  /* --------------------------------------------- 强制注册（半登录） */
  section('Enrollment required');
  const novak = await api('POST', '/v1/users', {
    name: 'E2E Enrollee', email: `e2e-mfa-${Date.now()}@example.test`, password: 'enroll-pass-123',
  }, auth(ownerSession));
  const newUserId = novak.json?.id;
  if (newUserId) created.users.push(newUserId);
  check('a test user is created', novak.status === 201 && !!newUserId, `${novak.status}`);

  if (newUserId) {
    const addMember = await api('POST', '/v1/members', { userId: newUserId, role: 'admin' }, auth(ownerSession));
    check('the test user joins the project as admin', addMember.status === 201, `${addMember.status} ${addMember.json?.error}`);

    const fresh = await login({ email: novak.json.email, password: 'enroll-pass-123' });
    check('a required role without a factor gets a pending session',
      !!fresh.secret && fresh.assurance === 'pending' && fresh.mfaEnrollmentRequired === true,
      JSON.stringify(fresh).slice(0, 160));

    const blocked = await api('GET', '/v1/databases/collections', undefined, auth(fresh.secret));
    check('a pending session cannot reach the console', blocked.status === 403 && blocked.json.code === 'mfa_required',
      `${blocked.status} ${blocked.json?.code}`);

    const allowed = await api('GET', '/v1/auth/mfa', undefined, auth(fresh.secret));
    check('a pending session can still manage its own factors', allowed.status === 200 && allowed.json.pending === true,
      `${allowed.status}`);

    const enrollBegin = await api('POST', '/v1/auth/mfa/totp/begin', {}, auth(fresh.secret));
    check('a pending session can start enrollment', enrollBegin.status === 201, `${enrollBegin.status}`);
    if (enrollBegin.json?.methodId) created.methods.push(enrollBegin.json.methodId);
    const enrollOk = await api('POST', '/v1/auth/mfa/totp/confirm', {
      methodId: enrollBegin.json?.methodId, code: totpAt(enrollBegin.json?.secret, Date.now()),
    }, auth(fresh.secret));
    check('enrollment completes while pending', enrollOk.status === 200, `${enrollOk.status} ${enrollOk.json?.error}`);

    // 绑好之后同一个会话仍然是 pending：这是有意的 —— 会话必须重新走一次登录才升级，
    // 否则「刚绑的 8 秒前还没验证过的设备」就等于第二因素。
    const stillBlocked = await api('GET', '/v1/databases/collections', undefined, auth(fresh.secret));
    check('the pending session stays limited until the next sign-in', stillBlocked.status === 403, `${stillBlocked.status}`);

    const retry = await login({ email: novak.json.email, password: 'enroll-pass-123' });
    check('the next sign-in asks for the code', retry.mfaRequired === true && !!retry.challenge, JSON.stringify(retry).slice(0, 120));
    const up = await api('POST', '/v1/auth/mfa/verify', {
      challenge: retry.challenge, code: totpAt(enrollBegin.json?.secret, Date.now() + 30_000),
    });
    check('and completes normally', up.status === 200 && up.json.assurance === 'multi', `${up.status} ${up.json?.error}`);
  }

  /* -------------------------------------------------- 策略优先级 */
  section('Policy precedence');
  const exempt = await api('PUT', '/v1/auth/mfa/policies', {
    policies: [
      { scope: 'role', target: 'owner', mode: 'required' },
      { scope: 'user', target: owner.userId, mode: 'exempt' },
    ],
  }, auth(ownerSession));
  check('a user-level exemption is accepted', exempt.status === 200, `${exempt.status}`);

  const third = await login(OWNER);
  check('an exempt user is not challenged even though the role requires it',
    !!third.secret && third.mfaRequired !== true, JSON.stringify(third).slice(0, 160));

  const none = await api('PUT', '/v1/auth/mfa/policies', { policies: [] }, auth(ownerSession));
  check('policies can be cleared', none.status === 200 && none.json.policies.length === 0, `${none.status}`);

  const fourth = await login(OWNER);
  check('with no policy, sign-in is single-factor again', fourth.assurance === 'single', JSON.stringify(fourth).slice(0, 120));

  /* ------------------------------------------------------------ 清理 */
  section('Cleanup');
  const del = await api('DELETE', `/v1/auth/mfa/methods/${methodId}`, undefined, auth(ownerSession));
  check('owner can remove a method', del.status === 200 && del.json.ok === true, `${del.status}`);
}

try {
  await main();
} catch (e) {
  failures.push(`fatal: ${e.message}`);
  console.error(`\n!! ${e.stack || e.message}`);
} finally {
  await cleanup();
}

const total = pass + failures.length;
console.log(`\n=== ${pass}/${total} checks passed · ${failures.length} failed ===`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
