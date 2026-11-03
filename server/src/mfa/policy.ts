import { db, now, uid } from '../db.js';

/**
 * 二次验证策略。
 *
 * 策略是**项目级**的，因为角色本身就是项目级的：同一个人在 A 项目是 admin、
 * 在 B 项目是 viewer。登录却是全局的 —— 一个人只有一份会话。所以判定要遍历
 * 他所属的全部项目：只要有一个项目要求、且他自己没有被显式豁免，就必须过第二因素。
 *
 * 优先级（从高到低）：
 *   1. 用户级豁免   —— 服务账号、CI 机器人这类没有手机的人
 *   2. 用户级强制   —— 比角色更精确，用于「实习生必须开，其他人随意」
 *   3. 项目内角色豁免
 *   4. 项目内角色强制
 *   5. 默认关闭
 *
 * 显式豁免放在最前面是有意的：管理员给某个账号开了豁免，结果被另一个
 * 项目的角色规则盖回去，这种「设置不生效」最难排查。
 */

export type PolicyScope = 'role' | 'user';
export type PolicyMode = 'required' | 'exempt';

export interface MfaPolicy {
  id: string;
  projectId: string;
  scope: PolicyScope;
  target: string;
  mode: PolicyMode;
  createdAt: string;
}

export interface PolicyDecision {
  required: boolean;
  reason: 'user-required' | 'user-exempt' | 'role-required' | 'role-exempt' | 'not-configured';
  /** 触发判定的项目与角色，便于界面解释「为什么我要开」 */
  projectId?: string;
  role?: string;
}

function rowToPolicy(r: any): MfaPolicy {
  return {
    id: r.id, projectId: r.projectId, scope: r.scope,
    target: r.target, mode: r.mode, createdAt: r.createdAt,
  };
}

export function listPolicies(projectId: string): MfaPolicy[] {
  return (db.prepare('SELECT * FROM mfaPolicies WHERE projectId=? ORDER BY scope, target').all(projectId) as any[])
    .map(rowToPolicy);
}

export function policiesForUser(userId: string): MfaPolicy[] {
  const rows = db.prepare(
    `SELECT p.*, m.role FROM mfaPolicies p
     LEFT JOIN members m ON m.projectId = p.projectId AND m.userId = ?
     WHERE p.scope = 'user' AND p.target = ?
        OR p.scope = 'role' AND p.target = m.role`,
  ).all(userId, userId) as any[];
  return rows.map(rowToPolicy);
}

/**
 * 整表替换。管理员在界面上改的是「一组规则」，逐条 diff 只会制造
 * 中间状态（比如先把 required 删了、再把 exempt 加上，中间有一瞬间是「没人管」）。
 */
export function replacePolicies(projectId: string, input: { scope: string; target: string; mode: string }[]): MfaPolicy[] {
  const seen = new Set<string>();
  const clean: { scope: PolicyScope; target: string; mode: PolicyMode }[] = [];

  for (const raw of Array.isArray(input) ? input : []) {
    const scope = raw?.scope === 'user' ? 'user' : raw?.scope === 'role' ? 'role' : null;
    const mode = raw?.mode === 'exempt' ? 'exempt' : raw?.mode === 'required' ? 'required' : null;
    const target = String(raw?.target || '').trim();
    if (!scope || !mode || !target) throw new Error('Each rule needs scope, target and mode');
    if (scope === 'role' && !['owner', 'admin', 'developer', 'viewer'].includes(target)) {
      throw new Error(`Unknown role "${target}"`);
    }
    if (scope === 'user' && !db.prepare('SELECT 1 FROM users WHERE id=?').get(target)) {
      throw new Error(`Unknown user "${target}"`);
    }
    const key = `${scope}:${target}`;
    if (seen.has(key)) throw new Error(`Duplicate rule for ${scope} "${target}"`);
    seen.add(key);
    clean.push({ scope, target, mode });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM mfaPolicies WHERE projectId=?').run(projectId);
    const ins = db.prepare(
      'INSERT INTO mfaPolicies (id,projectId,scope,target,mode,createdAt) VALUES (?,?,?,?,?,?)',
    );
    for (const p of clean) ins.run(uid('mfa_'), projectId, p.scope, p.target, p.mode, now());
  })();

  return listPolicies(projectId);
}

/**
 * 判定某个用户登录时是否必须过第二因素。
 *
 * 传入 memberships 而不是自己去查，是为了让调用方（登录流程）能一次性
 * 拿到角色，也方便测试构造场景。
 */
export function decide(
  userId: string,
  memberships: { projectId: string; role: string }[],
  policies: MfaPolicy[] = policiesForUser(userId),
): PolicyDecision {
  const userExempt = policies.find((p) => p.scope === 'user' && p.target === userId && p.mode === 'exempt');
  if (userExempt) return { required: false, reason: 'user-exempt', projectId: userExempt.projectId };

  const userRequired = policies.find((p) => p.scope === 'user' && p.target === userId && p.mode === 'required');
  if (userRequired) {
    const m = memberships.find((x) => x.projectId === userRequired.projectId);
    return { required: true, reason: 'user-required', projectId: userRequired.projectId, role: m?.role };
  }

  for (const m of memberships) {
    const exempt = policies.find((p) => p.scope === 'role' && p.projectId === m.projectId && p.target === m.role && p.mode === 'exempt');
    if (exempt) continue;
    const required = policies.find((p) => p.scope === 'role' && p.projectId === m.projectId && p.target === m.role && p.mode === 'required');
    if (required) return { required: true, reason: 'role-required', projectId: m.projectId, role: m.role };
  }

  return { required: false, reason: 'not-configured' };
}

export function decideForUser(userId: string): PolicyDecision {
  const memberships = db.prepare('SELECT projectId, role FROM members WHERE userId=?').all(userId) as { projectId: string; role: string }[];
  return decide(userId, memberships);
}
