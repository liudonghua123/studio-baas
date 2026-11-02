#!/usr/bin/env node
/**
 * 本地演示用的身份提供方（OIDC + OAuth2 + CAS），零依赖。
 *
 * 两种用法：
 *   1. 手动体验：`node scripts/fixtures/demo-idp.mjs`
 *      → 在控制台「设置 → 认证」里添加一个 OIDC 源，Issuer 填 http://127.0.0.1:5199，
 *        Client ID `studio`，Client Secret 见下方输出；然后去 /login 点它。
 *   2. 自动化：被 scripts/sso-e2e.mjs import，跑完整断言。
 *
 * 这不是生产实现：没有同意页、没有会话、拿到 code 就给 token。
 * 但它签的 id_token 是真的 RS256，PKCE 和 redirect_uri 也真的校验 ——
 * 所以被测客户端如果偷懒，这里会失败。
 */
import http from 'node:http';
import crypto from 'node:crypto';

export const DEFAULT_PORT = 5199;
export const CLIENT_ID = 'studio';
export const CLIENT_SECRET = 'e2e-client-secret-9f2a';

const USERS = {
  alice: { sub: 'u-alice', email: 'alice@corp.example', name: 'Alice Chen', email_verified: true },
  bob_verified: { sub: 'u-bob', email: 'bob@studio.local', name: 'Bob Linked', email_verified: true },
  bob_unverified: { sub: 'u-bob-unverified', email: 'bob@studio.local', name: 'Bob Impostor', email_verified: false },
  mallory: { sub: 'u-mallory', email: 'mallory@corp.example', name: 'Mallory', email_verified: true },
};

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export function startDemoIdp({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const { privateKey: keyA, publicKey: pubA } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { privateKey: keyB } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwkA = { ...pubA.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

  const codes = new Map();
  const tickets = new Map();
  const accessTokens = new Map();

  const sign = (claims, key = keyA, kid = 'k1') => {
    const head = b64url({ alg: 'RS256', typ: 'JWT', kid });
    const input = `${head}.${b64url(claims)}`;
    return `${input}.${crypto.sign('sha256', Buffer.from(input), key).toString('base64url')}`;
  };

  const origin = `http://${host}:${port}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin);
    const p = url.pathname;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (p === '/.well-known/openid-configuration') {
      return send(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        userinfo_endpoint: `${origin}/userinfo`,
        jwks_uri: `${origin}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }

    if (p === '/jwks') return send(200, { keys: [jwkA] });

    if (p === '/authorize') {
      const user = url.searchParams.get('login_hint') || 'alice';
      const code = 'code_' + crypto.randomBytes(12).toString('hex');
      codes.set(code, {
        challenge: url.searchParams.get('code_challenge'),
        nonce: url.searchParams.get('nonce'),
        redirectUri: url.searchParams.get('redirect_uri'),
        user,
      });
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (p === '/token') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const rec = codes.get(form.get('code'));
        if (!rec) return send(400, { error: 'invalid_grant' });
        if (form.get('client_secret') !== CLIENT_SECRET) return send(401, { error: 'invalid_client' });
        if (form.get('redirect_uri') !== rec.redirectUri) return send(400, { error: 'redirect_uri_mismatch' });

        const computed = crypto.createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!rec.challenge || computed !== rec.challenge) return send(400, { error: 'invalid_grant', hint: 'PKCE failed' });

        codes.delete(form.get('code')); // 授权码一次性
        // bad_sig / bad_nonce 是「攻击者」场景，复用 alice 的资料，只改签名或 nonce
        const u = USERS[rec.user] || USERS.alice;
        const now = Math.floor(Date.now() / 1000);
        const claims = {
          iss: origin, aud: form.get('client_id'), sub: u.sub,
          email: u.email, email_verified: u.email_verified, name: u.name,
          iat: now, exp: now + 300, nonce: rec.nonce,
        };
        if (rec.user === 'bad_nonce') claims.nonce = 'not-the-nonce-we-sent';

        const at = 'at_' + crypto.randomBytes(10).toString('hex');
        accessTokens.set(at, rec.user);
        send(200, {
          access_token: at, token_type: 'Bearer', expires_in: 300,
          id_token: sign(claims, rec.user === 'bad_sig' ? keyB : keyA),
        });
      });
      return;
    }

    if (p === '/userinfo') {
      const at = (req.headers.authorization || '').replace(/^Bearer /, '');
      const who = accessTokens.get(at);
      if (!who) return send(401, { error: 'invalid_token' });
      const u = USERS[who] || USERS.alice;
      return send(200, { sub: u.sub, email: u.email, email_verified: u.email_verified, name: u.name });
    }

    /* ------------------------------------------------------------- CAS */
    if (p === '/cas/login') {
      const service = url.searchParams.get('service');
      if (!service) return send(400, 'missing service');
      const ticket = 'ST-' + crypto.randomBytes(8).toString('hex');
      tickets.set(ticket, { service, user: url.searchParams.get('login_hint') || 'alice' });
      const back = new URL(service);
      back.searchParams.set('ticket', ticket);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    if (p === '/cas/serviceValidate' || p === '/cas/p3/serviceValidate') {
      const ticket = url.searchParams.get('ticket');
      const service = url.searchParams.get('service');
      const rec = tickets.get(ticket);
      if (!rec || rec.service !== service) {
        return send(200, '<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">'
          + '<cas:authenticationFailure code="INVALID_TICKET">ticket not recognized</cas:authenticationFailure>'
          + '</cas:serviceResponse>', { 'content-type': 'text/xml' });
      }
      tickets.delete(ticket);
      const u = USERS[rec.user] || USERS.alice;
      return send(200, '<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess>'
        + `<cas:user>${u.sub}</cas:user><cas:attributes>`
        + `<cas:mail>${u.email}</cas:mail><cas:displayName>${u.name}</cas:displayName>`
        + '</cas:attributes></cas:authenticationSuccess></cas:serviceResponse>', { 'content-type': 'text/xml' });
    }

    send(404, { error: 'not_found', path: p });
  });

  const ready = new Promise((resolve) => server.listen(port, host, resolve));

  return {
    server, origin, ready,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/* 直接运行时：起服务并打印可以照抄的配置 */
if (process.argv[1] && process.argv[1].endsWith('demo-idp.mjs')) {
  const port = Number(process.env.PORT || DEFAULT_PORT);
  const idp = startDemoIdp({ port });
  await idp.ready;
  console.log(`Demo IdP (OIDC + OAuth2 + CAS) on ${idp.origin}`);
  console.log(`  Issuer        ${idp.origin}`);
  console.log(`  Client ID     ${CLIENT_ID}`);
  console.log(`  Client secret ${CLIENT_SECRET}`);
  console.log(`  CAS server    ${idp.origin}/cas`);
  console.log('  Accounts: alice@corp.example (verified), bob_unverified@studio.local (unverified)');
}
