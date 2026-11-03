import crypto from 'node:crypto';
import type express from 'express';
import { db } from '../db.js';
import { currentPrincipal, currentProjectId } from '../context.js';
import { guard } from '../auth.js';
import * as members from '../members.js';
import { rateLimit } from '../ratelimit.js';
import { issueSession } from '../store.js';
import {
  availableMethods, beginTotp, challengeData, confirmTotp, consumeChallenge, countVerified,
  createChallenge, deleteMethod, failChallenge, getChallenge, getMethodRow, issueRecoveryCodes,
  listMethods, passkeyRows, recoveryCodesLeft, renameMethod, savePasskey,
  updateCounter, verifyCode,
} from './methods.js';
import { decideForUser, listPolicies, replacePolicies } from './policy.js';
import { enrollmentGaps } from './gate.js';
import {
  makeCreationOptions, makeRequestOptions, rpIdOf, verifyAssertion, verifyRegistration,
  type AssertionResponse, type RegistrationResponse,
} from './webauthn.js';

/**
 * 二次验证路由。
 *
 * 两套权限边界：
 *   - 已登录用户管理自己的因素（只能碰自己的行，userId 来自会话而不是参数）
 *   - 管理员配置策略（mfa.read / mfa.write）
 *
 * 登录第二步（/verify、/webauthn/assert/*）是匿名的：此刻的凭据是一张
 * 一次性挑战票据，它由第一因素换来的，本身就是身份证明。
 */

type Wrap = (fn: (req: express.Request, res: express.Response) => Promise<any> | any) => express.RequestHandler;
type Fail = (res: express.Response, e: any, code?: number) => void;

/**
 * 只允许「人」管理自己的第二因素。
 * API Key 是机器身份，给它绑 TOTP 没有意义，还会让 key 泄露后多一条提权路径。
 */
function requireUser(res: express.Response): string | null {
  const p = currentPrincipal();
  if (!p || p.invalid) {
    res.status(401).json({ ok: false, code: 'unauthenticated', error: 'Sign in first' });
    return null;
  }
  // demo 身份也是「某个人」（本地免登录体验会落到项目 owner 身上），
  // 让它同样能绑定第二因素 —— 否则演示模式下这个功能只能看不能用。
  if (p.type !== 'user' && p.type !== 'demo') {
    res.status(403).json({ ok: false, code: 'forbidden', error: 'Two-factor authentication is per user account' });
    return null;
  }
  return p.id;
}

/**
 * rpId 必须是域名。WebAuthn 规范明确禁止 IP 地址（浏览器会抛 SecurityError），
 * 而内网部署经常直接用 IP 访问 —— 在服务端提前拦住，错误信息才说得清。
 * localhost 是特例，规范允许。
 */
function isIpHost(host: string): boolean {
  if (!host) return true;
  if (host.includes(':')) return true;               // IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

/** 注册与断言都要求 Origin 与 API 同站；这是唯一无法被页面脚本伪造的来源 */
function originOf(req: express.Request): string {
  const raw = req.header('origin') || '';
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
  } catch { /* fallthrough */ }
  const env = process.env.STUDIO_APP_URL;
  if (env) {
    try { return new URL(env).origin; } catch { /* ignore */ }
  }
  const proto = (req.header('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = (req.header('x-forwarded-host') || req.get('host') || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

export function mountMfaRoutes(app: express.Express, wrap: Wrap, fail: Fail) {
  /* ------------------------------------------------------------ 我的因素 */
  app.get('/v1/auth/mfa', guard('project.read'), wrap((_req, res) => {
    const userId = currentPrincipal()!.id;
    const decision = decideForUser(userId);
    const projectId = currentProjectId();
    res.json({
      methods: listMethods(userId, { includePending: true }),
      verifiedMethods: countVerified(userId),
      recoveryCodesLeft: recoveryCodesLeft(userId),
      required: decision.required,
      reason: decision.reason,
      // 没触发判定时也告诉前端「你在这个项目是什么角色」，界面要拿它解释规则
      projectId: decision.projectId || projectId,
      role: decision.role || members.roleOf(projectId, userId),
      sessionVerified: !!currentPrincipal()?.mfaVerified,
      pending: !!currentPrincipal()?.mfaPending,
    });
  }));

  /* ---------------------------------------------------------------- TOTP */
  app.post('/v1/auth/mfa/totp/begin', guard('project.read'), wrap((req, res) => {
    const userId = requireUser(res);
    if (!userId) return;
    const u = db.prepare('SELECT email FROM users WHERE id=?').get(userId) as any;
    const result = beginTotp(userId, u?.email || userId, req.body?.name);
    res.status(201).json(result);
  }));

  app.post('/v1/auth/mfa/totp/confirm', guard('project.read'), wrap((req, res) => {
    const userId = requireUser(res);
    if (!userId) return;
    const { methodId, code } = req.body || {};
    const out = confirmTotp(userId, String(methodId || ''), String(code || ''));
    res.json({ ok: true, ...out });
  }));

  /* ------------------------------------------------------------- Passkey */
  app.post('/v1/auth/mfa/webauthn/begin', guard('project.read'), wrap((req, res) => {
    const userId = requireUser(res);
    if (!userId) return;

    const origin = originOf(req);
    const rpId = rpIdOf(origin);
    if (!rpId) return fail(res, new Error('Cannot determine the relying party for this host'), 400);
    if (isIpHost(rpId)) {
      return fail(res, new Error('Passkeys need a domain name — open the console via localhost or a real hostname instead of an IP address'), 400);
    }

    const u = db.prepare('SELECT name, email FROM users WHERE id=?').get(userId) as any;
    const challenge = crypto.randomBytes(32).toString('base64url');
    const name = String(req.body?.name || '').trim().slice(0, 64) || 'Passkey';

    const ticket = createChallenge({
      userId, projectId: currentProjectId(), kind: 'register',
      data: { challenge, origin, rpId, name },
    });

    res.json({
      ticket,
      options: makeCreationOptions({
        rpId,
        rpName: 'Studio BaaS',
        userId,
        userName: u?.email || userId,
        displayName: u?.name || u?.email || 'Studio user',
        challenge,
        exclude: passkeyRows(userId).map((r) => ({
          credentialId: r.credentialId,
          transports: JSON.parse(r.transports || '[]'),
        })),
      }),
    });
  }));

  app.post('/v1/auth/mfa/webauthn/finish', guard('project.read'), wrap((req, res) => {
    const userId = requireUser(res);
    if (!userId) return;

    const row = getChallenge(String(req.body?.ticket || ''), 'register');
    if (!row || row.userId !== userId) return fail(res, new Error('This registration attempt has expired'), 400);

    const data = challengeData(row);
    const response = req.body?.response as RegistrationResponse;
    if (!response) return fail(res, new Error('Missing registration response'), 400);

    const reg = verifyRegistration({
      response,
      expectedChallenge: data.challenge,
      expectedOrigin: data.origin,
      rpId: data.rpId,
    });
    consumeChallenge(row.id);

    const method = savePasskey(userId, data.name, reg);
    res.status(201).json({ ok: true, method, recoveryCodesLeft: recoveryCodesLeft(userId) });
  }));

  /* --------------------------------------------------------- 管理已有因素 */
  app.patch('/v1/auth/mfa/methods/:id', guard('project.read'), wrap((req, res) => {
    const userId = requireUser(res);
    if (!userId) return;
    res.json(renameMethod(userId, req.params.id, String(req.body?.name || '')));
  }));

  app.delete('/v1/auth/mfa/methods/:id', guard('project.read'), wrap((req, res) => {
    const userId = requireUser(res);
    if (!userId) return;
    const row = getMethodRow(userId, req.params.id);
    if (!row) return fail(res, new Error('Method not found'), 404);
    deleteMethod(userId, req.params.id);

    const left = countVerified(userId);
    const required = decideForUser(userId).required;
    // 删完最后一个因素时把后果说清楚：下次登录会被要求重新绑定
    res.json({
      ok: true,
      remaining: left,
      warning: required && left === 0
        ? 'You now have no second factor. Your next sign-in will be limited to setting one up again.'
        : null,
    });
  }));

  app.post('/v1/auth/mfa/recovery/regenerate', guard('project.read'), wrap((req, res) => {
    const userId = requireUser(res);
    if (!userId) return;
    if (countVerified(userId) === 0) {
      return fail(res, new Error('Add a second factor before generating recovery codes'), 400);
    }
    res.json({ codes: issueRecoveryCodes(userId) });
  }));

  /* ================================================= 登录第二步（匿名） */

  /**
   * 用挑战 id 换回「这个账号能用哪些方式」。
   *
   * 挑战 id 本身就是 32 字节随机串，是持有证明；返回体里刻意不含
   * userId / 邮箱 / 姓名 —— 登录页刷新后能恢复界面，但拿不到更多信息。
   */
  app.get('/v1/auth/mfa/challenge/:id', wrap((req, res) => {
    const row = getChallenge(req.params.id, 'login');
    if (!row) return fail(res, new Error('This sign-in attempt has expired. Start again from the sign-in page.'), 410);
    const data = challengeData(row);
    res.json({
      challenge: row.id,
      expiresAt: row.expiresAt,
      methods: availableMethods(row.userId),
      reason: data.decision || null,
      provider: data.provider || null,
    });
  }));

  const completeLogin = (challengeId: string) => {
    const row = getChallenge(challengeId, 'login');
    if (!row) throw new Error('This sign-in attempt has expired. Start again from the sign-in page.');
    const data = challengeData(row);
    consumeChallenge(challengeId);

    const session = issueSession(row.userId, { assurance: 'multi' });
    // 把第一因素阶段记录的信息原样带回：provider 名称、returnTo、是否新用户
    const { decision: _decision, ...rest } = data;
    return { ...session, ...rest, mfaVerified: true };
  };

  /**
   * TOTP / 恢复码。
   *
   * 限流按挑战 id 计：一个 challenge 只有 5 次机会（见 failChallenge），
   * 再加一层 IP 级限流是为了防止有人不停地「新开一次登录」来重置计数。
   */
  app.post('/v1/auth/mfa/verify',
    rateLimit({ windowMs: 60_000, max: 20, message: 'Too many verification attempts, wait a minute' }),
    wrap((req, res) => {
      const challengeId = String(req.body?.challenge || '');
      const row = getChallenge(challengeId, 'login');
      if (!row) return fail(res, new Error('This sign-in attempt has expired. Start again from the sign-in page.'), 401);

      try {
        const out = verifyCode(row.userId, {
          method: req.body?.method,
          code: String(req.body?.code || ''),
        });
        const session = completeLogin(challengeId);
        res.json({ ...session, factor: out.kind });
      } catch (e: any) {
        const { gone } = failChallenge(challengeId);
        const left = gone ? 0 : 5;
        const message = gone
          ? 'Too many incorrect codes. This sign-in attempt has been cancelled.'
          : `${e?.message || 'Invalid code'} (${left - 1} attempts left)`;
        return fail(res, new Error(message), 401);
      }
    }));

  /* ------------------------------------------------------ Passkey 断言 */
  app.post('/v1/auth/mfa/webauthn/assert/begin',
    rateLimit({ windowMs: 60_000, max: 20, message: 'Too many verification attempts, wait a minute' }),
    wrap((req, res) => {
      const login = getChallenge(String(req.body?.challenge || ''), 'login');
      if (!login) return fail(res, new Error('This sign-in attempt has expired. Start again from the sign-in page.'), 401);

      const origin = originOf(req);
      const rpId = rpIdOf(origin);
      if (isIpHost(rpId)) {
        return fail(res, new Error('Passkeys need a domain name — open the console via localhost or a real hostname instead of an IP address'), 400);
      }
      const passkeys = passkeyRows(login.userId);
      if (!passkeys.length) {
        return fail(res, new Error('No passkey is registered for this account'), 400);
      }

      const challenge = crypto.randomBytes(32).toString('base64url');
      const ticket = createChallenge({
        userId: login.userId, projectId: login.projectId, kind: 'assert',
        data: { challenge, origin, rpId, loginChallenge: login.id },
      });

      res.json({
        ticket,
        options: makeRequestOptions({
          rpId,
          challenge,
          allow: passkeys.map((r) => ({
            credentialId: r.credentialId,
            transports: JSON.parse(r.transports || '[]'),
          })),
        }),
      });
    }));

  app.post('/v1/auth/mfa/webauthn/assert/finish',
    rateLimit({ windowMs: 60_000, max: 20, message: 'Too many verification attempts, wait a minute' }),
    wrap((req, res) => {
      const row = getChallenge(String(req.body?.ticket || ''), 'assert');
      if (!row) return fail(res, new Error('This passkey attempt has expired. Start again.'), 401);

      const data = challengeData(row);
      const login = getChallenge(data.loginChallenge, 'login');
      if (!login) return fail(res, new Error('This sign-in attempt has expired. Start again.'), 401);

      const response = req.body?.response as AssertionResponse;
      if (!response) return fail(res, new Error('Missing assertion response'), 400);

      // 用响应里的 credential id 找到那把公钥；找不到就直接拒绝，不做「猜测式」匹配
      const credId = String(response.rawId || response.id || '');
      const stored = db.prepare(
        "SELECT * FROM mfaMethods WHERE userId=? AND type='webauthn' AND verifiedAt IS NOT NULL AND credentialId=?",
      ).get(login.userId, credId) as any;
      if (!stored) {
        failChallenge(login.id);
        return fail(res, new Error('This passkey does not belong to the account'), 401);
      }

      try {
        const { counter } = verifyAssertion({
          response,
          expectedChallenge: data.challenge,
          expectedOrigin: data.origin,
          rpId: data.rpId,
          credential: {
            credentialId: stored.credentialId,
            publicKey: stored.publicKey,
            algorithm: stored.algorithm,
            counter: stored.counter,
          },
        });
        updateCounter(stored.id, counter);
        consumeChallenge(row.id);

        const session = completeLogin(login.id);
        res.json({ ...session, factor: 'passkey' });
      } catch (e: any) {
        failChallenge(login.id);
        fail(res, new Error(`Passkey verification failed: ${e?.message || e}`), 401);
      }
    }));

  /* ================================================= 管理员：策略配置 */
  app.get('/v1/auth/mfa/policies', guard('mfa.read'), wrap((_req, res) => {
    const projectId = currentProjectId();
    res.json({
      policies: listPolicies(projectId),
      gaps: enrollmentGaps(projectId),
      roles: ['owner', 'admin', 'developer', 'viewer'],
    });
  }));

  app.put('/v1/auth/mfa/policies', guard('mfa.write'), wrap((req, res) => {
    const projectId = currentProjectId();
    const policies = replacePolicies(projectId, req.body?.policies || []);
    res.json({ policies, gaps: enrollmentGaps(projectId) });
  }));
}
