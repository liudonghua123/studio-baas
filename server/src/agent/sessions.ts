/**
 * Persistent AI conversations.
 *
 * Without this, closing the tab loses the whole thread — including the tool
 * traces that explain what the agent actually did. Sessions are project-scoped
 * like every other resource, so switching projects shows a different history.
 */
import { db, now, uid } from '../db.js';
import { currentProjectId } from '../context.js';

export interface AiSession {
  id: string;
  title: string;
  model: string | null;
  provider: string | null;
  messages: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  traces: unknown[];
  createdAt: string;
}

const pid = () => currentProjectId();

/** Derive a readable title from the first user turn. */
export function titleFrom(text: string) {
  const clean = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? `${clean.slice(0, 47).trimEnd()}…` : clean || 'New conversation';
}

export function listSessions(limit = 50): AiSession[] {
  const rows = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM aiMessages m WHERE m.sessionId = s.id) AS messages
    FROM aiSessions s WHERE s.projectId = ? ORDER BY s.updatedAt DESC LIMIT ?
  `).all(pid(), Math.min(Math.max(limit, 1), 200)) as any[];
  return rows.map((r) => ({
    id: r.id, title: r.title, model: r.model, provider: r.provider,
    messages: r.messages, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }));
}

export function getSession(id: string): AiSession | null {
  const r = db.prepare('SELECT * FROM aiSessions WHERE id = ? AND projectId = ?').get(id, pid()) as any;
  if (!r) return null;
  const { c } = db.prepare('SELECT COUNT(*) c FROM aiMessages WHERE sessionId = ?').get(id) as any;
  return {
    id: r.id, title: r.title, model: r.model, provider: r.provider,
    messages: c, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export function createSession(input: { title?: string; model?: string; provider?: string } = {}): AiSession {
  const id = uid('chat_');
  const at = now();
  db.prepare(
    'INSERT INTO aiSessions (id,projectId,title,model,provider,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)',
  ).run(id, pid(), (input.title || 'New conversation').slice(0, 120), input.model || null, input.provider || null, at, at);
  return getSession(id)!;
}

export function renameSession(id: string, title: string): AiSession | null {
  const clean = title.trim().slice(0, 120);
  if (!clean) throw new Error('Title cannot be empty');
  const info = db.prepare('UPDATE aiSessions SET title = ?, updatedAt = ? WHERE id = ? AND projectId = ?')
    .run(clean, now(), id, pid());
  return info.changes ? getSession(id) : null;
}

export function deleteSession(id: string): boolean {
  const ok = db.transaction(() => {
    const info = db.prepare('DELETE FROM aiSessions WHERE id = ? AND projectId = ?').run(id, pid());
    if (!info.changes) return false;
    db.prepare('DELETE FROM aiMessages WHERE sessionId = ?').run(id);
    return true;
  })();
  return !!ok;
}

export function listMessages(sessionId: string, limit = 200): AiMessage[] {
  const rows = db.prepare(
    'SELECT * FROM aiMessages WHERE sessionId = ? ORDER BY createdAt ASC, rowid ASC LIMIT ?',
  ).all(sessionId, limit) as any[];
  return rows.map((r) => ({
    id: r.id, sessionId: r.sessionId, role: r.role, content: r.content,
    traces: (() => { try { return JSON.parse(r.traces || '[]'); } catch { return []; } })(),
    createdAt: r.createdAt,
  }));
}

function insertMessage(sessionId: string, role: 'user' | 'assistant', content: string, traces: unknown[] = []) {
  db.prepare('INSERT INTO aiMessages (id,sessionId,role,content,traces,createdAt) VALUES (?,?,?,?,?,?)')
    .run(uid('msg_'), sessionId, role, content, JSON.stringify(traces), now());
}

/**
 * Persist a completed turn. Also seeds the title from the first user message and
 * bumps `updatedAt` so the sidebar ordering reflects real activity.
 */
export function saveTurn(sessionId: string, userText: string, assistantText: string, traces: unknown[]) {
  const session = getSession(sessionId);
  if (!session) return null;
  db.transaction(() => {
    insertMessage(sessionId, 'user', userText);
    if (assistantText.trim()) insertMessage(sessionId, 'assistant', assistantText, traces);
    const patch: string[] = ['updatedAt = ?'];
    const params: any[] = [now()];
    // Only auto-title a thread the user has not named. Overwriting an explicit
    // title on the first turn would silently discard what the caller asked for.
    if (session.title === 'New conversation') {
      patch.push('title = ?');
      params.push(titleFrom(userText));
    }
    db.prepare(`UPDATE aiSessions SET ${patch.join(', ')} WHERE id = ?`).run(...params, sessionId);
  })();
  return getSession(sessionId);
}

/** Best-effort cleanup when a project is deleted. */
export function deleteSessionsForProject(projectId: string) {
  const ids = (db.prepare('SELECT id FROM aiSessions WHERE projectId = ?').all(projectId) as any[]).map((r) => r.id);
  for (const id of ids) db.prepare('DELETE FROM aiMessages WHERE sessionId = ?').run(id);
  db.prepare('DELETE FROM aiSessions WHERE projectId = ?').run(projectId);
}
