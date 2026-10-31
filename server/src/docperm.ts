import type { Principal } from './context.js';
import { currentPrincipal, currentProjectId } from './context.js';

/**
 * 文档级权限（Appwrite `$permissions` 语义）。
 *
 * 规则形如 `read("any")` / `update("user:usr_123")` / `delete("team:studio/admin")`。
 * Appwrite 里 `write(...)` 是 update + delete 的合集，这里保持一致。
 *
 * 生效条件：`collections.documentSecurity = 1`。开关关闭时沿用项目级 RBAC，
 * 与历史行为完全兼容（默认值是 0）。
 *
 * 注意：API Key 视为服务端身份，绕过文档级判定（Appwrite 的 server SDK 亦如此），
 * 但仍受 key 自身 scope 约束；定时任务/系统调用没有 principal，同样视为系统身份。
 */
export type DocAction = 'read' | 'update' | 'delete';

const RULE = /^(read|update|delete|write)\s*\(\s*['"]([^'"]+)['"]\s*\)$/;

export const PERMISSION_ACTIONS: DocAction[] = ['read', 'update', 'delete'];

/** 校验权限字符串格式，非法直接报错（避免静默存下一堆看不懂的规则） */
export function assertPermissionRules(list: unknown): string[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('permissions must be an array of strings like read("any")');
  return list.map((raw) => {
    const rule = String(raw).trim();
    if (!RULE.test(rule)) {
      throw new Error(`Invalid permission "${rule}". Expected read|update|delete|write("any"|"users"|"user:<id>"|"team:<id>"|"team:<id>/<role>")`);
    }
    return rule;
  });
}

/** 取出某个动作适用的目标列表 */
export function targetsFor(permissions: string[], action: DocAction): string[] {
  const out: string[] = [];
  for (const raw of permissions || []) {
    const m = RULE.exec(String(raw).trim());
    if (!m) continue;
    const [, verb, target] = m;
    const applies = verb === action || (verb === 'write' && (action === 'update' || action === 'delete'));
    if (applies) out.push(target);
  }
  return out;
}

function matches(target: string, principal: Principal | null, projectId: string): boolean {
  const t = target.trim().toLowerCase();
  const authenticated = !!principal && !principal.invalid;

  // 公开 / 匿名
  if (t === 'any' || t === '*' || t === 'role:all' || t === 'guests' || t === 'role:guests') return true;
  // 任何已登录身份（含控制台演示身份）
  if (t === 'users' || t === 'role:users' || t === 'role:member' || t === 'member') return authenticated;
  if (!authenticated) return false;

  if (t.startsWith('user:')) {
    return principal!.id === target.slice(5).trim();
  }

  if (t.startsWith('team:')) {
    // team:<id> 或 team:<id>/<role>；本项目就是唯一的 team，便于控制台里直接验证
    const rest = target.slice(5).trim();
    const [teamId, role] = rest.split('/');
    if (teamId !== '*' && teamId !== projectId) return false;
    if (!role) return true;
    return (principal!.role || '').toLowerCase() === role.trim().toLowerCase();
  }

  // label:<x> 需要用户标签体系，暂不支持显式匹配
  return false;
}

/** 文档级判定入口；principal 为空表示系统调用（定时任务、种子数据） */
export function documentAllows(
  permissions: string[],
  action: DocAction,
  principal: Principal | null = currentPrincipal(),
  projectId: string = currentProjectId(),
): boolean {
  if (!principal) return true;
  if (principal.invalid) return false;
  // API Key = 服务端身份，权限由 scope 决定
  if (principal.type === 'key') return true;
  return targetsFor(permissions, action).some((t) => matches(t, principal, projectId));
}

export class ForbiddenError extends Error {
  status = 403;
  code = 'forbidden';
  constructor(message: string, readonly action?: DocAction) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** 供路由层统一判定文档访问，未通过直接抛 403 */
export function assertDocumentAccess(permissions: string[], action: DocAction, docId: string) {
  if (!documentAllows(permissions, action)) {
    throw new ForbiddenError(`Document ${docId} does not grant ${action} to the current identity`, action);
  }
}

/** 默认权限：任何调用方可读，登录用户可写——与 Appwrite 控制台新建文档的默认值接近 */
export const DEFAULT_DOCUMENT_PERMISSIONS = ['read("any")', 'update("users")', 'delete("users")'];
