#!/usr/bin/env node
/**
 * SSO 端到端验收：OAuth2 / OIDC / CAS / LDAP。
 *
 * 不 mock 自己的代码，只 mock 对面的 IdP：
 *   - 一个真的 OIDC 提供方（discovery + JWKS + RS256 签名的 id_token + PKCE 校验）
 *   - 一个真的 CAS 服务端（service ticket 一次性消费）
 *   - LDAP 用外部目录（`LDAP_TEST_URL=ldap://…`），没配就跳过并明确说明
 *
 * 跑法：`pnpm dev` 另开一个终端，然后 `node scripts/sso-e2e.mjs`
 * 退出码非 0 表示有断言失败。
 */
import { startDemoIdp, CLIENT_SECRET } from './fixtures/demo-idp.mjs';

const API = process.env.API_BASE || 'http://127.0.0.1:5174';
const APP = process.env.APP_BASE || 'http://127.0.0.1:5173';
const PROJECT = process.env.PROJECT || 'studio';
const PORT = Number(process.env.IDP_PORT || 5199);
const IDP = `http://127.0.0.1:${PORT}`;
const LDAP_URL = process.env.LDAP_TEST_URL || '';

const results = [];
const check = (area, name, ok, detail = '') => {
  results.push({ area, name, ok: !!ok, detail: String(detail).slice(0, 300) });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${area}] ${name}${ok ? '' : `  → ${String(detail).slice(0, 300)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================ demo IdP */
// 身份提供方来自 scripts/fixtures/demo-idp.mjs —— 手写体验和自动化跑的是同一份实现
const idp = startDemoIdp({ port: PORT });
const server = idp.server;
await idp.ready;
console.log(`demo IdP/CAS listening on ${idp.origin}`);

/* ============================================================= client */
async function api(method, path, { body, headers = {}, session, as } = {}) {
  const h = { 'content-type': 'application/json', 'x-project-id': PROJECT, ...headers };
  if (session) h['x-studio-session'] = session;
  if (as) h['x-studio-act-as'] = as;
  const res = await fetch(API + path, {
    method, headers: h, redirect: 'manual',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers, location: res.headers.get('location') };
}

/** 模拟浏览器走一跳重定向，但不自动跟随（要逐跳检查） */
async function hop(url) {
  const res = await fetch(url, { redirect: 'manual' });
  await res.text().catch(() => '');
  return { status: res.status, location: res.headers.get('location') };
}

const fragment = (loc) => new URLSearchParams(String(loc || '').split('#')[1] || '');

function cleanupProviders(list, keep = []) {
  return Promise.all(list
    .filter((p) => p.name.startsWith('e2e-') && !keep.includes(p.id))
    .map((p) => api('DELETE', `/v1/auth/sso/config/${p.id}`)));
}

async function fullLogin(providerId, { returnTo = '/databases' } = {}) {
  const start = await api('POST', `/v1/auth/sso/${providerId}/start`, {
    body: { returnTo }, headers: { origin: APP },
  });
  if (start.status !== 200) return { error: `start failed: ${start.status} ${JSON.stringify(start.json)}` };

  const authorize = await hop(start.json.url);
  if (authorize.status !== 302) return { error: `authorize did not redirect: ${authorize.status}` };

  const cb = await hop(authorize.location);
  if (cb.status !== 302) return { error: `callback did not redirect: ${cb.status}` };
  const frag = fragment(cb.location);
  if (frag.get('error')) return { error: frag.get('error'), location: cb.location, start: start.json };
  if (!frag.get('secret')) return { error: `no secret in ${cb.location}` };
  return { session: frag.get('secret'), returnTo: frag.get('returnTo'), role: frag.get('role'), location: cb.location, start: start.json };
}

/* ================================================================ main */
const created = { providers: [], users: [] };

try {
  const health = await api('GET', '/v1/health');
  check('setup', 'API is reachable', health.status === 200, JSON.stringify(health.json));

  const existing = await api('GET', '/v1/auth/sso/config');
  await cleanupProviders(existing.json?.providers || []);

  /* ------------------------------------------------------- OIDC happy path */
  const oidc = await api('POST', '/v1/auth/sso/config', {
    body: {
      type: 'oidc', name: 'e2e-oidc', defaultRole: 'developer',
      config: {
        issuer: IDP, clientId: 'studio', clientSecret: CLIENT_SECRET,
        extraParams: { login_hint: 'alice' },
      },
    },
  });
  check('oidc', 'create provider', oidc.status === 201, JSON.stringify(oidc.json));
  check('oidc', 'secret is masked in response', oidc.json?.secrets?.clientSecret?.set === true
    && !JSON.stringify(oidc.json).includes(CLIENT_SECRET), JSON.stringify(oidc.json?.secrets));
  created.providers.push(oidc.json.id);

  const publicList = await api('GET', '/v1/auth/sso/providers');
  check('oidc', 'appears in public provider list', (publicList.json?.providers || []).some((p) => p.id === oidc.json.id));
  check('oidc', 'public list leaks no config',
    !JSON.stringify(publicList.json).includes('clientSecret') && !JSON.stringify(publicList.json).includes('issuer'));

  const login = await fullLogin(oidc.json.id, { returnTo: '/databases' });
  check('oidc', 'end-to-end login issues a session', !!login.session, JSON.stringify(login).slice(0, 400));

  if (login.session) {
    const me = await api('GET', '/v1/auth/me', { session: login.session });
    check('oidc', 'session resolves to the SSO user', me.json?.principal?.name === 'Alice Chen', JSON.stringify(me.json));
    check('oidc', 'default role applied on first login', me.json?.role === 'developer', me.json?.role);
    check('oidc', 'returnTo preserved', login.returnTo === '/databases', login.returnTo);

    const again = await fullLogin(oidc.json.id);
    const me2 = again.session ? await api('GET', '/v1/auth/me', { session: again.session }) : { json: {} };
    check('oidc', 'second login reuses the same local user', me2.json?.principal?.id === me.json?.principal?.id,
      `${me.json?.principal?.id} vs ${me2.json?.principal?.id}`);
  }

  /* --------------------------------------------------------- PKCE / params */
  const startAgain = await api('POST', `/v1/auth/sso/${oidc.json.id}/start`, { body: { returnTo: '/' }, headers: { origin: APP } });
  const authUrl = new URL(startAgain.json.url);
  check('oidc', 'start sends PKCE S256 challenge',
    authUrl.searchParams.get('code_challenge_method') === 'S256' && (authUrl.searchParams.get('code_challenge') || '').length > 20);
  check('oidc', 'start sends nonce and state',
    !!authUrl.searchParams.get('nonce') && (authUrl.searchParams.get('state') || '').length > 20);
  check('oidc', 'start requests openid scope', (authUrl.searchParams.get('scope') || '').includes('openid'));

  /* ------------------------------------------------------ state replay */
  const authorize2 = await hop(startAgain.json.url);
  const cb2 = await hop(authorize2.location);
  check('oidc', 'first use of state succeeds', cb2.status === 302 && !!fragment(cb2.location).get('secret'), cb2.location);
  const replay = await hop(authorize2.location);
  const replayErr = fragment(replay.location).get('error') || '';
  check('oidc', 'replaying the same state is rejected', /expired|already used/i.test(replayErr), replayErr || replay.location);

  /* --------------------------------------------------- forged signature */
  const forged = await api('POST', '/v1/auth/sso/config', {
    body: {
      type: 'oidc', name: 'e2e-forged',
      config: {
        issuer: IDP, clientId: 'studio', clientSecret: CLIENT_SECRET,
        extraParams: { login_hint: 'bad_sig' },
      },
    },
  });
  created.providers.push(forged.json.id);
  const forgedLogin = await fullLogin(forged.json.id);
  check('oidc', 'id_token signed by another key is rejected', /signature/i.test(forgedLogin.error || ''), forgedLogin.error);

  const badNonce = await api('POST', '/v1/auth/sso/config', {
    body: {
      type: 'oidc', name: 'e2e-nonce',
      config: {
        issuer: IDP, clientId: 'studio', clientSecret: CLIENT_SECRET,
        extraParams: { login_hint: 'bad_nonce' },
      },
    },
  });
  created.providers.push(badNonce.json.id);
  const nonceLogin = await fullLogin(badNonce.json.id);
  check('oidc', 'id_token with a foreign nonce is rejected', /nonce/i.test(nonceLogin.error || ''), nonceLogin.error);

  /* --------------------------------------------- account linking by email */
  const bob = await api('POST', '/v1/users', {
    body: { name: 'Bob Local', email: 'bob@studio.local', password: 'Sup3r-secret!' },
  });
  created.users.push(bob.json?.id);

  const unverified = await api('POST', '/v1/auth/sso/config', {
    body: {
      type: 'oidc', name: 'e2e-unverified',
      config: {
        issuer: IDP, clientId: 'studio', clientSecret: CLIENT_SECRET,
        extraParams: { login_hint: 'bob_unverified' },
      },
    },
  });
  created.providers.push(unverified.json.id);
  const unverifiedLogin = await fullLogin(unverified.json.id);
  check('oidc', 'unverified email cannot take over an existing account',
    /already exists/i.test(unverifiedLogin.error || ''), unverifiedLogin.error);

  const verified = await api('POST', '/v1/auth/sso/config', {
    body: {
      type: 'oidc', name: 'e2e-verified',
      config: {
        issuer: IDP, clientId: 'studio', clientSecret: CLIENT_SECRET,
        extraParams: { login_hint: 'bob_verified' },
      },
    },
  });
  created.providers.push(verified.json.id);
  const verifiedLogin = await fullLogin(verified.json.id);
  const verifiedMe = verifiedLogin.session ? await api('GET', '/v1/auth/me', { session: verifiedLogin.session }) : { json: {} };
  check('oidc', 'verified email links to the existing account', verifiedMe.json?.principal?.id === bob.json?.id,
    `${verifiedMe.json?.principal?.id} vs ${bob.json?.id}`);

  /* --------------------------------------------------------- open redirect */
  const openRedirect = await api('POST', `/v1/auth/sso/${oidc.json.id}/start`, {
    body: { returnTo: 'https://evil.example/steal' }, headers: { origin: APP },
  });
  const evilAuthorize = await hop(openRedirect.json.url);
  const evilCb = await hop(evilAuthorize.location);
  check('oidc', 'returnTo cannot point at another site', fragment(evilCb.location).get('returnTo') === '/',
    fragment(evilCb.location).get('returnTo'));

  /* ------------------------------------------- cross-site origin hijack */
  const foreign = await api('POST', `/v1/auth/sso/${oidc.json.id}/start`, {
    body: {}, headers: { origin: 'https://evil.example' },
  });
  const fAuth = await hop(foreign.json.url);
  const fCb = await hop(fAuth.location);
  check('oidc', 'a foreign Origin never receives the session ticket',
    !String(fCb.location).startsWith('https://evil.example'), fCb.location);

  /* ---------------------------------------------------------- OAuth2 flow */
  const oauth2 = await api('POST', '/v1/auth/sso/config', {
    body: {
      type: 'oauth2', name: 'e2e-oauth2', defaultRole: 'viewer',
      config: {
        clientId: 'studio', clientSecret: CLIENT_SECRET,
        authorizeUrl: `http://127.0.0.1:${PORT}/authorize`,
        tokenUrl: `http://127.0.0.1:${PORT}/token`,
        userinfoUrl: `http://127.0.0.1:${PORT}/userinfo`,
        scopes: ['email', 'profile'],
        extraParams: { login_hint: 'mallory' },
      },
    },
  });
  created.providers.push(oauth2.json.id);
  check('oauth2', 'create provider', oauth2.status === 201, JSON.stringify(oauth2.json).slice(0, 300));
  const oaLogin = await fullLogin(oauth2.json.id);
  const oaMe = oaLogin.session ? await api('GET', '/v1/auth/me', { session: oaLogin.session }) : { json: {} };
  check('oauth2', 'authorization-code login works without OIDC', oaMe.json?.principal?.name === 'Mallory',
    JSON.stringify(oaLogin).slice(0, 300));
  check('oauth2', 'defaultRole viewer honoured', oaMe.json?.role === 'viewer', oaMe.json?.role);

  /* --------------------------------------------------------------- CAS */
  const cas = await api('POST', '/v1/auth/sso/config', {
    body: {
      type: 'cas', name: 'e2e-cas', defaultRole: 'developer',
      config: { serverUrl: `http://127.0.0.1:${PORT}/cas`, version: '3' },
    },
  });
  created.providers.push(cas.json.id);
  const casStart = await api('POST', `/v1/auth/sso/${cas.json.id}/start`, { body: {}, headers: { origin: APP } });
  const casUrl = new URL(casStart.json.url);
  check('cas', 'authorize URL carries the service parameter',
    casUrl.pathname === '/cas/login' && (casUrl.searchParams.get('service') || '').includes('/v1/auth/sso/'),
    casStart.json.url);
  const casLoginReturn = await hop(casStart.json.url);
  const casCb = await hop(casLoginReturn.location);
  const casFrag = fragment(casCb.location);
  check('cas', 'ticket is validated and a session issued', !!casFrag.get('secret'), casCb.location);
  if (casFrag.get('secret')) {
    const casMe = await api('GET', '/v1/auth/me', { session: casFrag.get('secret') });
    check('cas', 'CAS attributes map to name and email',
      casMe.json?.principal?.name === 'Alice Chen', JSON.stringify(casMe.json?.principal));
  }

  /* -------------------------------------------------------------- RBAC */
  const asDev = await api('GET', '/v1/auth/sso/config', { as: 'developer' });
  check('rbac', 'developer cannot read identity providers', asDev.status === 403, asDev.status);
  const asViewerWrite = await api('POST', '/v1/auth/sso/config', {
    as: 'viewer', body: { type: 'cas', name: 'e2e-nope', config: { serverUrl: 'http://x' } },
  });
  check('rbac', 'viewer cannot create providers', asViewerWrite.status === 403, asViewerWrite.status);

  /* -------------------------------------------------- disable & cleanup */
  const disabled = await api('PATCH', `/v1/auth/sso/config/${oauth2.json.id}`, { body: { enabled: false } });
  check('lifecycle', 'provider can be disabled', disabled.json?.enabled === false, JSON.stringify(disabled.json).slice(0, 200));
  const hiddenStart = await api('POST', `/v1/auth/sso/${oauth2.json.id}/start`, { body: {} });
  check('lifecycle', 'disabled provider cannot start a login', hiddenStart.status === 404, hiddenStart.status);
  const listAfter = await api('GET', '/v1/auth/sso/providers');
  check('lifecycle', 'disabled provider disappears from the login page',
    !(listAfter.json?.providers || []).some((p) => p.id === oauth2.json.id));

  const del = await api('DELETE', `/v1/auth/sso/config/${verified.json.id}`);
  const gone = await api('GET', '/v1/auth/sso/config');
  check('lifecycle', 'deleting a provider removes its identities',
    del.json?.ok === true && !(gone.json?.providers || []).some((p) => p.id === verified.json.id));
  created.providers = created.providers.filter((id) => id !== verified.json.id);

  /* -------------------------------------------------------------- LDAP */
  if (!LDAP_URL) {
    results.push({ area: 'ldap', name: 'skipped (set LDAP_TEST_URL)', ok: true, warn: true });
    console.log('SKIP [ldap] no LDAP_TEST_URL — run `node scripts/fixtures/ldap-server.mjs` and re-run');
  } else {
    await testLdap();
  }

  /* ------------------------------------------------------------ cleanup */
  const remaining = await api('GET', '/v1/auth/sso/config');
  await cleanupProviders(remaining.json?.providers || []);

  // SSO 自动开的账号也要清掉：它们是 labels 里带 "sso" 的那批，
  // 否则每跑一次巡检，用户列表就多两个人。
  const usersAfter = await api('GET', '/v1/users');
  for (const u of usersAfter.json?.users || []) {
    if ((u.labels || []).includes('sso')) await api('DELETE', `/v1/users/${u.id}`);
  }
  for (const uid of created.users) if (uid) await api('DELETE', `/v1/users/${uid}`);
} catch (e) {
  check('harness', 'unexpected exception', false, e?.stack || e?.message);
} finally {
  server.close();
}

async function testLdap() {
  const prov = await api('POST', '/v1/auth/sso/config', {
    body: {
      type: 'ldap', name: 'e2e-ldap', defaultRole: 'developer',
      config: {
        url: LDAP_URL, baseDn: 'ou=people,dc=example,dc=org',
        bindDn: 'cn=admin,dc=example,dc=org', bindPassword: 'admin-secret',
        userFilter: '(uid={{username}})', attrEmail: 'mail', attrName: 'cn', attrUsername: 'uid',
      },
    },
  });
  check('ldap', 'create provider', prov.status === 201, JSON.stringify(prov.json).slice(0, 300));

  const probe = await api('POST', `/v1/auth/sso/config/${prov.json.id}/test`);
  check('ldap', 'connection test binds with the service account', probe.json?.ok === true, JSON.stringify(probe.json).slice(0, 300));

  const good = await api('POST', `/v1/auth/sso/${prov.json.id}/login`, { body: { username: 'alice', password: 'alice-pass' } });
  check('ldap', 'valid credentials return a session', good.status === 201 && !!good.json?.secret, JSON.stringify(good.json).slice(0, 300));
  if (good.json?.secret) {
    const me = await api('GET', '/v1/auth/me', { session: good.json.secret });
    check('ldap', 'directory attributes map to the local user', me.json?.principal?.name === 'Alice Chen', JSON.stringify(me.json?.principal));
  }

  const bad = await api('POST', `/v1/auth/sso/${prov.json.id}/login`, { body: { username: 'alice', password: 'wrong' } });
  check('ldap', 'wrong password is rejected', bad.status === 401, bad.status);
  const empty = await api('POST', `/v1/auth/sso/${prov.json.id}/login`, { body: { username: 'alice', password: '' } });
  check('ldap', 'empty password never becomes an anonymous bind', empty.status === 401,
    `${empty.status} ${JSON.stringify(empty.json)}`);
  const injected = await api('POST', `/v1/auth/sso/${prov.json.id}/login`, { body: { username: '*', password: 'x' } });
  check('ldap', 'wildcard username is escaped, not expanded', injected.status === 401, injected.status);

  await api('DELETE', `/v1/auth/sso/config/${prov.json.id}`);
}

/* ------------------------------------------------------------- summary */
const failed = results.filter((r) => !r.ok).length;
const skipped = results.filter((r) => r.warn).length;
console.log(`\n=== ${results.length - skipped} checks · ${failed} failed · ${skipped} skipped ===`);
process.exit(failed ? 1 : 0);
