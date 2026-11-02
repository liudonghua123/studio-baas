import {
  listCollections, getCollection, createCollection, addAttribute, deleteCollection,
  listDocuments, createDocument, updateDocument, deleteDocument, getDocument,
  listBuckets, listFiles, deleteFile, getFile, deleteBucket,
  listFunctions, getFunction, updateFunction, executeFunction, listExecutions, createFunction,
  listVersions, restoreVersion,
  listCollectionIndexes, createCollectionIndex, deleteCollectionIndex, explainDocumentQuery,
  listSites, getSite, updateSite, deploySite,
  listUsers, createUser, deleteUser,
  sendMessage, listMessages,
  getMetrics, listLogs, createApiKey, getSetting,
  createBucket, createDocuments,
} from './store.js';
import * as webhooksApi from './webhooks.js';
import * as schedulesApi from './schedules.js';
import * as gitApi from './git.js';
import * as projectsApi from './projects.js';
import * as membersApi from './members.js';
import { currentPrincipal, currentProjectId } from './context.js';
import { can } from './auth.js';
import { permissionFor } from './agent/permissions.js';

/* ------------------------------------------------------------------- types */

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: any) => Promise<unknown> | unknown;
  summary: (args: any) => string;
}

export interface ToolTrace {
  id: string;
  name: string;
  args: Record<string, any>;
  result: unknown;
  ok: boolean;
  duration: number;
  summary: string;
}

export interface ChatResult {
  text: string;
  traces: ToolTrace[];
  model: string;
  mode: 'deepseek' | 'demo';
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/* ---------------------------------------------------------------- helpers */

const CN_ALIAS: Record<string, string[]> = {
  products: ['产品', '商品', '货品'],
  orders: ['订单', '交易'],
  customers: ['客户', '顾客', '会员'],
  posts: ['文章', '帖子', '博客'],
};

function resolveCollection(nameOrId: string) {
  const all = listCollections(false);
  const q = nameOrId.toLowerCase().trim();
  const direct = all.find((c) => c.id === nameOrId) || all.find((c) => c.key === q) || all.find((c) => c.name.toLowerCase() === q)
    || all.find((c) => c.name.toLowerCase().includes(q) || c.key.includes(q));
  if (direct) return direct;
  for (const [key, words] of Object.entries(CN_ALIAS)) {
    if (words.some((w) => q.includes(w))) {
      const hit = all.find((c) => c.key === key);
      if (hit) return hit;
    }
  }
  return null;
}
function resolveFunction(nameOrId: string) {
  const all = listFunctions();
  const q = nameOrId.toLowerCase().trim();
  return all.find((f) => f.id === nameOrId)
    || all.find((f) => f.name.toLowerCase() === q)
    || all.find((f) => q.includes(f.name.toLowerCase()))
    || all.find((f) => f.name.toLowerCase().split(/\s+/).some((w: string) => w.length > 3 && q.includes(w)))
    || all.find((f) => f.name.toLowerCase().includes(q))
    || null;
}
function resolveSite(nameOrId: string) {
  const all = listSites();
  const q = nameOrId.toLowerCase().trim();
  return all.find((s) => s.id === nameOrId)
    || all.find((s) => s.name.toLowerCase() === q)
    || all.find((s) => q.includes(s.name.toLowerCase()))
    || all.find((s) => s.name.toLowerCase().includes(q))
    || null;
}

const truncate = (v: unknown, n = 1200): unknown => {
  const s = JSON.stringify(v);
  return s && s.length > n ? JSON.parse(JSON.stringify({ truncated: true, preview: s.slice(0, n) })) : v;
};

/* ------------------------------------------------------------------ tools */

export const tools: ToolDef[] = [
  {
    name: 'list_collections',
    description: 'List all database collections with document counts and attribute definitions.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查看所有集合',
    run: () => listCollections().map((c) => ({
      id: c.id, name: c.name, key: c.key, documents: c.documentCount,
      attributes: (c.attributes || []).map((a) => `${a.key}:${a.type}`),
    })),
  },
  {
    name: 'create_collection',
    description: 'Create a new database collection (table) in the project.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human readable collection name' },
        key: { type: 'string', description: 'Optional machine key (lowercase)' },
      },
      required: ['name'],
    },
    summary: (a) => `创建集合 ${a.name}`,
    run: (a) => {
      const c = createCollection({ name: a.name, key: a.key });
      return { ok: true, id: c.id, name: c.name, key: c.key };
    },
  },
  {
    name: 'add_attribute',
    description: 'Add an attribute/column to an existing collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name, key or id' },
        key: { type: 'string', description: 'Attribute key, e.g. "price"' },
        type: { type: 'string', enum: ['string', 'email', 'integer', 'float', 'boolean', 'datetime', 'url', 'enum', 'text'] },
        required: { type: 'boolean' },
        elements: { type: 'array', items: { type: 'string' }, description: 'Allowed values for enum type' },
      },
      required: ['collection', 'key', 'type'],
    },
    summary: (a) => `为 ${a.collection} 添加字段 ${a.key}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const attr = addAttribute(c.id, { key: a.key, type: a.type, required: !!a.required, elements: a.elements });
      return { ok: true, collection: c.name, attribute: attr.key, type: attr.type };
    },
  },
  {
    name: 'list_indexes',
    description: 'List the indexes of a collection and whether each one is available.',
    parameters: {
      type: 'object',
      properties: { collection: { type: 'string' } },
      required: ['collection'],
    },
    summary: (a) => `查看 ${a.collection} 的索引`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      return listCollectionIndexes(c.id).map((i) => ({
        key: i.key, type: i.type, attributes: i.attributes, status: i.status, error: i.error,
      }));
    },
  },
  {
    name: 'create_index',
    description: 'Create an index on a collection. Leftmost attributes are used first, so order matters.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        key: { type: 'string', description: 'Index key, e.g. status_created' },
        type: { type: 'string', enum: ['key', 'unique'], description: 'Defaults to key' },
        attributes: { type: 'array', items: { type: 'string' }, description: 'Attribute keys, in order' },
        orders: { type: 'array', items: { type: 'string', enum: ['ASC', 'DESC'] } },
      },
      required: ['collection', 'key', 'attributes'],
    },
    summary: (a) => `在 ${a.collection} 上建索引 ${a.key}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const idx = createCollectionIndex(c.id, a);
      return { ok: idx.status === 'available', key: idx.key, type: idx.type, status: idx.status, error: idx.error };
    },
  },
  {
    name: 'explain_query',
    description: 'Run EXPLAIN QUERY PLAN for a list query and report whether an index is used.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        queries: { type: 'array', items: { type: 'string' }, description: 'Appwrite queries, e.g. ["equal(\"status\",\"paid\")"]' },
      },
      required: ['collection'],
    },
    summary: (a) => `解释 ${a.collection} 的查询计划`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const p = explainDocumentQuery(c.id, { queries: a.queries || [], limit: 25 });
      return {
        verdict: p.fullScan ? 'full table scan' : p.narrowed ? 'index lookup' : 'collection scan',
        index: p.index, terms: p.terms, tempBTree: p.tempBTree,
        plan: p.plan.map((x) => x.detail),
      };
    },
  },
  {
    name: 'delete_index',
    description: 'Drop an index from a collection.',
    parameters: {
      type: 'object',
      properties: { collection: { type: 'string' }, key: { type: 'string' } },
      required: ['collection', 'key'],
    },
    summary: (a) => `删除 ${a.collection} 的索引 ${a.key}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const idx = listCollectionIndexes(c.id).find((i) => i.key === a.key);
      if (!idx) throw new Error(`Index "${a.key}" not found`);
      return { ok: deleteCollectionIndex(c.id, idx.id) };
    },
  },
  {
    name: 'list_documents',
    description: 'List or search documents inside a collection.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        limit: { type: 'number', description: 'Max 25' },
        search: { type: 'string', description: 'Free text search' },
      },
      required: ['collection'],
    },
    summary: (a) => `查询 ${a.collection} 文档`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const r = listDocuments(c.id, { limit: Math.min(a.limit || 10, 25), search: a.search });
      return { collection: c.name, total: r.total, documents: r.documents.map((d) => ({ id: d.id, ...d.data })) };
    },
  },
  {
    name: 'create_document',
    description: 'Create a document (row) inside a collection. Data must satisfy the collection attributes.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        data: { type: 'object', description: 'Key/value object matching the collection schema', additionalProperties: true },
        permissions: {
          type: 'array', items: { type: 'string' },
          description: 'Only used when the collection enables document security, e.g. ["read(\"any\")","update(\"team:studio/owner\")"]. Omit to use the defaults.',
        },
      },
      required: ['collection', 'data'],
    },
    summary: (a) => `在 ${a.collection} 新建文档`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const d = createDocument(c.id, a.data || {}, undefined, a.permissions);
      return { ok: true, id: d.id, collection: c.name, data: d.data, permissions: d.permissions };
    },
  },
  {
    name: 'update_document',
    description: 'Update an existing document by id.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' }, documentId: { type: 'string' },
        data: { type: 'object', additionalProperties: true },
        permissions: { type: 'array', items: { type: 'string' }, description: 'Replace the document permissions, e.g. ["read(\"users\")"]' },
      },
      required: ['collection', 'documentId', 'data'],
    },
    summary: (a) => `更新文档 ${a.documentId}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const d = updateDocument(c.id, a.documentId, a.data || {}, true, a.permissions);
      if (!d) throw new Error('Document not found');
      return { ok: true, id: d.id, data: d.data, permissions: d.permissions };
    },
  },
  {
    name: 'delete_document',
    description: 'Delete a document by id.',
    parameters: {
      type: 'object',
      properties: { collection: { type: 'string' }, documentId: { type: 'string' } },
      required: ['collection', 'documentId'],
    },
    summary: (a) => `删除文档 ${a.documentId}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const ok = deleteDocument(c.id, a.documentId);
      return { ok, message: ok ? 'Document deleted' : 'Document not found' };
    },
  },
  {
    name: 'list_files',
    description: 'List storage buckets and the files inside them.',
    parameters: { type: 'object', properties: { bucket: { type: 'string', description: 'Optional bucket name or id' } } },
    summary: (a) => (a.bucket ? `查看 ${a.bucket} 文件` : '查看存储桶'),
    run: (a) => {
      const buckets = listBuckets();
      if (!a.bucket) return buckets.map((b) => ({ id: b.id, name: b.name, files: b.fileCount, size: b.totalSize }));
      const b = buckets.find((x) => x.id === a.bucket || x.name.toLowerCase().includes(String(a.bucket).toLowerCase()));
      if (!b) throw new Error(`Bucket "${a.bucket}" not found`);
      return { bucket: b.name, files: listFiles(b.id).map((f) => ({ id: f.id, name: f.name, size: f.size })) };
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from storage by file id.',
    parameters: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
    summary: (a) => `删除文件 ${a.fileId}`,
    run: (a) => ({ ok: deleteFile(a.fileId) }),
  },
  {
    name: 'list_functions',
    description: 'List serverless functions with runtime, trigger and last execution status.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查看云函数',
    run: () => listFunctions().map((f) => ({
      id: f.id, name: f.name, runtime: f.runtime, schedule: f.schedule || 'manual',
      executions: f.executions, lastStatus: f.lastExecution?.status || null,
    })),
  },
  {
    name: 'get_function',
    description: 'Get a function definition including its source code and environment variables.',
    parameters: { type: 'object', properties: { function: { type: 'string' } }, required: ['function'] },
    summary: (a) => `读取函数 ${a.function}`,
    run: (a) => {
      const f = resolveFunction(a.function);
      if (!f) throw new Error(`Function "${a.function}" not found`);
      return { id: f.id, name: f.name, runtime: f.runtime, code: f.code, env: f.env, timeout: f.timeout };
    },
  },
  {
    name: 'update_function_code',
    description: 'Replace the source code of a function (online code editing).',
    parameters: {
      type: 'object',
      properties: { function: { type: 'string' }, code: { type: 'string', description: 'Full new source code' } },
      required: ['function', 'code'],
    },
    summary: (a) => `修改 ${a.function} 代码`,
    run: (a) => {
      const f = resolveFunction(a.function);
      if (!f) throw new Error(`Function "${a.function}" not found`);
      updateFunction(f.id, { code: a.code });
      return { ok: true, function: f.name, bytes: String(a.code).length };
    },
  },
  {
    name: 'create_function',
    description: 'Create a new Node.js serverless function.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, code: { type: 'string' } },
      required: ['name'],
    },
    summary: (a) => `创建函数 ${a.name}`,
    run: (a) => {
      const f = createFunction({ name: a.name, code: a.code });
      return { ok: true, id: f.id, name: f.name };
    },
  },
  {
    name: 'execute_function',
    description: 'Execute a function synchronously and return its logs, response and duration.',
    parameters: {
      type: 'object',
      properties: {
        function: { type: 'string' },
        payload: { type: 'object', additionalProperties: true, description: 'Request body passed to the function' },
      },
      required: ['function'],
    },
    summary: (a) => `执行 ${a.function}`,
    run: async (a) => {
      const f = resolveFunction(a.function);
      if (!f) throw new Error(`Function "${a.function}" not found`);
      const r = await executeFunction(f.id, a.payload ?? {}, 'ai');
      return { status: r.status, duration: r.duration, logs: r.logs, response: truncate(r.response, 2000), errors: r.errors };
    },
  },
  {
    name: 'list_function_versions',
    description: 'List the immutable deploy history of a function (version, label, author, time).',
    parameters: {
      type: 'object',
      properties: { function: { type: 'string' }, limit: { type: 'number' } },
      required: ['function'],
    },
    summary: (a) => `查看 ${a.function} 的版本`,
    run: (a) => {
      const f = resolveFunction(a.function);
      if (!f) throw new Error(`Function "${a.function}" not found`);
      const versions = listVersions(f.id, Math.min(Number(a.limit) || 10, 30));
      return versions.map((v) => ({ version: v.version, label: v.label, by: v.createdBy, at: v.createdAt }));
    },
  },
  {
    name: 'restore_function_version',
    description: 'Roll a function back to an earlier version. The current code is kept as a new version.',
    parameters: {
      type: 'object',
      properties: { function: { type: 'string' }, version: { type: 'number', description: 'Version number, e.g. 1' } },
      required: ['function', 'version'],
    },
    summary: (a) => `把 ${a.function} 回滚到 v${a.version}`,
    run: (a) => {
      const f = resolveFunction(a.function);
      if (!f) throw new Error(`Function "${a.function}" not found`);
      const target = listVersions(f.id, 30).find((v) => v.version === Number(a.version));
      if (!target) throw new Error(`Version v${a.version} not found`);
      const updated = restoreVersion(f.id, target.id);
      return { ok: true, version: updated?.code ? target.version : target.version, code: (updated?.code || '').slice(0, 400) };
    },
  },
  {
    name: 'list_executions',
    description: 'List recent function executions with status, duration and errors.',
    parameters: { type: 'object', properties: { function: { type: 'string' } } },
    summary: () => '查看执行记录',
    run: (a) => {
      const f = a.function ? resolveFunction(a.function) : null;
      return listExecutions(f?.id, 10).map((e) => ({
        function: e.functionName, status: e.status, duration: e.duration,
        errors: e.errors, at: e.createdAt,
      }));
    },
  },
  {
    name: 'list_sites',
    description: 'List hosted sites with framework, domain and status.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查看站点',
    run: () => listSites().map((s) => ({
      id: s.id, name: s.name, framework: s.framework, domain: s.domain,
      status: s.status, files: s.files.map((f) => f.path),
    })),
  },
  {
    name: 'update_site_file',
    description: 'Create or overwrite a file in a site (index.html, styles.css, app.js …).',
    parameters: {
      type: 'object',
      properties: {
        site: { type: 'string' }, path: { type: 'string', description: 'e.g. index.html' },
        content: { type: 'string' },
      },
      required: ['site', 'path', 'content'],
    },
    summary: (a) => `更新 ${a.site}/${a.path}`,
    run: (a) => {
      const s = resolveSite(a.site);
      if (!s) throw new Error(`Site "${a.site}" not found`);
      const files = [...s.files];
      const idx = files.findIndex((f) => f.path === a.path);
      if (idx >= 0) files[idx] = { path: a.path, content: a.content };
      else files.push({ path: a.path, content: a.content });
      updateSite(s.id, { files });
      return { ok: true, site: s.name, path: a.path, files: files.map((f) => f.path) };
    },
  },
  {
    name: 'deploy_site',
    description: 'Deploy the current site files to production preview.',
    parameters: { type: 'object', properties: { site: { type: 'string' } }, required: ['site'] },
    summary: (a) => `部署 ${a.site}`,
    run: (a) => {
      const s = resolveSite(a.site);
      if (!s) throw new Error(`Site "${a.site}" not found`);
      const d = deploySite(s.id);
      return { ok: true, site: d?.name, status: d?.status, logs: d?.buildLogs };
    },
  },
  {
    name: 'list_users',
    description: 'List end users of the project with status and labels.',
    parameters: { type: 'object', properties: { search: { type: 'string' } } },
    summary: () => '查看用户',
    run: (a) => {
      let users = listUsers();
      if (a.search) {
        const q = String(a.search).toLowerCase();
        users = users.filter((u) => u.name.toLowerCase().includes(q) || u.email.includes(q));
      }
      return users.map((u) => ({ id: u.id, name: u.name, email: u.email, status: u.status, labels: u.labels, createdAt: u.createdAt }));
    },
  },
  {
    name: 'create_user',
    description: 'Create a new end user account.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' }, email: { type: 'string' },
        password: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'email'],
    },
    summary: (a) => `创建用户 ${a.name}`,
    run: (a) => {
      const u = createUser({ name: a.name, email: a.email, password: a.password, labels: a.labels });
      return { ok: true, id: u.id, name: u.name, email: u.email };
    },
  },
  {
    name: 'delete_user',
    description: 'Delete an end user by id.',
    parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    summary: (a) => `删除用户 ${a.userId}`,
    run: (a) => ({ ok: deleteUser(a.userId) }),
  },
  {
    name: 'send_message',
    description: 'Send an email, SMS or push message through the messaging service.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['email', 'sms', 'push'] },
        recipient: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
      },
      required: ['channel', 'recipient', 'body'],
    },
    summary: (a) => `通过 ${a.channel} 发送消息`,
    run: (a) => {
      const m = sendMessage(a as any) as any;
      return { ok: true, id: m.id, channel: m.channel, recipient: m.recipient, status: m.status };
    },
  },
  {
    name: 'get_metrics',
    description: 'Get project-wide metrics: documents, files, storage, executions, users and request trend.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查询项目指标',
    run: () => {
      const m = getMetrics();
      return {
        documents: m.documents, files: m.files, storageBytes: m.storageBytes, users: m.users,
        functions: m.functions, executions24h: m.executions24h, requests24h: m.requests24h,
        topCollections: m.topCollections, trend7d: m.trend.slice(-7),
      };
    },
  },
  {
    name: 'get_logs',
    description: 'Get recent API request logs for debugging.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    summary: () => '查看请求日志',
    run: (a) => listLogs(Math.min(a.limit || 15, 50)).map((l: any) => ({
      method: l.method, path: l.path, status: l.status, ms: l.duration, at: l.createdAt,
    })),
  },
  {
    name: 'list_messages',
    description: 'List recently sent messages.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查看消息记录',
    run: () => listMessages(15).map((m: any) => ({ channel: m.channel, recipient: m.recipient, subject: m.subject, status: m.status })),
  },
  {
    name: 'create_api_key',
    description: 'Create a new API key with scopes.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } },
      required: ['name'],
    },
    summary: (a) => `创建 API Key ${a.name}`,
    run: (a) => {
      const k = createApiKey(a.name, a.scopes || ['databases.read']);
      return { ok: true, name: k.name, secret: k.secret, scopes: k.scopes };
    },
  },
  {
    name: 'list_schedules',
    description: 'List cron schedules of the project with timezone, next run and last status.',
    parameters: { type: 'object', properties: { function: { type: 'string', description: 'optional: only this function' } } },
    summary: (a) => (a.function ? `查看 ${a.function} 的定时任务` : '查看定时任务'),
    run: (a) => {
      const f = a.function ? resolveFunction(a.function) : null;
      return schedulesApi.listSchedules(f?.id).map((s) => ({
        id: s.id, function: s.functionName, cron: s.cron, timezone: s.timezone,
        enabled: s.enabled, nextRunAt: s.nextRunAt, lastStatus: s.lastStatus, description: s.description,
      }));
    },
  },
  {
    name: 'create_schedule',
    description: 'Schedule a function on a cron expression in a given IANA timezone.',
    parameters: {
      type: 'object',
      properties: {
        function: { type: 'string' },
        cron: { type: 'string', description: '5-field cron, e.g. "0 2 * * *"' },
        timezone: { type: 'string', description: 'IANA zone, defaults to UTC' },
      },
      required: ['function', 'cron'],
    },
    summary: (a) => `给 ${a.function} 加定时 ${a.cron}`,
    run: (a) => {
      const f = resolveFunction(a.function);
      if (!f) throw new Error(`Function "${a.function}" not found`);
      const s = schedulesApi.createSchedule(f.id, { cron: a.cron, timezone: a.timezone || 'UTC' });
      return { ok: true, cron: s.cron, timezone: s.timezone, nextRunAt: s.nextRunAt, description: s.description };
    },
  },
  {
    name: 'connect_function_repo',
    description: 'Bind a function to a GitHub repository branch so that pushes deploy it.',
    parameters: {
      type: 'object',
      properties: {
        function: { type: 'string' },
        repo: { type: 'string', description: 'owner/repo' },
        branch: { type: 'string' },
        path: { type: 'string', description: 'file inside the repo holding the function source' },
      },
      required: ['function', 'repo'],
    },
    summary: (a) => `把 ${a.function} 接到 ${a.repo}`,
    run: (a) => {
      const f = resolveFunction(a.function);
      if (!f) throw new Error(`Function "${a.function}" not found`);
      const it = gitApi.connect(f.id, { repo: a.repo, branch: a.branch || 'main', path: a.path });
      return { ok: true, repo: it.repo, branch: it.branch, path: it.path, webhook: `/v1/git/webhook/${it.id}` };
    },
  },
  {
    name: 'deploy_function_from_git',
    description: 'Pull the bound repository file into the function (deploy) and report the commit.',
    parameters: { type: 'object', properties: { function: { type: 'string' } }, required: ['function'] },
    summary: (a) => `从 GitHub 部署 ${a.function}`,
    run: async (a) => {
      const f = resolveFunction(a.function);
      if (!f) throw new Error(`Function "${a.function}" not found`);
      const r = await gitApi.pull(f.id, 'manual');
      return { ok: true, sha: r.sha, message: r.message, path: r.path, mode: r.mode };
    },
  },
  {
    name: 'list_projects',
    description: 'List projects and the current role of the caller in each of them.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查看项目',
    run: () => {
      const me = currentPrincipal();
      const here = currentProjectId();
      return projectsApi.listProjects().map((p) => ({
        id: p.id, name: p.name, key: p.key, status: p.status,
        role: me ? membersApi.roleOf(p.id, me.id) : 'owner',
        current: p.id === here,
      }));
    },
  },
  {
    name: 'delete_collection',
    description: 'Delete a collection and every document inside it. Irreversible.',
    parameters: {
      type: 'object',
      properties: { collection: { type: 'string' } },
      required: ['collection'],
    },
    summary: (a) => `删除集合 ${a.collection}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      return { ok: deleteCollection(c.id), collection: c.name, documents: c.documentCount ?? 0 };
    },
  },
  {
    name: 'get_document',
    description: 'Read a single document by id, including its permissions.',
    parameters: {
      type: 'object',
      properties: { collection: { type: 'string' }, documentId: { type: 'string' } },
      required: ['collection', 'documentId'],
    },
    summary: (a) => `读取文档 ${a.documentId}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const d = getDocument(c.id, a.documentId);
      if (!d) throw new Error('Document not found');
      return { id: d.id, collection: c.name, data: d.data, permissions: d.permissions, createdAt: d.createdAt, updatedAt: d.updatedAt };
    },
  },
  {
    name: 'bulk_create_documents',
    description: 'Insert up to 500 documents in one atomic batch. All rows validate or none are written.',
    parameters: {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        documents: {
          type: 'array',
          description: 'Array of plain objects matching the collection schema',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['collection', 'documents'],
    },
    summary: (a) => `批量写入 ${(a.documents || []).length} 条到 ${a.collection}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const rows = createDocuments(c.id, (a.documents || []).map((data: any) => ({ data })));
      return { ok: true, collection: c.name, created: rows.length, ids: rows.map((r) => r.id) };
    },
  },
  {
    name: 'list_buckets',
    description: 'List storage buckets with file counts, size and limits.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查看存储桶',
    run: () => listBuckets().map((b: any) => ({
      id: b.id, name: b.name, files: b.fileCount, size: b.totalSize,
      maxFileSize: b.maxFileSize, allowedExtensions: b.allowedExtensions,
    })),
  },
  {
    name: 'create_bucket',
    description: 'Create a storage bucket with optional size and extension limits.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        maxFileSize: { type: 'number', description: 'Bytes; defaults to 12 MB server-side' },
        allowedExtensions: { type: 'array', items: { type: 'string' }, description: 'e.g. ["png","jpg"]' },
        encryption: { type: 'boolean' },
      },
      required: ['name'],
    },
    summary: (a) => `创建存储桶 ${a.name}`,
    run: (a) => {
      const b = createBucket({ name: a.name, maxFileSize: a.maxFileSize, allowedExtensions: a.allowedExtensions, encryption: !!a.encryption });
      return { ok: true, id: b.id, name: b.name };
    },
  },
  {
    name: 'list_members',
    description: 'List project members and their roles.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查看项目成员',
    run: () => membersApi.listMembers(currentProjectId()).map((m: any) => ({
      id: m.id, name: m.name, email: m.email, role: m.role, status: m.status,
    })),
  },
  {
    name: 'add_member',
    description: 'Invite a person to the project by email with a role (owner/admin/developer/viewer).',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string' },
        role: { type: 'string', enum: ['owner', 'admin', 'developer', 'viewer'], description: 'Defaults to developer' },
      },
      required: ['email'],
    },
    summary: (a) => `邀请 ${a.email} 加入项目`,
    run: (a) => {
      const m = membersApi.addMember(currentProjectId(), { email: a.email, role: a.role || 'developer' });
      return { ok: true, id: m.id, email: (m as any).email, role: (m as any).role };
    },
  },
  {
    name: 'list_webhooks',
    description: 'List project webhook subscriptions with delivery health.',
    parameters: { type: 'object', properties: {} },
    summary: () => '查看 Webhook',
    run: () => webhooksApi.listWebhooks().map((w: any) => ({
      id: w.id, url: w.url, events: w.events, enabled: w.enabled,
      deliveries: w.deliveries, failures: w.failures, lastStatus: w.lastStatus,
    })),
  },
  {
    name: 'create_webhook',
    description: 'Subscribe an HTTP endpoint to project events, e.g. ["document.created","function.*"].',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL' },
        events: { type: 'array', items: { type: 'string' }, description: 'Defaults to ["*"] (everything)' },
        description: { type: 'string' },
      },
      required: ['url'],
    },
    summary: (a) => `订阅事件到 ${a.url}`,
    run: (a) => {
      const w = webhooksApi.createWebhook({ url: a.url, events: a.events, description: a.description });
      // The signing secret is handed out once; it is not stored in the readable row afterwards.
      return { ok: true, id: w.id, url: w.url, events: w.events, secret: webhooksApi.webhookSecret(w.id) };
    },
  },
  {
    name: 'delete_webhook',
    description: 'Remove a webhook subscription.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    summary: (a) => `删除 Webhook ${a.id}`,
    run: (a) => ({ ok: webhooksApi.deleteWebhook(a.id) }),
  },
  {
    name: 'create_project',
    description: 'Create a new project. The console keeps working in the current project.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, region: { type: 'string', description: 'e.g. fra, nyc, sgp' } },
      required: ['name'],
    },
    summary: (a) => `创建项目 ${a.name}`,
    run: (a) => {
      const p = projectsApi.createProject({ name: a.name, region: a.region });
      return { ok: true, id: p.id, name: p.name, key: p.key };
    },
  },
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

/* ------------------------------------------------------------ system prompt */

export const SYSTEM_PROMPT = `你是 Studio BaaS 的 AI 运维助手，由大模型驱动。
你可以通过工具直接操作这个平台的**所有**能力：数据库集合与文档、存储桶与文件、云函数（读取/修改代码、执行、绑定域名、定时任务、GitHub 仓库部署）、站点（修改文件、部署）、认证用户、消息推送、API Key、项目与成员、日志与指标。

工作原则：
1. 先理解用户意图，需要数据时先调用只读工具（list_* / get_* / get_metrics），再决定是否写入。
2. 修改代码、删除数据、发送消息属于写操作。系统会在执行前向用户请求批准，你不需要反复确认；被拒绝时不要重试，改为询问用户想怎么做。
3. 工具参数中的 collection / function / site 可以传名称、key 或 id。
4. 回复使用简体中文，专业、简洁。用 Markdown 组织，必要时用小表格或列表。只写结论与关键数据，不要复述工具返回的原始 JSON。
5. 不要在回复中编造工具没有返回的数据。执行失败时说明原因并给出修复建议。
6. 当用户要求“做一个页面/改站点”时，使用 update_site_file 写入完整文件内容，然后 deploy_site。
7. 当用户要求“写一个函数/改函数”时，使用 update_function_code，代码必须是完整的 ESM（export default async ({ req, res, log, error, databases, env }) => {...}），然后可以 execute_function 验证。`;

/* ------------------------------------------------------------- demo agent */

const lastNumber = (s: string) => {
  const m = s.match(/(\d{6,})/);
  return m ? m[1] : null;
};

export async function demoAgent(history: { role: string; content: string }[]): Promise<ChatResult> {
  const q = [...history].reverse().find((m) => m.role === 'user')?.content || '';
  const text = q.toLowerCase();
  const traces: ToolTrace[] = [];
  const add = (name: string, args: any, result: unknown) => {
    const def = toolMap.get(name)!;
    traces.push({
      id: `t_${traces.length}`, name, args, result, ok: true, duration: 12 + Math.round(Math.random() * 60),
      summary: def.summary(args),
    });
  };

  const want = (...keys: string[]) => keys.some((k) => text.includes(k));

  // Same boundary as the live agent: the rule engine must not be a way around RBAC.
  const run = (name: string, args: any) => {
    const perm = permissionFor(name);
    if (perm && !can(perm, currentPrincipal())) {
      throw new Error(`缺少权限 ${perm}：当前角色不能执行这个操作。`);
    }
    return toolMap.get(name)!.run(args);
  };

  // Loose matching: punctuation and filler words must not decide whether an
  // instruction is understood. "创建一个叫 Reviews 的集合" is the same intent as
  // "创建集合 Reviews", and a keyword list alone would miss it.
  const norm = text.replace(/[\s，。,.!?！？、：:"'“”「」]/g, '');
  const say = (...vs: string[]) => vs.some((v) => norm.includes(v));
  const createWords = ['创建', '新建', '建', '添加', '加一个', 'create', 'new', 'add'];
  const listWords = ['列', '查看', '所有', '有哪些', '多少', 'list', 'show', 'overview', '概览'];

  /** Pull a user-supplied name out of a sentence, quoted or not. */
  const named = (kind: string): string | null => {
    const cleaned = q.replace(/的(集合|表|项目|存储桶|索引)/g, ' ');
    const quoted = cleaned.match(/[「"'“]([^」"'”]{1,28})[」"'”]/);
    if (quoted) return quoted[1].trim();
    const afterNamed = cleaned.match(/(?:叫|名为|名字叫|命名为)\s*([A-Za-z0-9_\u4e00-\u9fa5\- ]{1,28})/);
    if (afterNamed) return afterNamed[1].trim().split(/\s{2,}/)[0];
    const afterKind = cleaned.match(new RegExp(`${kind}\\s*[叫名]?\\s*([A-Za-z0-9_\\u4e00-\\u9fa5\\-]{2,24})`));
    return afterKind ? afterKind[1].trim() : null;
  };

  /** First noun-ish token after a preposition — how a human names the target. */
  const targetOf = (): string | null => {
    const m = q.match(/(?:给|在|为|把|列出|查看|显示|查询|list|show)\s*[「"'`]?([A-Za-z0-9_\u4e00-\u9fa5\-]{2,24})/i);
    return m ? m[1].trim() : null;
  };

  let answer = '';

  try {
    if (say('集合', 'collection', '表') && say(...createWords)) {
      const name = named('集合') || named('表') || 'New collection';
      const r = await run('create_collection', { name });
      add('create_collection', { name }, r);
      answer = `已创建集合 **${(r as any).name}**（key: \`${(r as any).key}\`）。\n\n下一步可以让我「给 ${(r as any).name} 添加字段 price，类型 float」，或者直接在 Databases 页面添加属性。`;
    } else if (say('集合', 'collection') && say(...listWords)) {
      const cols = (await run('list_collections', {})) as any[];
      add('list_collections', {}, cols);
      answer = `当前项目有 **${cols.length}** 个集合：\n\n| 集合 | key | 文档 |\n|---|---|---|\n${cols
        .map((c) => `| ${c.name} | \`${c.key}\` | ${c.documents} |`)
        .join('\n')}`;
    } else if (say('集合') && say('删除', '删掉', 'drop', 'delete')) {
      const afterVerb = q.match(/(?:删除|删掉|drop|delete)\s*[「"'`]?([A-Za-z0-9_\u4e00-\u9fa5\-]{2,24})/i)?.[1];
      const col = resolveCollection(afterVerb || targetOf() || q);
      if (!col) {
        answer = '没有找到要删除的集合。告诉我集合名，例如「删除 Reviews 集合」。';
      } else {
        const r = await run('delete_collection', { collection: col.id });
        add('delete_collection', { collection: col.name }, r);
        answer = `已删除集合 **${col.name}** 及其 ${(r as any).documents} 条文档。`;
      }
    } else if (say('索引', 'index') && say('建', '创建', '加', 'create', 'add')) {
      const col = resolveCollection(targetOf() || q);
      // "status 字段" reads more naturally than "字段 status", so try both orders.
      const attr = q.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:字段|属性|field)/)?.[1]
        || q.match(/(?:字段|属性|field)\s*[「"'`]?([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
        || q.match(/(?:按|对)\s*[「"'`]?([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
      if (!col) {
        answer = '要先告诉我给哪个集合建索引，例如「给 orders 的 status 字段建索引」。';
      } else if (!attr) {
        answer = `给 **${col.name}** 的哪个字段建索引？例如「给 ${col.name} 的 status 字段建索引」，我会用 \`(status, createdAt DESC)\` 这种能同时服务过滤与排序的顺序。`;
      } else {
        const r = await run('create_index', {
          // `$createdAt` is a real column, not a JSON field — mixing it up makes
          // SQLite index the literal string "createdAt" inside every document.
          collection: col.id, key: `${attr}_idx`, attributes: [attr, '$createdAt'], orders: ['ASC', 'DESC'],
        });
        add('create_index', { collection: col.name, key: `${attr}_idx` }, r);
        answer = `已在 **${col.name}** 上创建索引 \`${(r as any).key}\`：\`(${attr}, $createdAt DESC)\`，状态 \`${(r as any).status}\`。`;
      }
    } else if (say('项目', 'project') && say(...createWords) && !say('成员', 'member')) {
      const name = named('项目') || 'New project';
      const r = await run('create_project', { name });
      add('create_project', { name }, r);
      answer = `已创建项目 **${(r as any).name}**（key: \`${(r as any).key}\`）。\n\n在左上角的项目切换器里可以切过去，新项目从空白开始。`;
    } else if (say('成员', 'member', '邀请', 'invite') && say('邀请', '添加', '加', 'invite', 'add')) {
      const email = q.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
      const role = (q.match(/\b(owner|admin|developer|viewer)\b/) || q.match(/(观察者|只读|开发者|管理员|所有者)/))?.[0];
      const roleMap: Record<string, string> = { 观察者: 'viewer', 只读: 'viewer', 开发者: 'developer', 管理员: 'admin', 所有者: 'owner' };
      if (!email) {
        answer = '邀请成员需要邮箱，例如「邀请 alice@example.com 作为 developer」。';
      } else {
        const r = await run('add_member', { email, role: roleMap[role as string] || role || 'developer' });
        add('add_member', { email, role: (r as any).role }, r);
        answer = `已邀请 **${email}** 加入项目，角色 \`${(r as any).role}\`。\n\n在 **Members** 页面可以随时调整角色或移除成员。`;
      }
    } else if (want('函数', 'function') && want('运行', '执行', 'run', 'execute', '测试')) {
      const fn = resolveFunction(q) || listFunctions()[0];
      const r = await run('execute_function', { function: fn.name, payload: { source: 'deepseek-demo' } });
      add('execute_function', { function: fn.name }, r);
      // A chat reply should read like a report, not like a debug dump: lead with
      // the scalar fields a human cares about and point at the full record.
      const resp = (r as any).response;
      const obj = resp && typeof resp === 'object' && !Array.isArray(resp) ? resp : null;
      const scalars = obj
        ? Object.entries(obj).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 4)
        : [];
      const summary = scalars.length
        ? scalars.map(([k, v]) => `\`${k}=${v}\``).join(' · ')
        : (typeof resp === 'string' ? resp.slice(0, 200) : '');
      answer = `已执行云函数 **${fn.name}**，状态 \`${(r as any).status}\`，耗时 ${(r as any).duration}ms。${summary ? `\n\n返回：${summary}` : ''}\n\n完整响应与日志在 **Functions → 执行记录**里可查。`;
    } else if (want('函数', 'function') && want('列表', '有哪些', '列出', 'list')) {
      const r = await run('list_functions', {});
      add('list_functions', {}, r);
      const rows = (r as any[]).map((f) => `| ${f.name} | \`${f.runtime}\` | ${f.schedule} | ${f.executions} |`).join('\n');
      answer = `当前项目有 **${(r as any[]).length}** 个云函数：\n\n| 名称 | 运行时 | 触发器 | 执行次数 |\n|---|---|---|---|\n${rows}\n\n可以让我「执行 Order webhook」或「把 Health probe 的代码改成…」。`;
    } else if (want('用户', 'user') && want('创建', '新建', '添加', 'create')) {
      const email = q.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] || `user${Date.now().toString().slice(-4)}@example.com`;
      const name = q.match(/(?:叫|名为|名字是)\s*([\u4e00-\u9fa5A-Za-z ]{2,20})/)?.[1] || email.split('@')[0];
      const r = await run('create_user', { name, email });
      add('create_user', { name, email }, r);
      answer = `已创建用户 **${name}**（${email}），状态为 \`unverified\`，已发送验证邮件（演示）。`;
    } else if (want('用户', 'user') && !want('概览', '指标', '统计', 'overview', 'metric', '汇总')) {
      const r = await run('list_users', {});
      add('list_users', {}, r);
      answer = `当前有 **${(r as any[]).length}** 位终端用户，其中 ${(r as any[]).filter((u) => u.status === 'active').length} 位处于 active 状态。\n\n${(r as any[]).slice(0, 5).map((u) => `- **${u.name}** · ${u.email} · ${u.status}`).join('\n')}`;
    } else if (want('文档', '数据', '产品', '订单', '记录', 'document', 'data') && !want('创建', '新建') && !want('概览', '指标', '统计', '汇总')) {
      const col = resolveCollection(targetOf() || q) || listCollections(false)[0];
      const r = await run('list_documents', { collection: col.id, limit: 5 });
      add('list_documents', { collection: col.name, limit: 5 }, r);
      const docs = (r as any).documents;
      answer = `集合 **${col.name}** 共 **${(r as any).total}** 条文档。最近 ${docs.length} 条：\n\n| ID | 摘要 |\n|---|---|\n${docs.map((d: any) => `| \`${d.id}\` | ${Object.entries(d).filter(([k]) => !['id'].includes(k)).slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 28)}`).join(' · ')} |`).join('\n')}`;
    } else if (want('创建文档', '新建文档', '插入', '添加一条', 'create document')) {
      const col = resolveCollection(q) || listCollections(false)[0];
      const r = await run('create_document', { collection: col.id, data: { name: 'AI generated record', status: 'draft' } });
      add('create_document', { collection: col.name }, r);
      answer = `已在 **${col.name}** 创建文档 \`${(r as any).id}\`。`;
    } else if (want('指标', '统计', '概览', '多少', 'metrics', 'stat')) {
      const r = await run('get_metrics', {});
      add('get_metrics', {}, r);
      answer = `项目实时概览：\n\n| 指标 | 数值 |\n|---|---|\n| 集合 | ${listCollections().length} |\n| 文档 | ${(r as any).documents} |\n| 文件 | ${(r as any).files} |\n| 用户 | ${(r as any).users} |\n| 云函数 | ${(r as any).functions} |\n| 24h 执行 | ${(r as any).executions24h} |\n| 24h 请求 | ${(r as any).requests24h} |\n\n请求量最高的集合：${(r as any).topCollections.slice(0, 3).map((c: any) => `${c.name} (${c.documents})`).join('、')}。`;
    } else if (want('站点', 'site', '页面')) {
      const sites = await run('list_sites', {});
      add('list_sites', {}, sites);
      answer = `当前托管 **${(sites as any[]).length}** 个站点：\n\n${(sites as any[]).map((s) => `- **${s.name}** · ${s.domain} · \`${s.status}\` · ${s.files.length} 个文件`).join('\n')}\n\n打开 **Sites** 页面即可在线编辑 HTML/CSS/JS 并实时预览。`;
    } else if (want('日志', 'log', '错误', '报错')) {
      const r = await run('get_logs', { limit: 10 });
      add('get_logs', {}, r);
      const errs = (r as any[]).filter((l) => l.status >= 400);
      answer = `最近 10 条请求中，有 **${errs.length}** 条错误：\n\n${errs.slice(0, 5).map((l) => `- \`${l.status}\` ${l.method} ${l.path} (${l.ms}ms)`).join('\n') || '- 没有错误，服务健康。'}`;
    } else if (want('存储', '文件', 'file', 'bucket')) {
      const r = await run('list_files', {});
      add('list_files', {}, r);
      answer = `存储服务共有 **${(r as any[]).length}** 个桶：\n\n| 桶 | 文件数 | 占用 |\n|---|---|---|\n${(r as any[]).map((b) => `| ${b.name} | ${b.files} | ${(b.size / 1024).toFixed(1)} KB |`).join('\n')}`;
    } else if (want('定时', '调度', 'cron', 'schedule')) {
      const at = q.match(/(\d{1,2})\s*点/);
      if (want('加', '创建', '新增', '设置', '每天', '每小时') && (at || want('每天', '每小时'))) {
        const fn = resolveFunction(q) || listFunctions()[0];
        const cron = at ? `0 ${Number(at[1])} * * *` : '0 * * * *';
        const r = await run('create_schedule', { function: fn.name, cron, timezone: 'UTC' });
        add('create_schedule', { function: fn.name, cron, timezone: 'UTC' }, r);
        answer = `已给 **${fn.name}** 添加定时任务 \`${cron}\`（UTC），下次执行 **${new Date((r as any).nextRunAt).toISOString().replace('T', ' ').slice(0, 16)}Z**。\n\n调度器每 15 秒扫描一次到期任务，执行记录与手动调用一样完整。`;
      } else {
        const r = await run('list_schedules', {});
        add('list_schedules', {}, r);
        const list = r as any[];
        const fmt = (iso: string, tz: string) => new Date(iso).toLocaleString('en-GB', {
          timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        answer = list.length
          ? `当前项目有 **${list.length}** 个定时任务：\n\n| 函数 | Cron | 时区 | 下次执行 | 上次状态 |\n|---|---|---|---|---|\n${list.map((s) => `| ${s.function} | \`${s.cron}\` | ${s.timezone} | ${s.nextRunAt ? fmt(s.nextRunAt, s.timezone) : '—'} | ${s.lastStatus || '—'} |`).join('\n')}`
          : '当前项目还没有定时任务。可以说「给 Store analytics 加一个每天 3 点的定时任务」。';
      }
    } else if (want('github', '仓库', 'repo')) {
      const withRepo = listFunctions().find((f) => gitApi.getIntegration(f.id));
      const fn = resolveFunction(q) || withRepo;
      if (!fn) {
        answer = '还没有函数绑定仓库。到 Functions → GitHub 里填写 owner/repo，或者对我说「把 Store analytics 接到 studio-baas/demo-functions」。';
      } else if (!gitApi.getIntegration(fn.id)) {
        answer = `**${fn.name}** 还没有绑定仓库。告诉我仓库名（例如 studio-baas/demo-functions），我就把它接上。`;
      } else {
        const r = await run('deploy_function_from_git', { function: fn.name });
        add('deploy_function_from_git', { function: fn.name }, r);
        answer = `已从仓库拉取并部署 **${fn.name}**：commit \`${(r as any).sha}\` · ${(r as any).message}。\n\n函数代码已被远端文件覆盖，可以直接 Execute 验证。`;
      }
    } else {
      const m = await run('get_metrics', {});
      add('get_metrics', {}, m);
      const cols = await run('list_collections', {});
      add('list_collections', {}, cols);
      answer = `我是 Studio BaaS 的 AI 助手。当前处于**演示模式**：未检测到 \`DEEPSEEK_API_KEY\`，我用本地规则引擎执行了你的请求所对应的真实工具调用。\n\n项目状态：**${(m as any).documents}** 条文档 · **${(m as any).files}** 个文件 · **${(m as any).users}** 位用户 · **${(m as any).functions}** 个云函数。\n\n你可以试试：\n- 「列出所有集合和文档数量」\n- 「执行 Store analytics 函数」\n- 「显示最近的错误日志」\n- 「创建一个叫 Reviews 的集合」\n\n配置 DeepSeek Key 后（Settings → AI），我会用大模型自主规划多步工具调用，能力与现在完全一致。`;
    }
  } catch (e: any) {
    answer = `执行时出错：${e?.message || e}`;
  }

  return { text: answer, traces, model: 'deepseek-chat (demo)', mode: 'demo' };
}
