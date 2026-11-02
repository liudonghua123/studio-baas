/**
 * Project webhooks — the missing half of the event bus.
 *
 * `bus` already tells the console what changed; a webhook turns those events
 * into HTTP callbacks so an external service (a queue, a Slack relay, a test
 * harness) can react without polling. Deliveries are fire-and-forget with a
 * bounded retry ladder, and each request carries an HMAC signature the receiver
 * can verify with the subscription secret.
 */
import crypto from 'node:crypto';
import { db, now, uid } from './db.js';
import { currentProjectId } from './context.js';
import { bus } from './events.js';

export interface Webhook {
  id: string;
  /** set by the dispatcher so a delivery knows which project it belongs to */
  projectId?: string;
  url: string;
  events: string[];
  description: string | null;
  enabled: boolean;
  deliveries: number;
  failures: number;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  status: number | null;
  duration: number;
  error: string | null;
  attempts: number;
  createdAt: string;
}

const pid = () => currentProjectId();
const MAX_EVENTS = 40;

const rowToHook = (r: any): Webhook => ({
  id: r.id, projectId: r.projectId, url: r.url, events: JSON.parse(r.events || '[]'),
  description: r.description, enabled: !!r.enabled,
  deliveries: r.deliveries || 0, failures: r.failures || 0,
  lastStatus: r.lastStatus ?? null, lastError: r.lastError ?? null,
  lastDeliveryAt: r.lastDeliveryAt ?? null,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export function listWebhooks(): Webhook[] {
  return (db.prepare('SELECT * FROM webhooks WHERE projectId = ? ORDER BY createdAt ASC').all(pid()) as any[]).map(rowToHook);
}

export function getWebhook(id: string): Webhook | null {
  const r = db.prepare('SELECT * FROM webhooks WHERE id = ? AND projectId = ?').get(id, pid()) as any;
  return r ? rowToHook(r) : null;
}

function validateUrl(url: string) {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Webhook URL must be an absolute http(s) URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Webhook URL must use http or https');
  if (!parsed.hostname) throw new Error('Webhook URL is missing a host');
  return parsed.toString();
}

/** `document.created`, `document.*` and `*` are all valid; anything else is rejected loudly. */
const EVENT_RE = /^(\*|[a-z]+)(\.(\*|[a-z]+))?$/;
export function normalizeEvents(input: unknown): string[] {
  const list = Array.isArray(input) ? input.map(String) : input ? [String(input)] : ['*'];
  const out = [...new Set(list.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!out.length) out.push('*');
  for (const e of out) if (!EVENT_RE.test(e)) throw new Error(`Invalid event "${e}" (expected "resource.action", "resource.*" or "*")`);
  return out.slice(0, MAX_EVENTS);
}

export function createWebhook(input: { url: string; events?: unknown; secret?: string; description?: string; enabled?: boolean }): Webhook {
  if (!input?.url) throw new Error('url is required');
  const id = uid('wh_');
  const at = now();
  db.prepare(
    `INSERT INTO webhooks (id,projectId,url,events,secret,enabled,description,createdAt,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, pid(), validateUrl(input.url), JSON.stringify(normalizeEvents(input.events)),
    input.secret || crypto.randomBytes(24).toString('hex'), input.enabled === false ? 0 : 1,
    input.description || null, at, at);
  return getWebhook(id)!;
}

export function updateWebhook(id: string, patch: Partial<{ url: string; events: unknown; secret: string; description: string; enabled: boolean }>): Webhook | null {
  const cur = getWebhook(id);
  if (!cur) return null;
  const next = {
    url: patch.url ? validateUrl(patch.url) : cur.url,
    events: patch.events !== undefined ? normalizeEvents(patch.events) : cur.events,
    secret: patch.secret ?? '',
    description: patch.description !== undefined ? patch.description : cur.description || '',
    enabled: patch.enabled !== undefined ? patch.enabled : cur.enabled,
  };
  db.prepare(
    `UPDATE webhooks SET url=?, events=?, description=?, enabled=?, secret=COALESCE(NULLIF(?,''),secret), updatedAt=? WHERE id=? AND projectId=?`,
  ).run(next.url, JSON.stringify(next.events), next.description || null, next.enabled ? 1 : 0, next.secret, now(), id, pid());
  return getWebhook(id);
}

export function deleteWebhook(id: string): boolean {
  const ok = db.transaction(() => {
    const info = db.prepare('DELETE FROM webhooks WHERE id = ? AND projectId = ?').run(id, pid());
    if (!info.changes) return false;
    db.prepare('DELETE FROM webhookDeliveries WHERE webhookId = ?').run(id);
    return true;
  })();
  return !!ok;
}

export function rotateSecret(id: string): Webhook | null {
  const secret = crypto.randomBytes(24).toString('hex');
  db.prepare('UPDATE webhooks SET secret = ?, updatedAt = ? WHERE id = ? AND projectId = ?').run(secret, now(), id, pid());
  return getWebhook(id);
}

/** The signing secret is only shown right after creation/rotation. */
export function webhookSecret(id: string): string | null {
  const r = db.prepare('SELECT secret FROM webhooks WHERE id = ? AND projectId = ?').get(id, pid()) as any;
  return r?.secret || null;
}

export function listDeliveries(webhookId?: string, limit = 50): WebhookDelivery[] {
  const rows = webhookId
    ? db.prepare('SELECT * FROM webhookDeliveries WHERE webhookId = ? AND projectId = ? ORDER BY createdAt DESC LIMIT ?').all(webhookId, pid(), limit)
    : db.prepare('SELECT * FROM webhookDeliveries WHERE projectId = ? ORDER BY createdAt DESC LIMIT ?').all(pid(), limit);
  return (rows as any[]).map((r) => ({
    id: r.id, webhookId: r.webhookId, event: r.event, status: r.status,
    duration: r.duration, error: r.error, attempts: r.attempts, createdAt: r.createdAt,
  }));
}

/* ------------------------------------------------------------- delivery */

export function sign(secret: string, body: string, at = Math.floor(Date.now() / 1000)) {
  // Stripe-style: sign "{timestamp}.{payload}" so a captured request cannot be
  // replayed with a different body.
  const mac = crypto.createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${mac}`;
}

function matches(subs: string[], resource: string, action: string) {
  const full = `${resource}.${action}`;
  return subs.some((s) => s === '*' || s === full || s === `${resource}.*`);
}

const RETRY_DELAYS = [0, 250, 1000];

async function deliver(hook: Webhook, secret: string, event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  let lastError: string | null = null;
  let status: number | null = null;
  let attempts = 0;
  const started = Date.now();

  for (const delay of RETRY_DELAYS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    attempts++;
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'StudioBaaS-Webhook/1.0',
          'X-Studio-Event': event,
          'X-Studio-Delivery': uid('dlv_'),
          'X-Studio-Signature': sign(secret, body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      status = res.status;
      if (res.ok) { lastError = null; break; }
      lastError = `HTTP ${res.status}`;
      // 4xx (except 429) will not fix itself; stop retrying.
      if (res.status < 500 && res.status !== 429) break;
    } catch (e: any) {
      lastError = e?.name === 'TimeoutError' ? 'timeout after 5s' : (e?.message || String(e));
      status = null;
    }
  }

  const duration = Date.now() - started;
  const ok = status !== null && status >= 200 && status < 300;
  try {
    db.prepare(
      `INSERT INTO webhookDeliveries (id,webhookId,projectId,event,status,duration,error,attempts,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(uid('dlv_'), hook.id, hook.projectId ?? currentProjectId(), event, status, duration, lastError, attempts, now());
    db.prepare(
      `UPDATE webhooks SET deliveries = deliveries + 1, failures = failures + ?,
         lastStatus = ?, lastError = ?, lastDeliveryAt = ? WHERE id = ?`,
    ).run(ok ? 0 : 1, status, lastError, now(), hook.id);
  } catch { /* delivery bookkeeping must never break the request path */ }
}

/** Send a synthetic event so the user can verify their endpoint works. */
export async function testWebhook(id: string) {
  const hook = getWebhook(id);
  if (!hook) throw new Error('Webhook not found');
  const secret = webhookSecret(id) || '';
  const payload = {
    event: 'ping',
    projectId: pid(),
    at: now(),
    data: { message: 'This is a test delivery from Studio BaaS.', webhookId: id },
  };
  await deliver({ ...hook, projectId: pid() }, secret, 'ping', payload);
  return listDeliveries(id, 1)[0] || null;
}

/**
 * Subscribe once, at boot. Events arrive on the in-process bus, so this costs
 * nothing when no webhook is configured: the query returns an empty array.
 */
export function startWebhookDispatcher() {
  bus.on('event', (e: any) => {
    try {
      const hooks = db.prepare('SELECT * FROM webhooks WHERE projectId = ? AND enabled = 1')
        .all(e.projectId || 'studio') as any[];
      if (!hooks.length) return;
      const targets = hooks
        .map((r) => ({ row: r, hook: rowToHook(r) }))
        .filter(({ hook }) => matches(hook.events, e.type, e.action));
      if (!targets.length) return;

      const payload = {
        event: e.type === 'log' ? 'log.created' : `${e.type}.${e.action}`,
        projectId: e.projectId,
        at: e.at,
        data: { resource: e.resource, detail: e.detail },
      };
      for (const { row, hook } of targets) {
        // Fire and forget: a slow endpoint must not delay the API response.
        setImmediate(() => { void deliver(hook, row.secret || '', payload.event, payload); });
      }
    } catch { /* never throw from an event listener */ }
  });
}
