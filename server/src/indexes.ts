/**
 * 集合索引（对应 Appwrite 的 `indexes` 资源）。
 *
 * 文档存在 `documents.data` 这个 JSON 列里，查询走 `json_extract(data,'$.x')`，
 * 没有索引时每条查询都是全表扫描。SQLite 从 3.9 起支持**表达式索引**，所以可以
 * 给 JSON 字段建真实索引：
 *
 *   CREATE INDEX ix_col_orders_status ON documents(collectionId, json_extract(data,'$.status'))
 *
 * 实测（5000 行）：建索引前 `SCAN documents | USE TEMP B-TREE FOR ORDER BY`，
 * 建索引后 `SEARCH documents USING INDEX ix_... (collectionId=? AND <expr>=?)`，
 * 排序也不再需要临时 B 树。
 *
 * 两个关键设计：
 *
 * 1. 每条索引都是**部分索引**（`WHERE collectionId='col_x'`），只服务自己的集合。
 *    早先试过把 `collectionId` 作为索引第一列的做法（一条物理索引服务所有集合），
 *    但那样「在 orders 上建的 status 索引」会命中 products 的同类查询——索引列表
 *    里根本看不到它，查询计划里却出现别的集合的索引名，非常难解释。
 * 2. 部分索引的条件是常量 `collectionId='col_x'`，而查询用的是参数 `collectionId=?`。
 *    已验证 SQLite 会在运行时比对参数，索引照常命中，且唯一约束也照常触发。
 */
import { db, now, uid } from './db.js';

export type IndexType = 'key' | 'unique';
export const INDEX_TYPES: IndexType[] = ['key', 'unique'];

export interface CollectionIndex {
  id: string;
  collectionId: string;
  key: string;
  type: IndexType;
  attributes: string[];
  orders: ('ASC' | 'DESC')[];
  status: 'available' | 'failed';
  error: string | null;
  createdAt: string;
}

const ATTR = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/** 元字段映射到真实列，与 query.ts 保持一致 */
const META: Record<string, string> = { $id: 'id', $createdAt: 'createdAt', $updatedAt: 'updatedAt' };

function exprFor(attr: string): string {
  if (META[attr]) return META[attr];
  if (!ATTR.test(attr)) throw new Error(`Invalid attribute name "${attr}"`);
  return `json_extract(data, '$.${attr}')`;
}

const indexName = (collectionId: string, key: string) =>
  `ix_${collectionId}_${key}`.replace(/[^a-zA-Z0-9_]/g, '_');

const esc = (s: string) => s.replace(/'/g, "''");

function buildDdl(idx: Pick<CollectionIndex, 'collectionId' | 'key' | 'type' | 'attributes' | 'orders'>): string {
  const name = indexName(idx.collectionId, idx.key);
  const exprs = idx.attributes.map((a, i) => {
    const dir = idx.orders[i] === 'DESC' ? ' DESC' : '';
    return `${exprFor(a)}${dir}`;
  });
  // 唯一索引与普通索引都用部分索引收窄到本集合：前者避免跨集合同名值互相冲突，
  // 后者避免「别人的索引命中我的查询」这种难解释的行为。
  return `CREATE ${idx.type === 'unique' ? 'UNIQUE ' : ''}INDEX "${name}" ON documents(${exprs.join(', ')})
    WHERE collectionId='${esc(idx.collectionId)}'`;
}

function fromRow(r: any): CollectionIndex {
  const parse = <T,>(s: string | null, fallback: T): T => {
    try { return (JSON.parse(s || '') as T) ?? fallback; } catch { return fallback; }
  };
  return {
    id: r.id, collectionId: r.collectionId, key: r.key, type: r.type as IndexType,
    attributes: parse<string[]>(r.attributes, []),
    orders: parse<('ASC' | 'DESC')[]>(r.orders, []),
    status: (r.status as CollectionIndex['status']) || 'available',
    error: r.error ?? null,
    createdAt: r.createdAt,
  };
}

export function listIndexes(collectionId: string): CollectionIndex[] {
  return (db.prepare('SELECT * FROM collectionIndexes WHERE collectionId=? ORDER BY createdAt ASC')
    .all(collectionId) as any[]).map(fromRow);
}

export function getIndex(collectionId: string, id: string): CollectionIndex | null {
  const r = db.prepare('SELECT * FROM collectionIndexes WHERE id=? AND collectionId=?').get(id, collectionId) as any;
  return r ? fromRow(r) : null;
}

export function indexesOnAttribute(collectionId: string, key: string): CollectionIndex[] {
  return listIndexes(collectionId).filter((i) => i.attributes.includes(key));
}

export function createIndex(collectionId: string, input: {
  key?: string; type?: string; attributes?: unknown; orders?: unknown;
}): CollectionIndex {
  const key = String(input.key || '').trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(key)) {
    throw new Error('Index key must start with a letter and contain only letters, digits or underscores (max 40)');
  }
  const type = (input.type || 'key') as IndexType;
  if (!INDEX_TYPES.includes(type)) {
    throw new Error(`Unknown index type "${type}". Expected one of: ${INDEX_TYPES.join(', ')}`);
  }
  const attributes = (Array.isArray(input.attributes) ? input.attributes : [])
    .map((a) => String(a).trim()).filter(Boolean);
  if (!attributes.length) throw new Error('An index needs at least one attribute');
  if (attributes.length > 4) throw new Error('An index can cover at most 4 attributes');
  if (new Set(attributes).size !== attributes.length) throw new Error('Duplicate attribute in index');

  const defined = db.prepare('SELECT key, array FROM attributes WHERE collectionId=?').all(collectionId) as any[];
  for (const a of attributes) {
    if (META[a]) continue; // $id / $createdAt / $updatedAt 是真实列，始终可索引
    const attr = defined.find((d) => d.key === a);
    if (!attr) throw new Error(`Attribute "${a}" is not defined in this collection`);
    if (attr.array) throw new Error(`Array attribute "${a}" cannot be indexed (use a scalar attribute)`);
  }

  if (db.prepare('SELECT 1 FROM collectionIndexes WHERE collectionId=? AND key=?').get(collectionId, key)) {
    throw new Error(`Index key "${key}" already exists in this collection`);
  }

  const ordersIn = Array.isArray(input.orders) ? input.orders.map((o) => String(o).toUpperCase()) : [];
  const orders = attributes.map((_, i) => (ordersIn[i] === 'DESC' ? 'DESC' : 'ASC') as 'ASC' | 'DESC');

  const id = uid('idx_');
  const t = now();
  const draft = { collectionId, key, type, attributes, orders };

  // 建索引可能失败：唯一索引遇到历史重复数据是常见情况。Appwrite 会把索引标成
  // failed 并保留记录（方便看到哪里冲突），这里保持一致——失败不当成 500 抛出去。
  let status: CollectionIndex['status'] = 'available';
  let error: string | null = null;
  try {
    db.exec(buildDdl(draft));
  } catch (e: any) {
    status = 'failed';
    error = e?.message || String(e);
  }

  db.prepare(`INSERT INTO collectionIndexes (id,collectionId,key,type,attributes,orders,status,error,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    id, collectionId, key, type, JSON.stringify(attributes), JSON.stringify(orders), status, error, t,
  );
  return getIndex(collectionId, id)!;
}

export function deleteIndex(collectionId: string, id: string): boolean {
  const idx = getIndex(collectionId, id);
  if (!idx) return false;
  db.exec(`DROP INDEX IF EXISTS "${indexName(idx.collectionId, idx.key)}"`);
  db.prepare('DELETE FROM collectionIndexes WHERE id=?').run(id);
  return true;
}

/** 删集合时把物理索引一并清掉，否则 SQLite 里会留下指向已不存在集合的空索引 */
export function dropIndexesForCollection(collectionId: string): number {
  const all = listIndexes(collectionId);
  db.transaction(() => {
    for (const i of all) {
      db.exec(`DROP INDEX IF EXISTS "${indexName(i.collectionId, i.key)}"`);
      db.prepare('DELETE FROM collectionIndexes WHERE id=?').run(i.id);
    }
  })();
  return all.length;
}

/**
 * 把 SQLite 的唯一约束错误翻译成人话。
 * 抛出的信息形如 `UNIQUE constraint failed: index 'ix_col_x_code'`，
 * 反查索引 key 后返回 `Index "code" requires unique values`。
 */
export function translateConstraintError(e: any): Error | null {
  const msg = String(e?.message || '');
  if (!/UNIQUE constraint failed/i.test(msg)) return null;
  const m = /index '([^']+)'/.exec(msg);
  const name = m?.[1];
  if (name) {
    const row = db.prepare('SELECT collectionId, key FROM collectionIndexes WHERE key IS NOT NULL').all() as any[];
    const hit = row.find((r) => indexName(r.collectionId, r.key) === name);
    if (hit) return new Error(`Index "${hit.key}" requires unique values — a document with these values already exists`);
  }
  return new Error('Unique constraint violated by an index on this collection');
}
