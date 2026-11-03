/**
 * 基于角色的访问控制（RBAC）
 *
 * 角色是项目级的：同一个人在 A 项目是 owner，在 B 项目可能只是 viewer。
 * 权限点用 `资源.动作` 表示，API Key 的 scope 复用同一套字符串，
 * 因此「人」和「机器」走的是同一份授权矩阵。
 */

export type Role = 'owner' | 'admin' | 'developer' | 'viewer';

export const ROLES: { id: Role; label: string; description: string; color: string }[] = [
  { id: 'owner', label: 'Owner', description: '完全控制，包含删除项目与转让所有权', color: '#fd366e' },
  { id: 'admin', label: 'Admin', description: '管理成员、密钥与全部资源，不能删除项目', color: '#fdcb6e' },
  { id: 'developer', label: 'Developer', description: '读写数据、部署站点、执行函数', color: '#6C5CE7' },
  { id: 'viewer', label: 'Viewer', description: '只读访问控制台与日志', color: '#00b894' },
];

const ALL: Role[] = ['owner', 'admin', 'developer', 'viewer'];
const DEV: Role[] = ['owner', 'admin', 'developer'];
const ADM: Role[] = ['owner', 'admin'];
const OWN: Role[] = ['owner'];

export interface PermissionDef {
  id: string;
  group: string;
  label: string;
  roles: Role[];
}

export const PERMISSIONS: PermissionDef[] = [
  { id: 'project.read', group: 'Project', label: 'View project', roles: ALL },
  { id: 'project.write', group: 'Project', label: 'Update settings', roles: ADM },
  { id: 'project.delete', group: 'Project', label: 'Delete project', roles: OWN },

  { id: 'members.read', group: 'Members', label: 'View members', roles: ALL },
  { id: 'members.write', group: 'Members', label: 'Invite / change roles', roles: ADM },

  { id: 'databases.read', group: 'Databases', label: 'Read collections & documents', roles: ALL },
  { id: 'databases.write', group: 'Databases', label: 'Create / update / delete', roles: DEV },

  { id: 'storage.read', group: 'Storage', label: 'Read buckets & files', roles: ALL },
  { id: 'storage.write', group: 'Storage', label: 'Upload / delete files', roles: DEV },

  { id: 'functions.read', group: 'Functions', label: 'Read code & executions', roles: ALL },
  { id: 'functions.write', group: 'Functions', label: 'Edit code & configuration', roles: DEV },
  { id: 'functions.execute', group: 'Functions', label: 'Execute functions', roles: DEV },

  { id: 'sites.read', group: 'Sites', label: 'Read sites', roles: ALL },
  { id: 'sites.write', group: 'Sites', label: 'Edit files & settings', roles: DEV },
  { id: 'sites.deploy', group: 'Sites', label: 'Deploy', roles: DEV },

  { id: 'users.read', group: 'Auth', label: 'Read end users', roles: DEV },
  { id: 'users.write', group: 'Auth', label: 'Create / block users', roles: ADM },

  // 身份源配置能决定「谁能进控制台」，只读也不该给到 developer
  { id: 'sso.read', group: 'Auth', label: 'View identity providers', roles: ADM },
  { id: 'sso.write', group: 'Auth', label: 'Configure SSO / LDAP', roles: ADM },

  // 策略决定「谁必须开二次验证」——能改它就能把某个角色从强制名单里拿掉
  { id: 'mfa.read', group: 'Auth', label: 'View two-factor policy', roles: ADM },
  { id: 'mfa.write', group: 'Auth', label: 'Change two-factor policy', roles: ADM },

  { id: 'messaging.read', group: 'Messaging', label: 'Read messages', roles: DEV },
  { id: 'messaging.write', group: 'Messaging', label: 'Send messages', roles: DEV },

  { id: 'keys.read', group: 'API keys', label: 'View keys', roles: ADM },
  { id: 'keys.write', group: 'API keys', label: 'Create / revoke keys', roles: ADM },

  { id: 'logs.read', group: 'Observability', label: 'Read request logs', roles: DEV },
];

export const PERMISSION_IDS = PERMISSIONS.map((p) => p.id);

export function isPermission(id: string): boolean {
  return PERMISSION_IDS.includes(id);
}

export function roleAllows(role: string | undefined, permission: string): boolean {
  if (!role) return false;
  const def = PERMISSIONS.find((p) => p.id === permission);
  if (!def) return false;
  return def.roles.includes(role as Role);
}

export function permissionsForRole(role: string | undefined): string[] {
  return PERMISSIONS.filter((p) => roleAllows(role, p.id)).map((p) => p.id);
}

export function roleLabel(role: string | undefined): string {
  return ROLES.find((r) => r.id === role)?.label || role || 'None';
}

/** 角色是否可以管理另一个角色（不能修改比自己高的角色，owner 唯一例外） */
export function canManageRole(actor: string | undefined, target: string): boolean {
  if (actor === 'owner') return true;
  if (actor === 'admin') return target !== 'owner';
  return false;
}
