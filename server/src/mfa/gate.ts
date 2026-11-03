import { db } from '../db.js';
import { issueSession, type IssuedSession } from '../store.js';
import { availableMethods, countVerified, createChallenge } from './methods.js';
import { decideForUser, type PolicyDecision } from './policy.js';

/**
 * 登录闸门：第一因素（密码 / SSO / LDAP）通过之后，决定能不能立刻发会话。
 *
 * 三种结局：
 *   session     策略不要求，或用户已经在本会话里过了第二因素 → 正常会话
 *   challenge   策略要求且用户有可用的第二因素 → 一次性票据，换会话前必须过验证
 *   enroll      策略要求但用户一个因素都没绑 → 发「受限会话」，只能去绑第二因素
 *
 * 第三种是必须的：如果直接拒绝登录，用户就永远进不来，也就永远没机会绑定；
 * 如果放行成普通会话，策略等于没有。受限会话把「能进控制台」压缩到
 * 「只能打开安全设置」，其他接口一律 403（见 auth.ts 的 guard）。
 */

export interface GateInput {
  userId: string;
  /** 登录发起时所在的项目，仅用于记录；策略判定会遍历全部项目 */
  projectId: string;
  /** 带上这些字段，验证通过后原样返回给前端（provider 名称、是否新用户等） */
  context?: Record<string, unknown>;
}

export type GateResult =
  | { kind: 'session'; session: IssuedSession }
  | { kind: 'enroll'; session: IssuedSession; decision: PolicyDecision }
  | { kind: 'challenge'; challenge: string; expiresAt: string; methods: ReturnType<typeof availableMethods>; decision: PolicyDecision };

const CHALLENGE_TTL = 5 * 60_000;

export function gateAfterPrimary(input: GateInput): GateResult {
  const decision = decideForUser(input.userId);
  const enrolled = countVerified(input.userId) > 0;

  if (!decision.required) {
    return { kind: 'session', session: issueSession(input.userId) };
  }

  if (!enrolled) {
    return {
      kind: 'enroll',
      session: issueSession(input.userId, { assurance: 'pending' }),
      decision,
    };
  }

  const challenge = createChallenge({
    userId: input.userId,
    projectId: input.projectId,
    kind: 'login',
    ttlMs: CHALLENGE_TTL,
    data: { ...(input.context || {}), decision },
  });

  return {
    kind: 'challenge',
    challenge,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL).toISOString(),
    methods: availableMethods(input.userId),
    decision,
  };
}

/**
 * 把闸门结果翻译成登录接口的响应体。
 *
 * 刻意让「需要第二次」和普通登录共用 201：这不是错误，是一个正常的分支。
 * 前端看 `mfaRequired` 决定是存票据还是弹验证码框。
 */
export function loginResponse(result: GateResult, extra: Record<string, unknown> = {}) {
  if (result.kind === 'session') return { ...result.session, ...extra };
  if (result.kind === 'enroll') {
    return {
      ...result.session,
      mfaEnrollmentRequired: true,
      mfaReason: result.decision,
    };
  }
  return {
    mfaRequired: true,
    challenge: result.challenge,
    expiresAt: result.expiresAt,
    methods: result.methods,
    reason: result.decision,
    ...extra,
  };
}

/** 某个项目当前有哪些人是「必须开但还没开」，给管理员看合规缺口 */
export function enrollmentGaps(projectId: string): { userId: string; name: string; email: string; role: string }[] {
  const rows = db.prepare(
    `SELECT u.id AS userId, u.name, u.email, m.role FROM members m JOIN users u ON u.id=m.userId
     WHERE m.projectId=?`,
  ).all(projectId) as any[];

  const out: { userId: string; name: string; email: string; role: string }[] = [];
  for (const r of rows) {
    if (!decideForUser(r.userId).required) continue;
    if (countVerified(r.userId) === 0) out.push({ userId: r.userId, name: r.name, email: r.email, role: r.role });
  }
  return out;
}
