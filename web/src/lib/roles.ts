export interface RoleMeta {
  id: string; label: string; description: string; color: string;
}

export const ROLE_META: RoleMeta[] = [
  { id: 'owner', label: 'Owner', description: 'Full control incl. deleting the project', color: '#fd366e' },
  { id: 'admin', label: 'Admin', description: 'Manage members, keys and all resources', color: '#fdcb6e' },
  { id: 'developer', label: 'Developer', description: 'Write data, deploy sites, run functions', color: '#6C5CE7' },
  { id: 'viewer', label: 'Viewer', description: 'Read-only access to console and logs', color: '#00b894' },
];

export const roleOf = (id: string | undefined) => ROLE_META.find((r) => r.id === id);
export const roleColor = (id: string | undefined) => roleOf(id)?.color || '#6b6b7b';
export const roleLabel = (id: string | undefined) => roleOf(id)?.label || id || 'None';
