import { db, now, uid } from './db.js';
import { bus } from './events.js';
import { currentProjectId } from './context.js';
import { nextRun, nextRuns, describeCron } from './cron.js';
import * as store from './store.js';

export interface Schedule {
  id: string; projectId: string; functionId: string; functionName?: string;
  cron: string; timezone: string; enabled: boolean;
  nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null;
  description?: string; createdAt: string;
}

const fromRow = (r: any): Schedule => ({
  id: r.id, projectId: r.projectId, functionId: r.functionId,
  cron: r.cron, timezone: r.timezone || 'UTC', enabled: !!r.enabled,
  nextRunAt: r.nextRunAt, lastRunAt: r.lastRunAt, lastStatus: r.lastStatus,
  description: describeCron(r.cron), createdAt: r.createdAt,
  functionName: (db.prepare('SELECT name FROM functions WHERE id=?').get(r.functionId) as any)?.name,
});

export function listSchedules(functionId?: string): Schedule[] {
  const rows = functionId
    ? db.prepare('SELECT * FROM schedules WHERE projectId=? AND functionId=? ORDER BY createdAt ASC').all(currentProjectId(), functionId)
    : db.prepare('SELECT * FROM schedules WHERE projectId=? ORDER BY createdAt ASC').all(currentProjectId());
  return (rows as any[]).map(fromRow);
}

export function createSchedule(functionId: string, input: { cron: string; timezone?: string; enabled?: boolean }): Schedule {
  const fn = store.getFunction(functionId);
  if (!fn) throw new Error('Function not found');
  const tz = input.timezone || 'UTC';
  const cron = String(input.cron || '').trim();
  const next = nextRun(cron, new Date(), tz); // 校验表达式
  const id = uid('sch_');
  db.prepare(`INSERT INTO schedules (id,projectId,functionId,cron,timezone,enabled,nextRunAt,lastRunAt,lastStatus,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, currentProjectId(), functionId, cron, tz, input.enabled === false ? 0 : 1,
    next.toISOString(), null, null, now(),
  );
  // 同步到函数概览里的 Schedule 字段
  db.prepare('UPDATE functions SET schedule=? WHERE id=?').run(cron, functionId);
  bus.publish({ type: 'schedule', action: 'create', resource: fn.name });
  return listSchedules(functionId).find((s) => s.id === id)!;
}

export function updateSchedule(id: string, patch: Partial<{ cron: string; timezone: string; enabled: boolean }>): Schedule | null {
  const r = db.prepare('SELECT * FROM schedules WHERE id=? AND projectId=?').get(id, currentProjectId()) as any;
  if (!r) return null;
  const cron = patch.cron ?? r.cron;
  const tz = patch.timezone ?? r.timezone ?? 'UTC';
  const enabled = patch.enabled ?? !!r.enabled;
  const next = nextRun(cron, new Date(), tz);
  db.prepare('UPDATE schedules SET cron=?,timezone=?,enabled=?,nextRunAt=? WHERE id=?').run(
    cron, tz, enabled ? 1 : 0, next.toISOString(), id,
  );
  db.prepare('UPDATE functions SET schedule=? WHERE id=?').run(cron, r.functionId);
  bus.publish({ type: 'schedule', action: 'update' });
  return fromRow(db.prepare('SELECT * FROM schedules WHERE id=?').get(id));
}

export function deleteSchedule(id: string): boolean {
  const r = db.prepare('SELECT * FROM schedules WHERE id=? AND projectId=?').get(id, currentProjectId()) as any;
  if (!r) return false;
  db.prepare('DELETE FROM schedules WHERE id=?').run(id);
  const left = db.prepare('SELECT COUNT(*) c FROM schedules WHERE functionId=?').get(r.functionId) as any;
  if (!left.c) db.prepare("UPDATE functions SET schedule='' WHERE id=?").run(r.functionId);
  bus.publish({ type: 'schedule', action: 'delete' });
  return true;
}

export function preview(expr: string, count = 3, timezone = 'UTC'): { next: string[]; description: string } {
  return { next: nextRuns(expr, count, new Date(), timezone), description: describeCron(expr) };
}

/** 取出所有到期且启用的调度（跨项目） */
export function dueSchedules(at: Date = new Date()): any[] {
  return db.prepare(
    'SELECT * FROM schedules WHERE enabled=1 AND nextRunAt IS NOT NULL AND nextRunAt<=? ORDER BY nextRunAt ASC LIMIT 20',
  ).all(at.toISOString()) as any[];
}

export function markRun(id: string, status: string, cron: string, timezone: string) {
  const next = nextRun(cron, new Date(), timezone || 'UTC');
  db.prepare('UPDATE schedules SET lastRunAt=?,lastStatus=?,nextRunAt=? WHERE id=?').run(
    now(), status, next.toISOString(), id,
  );
}

/** 调度执行器：每 15 秒扫一次到期任务 */
export function startScheduler() {
  const tick = async () => {
    const due = dueSchedules();
    for (const s of due) {
      try {
        const { withProject } = await import('./context.js');
        const r = await withProject(s.projectId, () => store.executeFunction(s.functionId, {
          scheduledAt: new Date().toISOString(), cron: s.cron, source: 'schedule',
        }, 'schedule'));
        markRun(s.id, r.status, s.cron, s.timezone);
      } catch (e: any) {
        markRun(s.id, 'failed', s.cron, s.timezone);
      }
    }
  };
  const timer = setInterval(() => { tick().catch(() => {}); }, 15_000);
  timer.unref?.();
  return timer;
}
