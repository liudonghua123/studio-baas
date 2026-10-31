import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now, uid, UPLOAD_DIR } from './db.js';
import { bus } from './events.js';
import { executeFunctionCode, type ExecContext } from './runtime.js';
import { currentProjectId } from './context.js';
import { parseQueries } from './query.js';

/** 当前请求所属项目；store 层所有查询据此隔离 */
const pid = () => currentProjectId();

/* ------------------------------------------------------------------ types */

export type AttributeType =
  | 'string' | 'email' | 'integer' | 'float' | 'boolean' | 'datetime' | 'url' | 'enum' | 'text';

export interface Attribute {
  id: string; collectionId: string; key: string; type: AttributeType;
  required: boolean; array: boolean; size?: number; defaultVal?: string | null;
  elements?: string[]; createdAt: string;
}

export interface Collection {
  id: string; name: string; key: string; icon: string; color: string;
  documentSecurity: boolean; enabled: boolean; createdAt: string; updatedAt: string;
  attributes?: Attribute[]; documentCount?: number;
}

export interface Doc {
  id: string; collectionId: string; data: Record<string, unknown>;
  permissions: string[]; createdAt: string; updatedAt: string;
}

const safeJson = <T,>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/** 文档元字段，作为属性名会与 API 返回结构冲突 */
const RESERVED_KEYS = new Set([
  'id', 'data', 'permissions', 'createdAt', 'updatedAt',
  '$id', '$createdAt', '$updatedAt', '$permissions', '$collectionId',
]);

/* ------------------------------------------------------------- collections */

export function listCollections(withStats = true): Collection[] {
  const rows = db.prepare('SELECT * FROM collections WHERE projectId=? ORDER BY createdAt ASC').all(pid()) as any[];
  return rows.map((r) => {
    const c: Collection = {
      id: r.id, name: r.name, key: r.key, icon: r.icon || 'database', color: r.color || '#6C5CE7',
      documentSecurity: !!r.documentSecurity, enabled: !!r.enabled,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
    if (withStats) {
      c.attributes = listAttributes(c.id);
      c.documentCount = (db.prepare('SELECT COUNT(*) c FROM documents WHERE collectionId=?').get(c.id) as any).c;
    }
    return c;
  });
}

export function getCollection(idOrKey: string): Collection | null {
  const r = db.prepare('SELECT * FROM collections WHERE (id=? OR key=?) AND projectId=?').get(idOrKey, idOrKey, pid()) as any;
  if (!r) return null;
  return {
    id: r.id, name: r.name, key: r.key, icon: r.icon, color: r.color,
    documentSecurity: !!r.documentSecurity, enabled: !!r.enabled,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
    attributes: listAttributes(r.id),
    documentCount: (db.prepare('SELECT COUNT(*) c FROM documents WHERE collectionId=?').get(r.id) as any).c,
  };
}

export function listAttributes(collectionId: string): Attribute[] {
  const rows = db.prepare('SELECT * FROM attributes WHERE collectionId=? ORDER BY createdAt ASC').all(collectionId) as any[];
  return rows.map((r) => ({
    id: r.id, collectionId: r.collectionId, key: r.key, type: r.type as AttributeType,
    required: !!r.required, array: !!r.array, size: r.size ?? undefined,
    defaultVal: r.defaultVal, elements: safeJson<string[]>(r.elements, []), createdAt: r.createdAt,
  }));
}

export function createCollection(input: {
  name: string; key?: string; icon?: string; color?: string; documentSecurity?: boolean;
}): Collection {
  const key = (input.key || input.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `collection_${Date.now()}`;
  if (db.prepare('SELECT 1 FROM collections WHERE key=? AND projectId=?').get(key, pid())) {
    throw new Error(`Collection key "${key}" already exists`);
  }
  const id = uid('col_');
  const t = now();
  db.prepare(`INSERT INTO collections (id,name,key,icon,color,documentSecurity,enabled,createdAt,updatedAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, key, input.icon || 'database', input.color || '#6C5CE7',
    input.documentSecurity ? 1 : 0, 1, t, t, pid(),
  );
  bus.publish({ type: 'collection', action: 'create', resource: input.name });
  return getCollection(id)!;
}

export function updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'icon' | 'color' | 'enabled' | 'documentSecurity'>>): Collection | null {
  const cur = getCollection(id);
  if (!cur) return null;
  db.prepare('UPDATE collections SET name=?,icon=?,color=?,enabled=?,documentSecurity=?,updatedAt=? WHERE id=?').run(
    patch.name ?? cur.name, patch.icon ?? cur.icon, patch.color ?? cur.color,
    (patch.enabled ?? cur.enabled) ? 1 : 0, (patch.documentSecurity ?? cur.documentSecurity) ? 1 : 0,
    now(), id,
  );
  bus.publish({ type: 'collection', action: 'update', resource: cur.name });
  return getCollection(id);
}

export function deleteCollection(id: string): boolean {
  const cur = getCollection(id);
  if (!cur) return false;
  db.transaction(() => {
    db.prepare('DELETE FROM documents WHERE collectionId=?').run(id);
    db.prepare('DELETE FROM attributes WHERE collectionId=?').run(id);
    db.prepare('DELETE FROM collections WHERE id=?').run(id);
  })();
  bus.publish({ type: 'collection', action: 'delete', resource: cur.name });
  return true;
}

export const ATTRIBUTE_TYPES: AttributeType[] = ['string', 'email', 'integer', 'float', 'boolean', 'datetime', 'url', 'enum', 'text'];

export function addAttribute(collectionId: string, input: {
  key: string; type: AttributeType; required?: boolean; array?: boolean;
  size?: number; defaultVal?: string; elements?: string[];
}): Attribute {
  if (!getCollection(collectionId)) throw new Error('Collection not found');
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(input.key)) throw new Error('Attribute key must be alphanumeric');
  if (RESERVED_KEYS.has(input.key)) throw new Error(`"${input.key}" is a reserved key`);
  if (!ATTRIBUTE_TYPES.includes(input.type)) {
    throw new Error(`Unknown attribute type "${input.type}". Expected one of: ${ATTRIBUTE_TYPES.join(', ')}`);
  }
  if (listAttributes(collectionId).some((a) => a.key === input.key)) {
    throw new Error(`Attribute "${input.key}" already exists in this collection`);
  }
  if (input.type === 'enum') {
    const els = input.elements ?? [];
    if (!els.length) throw new Error('Enum attributes need at least one element');
    if (els.some((e) => typeof e !== 'string' || !e.trim())) throw new Error('Enum elements must be non-empty strings');
  }
  const id = uid('attr_');
  db.prepare(`INSERT INTO attributes (id,collectionId,key,type,required,array,size,defaultVal,elements,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, collectionId, input.key, input.type, input.required ? 1 : 0, input.array ? 1 : 0,
    input.size ?? null, input.defaultVal ?? null, JSON.stringify(input.elements ?? []), now(),
  );
  bus.publish({ type: 'collection', action: 'attribute.create', resource: input.key });
  return listAttributes(collectionId).find((a) => a.id === id)!;
}

export function deleteAttribute(collectionId: string, attributeId: string): boolean {
  const r = db.prepare('DELETE FROM attributes WHERE id=? AND collectionId=?').run(attributeId, collectionId);
  bus.publish({ type: 'collection', action: 'attribute.delete' });
  return r.changes > 0;
}

/* --------------------------------------------------------------- documents */

function docFromRow(r: any): Doc {
  return {
    id: r.id, collectionId: r.collectionId,
    data: safeJson<Record<string, unknown>>(r.data, {}),
    permissions: safeJson<string[]>(r.permissions, []),
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export function coerceValue(attr: Attribute, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') {
    if (attr.required) throw new Error(`Attribute "${attr.key}" is required`);
    return attr.defaultVal ?? null;
  }
  if (attr.array) {
    const arr = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim()).filter(Boolean);
    return arr.map((v) => coerceValue({ ...attr, array: false, required: false }, v));
  }
  switch (attr.type) {
    case 'integer': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`"${attr.key}" must be an integer`);
      return Math.trunc(n);
    }
    case 'float': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`"${attr.key}" must be a number`);
      return n;
    }
    case 'boolean':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(raw))) throw new Error(`"${attr.key}" must be a valid email`);
      return String(raw);
    case 'url':
      if (!/^https?:\/\//.test(String(raw))) throw new Error(`"${attr.key}" must be a valid URL`);
      return String(raw);
    case 'enum': {
      const v = String(raw);
      if (attr.elements?.length && !attr.elements.includes(v)) {
        throw new Error(`"${attr.key}" must be one of: ${attr.elements.join(', ')}`);
      }
      return v;
    }
    default:
      return String(raw);
  }
}

export function validateDocument(collectionId: string, data: Record<string, unknown>): Record<string, unknown> {
  const attrs = listAttributes(collectionId);
  const out: Record<string, unknown> = {};
  for (const a of attrs) {
    if (!(a.key in data)) {
      if (a.required) throw new Error(`Attribute "${a.key}" is required`);
      continue;
    }
    out[a.key] = coerceValue(a, data[a.key]);
  }
  return out;
}

export function listDocuments(collectionId: string, opts: {
  limit?: number; offset?: number; search?: string; orderBy?: string; orderType?: 'asc' | 'desc';
  queries?: unknown;
} = {}) {
  const col = getCollection(collectionId);
  if (!col) throw new Error(`Collection "${collectionId}" not found`);
  // Appwrite 风格查询：equal(...) / orderDesc(...) / limit(...) 等，参数全部走占位符
  const q = parseQueries(opts.queries);
  const limit = Math.min(Math.max(q.limit ?? opts.limit ?? 25, 1), 100);
  const offset = Math.max(q.offset ?? opts.offset ?? 0, 0);
  const where: string[] = ['collectionId=?'];
  const params: any[] = [col.id];
  if (opts.search) {
    where.push('data LIKE ?');
    params.push(`%${opts.search}%`);
  }
  where.push(...q.where);
  params.push(...q.params);
  let order = 'createdAt DESC';
  if (q.order) {
    order = q.order;
  } else if (opts.orderBy) {
    const dir = opts.orderType === 'asc' ? 'ASC' : 'DESC';
    order = opts.orderBy === '$createdAt' ? `createdAt ${dir}` : `json_extract(data, '$.${opts.orderBy.replace(/[^a-zA-Z0-9_]/g, '')}') ${dir}`;
  }
  const total = (db.prepare(`SELECT COUNT(*) c FROM documents WHERE ${where.join(' AND ')}`).get(...params) as any).c;
  const rows = db.prepare(
    `SELECT * FROM documents WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as any[];
  const documents = rows.map(docFromRow);
  if (q.select) {
    const keep = new Set(q.select);
    for (const d of documents) {
      d.data = Object.fromEntries(Object.entries(d.data).filter(([k]) => keep.has(k)));
    }
  }
  return { total, limit, offset, documents };
}

export function getDocument(collectionId: string, docId: string): Doc | null {
  const col = getCollection(collectionId);
  if (!col) return null;
  const r = db.prepare('SELECT * FROM documents WHERE id=? AND collectionId=?').get(docId, col.id) as any;
  return r ? docFromRow(r) : null;
}

export function createDocument(collectionId: string, data: Record<string, unknown>, docId?: string, permissions: string[] = ['read("any")', 'update("users")', 'delete("users")']): Doc {
  const col = getCollection(collectionId);
  if (!col) throw new Error(`Collection "${collectionId}" not found`);
  const clean = validateDocument(col.id, data);
  const id = docId || uid('doc_');
  const t = now();
  db.prepare('INSERT INTO documents (id,collectionId,data,permissions,createdAt,updatedAt) VALUES (?,?,?,?,?,?)').run(
    id, col.id, JSON.stringify(clean), JSON.stringify(permissions), t, t,
  );
  bus.publish({ type: 'document', action: 'create', resource: col.key });
  return getDocument(col.id, id)!;
}

export function updateDocument(collectionId: string, docId: string, data: Record<string, unknown>, merge = true): Doc | null {
  const col = getCollection(collectionId);
  if (!col) return null;
  const cur = getDocument(col.id, docId);
  if (!cur) return null;
  const merged = merge ? { ...cur.data, ...data } : data;
  const clean = validateDocument(col.id, merged);
  db.prepare('UPDATE documents SET data=?, updatedAt=? WHERE id=?').run(JSON.stringify(clean), now(), docId);
  bus.publish({ type: 'document', action: 'update', resource: col.key });
  return getDocument(col.id, docId);
}

export function deleteDocument(collectionId: string, docId: string): boolean {
  const col = getCollection(collectionId);
  if (!col) return false;
  const r = db.prepare('DELETE FROM documents WHERE id=? AND collectionId=?').run(docId, col.id);
  bus.publish({ type: 'document', action: 'delete', resource: col.key });
  return r.changes > 0;
}

/* ------------------------------------------------------------------- files */

export function listBuckets() {
  const rows = db.prepare('SELECT * FROM buckets WHERE projectId=? ORDER BY createdAt ASC').all(pid()) as any[];
  return rows.map((r) => ({
    id: r.id, name: r.name, maxFileSize: r.maxFileSize,
    allowedExtensions: safeJson<string[]>(r.allowedExtensions, []),
    compression: r.compression || 'none', encryption: !!r.encryption,
    imageTransform: !!r.imageTransform, createdAt: r.createdAt,
    fileCount: (db.prepare('SELECT COUNT(*) c FROM files WHERE bucketId=?').get(r.id) as any).c,
    totalSize: (db.prepare('SELECT COALESCE(SUM(size),0) c FROM files WHERE bucketId=?').get(r.id) as any).c,
  }));
}

export function createBucket(input: { name: string; maxFileSize?: number; allowedExtensions?: string[]; compression?: string; encryption?: boolean; imageTransform?: boolean }) {
  const id = uid('bkt_');
  db.prepare(`INSERT INTO buckets (id,name,maxFileSize,allowedExtensions,compression,encryption,imageTransform,createdAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, input.maxFileSize ?? 5 * 1024 * 1024,
    JSON.stringify(input.allowedExtensions ?? []), input.compression ?? 'none',
    input.encryption ? 1 : 0, input.imageTransform ? 1 : 0, now(), pid(),
  );
  bus.publish({ type: 'file', action: 'bucket.create', resource: input.name });
  return listBuckets().find((b) => b.id === id)!;
}

export function deleteBucket(id: string) {
  const files = db.prepare('SELECT * FROM files WHERE bucketId=?').all(id) as any[];
  for (const f of files) { try { fs.unlinkSync(f.path); } catch {} }
  db.prepare('DELETE FROM files WHERE bucketId=?').run(id);
  const r = db.prepare('DELETE FROM buckets WHERE id=?').run(id);
  bus.publish({ type: 'file', action: 'bucket.delete' });
  return r.changes > 0;
}

export function listFiles(bucketId: string) {
  const rows = db.prepare('SELECT * FROM files WHERE bucketId=? ORDER BY createdAt DESC').all(bucketId) as any[];
  return rows.map((r) => ({
    id: r.id, bucketId: r.bucketId, name: r.name, mimeType: r.mimeType,
    size: r.size, createdAt: r.createdAt,
    url: `/v1/storage/files/${r.id}/view`,
  }));
}

export function getFile(id: string) {
  return db.prepare('SELECT * FROM files WHERE id=?').get(id) as any;
}

export function saveFile(bucketId: string, file: { originalname: string; mimetype: string; size: number; buffer: Buffer }) {
  const bucket = db.prepare('SELECT * FROM buckets WHERE id=?').get(bucketId) as any;
  if (!bucket) throw new Error('Bucket not found');
  const allowed = safeJson<string[]>(bucket.allowedExtensions, []);
  const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
  if (allowed.length && !allowed.includes(ext)) throw new Error(`Extension .${ext} is not allowed`);
  if (file.size > bucket.maxFileSize) throw new Error('File exceeds bucket max size');
  const id = uid('file_');
  const filename = `${id}${ext ? '.' + ext : ''}`;
  const target = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(target, file.buffer);
  db.prepare('INSERT INTO files (id,bucketId,name,mimeType,size,path,createdAt) VALUES (?,?,?,?,?,?,?)').run(
    id, bucketId, file.originalname, file.mimetype, file.size, target, now(),
  );
  bus.publish({ type: 'file', action: 'create', resource: file.originalname });
  return listFiles(bucketId).find((f) => f.id === id)!;
}

export function deleteFile(id: string) {
  const f = getFile(id);
  if (!f) return false;
  try { fs.unlinkSync(f.path); } catch {}
  db.prepare('DELETE FROM files WHERE id=?').run(id);
  bus.publish({ type: 'file', action: 'delete', resource: f.name });
  return true;
}

/* --------------------------------------------------------------- functions */

const funcFromRow = (r: any) => ({
  id: r.id, name: r.name, runtime: r.runtime, entrypoint: r.entrypoint, code: r.code,
  schedule: r.schedule, timeout: r.timeout, env: safeJson<Record<string, string>>(r.env, {}),
  enabled: !!r.enabled, executeAccess: r.executeAccess || 'any',
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export function listFunctions() {
  const rows = db.prepare('SELECT * FROM functions WHERE projectId=? ORDER BY createdAt ASC').all(pid()) as any[];
  return rows.map((r) => ({
    ...funcFromRow(r),
    executions: (db.prepare('SELECT COUNT(*) c FROM executions WHERE functionId=?').get(r.id) as any).c,
    lastExecution: db.prepare('SELECT createdAt,status FROM executions WHERE functionId=? ORDER BY createdAt DESC LIMIT 1').get(r.id) as any || null,
  }));
}

export function getFunction(id: string) {
  const r = db.prepare('SELECT * FROM functions WHERE id=?').get(id) as any;
  return r ? funcFromRow(r) : null;
}

export function createFunction(input: { name: string; runtime?: string; code?: string; entrypoint?: string; timeout?: number; env?: Record<string, string>; schedule?: string }) {
  const id = uid('fn_');
  const t = now();
  db.prepare(`INSERT INTO functions (id,name,runtime,entrypoint,code,schedule,timeout,env,enabled,executeAccess,createdAt,updatedAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, input.runtime || 'node-22', input.entrypoint || 'src/main.js',
    input.code || DEFAULT_FUNCTION_CODE, input.schedule || '', input.timeout ?? 15,
    JSON.stringify(input.env || {}), 1, 'any', t, t, pid(),
  );
  bus.publish({ type: 'function', action: 'create', resource: input.name });
  return getFunction(id)!;
}

export function updateFunction(id: string, patch: Partial<{
  name: string; code: string; env: Record<string, string>; timeout: number; enabled: boolean;
  schedule: string; runtime: string; entrypoint: string;
  /** Appwrite 风格的变量数组，等价于 env 对象 */
  variables: { key: string; value: string }[];
}>) {
  const cur = getFunction(id);
  if (!cur) return null;
  // 同时接受 { env: {K:V} } 与 Appwrite 的 variables: [{key,value}]
  const env = patch.env
    ?? (Array.isArray(patch.variables)
      ? Object.fromEntries(patch.variables.filter((v) => v && v.key).map((v) => [String(v.key), String(v.value ?? '')]))
      : cur.env);
  db.prepare(`UPDATE functions SET name=?,code=?,env=?,timeout=?,enabled=?,schedule=?,runtime=?,entrypoint=?,updatedAt=? WHERE id=?`).run(
    patch.name ?? cur.name, patch.code ?? cur.code, JSON.stringify(env),
    patch.timeout ?? cur.timeout, (patch.enabled ?? cur.enabled) ? 1 : 0,
    patch.schedule ?? cur.schedule, patch.runtime ?? cur.runtime, patch.entrypoint ?? cur.entrypoint, now(), id,
  );
  bus.publish({ type: 'function', action: 'update', resource: cur.name });
  return getFunction(id);
}

export function deleteFunction(id: string) {
  const cur = getFunction(id);
  if (!cur) return false;
  db.prepare('DELETE FROM executions WHERE functionId=?').run(id);
  // 删除函数时一并清理它的附属资源，避免悬挂的域名/调度/仓库绑定
  try {
    db.prepare('DELETE FROM functionDomains WHERE functionId=?').run(id);
    db.prepare('DELETE FROM schedules WHERE functionId=?').run(id);
    db.prepare('DELETE FROM gitIntegrations WHERE functionId=?').run(id);
    db.prepare('DELETE FROM gitDeploys WHERE functionId=?').run(id);
  } catch { /* 表可能尚未迁移 */ }
  db.prepare('DELETE FROM functions WHERE id=?').run(id);
  bus.publish({ type: 'function', action: 'delete', resource: cur.name });
  return true;
}

export function countExecutions(functionId?: string): number {
  const row = functionId
    ? db.prepare('SELECT COUNT(*) c FROM executions WHERE functionId=? AND projectId=?').get(functionId, pid())
    : db.prepare('SELECT COUNT(*) c FROM executions WHERE projectId=?').get(pid());
  return (row as any)?.c || 0;
}

export function listExecutions(functionId?: string, limit = 30) {
  const rows = functionId
    ? db.prepare('SELECT * FROM executions WHERE functionId=? AND projectId=? ORDER BY createdAt DESC LIMIT ?').all(functionId, pid(), limit)
    : db.prepare('SELECT * FROM executions WHERE projectId=? ORDER BY createdAt DESC LIMIT ?').all(pid(), limit);
  return (rows as any[]).map((r) => ({
    id: r.id, functionId: r.functionId, status: r.status, triggerType: r.triggerType,
    duration: r.duration, logs: safeJson<string[]>(r.logs, []),
    response: safeJson<any>(r.response, null), errors: safeJson<string[]>(r.errors, []),
    createdAt: r.createdAt,
    functionName: (db.prepare('SELECT name FROM functions WHERE id=?').get(r.functionId) as any)?.name || 'deleted',
  }));
}

export async function executeFunction(id: string, payload: any, triggerType = 'manual'): Promise<any> {
  const fn = getFunction(id);
  if (!fn) throw new Error('Function not found');
  if (!fn.enabled) throw new Error('Function is disabled');
  const started = Date.now();
  const logs: string[] = [];
  const errors: string[] = [];
  const res = {
    status: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    json(body: any) { this.body = body; this.headers['content-type'] = 'application/json'; return this; },
    text(body: string) { this.body = body; this.headers['content-type'] = 'text/plain'; return this; },
    send(body: any) { this.body = body; return this; },
    redirect(url: string) { this.status = 302; this.headers.location = url; this.body = url; return this; },
  };

  const ctx = {
    req: {
      method: 'POST', path: `/v1/functions/${id}/executions`, headers: { 'content-type': 'application/json' },
      body: payload ?? {}, query: {},
    },
    res,
    log: (...args: any[]) => logs.push(args.map(stringify).join(' ')),
    error: (...args: any[]) => { const m = args.map(stringify).join(' '); logs.push('ERROR ' + m); errors.push(m); },
    env: fn.env,
    databases: {
      listCollections: () => listCollections(false),
      listDocuments: (cid: string, opts: any) => listDocuments(cid, opts),
      getDocument: (cid: string, did: string) => getDocument(cid, did),
      createDocument: (cid: string, data: any) => createDocument(cid, data),
      updateDocument: (cid: string, did: string, data: any) => updateDocument(cid, did, data),
      deleteDocument: (cid: string, did: string) => deleteDocument(cid, did),
    },
    storage: { listFiles, listBuckets },
    users: { list: () => listUsers() },
    meta: { functionId: id, functionName: fn.name, projectId: pid() },
  } satisfies ExecContext;

  let status: 'completed' | 'failed' = 'completed';
  try {
    const outcome = await executeFunctionCode(fn.code, ctx, fn.timeout);
    // worker 在独立线程里收集的日志要搬回来一起落库
    if (outcome.logs.length) logs.push(...outcome.logs);
    if (outcome.errors.length) errors.push(...outcome.errors);
    if (outcome.status !== undefined) res.status = outcome.status;
    if (outcome.headers) res.headers = { ...res.headers, ...outcome.headers };
    if (outcome.failure) throw new Error(outcome.failure);
    if (outcome.value !== undefined && res.body === null) res.body = outcome.value;
  } catch (e: any) {
    status = 'failed';
    errors.push(e?.message || String(e));
  }
  const duration = Date.now() - started;
  const execId = uid('exec_');
  db.prepare(`INSERT INTO executions (id,functionId,status,triggerType,duration,logs,response,errors,createdAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    execId, id, status, triggerType, duration, JSON.stringify(logs),
    JSON.stringify(res.body), JSON.stringify(errors), now(), pid(),
  );
  addLog({ method: 'POST', path: `/v1/functions/${fn.name}/executions`, status: status === 'completed' ? 200 : 500, duration, service: 'functions' });
  bus.publish({ type: 'execution', action: status, resource: fn.name });
  return {
    id: execId, functionId: id, functionName: fn.name, status, duration,
    statusCode: res.status, headers: res.headers, response: res.body, logs, errors,
    trigger: triggerType, createdAt: now(),
  };
}

function stringify(v: any): string {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/* ------------------------------------------------------------------- sites */

const siteFromRow = (r: any) => ({
  id: r.id, name: r.name, framework: r.framework, domain: r.domain, entrypoint: r.entrypoint,
  buildCommand: r.buildCommand, files: safeJson<{ path: string; content: string }[]>(r.files, []),
  status: r.status, buildLogs: safeJson<string[]>(r.buildLogs, []),
  createdAt: r.createdAt, updatedAt: r.updatedAt,
});

export function listSites() {
  return (db.prepare('SELECT * FROM sites WHERE projectId=? ORDER BY createdAt ASC').all(pid()) as any[]).map((r) => {
    const s = siteFromRow(r);
    return { ...s, fileCount: s.files.length };
  });
}

export function getSite(id: string) {
  const r = db.prepare('SELECT * FROM sites WHERE id=?').get(id) as any;
  return r ? siteFromRow(r) : null;
}

export function createSite(input: { name: string; framework?: string; files?: { path: string; content: string }[]; entrypoint?: string; domain?: string }) {
  const id = uid('site_');
  const t = now();
  const files = input.files?.length ? input.files : [{ path: 'index.html', content: EMPTY_SITE_CODE }];
  db.prepare(`INSERT INTO sites (id,name,framework,domain,entrypoint,buildCommand,files,status,buildLogs,createdAt,updatedAt,projectId)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, input.framework || 'static', input.domain || `${input.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}.studio.app`,
    input.entrypoint || 'index.html', 'npm run build', JSON.stringify(files), 'ready',
    JSON.stringify(['✓ Build started', '✓ 3 files processed', '✓ Deployed to edge']), t, t, pid(),
  );
  bus.publish({ type: 'site', action: 'create', resource: input.name });
  return getSite(id)!;
}

export function updateSite(id: string, patch: Partial<{ name: string; files: { path: string; content: string }[]; entrypoint: string; domain: string; framework: string; status: string }>) {
  const cur = getSite(id);
  if (!cur) return null;
  db.prepare('UPDATE sites SET name=?,files=?,entrypoint=?,domain=?,framework=?,status=?,updatedAt=? WHERE id=?').run(
    patch.name ?? cur.name, JSON.stringify(patch.files ?? cur.files), patch.entrypoint ?? cur.entrypoint,
    patch.domain ?? cur.domain, patch.framework ?? cur.framework, patch.status ?? cur.status, now(), id,
  );
  bus.publish({ type: 'site', action: 'update', resource: cur.name });
  return getSite(id);
}

export function deploySite(id: string) {
  const site = getSite(id);
  if (!site) return null;
  db.prepare('UPDATE sites SET status=?,buildLogs=?,updatedAt=? WHERE id=?').run(
    'ready',
    JSON.stringify([
      `▸ ${new Date().toLocaleTimeString()} Build started (${site.framework})`,
      `▸ ${site.files.length} files uploaded`,
      '▸ Running production build…',
      '✓ Build completed in 1.24s',
      `✓ Deployment live at ${site.domain}`,
    ]),
    now(), id,
  );
  addLog({ method: 'POST', path: `/v1/sites/${site.name}/deployments`, status: 200, duration: 1240, service: 'sites' });
  bus.publish({ type: 'site', action: 'deploy', resource: site.name });
  return getSite(id);
}

export function deleteSite(id: string) {
  const cur = getSite(id);
  if (!cur) return false;
  db.prepare('DELETE FROM sites WHERE id=?').run(id);
  bus.publish({ type: 'site', action: 'delete', resource: cur.name });
  return true;
}

export function siteFile(siteId: string, filePath: string) {
  const site = getSite(siteId);
  if (!site) return null;
  const clean = decodeURIComponent(filePath || '').replace(/^\/+/, '') || site.entrypoint;
  const exact = site.files.find((x) => x.path === clean);
  if (exact) return exact;
  // 只有「看起来像页面路由」的路径才回退到入口 HTML（SPA 前端路由）；
  // 缺失的静态资源（/logo.png、/app.js）必须 404，否则浏览器会拿到 HTML 当脚本执行
  const last = clean.split('/').pop() || '';
  if (!last.includes('.') || clean.endsWith('/')) {
    return site.files.find((x) => x.path === site.entrypoint) || site.files[0] || null;
  }
  return null;
}

/* ------------------------------------------------------------------- users */

/**
 * 口令哈希：每个用户独立随机盐，格式 `scrypt$<salt>$<hash>`。
 * 旧数据是「固定盐 + 纯 hash」，验证通过后会在登录时自动升级为新格式。
 */
const hashPassword = (pw: string, salt = crypto.randomBytes(16).toString('hex')) =>
  `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;

const safeEqual = (a: string, b: string) => {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    if (!salt || !hash) return false;
    return safeEqual(crypto.scryptSync(pw, salt, 32).toString('hex'), hash);
  }
  // 兼容历史固定盐格式
  return safeEqual(crypto.scryptSync(pw, 'studio-salt', 32).toString('hex'), stored);
}

export function listUsers() {
  const rows = db.prepare('SELECT * FROM users ORDER BY createdAt DESC').all() as any[];
  return rows.map((r) => ({
    id: r.id, name: r.name, email: r.email, status: r.status, emailVerified: !!r.emailVerified,
    labels: safeJson<string[]>(r.labels, []), prefs: safeJson<Record<string, unknown>>(r.prefs, {}),
    createdAt: r.createdAt, lastLoginAt: r.lastLoginAt,
  }));
}

export function createUser(input: { name: string; email: string; password?: string; labels?: string[]; prefs?: Record<string, unknown> }) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Invalid email address');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new Error('User with this email already exists');
  const id = uid('usr_');
  db.prepare(`INSERT INTO users (id,name,email,passwordHash,status,emailVerified,labels,prefs,createdAt,lastLoginAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, input.name, email, hashPassword(input.password || crypto.randomBytes(8).toString('hex')),
    'active', 0, JSON.stringify(input.labels || []), JSON.stringify(input.prefs || {}), now(), null,
  );
  bus.publish({ type: 'user', action: 'create', resource: input.name });
  return listUsers().find((u) => u.id === id)!;
}

export function updateUser(id: string, patch: Partial<{ name: string; status: string; emailVerified: boolean; labels: string[]; prefs: Record<string, unknown> }>) {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;
  if (!cur) return null;
  db.prepare('UPDATE users SET name=?,status=?,emailVerified=?,labels=?,prefs=? WHERE id=?').run(
    patch.name ?? cur.name, patch.status ?? cur.status, (patch.emailVerified ?? !!cur.emailVerified) ? 1 : 0,
    JSON.stringify(patch.labels ?? safeJson(cur.labels, [])), JSON.stringify(patch.prefs ?? safeJson(cur.prefs, {})), id,
  );
  bus.publish({ type: 'user', action: 'update', resource: patch.name ?? cur.name });
  return listUsers().find((u) => u.id === id);
}

export function deleteUser(id: string) {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(id) as any;
  if (!cur) return false;
  db.prepare('DELETE FROM sessions WHERE userId=?').run(id);
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  bus.publish({ type: 'user', action: 'delete', resource: cur.name });
  return true;
}

export function login(email: string, password: string) {
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase()) as any;
  if (!u) throw new Error('Invalid credentials');
  if (!verifyPassword(password, u.passwordHash)) throw new Error('Invalid credentials');
  if (!String(u.passwordHash || '').startsWith('scrypt$')) {
    // 登录成功时顺手把旧哈希升级为「每用户盐」格式
    db.prepare('UPDATE users SET passwordHash=? WHERE id=?').run(hashPassword(password), u.id);
  }
  const id = uid('sess_');
  const secret = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (id,userId,secret,expiresAt,createdAt) VALUES (?,?,?,?,?)').run(id, u.id, secret, expiresAt, now());
  db.prepare('UPDATE users SET lastLoginAt=? WHERE id=?').run(now(), u.id);
  return { userId: u.id, sessionId: id, secret, expiresAt, name: u.name, email: u.email };
}

/* --------------------------------------------------------------- messaging */

export function sendMessage(input: { channel: string; recipient: string; subject?: string; body: string }) {
  const id = uid('msg_');
  db.prepare('INSERT INTO messages (id,channel,recipient,subject,body,status,createdAt,projectId) VALUES (?,?,?,?,?,?,?,?)').run(
    id, input.channel, input.recipient, input.subject || '', input.body, 'sent', now(), pid(),
  );
  addLog({ method: 'POST', path: '/v1/messaging/messages', status: 201, duration: 87, service: 'messaging' });
  bus.publish({ type: 'message', action: 'send', resource: input.recipient });
  return db.prepare('SELECT * FROM messages WHERE id=?').get(id);
}

export function listMessages(limit = 50) {
  return db.prepare('SELECT * FROM messages WHERE projectId=? ORDER BY createdAt DESC LIMIT ?').all(pid(), limit);
}

/* ---------------------------------------------------------------- api keys */

export function listApiKeys() {
  return (db.prepare('SELECT * FROM apiKeys WHERE projectId=? ORDER BY createdAt DESC').all(pid()) as any[]).map((r) => ({
    id: r.id, name: r.name, scopes: safeJson<string[]>(r.scopes, []),
    secret: r.secret, lastUsedAt: r.lastUsedAt, createdAt: r.createdAt,
  }));
}

export function createApiKey(name: string, scopes: string[]) {
  const id = uid('key_');
  const secret = 'standard_' + crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO apiKeys (id,name,scopes,secret,lastUsedAt,createdAt,projectId) VALUES (?,?,?,?,?,?,?)').run(
    id, name, JSON.stringify(scopes), secret, null, now(), pid(),
  );
  return listApiKeys().find((k) => k.id === id)!;
}

export function deleteApiKey(id: string) {
  return db.prepare('DELETE FROM apiKeys WHERE id=?').run(id).changes > 0;
}

/* ------------------------------------------------------------------- logs */

export function addLog(input: { method: string; path: string; status: number; duration: number; service: string; ip?: string }) {
  db.prepare('INSERT INTO logs (id,method,path,status,duration,service,ip,createdAt,projectId) VALUES (?,?,?,?,?,?,?,?,?)').run(
    uid('log_'), input.method, input.path, input.status, input.duration,
    input.service, input.ip || '127.0.0.1', now(), pid(),
  );
}

export function listLogs(limit = 60) {
  return db.prepare('SELECT * FROM logs WHERE projectId=? ORDER BY createdAt DESC LIMIT ?').all(pid(), limit);
}

/* ---------------------------------------------------------------- metrics */

export function getMetrics() {
  const projectId = pid();
  const docCount = (db.prepare(
    'SELECT COUNT(*) c FROM documents d JOIN collections c2 ON c2.id=d.collectionId WHERE c2.projectId=?',
  ).get(projectId) as any).c;
  const fileAgg = db.prepare(
    'SELECT COUNT(*) c, COALESCE(SUM(f.size),0) s FROM files f JOIN buckets b ON b.id=f.bucketId WHERE b.projectId=?',
  ).get(projectId) as any;
  const execs24 = (db.prepare("SELECT COUNT(*) c FROM executions WHERE projectId=? AND createdAt > datetime('now','-1 day')").get(projectId) as any).c;
  const failed = (db.prepare("SELECT COUNT(*) c FROM executions WHERE projectId=? AND status='failed'").get(projectId) as any).c;
  const requests24 = (db.prepare("SELECT COUNT(*) c FROM logs WHERE projectId=? AND createdAt > datetime('now','-1 day')").get(projectId) as any).c;

  const trend: { date: string; requests: number; errors: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const key = d.toISOString().slice(0, 10);
    const r = db.prepare(
      "SELECT COUNT(*) c, SUM(CASE WHEN status>=400 THEN 1 ELSE 0 END) e FROM logs WHERE projectId=? AND substr(createdAt,1,10)=?",
    ).get(projectId, key) as any;
    trend.push({ date: key, requests: r.c || 0, errors: r.e || 0 });
  }

  const topCollections = (db.prepare(
    `SELECT c.name, c.key, c.color, COUNT(d.id) n FROM collections c LEFT JOIN documents d ON d.collectionId=c.id
     WHERE c.projectId=? GROUP BY c.id ORDER BY n DESC`,
  ).all(projectId) as any[]).map((r) => ({ name: r.name, key: r.key, color: r.color, documents: r.n }));

  return {
    documents: docCount,
    files: fileAgg.c,
    storageBytes: fileAgg.s,
    functions: (db.prepare('SELECT COUNT(*) c FROM functions WHERE projectId=?').get(projectId) as any).c,
    executions24h: execs24,
    failedExecutions: failed,
    users: (() => {
      try { return (db.prepare('SELECT COUNT(*) c FROM members WHERE projectId=?').get(projectId) as any).c; }
      catch { return (db.prepare('SELECT COUNT(*) c FROM users').get() as any).c; }
    })(),
    sites: (db.prepare('SELECT COUNT(*) c FROM sites WHERE projectId=?').get(projectId) as any).c,
    collections: (db.prepare('SELECT COUNT(*) c FROM collections WHERE projectId=?').get(projectId) as any).c,
    messages: (db.prepare('SELECT COUNT(*) c FROM messages WHERE projectId=?').get(projectId) as any).c,
    requests24h: requests24,
    trend,
    topCollections,
    services: [
      { name: 'Databases', status: 'operational', latency: 12, uptime: 99.99 },
      { name: 'Storage', status: 'operational', latency: 38, uptime: 99.98 },
      { name: 'Functions', status: 'operational', latency: 74, uptime: 99.95 },
      { name: 'Sites', status: 'operational', latency: 21, uptime: 100 },
      { name: 'Auth', status: 'operational', latency: 9, uptime: 99.99 },
      { name: 'Messaging', status: 'operational', latency: 46, uptime: 99.97 },
    ],
    recentExecutions: listExecutions(undefined, 6),
    recentLogs: listLogs(8),
    project: db.prepare('SELECT * FROM projects WHERE id=?').get(projectId) || db.prepare('SELECT * FROM projects LIMIT 1').get(),
  };
}

/* --------------------------------------------------------------- settings */

export function getSetting(key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key=?').get(key) as any;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string) {
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

export const EMPTY_SITE_CODE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>New Site</title>
  <style>
    body { margin:0; height:100vh; display:grid; place-items:center;
      font-family: ui-sans-serif, system-ui; background:#0b0b0f; color:#fff; }
    h1 { font-size:42px; letter-spacing:-.03em; }
  </style>
</head>
<body>
  <h1>Hello from Appwrite Sites 👋</h1>
</body>
</html>`;

export const DEFAULT_FUNCTION_CODE = `export default async ({ req, res, log, error }) => {
  log('Function invoked with payload:', req.body);

  return res.json({
    ok: true,
    message: 'Hello from Studio BaaS Functions',
    receivedAt: new Date().toISOString(),
  });
};`;
