import type express from 'express';
import { db, now } from './db.js';
import type { Principal } from './context.js';
import { currentPrincipal, currentProjectId } from './context.js';
import { roleAllows, permissionsForRole } from './rbac.js';
import * as members from './members.js';
import { hashApiKey } from './apikey.js';

export interface ResolvedAuth {
  principal: Principal;
  projectId?: string;
}

/**
 * 身份解析顺序：
 *   1. x-api-key     —— 机器身份，scope 决定权限，且锁定到 key 所属项目
 *   2. x-studio-session —— 登录会话，角色来自 members 表
 *   3. x-studio-act-as  —— 本地演示用的“以某角色查看”，方便验证 RBAC
 *   4. 兜底 demo owner   —— 该项目的第一位 owner，保证开箱即用
 */
/** 角色强弱，用于「以角色查看」不得提权 */
const RANK: Record<string, number> = { viewer: 1, developer: 2, admin: 3, owner: 4 };

/**
 * `x-studio-act-as` 是演示开关：没有凭据时可以任意声明角色（控制台的 View as role），
 * 但**已登录时必须遵守两条**，否则它就是一个自称 owner 的后门：
 *   1. 不能声明比会话本身更高的角色（不纵向提权）；
 *   2. `STUDIO_ALLOW_ACT_AS=0` 可整体关闭（公网部署建议关掉）。
 */
function actAsAllowedFor(role: string | null): boolean {
  if (process.env.STUDIO_ALLOW_ACT_AS === '0') return false;
  if (!role) return true;                 // 无凭据的演示模式
  return true;                            // 有会话时由调用处再比较 RANK
}

export function resolveAuth(req: express.Request, fallbackProjectId = 'studio'): ResolvedAuth {
  const key = req.header('x-api-key');
  if (key) {
    // 库里只有 sha256 摘要，明文永不落盘
    const row = db.prepare('SELECT * FROM apiKeys WHERE secretHash=?').get(hashApiKey(key)) as any;
    if (row) {
      db.prepare('UPDATE apiKeys SET lastUsedAt=? WHERE id=?').run(now(), row.id);
      return {
        principal: {
          type: 'key', id: row.id, name: row.name,
          scopes: parseScopes(row.scopes),
        },
        projectId: row.projectId || undefined,
      };
    }
    // 带了 key 但查不到：可能是删除/轮换过的 key，必须 401 而不是当成“无权限身份”
    return {
      principal: {
        type: 'key', id: 'invalid', name: 'Invalid key', scopes: [],
        invalid: true, invalidReason: 'Invalid or revoked API key',
      },
    };
  }

  const actAs = req.header('x-studio-act-as');
  const wantActAs = !!actAs && !!RANK[actAs];

  const session = req.header('x-studio-session');
  if (session) {
    const row = db.prepare(
      'SELECT s.*, u.name, u.email FROM sessions s JOIN users u ON u.id=s.userId WHERE s.secret=?',
    ).get(session) as any;
    if (row && new Date(row.expiresAt).getTime() > Date.now()) {
      const own = members.roleOf(fallbackProjectId, row.userId) || 'viewer';
      const assurance = row.assurance || 'single';
      // 半登录状态不允许「以角色查看」：它本来就是个降权开关，
      // 而此刻要做的事情（绑定第二因素）与角色无关，多一层身份切换只会误导
      if (assurance === 'pending') {
        return {
          principal: {
            type: 'user', id: row.userId, name: row.name,
            role: own, mfaPending: true, mfaVerified: false,
          },
        };
      }
      // 只能「往下看」：viewer 不能借这个头把自己变成 owner
      if (wantActAs && actAsAllowedFor(own) && RANK[actAs!] <= RANK[own]) {
        return {
          principal: {
            type: 'user', id: row.userId, name: row.name,
            role: actAs!, mfaVerified: assurance === 'multi',
          },
        };
      }
      return {
        principal: {
          type: 'user', id: row.userId, name: row.name,
          role: own, mfaVerified: assurance === 'multi',
        },
      };
    }
    // 会话过期/不存在时不能悄悄回退成 demo owner，否则等于绕过登录
    return {
      principal: {
        type: 'user', id: 'invalid', name: 'Expired session',
        invalid: true, invalidReason: 'Session expired, please sign in again',
      },
    };
  }

  if (wantActAs && actAsAllowedFor(null)) {
    return {
      principal: {
        type: 'demo', id: 'demo', name: `Demo ${actAs![0].toUpperCase()}${actAs!.slice(1)}`,
        role: actAs!,
      },
    };
  }

  return { principal: demoOwner(fallbackProjectId) };
}

function demoOwner(projectId: string): Principal {
  const row = db.prepare(
    "SELECT m.userId, u.name FROM members m JOIN users u ON u.id=m.userId WHERE m.projectId=? AND m.role='owner' LIMIT 1",
  ).get(projectId) as any;
  if (row) return { type: 'demo', id: row.userId, name: row.name, role: 'owner' };

  const any = db.prepare('SELECT id, name FROM users LIMIT 1').get() as any;
  if (any) return { type: 'demo', id: any.id, name: any.name, role: 'owner' };
  return { type: 'demo', id: 'demo', name: 'Demo Owner', role: 'owner' };
}

function parseScopes(raw: string | null): string[] {
  try {
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function can(permission: string, principal: Principal | null = currentPrincipal()): boolean {
  if (!principal) return false;
  if (principal.type === 'key') {
    const scopes = principal.scopes || [];
    return scopes.includes('*') || scopes.includes(permission);
  }
  return roleAllows(principal.role, permission);
}

/**
 * 半登录会话能碰的路径。
 *
 * 只有「证明第二因素」和「看清楚自己是谁」这两件事应该被允许 ——
 * 其余全部 403。这里的白名单必须按前缀精确匹配，不能用 includes，
 * 否则 `/v1/auth/mfa/../../databases` 这类路径会骗过判断。
 */
const MFA_PENDING_ALLOWED = [
  /^\/v1\/auth\/mfa(\/|$)/,
  /^\/v1\/auth\/me$/,
  /^\/v1\/permissions$/,
  /^\/v1\/account\/sessions$/,
  /^\/v1\/health$/,
];

/** 路由守卫：无权限直接 403，并告知需要哪个权限点 */
export function guard(permission: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const principal = currentPrincipal();
    if (principal?.invalid) {
      return res.status(401).json({
        ok: false, code: 'unauthenticated',
        error: principal.invalidReason || 'Invalid credentials',
      });
    }
    if (!principal) {
      return res.status(401).json({ ok: false, code: 'unauthenticated', error: 'Authentication required' });
    }
    if (principal.mfaPending && !MFA_PENDING_ALLOWED.some((re) => re.test(req.path))) {
      return res.status(403).json({
        ok: false, code: 'mfa_required',
        error: 'Finish setting up two-factor authentication before using the console',
        enrollUrl: '/settings?focus=mfa',
      });
    }
    if (!can(permission, principal)) {
      return res.status(403).json({
        ok: false,
        code: 'forbidden',
        error: `Missing permission: ${permission}`,
        required: permission,
        role: principal.role || (principal.type === 'key' ? 'api-key' : principal.type),
        projectId: currentProjectId(),
      });
    }
    next();
  };
}

export function me(projectId: string) {
  const principal = currentPrincipal();
  const role = principal?.type === 'key' ? 'api-key' : principal?.role;
  return {
    principal,
    projectId,
    role,
    permissions: principal?.type === 'key'
      ? (principal.scopes || [])
      : permissionsForRole(principal?.role),
  };
}
