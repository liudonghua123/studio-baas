import type express from 'express';
import { guard } from '../auth.js';
import { currentProjectId, withProject } from '../context.js';
import { rateLimit } from '../ratelimit.js';
import { ldapProbe } from './ldap.js';
import { discover } from './jwt.js';
import {
  consumeState, createProvider, decryptConfig, deleteProvider, getProvider, getProviderById,
  listProviders, publicList, publicView, safeReturnTo, updateProvider,
} from './providers.js';
import { handleCallback, handleLdapLogin, identityCount, startFlow } from './flow.js';

/**
 * SSO 路由。
 *
 * 分两类，权限边界很清楚：
 *   /config/*  —— 管理员配置身份源（sso.read / sso.write）
 *   /:id/*     —— 登录端点，必须匿名可访问（用户此刻还没登录）
 *
 * 匿名端点的安全性全靠 state + PKCE + token 验签，不靠「调用者是谁」。
 */

type Wrap = (fn: (req: express.Request, res: express.Response) => Promise<any> | any) => express.RequestHandler;
type Fail = (res: express.Response, e: any, code?: number) => void;

function sanitizeOrigin(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin;
  } catch { return ''; }
}

/**
 * 登录后回哪里。
 *
 * Origin 头由浏览器写入、脚本改不了，是整个流程里唯一可信的来源；
 * 但**不能无条件相信**：恶意站点可以自己调 /start 拿到 state，
 * 诱导用户完成认证后，把会话票据送进它的 /login#secret。所以只接受
 * 与 API 同站（同主机名，或都跑在回环地址上）的 Origin。
 */
function appOriginOf(req: express.Request): string {
  const base = apiBase(req);
  const sameSite = (origin: string) => {
    try {
      const a = new URL(origin);
      const b = new URL(base);
      if (a.hostname === b.hostname) return true;
      const loop = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
      return loop(a.hostname) && loop(b.hostname);
    } catch { return false; }
  };

  const fromHeader = sanitizeOrigin(req.header('origin'));
  if (fromHeader && sameSite(fromHeader)) return fromHeader;

  const ref = req.header('referer');
  if (ref) {
    try {
      const o = sanitizeOrigin(new URL(ref).origin);
      if (o && sameSite(o)) return o;
    } catch { /* ignore */ }
  }
  return sanitizeOrigin(process.env.STUDIO_APP_URL) || base;
}

function apiBase(req: express.Request): string {
  const env = process.env.STUDIO_API_URL;
  if (env) return env.replace(/\/+$/, '');
  const proto = (req.header('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = (req.header('x-forwarded-host') || req.get('host') || 'localhost:5174').split(',')[0].trim();
  return `${proto}://${host}`;
}

const callbackUrlFor = (req: express.Request, id: string) => `${apiBase(req)}/v1/auth/sso/${id}/callback`;

/** 回调是浏览器导航，出错要回登录页说人话，而不是甩一坨 JSON */
function redirectError(res: express.Response, origin: string, message: string) {
  const params = new URLSearchParams({ error: message });
  if (!origin) {
    res.status(400).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>`
      + `<body style="font:15px system-ui;padding:40px"><h2>Sign-in failed</h2><p>${escapeHtml(message)}</p></body>`,
    );
    return;
  }
  res.redirect(302, `${origin}/login#${params.toString()}`);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function mountSsoRoutes(app: express.Express, wrap: Wrap, fail: Fail) {
  /* --------------------------------------------------- public: buttons */
  // 登录页要知道「这个项目开了哪些登录方式」，但拿不到任何配置细节
  app.get('/v1/auth/sso/providers', wrap((req, res) => {
    const pid = String(req.query.projectId || '') || currentProjectId();
    res.json({ providers: publicList(pid), projectId: pid });
  }));

  /* ---------------------------------------------------- admin: config */
  app.get('/v1/auth/sso/config', guard('sso.read'), wrap((_req, res) => {
    const list = listProviders(currentProjectId()).map((p) => ({
      ...publicView(p), identities: identityCount(p.id),
    }));
    res.json({ providers: list });
  }));

  app.post('/v1/auth/sso/config', guard('sso.write'), wrap((req, res) => {
    const p = createProvider(currentProjectId(), req.body || {});
    res.status(201).json({ ...publicView(p), identities: 0 });
  }));

  app.patch('/v1/auth/sso/config/:id', guard('sso.write'), wrap((req, res) => {
    const p = updateProvider(currentProjectId(), req.params.id, req.body || {});
    if (!p) return fail(res, new Error('Identity provider not found'), 404);
    res.json({ ...publicView(p), identities: identityCount(p.id) });
  }));

  app.delete('/v1/auth/sso/config/:id', guard('sso.write'), wrap((req, res) => {
    res.json({ ok: deleteProvider(currentProjectId(), req.params.id) });
  }));

  /**
   * 「测试连接」：把配置真正用一次，但不创建任何用户、不写会话。
   * OIDC 会去取 discovery 文档，CAS 探一下登录页，LDAP 用服务账号 bind 一次。
   */
  app.post('/v1/auth/sso/config/:id/test', guard('sso.write'), wrap(async (req, res) => {
    const p = getProvider(currentProjectId(), req.params.id);
    if (!p) return fail(res, new Error('Identity provider not found'), 404);

    // 配置里的密码是密文，测试连接必须先解密
    const cfg: any = decryptConfig(p.type, p.config);
    if (p.type === 'oidc') {
      const meta = await discover(cfg.issuer);
      return res.json({
        ok: true, type: p.type, issuer: meta.issuer,
        endpoints: { authorize: meta.authorization_endpoint, token: meta.token_endpoint, jwks: meta.jwks_uri },
      });
    }
    if (p.type === 'oauth2') {
      const r = await fetch(cfg.authorizeUrl, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      return res.json({ ok: r.status < 400, type: p.type, status: r.status, authorizeUrl: cfg.authorizeUrl });
    }
    if (p.type === 'cas') {
      const r = await fetch(`${cfg.serverUrl}/login`, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
      return res.json({ ok: r.status < 400, type: p.type, status: r.status, serverUrl: cfg.serverUrl });
    }
    const probe = await ldapProbe({ ...cfg, timeoutMs: 6000 });
    res.json({ type: p.type, ...probe });
  }));

  /* ------------------------------------------------------- login: start */
  // 前端 fetch 拿 URL，然后自己跳转 —— 这样 302 也能带自定义头，调试友好
  app.post('/v1/auth/sso/:id/start', rateLimit({ windowMs: 60_000, max: 30 }), wrap(async (req, res) => {
    const p = getProviderById(req.params.id);
    if (!p || !p.enabled) return fail(res, new Error('Identity provider not found or disabled'), 404);
    if (p.type === 'ldap') return fail(res, new Error('LDAP signs in with a username and password, not a redirect'), 400);

    const origin = appOriginOf(req);
    const result = await withProject(p.projectId, () => startFlow(p, {
      appOrigin: origin,
      returnTo: safeReturnTo(req.body?.returnTo),
      callbackUrl: callbackUrlFor(req, p.id),
    }));
    res.json({ ...result, provider: { id: p.id, type: p.type, name: p.name } });
  }));

  // 直接导航也能用（贴到地址栏 / 邮件链接）
  app.get('/v1/auth/sso/:id/start', rateLimit({ windowMs: 60_000, max: 30 }), wrap(async (req, res) => {
    const p = getProviderById(req.params.id);
    if (!p || !p.enabled) return fail(res, new Error('Identity provider not found or disabled'), 404);
    if (p.type === 'ldap') return fail(res, new Error('LDAP signs in with a username and password'), 400);
    const result = await withProject(p.projectId, () => startFlow(p, {
      appOrigin: appOriginOf(req),
      returnTo: safeReturnTo(req.query.returnTo),
      callbackUrl: callbackUrlFor(req, p.id),
    }));
    res.redirect(302, result.url);
  }));

  /* ---------------------------------------------------- login: callback */
  app.get('/v1/auth/sso/:id/callback', wrap(async (req, res) => {
    const p = getProviderById(req.params.id);
    if (!p) return redirectError(res, appOriginOf(req), 'Unknown identity provider');

    // 先取 state：即使后面换 token 失败，也知道该把用户送回哪个前端
    const state = consumeState(String(req.query.state || ''));
    if (!state || state.providerId !== p.id) {
      return redirectError(res, appOriginOf(req), 'This sign-in link has expired or was already used. Please try again.');
    }
    const origin = state.appOrigin || appOriginOf(req);

    try {
      const result = await withProject(p.projectId, () => handleCallback(p, {
        code: req.query.code ? String(req.query.code) : undefined,
        ticket: req.query.ticket ? String(req.query.ticket) : undefined,
        state: state.id,
        callbackUrl: callbackUrlFor(req, p.id),
      }, state));

      // 会话票据放 fragment：不发给服务端、不进代理日志、不经 Referer 外泄。
      // 需要第二因素时这里只带 challenge —— 票据还没签发，没什么可泄露的。
      const params = new URLSearchParams({ returnTo: result.returnTo, provider: p.name });
      if (result.login.mfaRequired) {
        params.set('challenge', String(result.login.challenge || ''));
      } else {
        params.set('secret', String(result.login.secret || ''));
        params.set('role', String(result.login.role || ''));
        params.set('joined', result.login.joined ? '1' : '0');
      }
      return res.redirect(302, `${origin}/login#${params.toString()}`);
    } catch (e: any) {
      return redirectError(res, origin, e?.message || 'Sign-in failed');
    }
  }));

  /* ------------------------------------------------------- login: LDAP */
  app.post('/v1/auth/sso/:id/login',
    rateLimit({
      windowMs: 60_000, max: 8,
      keyOf: (r) => String(r.body?.username || '').toLowerCase(),
      message: 'Too many sign-in attempts, wait a minute before retrying',
    }),
    wrap(async (req, res) => {
      const p = getProviderById(req.params.id);
      if (!p || !p.enabled) return fail(res, new Error('Identity provider not found or disabled'), 404);
      if (p.type !== 'ldap') return fail(res, new Error('This provider does not accept a password'), 400);

      const { username, password } = req.body || {};
      try {
        const session = await withProject(p.projectId, () => handleLdapLogin(p, String(username || ''), String(password || '')));
        res.status(201).json(session);
      } catch (e: any) {
        // 统一话术：不区分「用户不存在」和「密码错」，避免目录账号被枚举
        const msg = /Invalid username or password/i.test(e?.message || '')
          ? 'Invalid username or password'
          : `LDAP sign-in failed: ${e?.message || e}`;
        res.status(401).json({ ok: false, code: 'unauthenticated', error: msg });
      }
    }));
}
