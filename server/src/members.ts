import { db, now, uid } from './db.js';
import { bus } from './events.js';

export interface Member {
  id: string; projectId: string; userId: string;
  name: string; email: string; avatarColor: string;
  role: string; status: string; addedAt: string;
}

const fromRow = (r: any): Member => ({
  id: r.id, projectId: r.projectId, userId: r.userId,
  name: r.name, email: r.email,
  avatarColor: r.avatarColor || '#6C5CE7',
  role: r.role, status: r.status || 'active', addedAt: r.createdAt,
});

export function listMembers(projectId: string): Member[] {
  const rows = db.prepare(
    `SELECT m.*, u.name, u.email, u.status FROM members m JOIN users u ON u.id=m.userId
     WHERE m.projectId=? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
     WHEN 'developer' THEN 2 ELSE 3 END, m.createdAt ASC`,
  ).all(projectId) as any[];
  return rows.map(fromRow);
}

export function getMember(projectId: string, id: string): Member | null {
  const r = db.prepare(
    `SELECT m.*, u.name, u.email, u.status FROM members m JOIN users u ON u.id=m.userId
     WHERE m.projectId=? AND m.id=?`,
  ).get(projectId, id) as any;
  return r ? fromRow(r) : null;
}

export function roleOf(projectId: string, userId: string): string | null {
  const r = db.prepare('SELECT role FROM members WHERE projectId=? AND userId=?').get(projectId, userId) as any;
  return r?.role || null;
}

export function countMembers(projectId: string): number {
  try {
    return (db.prepare('SELECT COUNT(*) c FROM members WHERE projectId=?').get(projectId) as any).c;
  } catch { return 0; }
}

export function addMember(projectId: string, input: { userId?: string; email?: string; role?: string }): Member {
  let userId = input.userId;
  if (!userId) {
    const email = String(input.email || '').trim().toLowerCase();
    const u = db.prepare('SELECT id FROM users WHERE email=?').get(email) as any;
    if (!u) throw new Error(`No user with email ${email}. Create the user first in Auth.`);
    userId = u.id;
  }
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw new Error('User not found');
  if (db.prepare('SELECT 1 FROM members WHERE projectId=? AND userId=?').get(projectId, userId)) {
    throw new Error('User is already a member of this project');
  }
  const role = input.role || 'developer';
  const id = uid('mem_');
  db.prepare('INSERT INTO members (id,projectId,userId,role,createdAt) VALUES (?,?,?,?,?)').run(
    id, projectId, userId, role, now(),
  );
  bus.publish({ type: 'member', action: 'invite', resource: role });
  return getMember(projectId, id)!;
}

export function updateMemberRole(projectId: string, memberId: string, role: string): Member | null {
  const cur = getMember(projectId, memberId);
  if (!cur) return null;
  if (cur.role === 'owner' && role !== 'owner') {
    const owners = listMembers(projectId).filter((m) => m.role === 'owner');
    if (owners.length <= 1) throw new Error('Project must keep at least one owner');
  }
  db.prepare('UPDATE members SET role=? WHERE id=? AND projectId=?').run(role, memberId, projectId);
  bus.publish({ type: 'member', action: 'role', resource: role });
  return getMember(projectId, memberId);
}

export function removeMember(projectId: string, memberId: string): boolean {
  const cur = getMember(projectId, memberId);
  if (!cur) return false;
  if (cur.role === 'owner') {
    const owners = listMembers(projectId).filter((m) => m.role === 'owner');
    if (owners.length <= 1) throw new Error('Cannot remove the last owner of the project');
  }
  db.prepare('DELETE FROM members WHERE id=? AND projectId=?').run(memberId, projectId);
  bus.publish({ type: 'member', action: 'remove', resource: cur.email });
  return true;
}
