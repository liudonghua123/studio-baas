import type express from 'express';
import { db, now } from './db.js';
import type { Principal } from './context.js';
import { currentPrincipal, currentProjectId } from './context.js';
import { roleAllows, permissionsForRole } from './rbac.js';
import * as members from './members.js';

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
export function resolveAuth(req: express.Request, fallbackProjectId = 'studio'): ResolvedAuth {
  const key = req.header('x-api-key');
  if (key) {
    const row = db.prepare('SELECT * FROM apiKeys WHERE secret=?').get(key) as any;
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

  const session = req.header('x-studio-session');
  if (session) {
    const row = db.prepare(
      'SELECT s.*, u.name, u.email FROM sessions s JOIN users u ON u.id=s.userId WHERE s.secret=?',
    ).get(session) as any;
    if (row && new Date(row.expiresAt).getTime() > Date.now()) {
      const role = members.roleOf(fallbackProjectId, row.userId);
      return {
        principal: {
          type: 'user', id: row.userId, name: row.name,
          role: role || 'viewer',
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

  const actAs = req.header('x-studio-act-as');
  if (actAs && ['owner', 'admin', 'developer', 'viewer'].includes(actAs)) {
    return {
      principal: {
        type: 'demo', id: 'demo', name: `Demo ${actAs[0].toUpperCase()}${actAs.slice(1)}`,
        role: actAs,
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
