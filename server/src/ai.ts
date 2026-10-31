import {
  listCollections, getCollection, createCollection, addAttribute, deleteCollection,
  listDocuments, createDocument, updateDocument, deleteDocument, getDocument,
  listBuckets, listFiles, deleteFile, getFile, deleteBucket,
  listFunctions, getFunction, updateFunction, executeFunction, listExecutions, createFunction,
  listSites, getSite, updateSite, deploySite,
  listUsers, createUser, deleteUser,
  sendMessage, listMessages,
  getMetrics, listLogs, createApiKey, getSetting,
} from './store.js';

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
      },
      required: ['collection', 'data'],
    },
    summary: (a) => `在 ${a.collection} 新建文档`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const d = createDocument(c.id, a.data || {});
      return { ok: true, id: d.id, collection: c.name, data: d.data };
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
      },
      required: ['collection', 'documentId', 'data'],
    },
    summary: (a) => `更新文档 ${a.documentId}`,
    run: (a) => {
      const c = resolveCollection(a.collection);
      if (!c) throw new Error(`Collection "${a.collection}" not found`);
      const d = updateDocument(c.id, a.documentId, a.data || {});
      if (!d) throw new Error('Document not found');
      return { ok: true, id: d.id, data: d.data };
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
];

export const toolMap = new Map(tools.map((t) => [t.name, t]));

/* ------------------------------------------------------------ system prompt */

export const SYSTEM_PROMPT = `你是 Studio BaaS 的 AI 运维助手，由 DeepSeek 驱动。
你可以通过工具直接操作这个平台的**所有**能力：数据库集合与文档、存储桶与文件、云函数（读取/修改代码、执行）、站点（修改文件、部署）、认证用户、消息推送、API Key、日志与指标。

工作原则：
1. 先理解用户意图，需要数据时先调用只读工具（list_* / get_* / get_metrics），再决定是否写入。
2. 修改代码、删除数据、发送消息属于写操作，直接执行并在回复中清晰说明改了什么。
3. 工具参数中的 collection / function / site 可以传名称、key 或 id。
4. 回复使用简体中文，专业、简洁。用 Markdown 组织，必要时用小表格或列表。
5. 不要在回复中编造工具没有返回的数据。执行失败时说明原因并给出修复建议。
6. 当用户要求“做一个页面/改站点”时，使用 update_site_file 写入完整文件内容，然后 deploy_site。
7. 当用户要求“写一个函数/改函数”时，使用 update_function_code，代码必须是完整的 ESM（export default async ({ req, res, log, error, databases, env }) => {...}），然后可以 execute_function 验证。`;

/* ---------------------------------------------------------------- deepseek */

const DEEPSEEK_URL = (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/chat/completions';

export function getAiConfig() {
  const key = process.env.DEEPSEEK_API_KEY || getSetting('deepseek_api_key') || '';
  const model = process.env.DEEPSEEK_MODEL || getSetting('deepseek_model') || 'deepseek-chat';
  return { key, model, configured: key.startsWith('sk-') || key.length > 20 };
}

async function callDeepSeek(key: string, model: string, messages: any[], useTools = true) {
  const body: any = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 2400,
  };
  if (useTools) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${txt.slice(0, 300)}`);
  }
  return (await res.json()) as any;
}

/* -------------------------------------------------------------- chat entry */

export async function chat(history: { role: 'user' | 'assistant'; content: string }[]): Promise<ChatResult> {
  const cfg = getAiConfig();
  if (!cfg.configured) {
    return demoAgent(history);
  }
  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.slice(-12),
  ];
  const traces: ToolTrace[] = [];
  let usage: ChatResult['usage'];

  for (let step = 0; step < 6; step++) {
    const data = await callDeepSeek(cfg.key, cfg.model, messages, true);
    usage = data.usage;
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Empty response from DeepSeek');
    messages.push(msg);

    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return { text: msg.content || '已完成。', traces, model: cfg.model, mode: 'deepseek', usage };
    }

    for (const call of calls) {
      const def = toolMap.get(call.function?.name);
      const started = Date.now();
      let args: any = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
      let result: unknown;
      let ok = true;
      try {
        if (!def) throw new Error(`Unknown tool ${call.function?.name}`);
        result = await def.run(args);
      } catch (e: any) {
        ok = false;
        result = { error: e?.message || String(e) };
      }
      const trace: ToolTrace = {
        id: call.id || `t_${Date.now()}`,
        name: call.function?.name || 'unknown',
        args,
        result: truncate(result, 2500),
        ok,
        duration: Date.now() - started,
        summary: def ? def.summary(args) : call.function?.name || 'unknown',
      };
      traces.push(trace);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      });
    }
  }

  return {
    text: '工具调用轮次已达上限。请把任务拆成更小的步骤，我再继续执行。',
    traces, model: cfg.model, mode: 'deepseek', usage,
  };
}

/* ------------------------------------------------------------- demo agent */

const lastNumber = (s: string) => {
  const m = s.match(/(\d{6,})/);
  return m ? m[1] : null;
};

async function demoAgent(history: { role: string; content: string }[]): Promise<ChatResult> {
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
  let answer = '';

  try {
    if (want('创建集合', '新建集合', 'create collection', '建一个表', '创建表')) {
      const nameMatch = q.match(/(?:集合|表)[叫名]?\s*[「"']?([A-Za-z0-9_\u4e00-\u9fa5]{2,20})/);
      const name = (nameMatch?.[1] || 'New collection').replace(/[，。,.].*$/, '');
      const r = await toolMap.get('create_collection')!.run({ name });
      add('create_collection', { name }, r);
      answer = `已创建集合 **${(r as any).name}**（key: \`${(r as any).key}\`）。\n\n下一步可以让我「给 ${(r as any).name} 添加字段 price，类型 float」，或者直接在 Databases 页面添加属性。`;
    } else if (want('函数', 'function') && want('运行', '执行', 'run', 'execute', '测试')) {
      const fn = resolveFunction(q) || listFunctions()[0];
      const r = await toolMap.get('execute_function')!.run({ function: fn.name, payload: { source: 'deepseek-demo' } });
      add('execute_function', { function: fn.name }, r);
      answer = `已执行云函数 **${fn.name}**，状态 \`${(r as any).status}\`，耗时 ${(r as any).duration}ms。\n\n\`\`\`json\n${JSON.stringify((r as any).response, null, 2).slice(0, 600)}\n\`\`\``;
    } else if (want('函数', 'function') && want('列表', '有哪些', '列出', 'list')) {
      const r = await toolMap.get('list_functions')!.run({});
      add('list_functions', {}, r);
      const rows = (r as any[]).map((f) => `| ${f.name} | \`${f.runtime}\` | ${f.schedule} | ${f.executions} |`).join('\n');
      answer = `当前项目有 **${(r as any[]).length}** 个云函数：\n\n| 名称 | 运行时 | 触发器 | 执行次数 |\n|---|---|---|---|\n${rows}\n\n可以让我「执行 Order webhook」或「把 Health probe 的代码改成…」。`;
    } else if (want('用户', 'user') && want('创建', '新建', '添加', 'create')) {
      const email = q.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0] || `user${Date.now().toString().slice(-4)}@example.com`;
      const name = q.match(/(?:叫|名为|名字是)\s*([\u4e00-\u9fa5A-Za-z ]{2,20})/)?.[1] || email.split('@')[0];
      const r = await toolMap.get('create_user')!.run({ name, email });
      add('create_user', { name, email }, r);
      answer = `已创建用户 **${name}**（${email}），状态为 \`unverified\`，已发送验证邮件（演示）。`;
    } else if (want('用户', 'user') && !want('概览', '指标', '统计', 'overview', 'metric', '汇总')) {
      const r = await toolMap.get('list_users')!.run({});
      add('list_users', {}, r);
      answer = `当前有 **${(r as any[]).length}** 位终端用户，其中 ${(r as any[]).filter((u) => u.status === 'active').length} 位处于 active 状态。\n\n${(r as any[]).slice(0, 5).map((u) => `- **${u.name}** · ${u.email} · ${u.status}`).join('\n')}`;
    } else if (want('文档', '数据', '产品', '订单', '记录', 'document', 'data') && !want('创建', '新建') && !want('概览', '指标', '统计', '汇总')) {
      const col = resolveCollection(q) || listCollections(false)[0];
      const r = await toolMap.get('list_documents')!.run({ collection: col.id, limit: 5 });
      add('list_documents', { collection: col.name, limit: 5 }, r);
      const docs = (r as any).documents;
      answer = `集合 **${col.name}** 共 **${(r as any).total}** 条文档。最近 ${docs.length} 条：\n\n| ID | 摘要 |\n|---|---|\n${docs.map((d: any) => `| \`${d.id}\` | ${Object.entries(d).filter(([k]) => !['id'].includes(k)).slice(0, 4).map(([k, v]) => `${k}: ${String(v).slice(0, 28)}`).join(' · ')} |`).join('\n')}`;
    } else if (want('创建文档', '新建文档', '插入', '添加一条', 'create document')) {
      const col = resolveCollection(q) || listCollections(false)[0];
      const r = await toolMap.get('create_document')!.run({ collection: col.id, data: { name: 'AI generated record', status: 'draft' } });
      add('create_document', { collection: col.name }, r);
      answer = `已在 **${col.name}** 创建文档 \`${(r as any).id}\`。`;
    } else if (want('指标', '统计', '概览', '多少', 'metrics', 'stat')) {
      const r = await toolMap.get('get_metrics')!.run({});
      add('get_metrics', {}, r);
      answer = `项目实时概览：\n\n| 指标 | 数值 |\n|---|---|\n| 集合 | ${listCollections().length} |\n| 文档 | ${(r as any).documents} |\n| 文件 | ${(r as any).files} |\n| 用户 | ${(r as any).users} |\n| 云函数 | ${(r as any).functions} |\n| 24h 执行 | ${(r as any).executions24h} |\n| 24h 请求 | ${(r as any).requests24h} |\n\n请求量最高的集合：${(r as any).topCollections.slice(0, 3).map((c: any) => `${c.name} (${c.documents})`).join('、')}。`;
    } else if (want('站点', 'site', '页面')) {
      const sites = await toolMap.get('list_sites')!.run({});
      add('list_sites', {}, sites);
      answer = `当前托管 **${(sites as any[]).length}** 个站点：\n\n${(sites as any[]).map((s) => `- **${s.name}** · ${s.domain} · \`${s.status}\` · ${s.files.length} 个文件`).join('\n')}\n\n打开 **Sites** 页面即可在线编辑 HTML/CSS/JS 并实时预览。`;
    } else if (want('日志', 'log', '错误', '报错')) {
      const r = await toolMap.get('get_logs')!.run({ limit: 10 });
      add('get_logs', {}, r);
      const errs = (r as any[]).filter((l) => l.status >= 400);
      answer = `最近 10 条请求中，有 **${errs.length}** 条错误：\n\n${errs.slice(0, 5).map((l) => `- \`${l.status}\` ${l.method} ${l.path} (${l.ms}ms)`).join('\n') || '- 没有错误，服务健康。'}`;
    } else if (want('存储', '文件', 'file', 'bucket')) {
      const r = await toolMap.get('list_files')!.run({});
      add('list_files', {}, r);
      answer = `存储服务共有 **${(r as any[]).length}** 个桶：\n\n| 桶 | 文件数 | 占用 |\n|---|---|---|\n${(r as any[]).map((b) => `| ${b.name} | ${b.files} | ${(b.size / 1024).toFixed(1)} KB |`).join('\n')}`;
    } else {
      const m = await toolMap.get('get_metrics')!.run({});
      add('get_metrics', {}, m);
      const cols = await toolMap.get('list_collections')!.run({});
      add('list_collections', {}, cols);
      answer = `我是 Studio BaaS 的 AI 助手。当前处于**演示模式**：未检测到 \`DEEPSEEK_API_KEY\`，我用本地规则引擎执行了你的请求所对应的真实工具调用。\n\n项目状态：**${(m as any).documents}** 条文档 · **${(m as any).files}** 个文件 · **${(m as any).users}** 位用户 · **${(m as any).functions}** 个云函数。\n\n你可以试试：\n- 「列出所有集合和文档数量」\n- 「执行 Store analytics 函数」\n- 「显示最近的错误日志」\n- 「创建一个叫 Reviews 的集合」\n\n配置 DeepSeek Key 后（Settings → AI），我会用大模型自主规划多步工具调用，能力与现在完全一致。`;
    }
  } catch (e: any) {
    answer = `执行时出错：${e?.message || e}`;
  }

  return { text: answer, traces, model: 'deepseek-chat (demo)', mode: 'demo' };
}
