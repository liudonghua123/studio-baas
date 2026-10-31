import { db, now, uid } from './db.js';
import { bus } from './events.js';
import { DEFAULT_PROJECT_ID } from './context.js';

export interface Project {
  id: string; name: string; key: string; region: string; plan: string;
  status: string; color: string; description: string;
  createdAt: string; updatedAt: string;
  stats?: { collections: number; functions: number; sites: number; members: number };
}

const colors = ['#fd366e', '#6C5CE7', '#00B894', '#0984E3', '#FDCB6E', '#E17055'];

const fromRow = (r: any): Project => ({
  id: r.id, name: r.name, key: r.key || r.id, region: r.region || 'fra', plan: r.plan || 'free',
  status: r.status || 'active', color: r.color || '#fd366e', description: r.description || '',
  createdAt: r.createdAt, updatedAt: r.updatedAt || r.createdAt,
});

export function listProjects(): Project[] {
  const rows = db.prepare('SELECT * FROM projects ORDER BY createdAt ASC').all() as any[];
  return rows.map((r) => {
    const p = fromRow(r);
    p.stats = {
      collections: (db.prepare('SELECT COUNT(*) c FROM collections WHERE projectId=?').get(p.id) as any).c,
      functions: (db.prepare('SELECT COUNT(*) c FROM functions WHERE projectId=?').get(p.id) as any).c,
      sites: (db.prepare('SELECT COUNT(*) c FROM sites WHERE projectId=?').get(p.id) as any).c,
      members: (() => {
        try { return (db.prepare('SELECT COUNT(*) c FROM members WHERE projectId=?').get(p.id) as any).c; }
        catch { return 0; }
      })(),
    };
    return p;
  });
}

export function getProject(idOrKey: string): Project | null {
  const r = db.prepare('SELECT * FROM projects WHERE id=? OR key=?').get(idOrKey, idOrKey) as any;
  return r ? fromRow(r) : null;
}

export function defaultProject(): Project {
  const p = getProject(DEFAULT_PROJECT_ID) || listProjects()[0];
  return p!;
}

export function createProject(input: { name: string; key?: string; region?: string; plan?: string; color?: string; description?: string }): Project {
  const name = (input.name || '').trim();
  if (!name) throw new Error('Project name is required');
  const key = (input.key || name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || `prj-${Date.now()}`;
  if (db.prepare('SELECT 1 FROM projects WHERE key=?').get(key)) throw new Error(`Project key "${key}" already exists`);
  const id = uid('prj_');
  const t = now();
  const count = (db.prepare('SELECT COUNT(*) c FROM projects').get() as any).c;
  db.prepare(`INSERT INTO projects (id,name,key,region,plan,status,color,description,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, name, key, input.region || 'fra', input.plan || 'free',
    'active', input.color || colors[count % colors.length], input.description || '', t, t,
  );
  // 新项目自带一个媒体桶，避免空项目无法上传
  db.prepare(`INSERT INTO buckets (id,name,maxFileSize,allowedExtensions,compression,encryption,imageTransform,createdAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    uid('bkt_'), 'media', 5 * 1024 * 1024, JSON.stringify([]), 'none', 0, 0, t, id,
  );
  bus.publish({ type: 'project', action: 'create', resource: name });
  return getProject(id)!;
}

export function updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'region' | 'plan' | 'status' | 'color' | 'description'>>): Project | null {
  const cur = getProject(id);
  if (!cur) return null;
  db.prepare('UPDATE projects SET name=?,region=?,plan=?,status=?,color=?,description=?,updatedAt=? WHERE id=?').run(
    patch.name ?? cur.name, patch.region ?? cur.region, patch.plan ?? cur.plan,
    patch.status ?? cur.status, patch.color ?? cur.color,
    patch.description ?? cur.description, now(), cur.id,
  );
  bus.publish({ type: 'project', action: 'update', resource: cur.name });
  return getProject(cur.id);
}

export function deleteProject(id: string): boolean {
  const total = (db.prepare('SELECT COUNT(*) c FROM projects').get() as any).c;
  if (total <= 1) throw new Error('Cannot delete the last project');
  const cur = getProject(id);
  if (!cur) return false;
  db.transaction(() => {
    const cols = db.prepare('SELECT id FROM collections WHERE projectId=?').all(cur.id) as any[];
    for (const c of cols) {
      db.prepare('DELETE FROM documents WHERE collectionId=?').run(c.id);
      db.prepare('DELETE FROM attributes WHERE collectionId=?').run(c.id);
    }
    db.prepare('DELETE FROM collections WHERE projectId=?').run(cur.id);
    const buckets = db.prepare('SELECT id FROM buckets WHERE projectId=?').all(cur.id) as any[];
    for (const b of buckets) db.prepare('DELETE FROM files WHERE bucketId=?').run(b.id);
    db.prepare('DELETE FROM buckets WHERE projectId=?').run(cur.id);
    db.prepare('DELETE FROM executions WHERE projectId=?').run(cur.id);
    db.prepare('DELETE FROM functions WHERE projectId=?').run(cur.id);
    db.prepare('DELETE FROM sites WHERE projectId=?').run(cur.id);
    db.prepare('DELETE FROM messages WHERE projectId=?').run(cur.id);
    db.prepare('DELETE FROM apiKeys WHERE projectId=?').run(cur.id);
    db.prepare('DELETE FROM logs WHERE projectId=?').run(cur.id);
    try {
      db.prepare('DELETE FROM members WHERE projectId=?').run(cur.id);
      db.prepare('DELETE FROM functionDomains WHERE projectId=?').run(cur.id);
      db.prepare('DELETE FROM schedules WHERE projectId=?').run(cur.id);
      db.prepare('DELETE FROM gitIntegrations WHERE projectId=?').run(cur.id);
    } catch { /* 表可能尚未迁移 */ }
    db.prepare('DELETE FROM projects WHERE id=?').run(cur.id);
  })();
  bus.publish({ type: 'project', action: 'delete', resource: cur.name });
  return true;
}
