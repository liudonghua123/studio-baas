import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, db, now } from './db.js';
import { seed, seedDemoProject, seedMembers } from './seed.js';
import { bus } from './events.js';
import * as store from './store.js';
import * as projects from './projects.js';
import { chat, getAiConfig, tools } from './ai.js';
import { runWithContext, currentProjectId, DEFAULT_PROJECT_ID } from './context.js';
import { resolveAuth, guard, me } from './auth.js';
import * as members from './members.js';
import { PERMISSIONS, ROLES, permissionsForRole } from './rbac.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const DOCS_DIR = path.join(ROOT, 'docs');

migrate();
const seeded = seed();
seedDemoProject();
seedMembers();

const app = express();
app.use(cors());
app.use(express.json({ limit: '12mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

/* ------------------------------------------------------- project context */
// 所有 /v1 请求都绑定到一个项目：显式 X-Project-Id 优先，否则用默认项目。
// 下游 store 层通过 AsyncLocalStorage 读取，避免层层透传 projectId。
app.use((req, _res, next) => {
  const requested = String(req.header('x-project-id') || req.query.projectId || '');
  const project = requested ? projects.getProject(requested) : projects.defaultProject();
  const fallback = project?.id || DEFAULT_PROJECT_ID;
  const auth = resolveAuth(req, fallback);
  // API Key 自带项目归属，优先于请求头，避免跨项目读取
  runWithContext({ projectId: auth.projectId || fallback, principal: auth.principal }, () => next());
});

const wrap = (fn: (req: express.Request, res: express.Response) => Promise<any> | any) =>
  (req: express.Request, res: express.Response) => {
    try {
      const out = fn(req, res);
      if (out && typeof (out as Promise<any>).catch === 'function') {
        (out as Promise<any>).catch((e) => fail(res, e));
      }
    } catch (e) { fail(res, e); }
  };
const fail = (res: express.Response, e: any, code = 400) =>
  res.status(code).json({ ok: false, error: e?.message || String(e) });

/* ----------------------------------------------------------- request logs */
const SKIP_LOG = ['/v1/metrics', '/v1/realtime', '/v1/logs', '/v1/ai/status', '/v1/project', '/v1/health', '/v1/docs'];
app.use((req, res, next) => {
  if (!req.path.startsWith('/v1') || SKIP_LOG.some((p) => req.path.startsWith(p))) return next();
  const started = Date.now();
  res.on('finish', () => {
    const service = req.path.split('/')[2] || 'core';
    store.addLog({
      method: req.method, path: req.path, status: res.statusCode,
      duration: Math.round(Date.now() - started), service: mapService(service),
      ip: req.ip?.replace('::ffff:', '') || '127.0.0.1',
    });
  });
  next();
});
const mapService = (s: string) => (s === 'databases' ? 'databases' : s);

/* ---------------------------------------------------------------- core */
app.get('/v1/health', (_req, res) => res.json({ ok: true, status: 'healthy', version: '1.6.0-studio', uptime: process.uptime() }));

app.get('/v1/project', guard('project.read'), (_req, res) => {
  const p = projects.getProject(currentProjectId()) || projects.defaultProject();
  res.json({ ...p, seeded, services: store.getMetrics().services });
});

/* ------------------------------------------------------------- identity */
app.get('/v1/auth/me', (_req, res) => res.json(me(currentProjectId())));

app.get('/v1/permissions', (_req, res) => res.json({
  roles: ROLES,
  permissions: PERMISSIONS,
  matrix: Object.fromEntries(ROLES.map((r) => [r.id, permissionsForRole(r.id)])),
}));

/* -------------------------------------------------------------- members */
app.get('/v1/members', guard('members.read'), (_req, res) => {
  const list = members.listMembers(currentProjectId());
  res.json({ total: list.length, members: list, me: me(currentProjectId()) });
});

app.post('/v1/members', guard('members.write'), wrap((req, res) => {
  res.status(201).json(members.addMember(currentProjectId(), req.body || {}));
}));

app.patch('/v1/members/:id', guard('members.write'), wrap((req, res) => {
  const m = members.updateMemberRole(currentProjectId(), req.params.id, req.body?.role);
  if (!m) return fail(res, new Error('Member not found'), 404);
  res.json(m);
}));

app.delete('/v1/members/:id', guard('members.write'), wrap((req, res) => {
  res.json({ ok: members.removeMember(currentProjectId(), req.params.id) });
}));

/* --------------------------------------------------------------- projects */
app.get('/v1/projects', guard('project.read'), (_req, res) => {
  const list = projects.listProjects();
  res.json({ total: list.length, projects: list, currentProjectId: currentProjectId() });
});

app.post('/v1/projects', guard('project.write'), wrap((req, res) => res.status(201).json(projects.createProject(req.body || {}))));

app.get('/v1/projects/:id', guard('project.read'), wrap((req, res) => {
  const p = projects.getProject(req.params.id);
  if (!p) return fail(res, new Error('Project not found'), 404);
  res.json(p);
}));

app.patch('/v1/projects/:id', guard('project.write'), wrap((req, res) => {
  const p = projects.updateProject(req.params.id, req.body || {});
  if (!p) return fail(res, new Error('Project not found'), 404);
  res.json(p);
}));

app.delete('/v1/projects/:id', guard('project.delete'), wrap((req, res) => {
  res.json({ ok: projects.deleteProject(req.params.id) });
}));

app.get('/v1/metrics', guard('project.read'), (_req, res) => res.json(store.getMetrics()));

/* ------------------------------------------------------------ databases */
app.get('/v1/databases/collections', guard('databases.read'), (_req, res) => res.json({ total: store.listCollections().length, collections: store.listCollections() }));

app.post('/v1/databases/collections', guard('databases.write'), wrap((req, res) => {
  const c = store.createCollection(req.body || {});
  res.status(201).json(c);
}));

app.get('/v1/databases/collections/:id', guard('databases.read'), wrap((req, res) => {
  const c = store.getCollection(req.params.id);
  if (!c) return fail(res, new Error('Collection not found'), 404);
  res.json(c);
}));

app.patch('/v1/databases/collections/:id', guard('databases.write'), wrap((req, res) => {
  const c = store.updateCollection(req.params.id, req.body || {});
  if (!c) return fail(res, new Error('Collection not found'), 404);
  res.json(c);
}));

app.delete('/v1/databases/collections/:id', guard('databases.write'), wrap((req, res) => {
  const ok = store.deleteCollection(req.params.id);
  res.json({ ok });
}));

app.post('/v1/databases/collections/:id/attributes', guard('databases.write'), wrap((req, res) => {
  const a = store.addAttribute(req.params.id, req.body || {});
  res.status(201).json(a);
}));

app.delete('/v1/databases/collections/:id/attributes/:attrId', guard('databases.write'), wrap((req, res) => {
  const ok = store.deleteAttribute(req.params.id, req.params.attrId);
  res.json({ ok });
}));

app.get('/v1/databases/collections/:id/documents', guard('databases.read'), wrap((req, res) => {
  const r = store.listDocuments(req.params.id, {
    limit: Number(req.query.limit) || 25,
    offset: Number(req.query.offset) || 0,
    search: (req.query.search as string) || undefined,
    orderBy: (req.query.orderBy as string) || undefined,
    orderType: (req.query.orderType as 'asc' | 'desc') || 'desc',
  });
  res.json(r);
}));

app.post('/v1/databases/collections/:id/documents', guard('databases.write'), wrap((req, res) => {
  const d = store.createDocument(req.params.id, req.body?.data ?? req.body, req.body?.documentId, req.body?.permissions);
  res.status(201).json(d);
}));

app.get('/v1/databases/collections/:id/documents/:docId', guard('databases.read'), wrap((req, res) => {
  const d = store.getDocument(req.params.id, req.params.docId);
  if (!d) return fail(res, new Error('Document not found'), 404);
  res.json(d);
}));

app.patch('/v1/databases/collections/:id/documents/:docId', guard('databases.write'), wrap((req, res) => {
  const d = store.updateDocument(req.params.id, req.params.docId, req.body?.data ?? req.body);
  if (!d) return fail(res, new Error('Document not found'), 404);
  res.json(d);
}));

app.delete('/v1/databases/collections/:id/documents/:docId', guard('databases.write'), wrap((req, res) => {
  res.json({ ok: store.deleteDocument(req.params.id, req.params.docId) });
}));

/* -------------------------------------------------------------- storage */
app.get('/v1/storage/buckets', guard('storage.read'), (_req, res) => res.json({ total: store.listBuckets().length, buckets: store.listBuckets() }));

app.post('/v1/storage/buckets', guard('storage.write'), wrap((req, res) => {
  res.status(201).json(store.createBucket(req.body || {}));
}));

app.delete('/v1/storage/buckets/:id', guard('storage.write'), wrap((req, res) => res.json({ ok: store.deleteBucket(req.params.id) })));

app.get('/v1/storage/buckets/:id/files', guard('storage.read'), wrap((req, res) => {
  res.json({ total: store.listFiles(req.params.id).length, files: store.listFiles(req.params.id) });
}));

app.post('/v1/storage/buckets/:id/files', guard('storage.write'), upload.single('file'), wrap((req, res) => {
  if (!req.file) return fail(res, new Error('No file uploaded'));
  res.status(201).json(store.saveFile(req.params.id, req.file));
}));

app.get('/v1/storage/files/:fileId/view', wrap((req, res) => {
  const f = store.getFile(req.params.fileId);
  if (!f || !fs.existsSync(f.path)) return fail(res, new Error('File not found'), 404);
  res.setHeader('Content-Type', f.mimeType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=300');
  fs.createReadStream(f.path).pipe(res);
}));

app.delete('/v1/storage/files/:fileId', guard('storage.write'), wrap((req, res) => res.json({ ok: store.deleteFile(req.params.fileId) })));

/* ------------------------------------------------------------ functions */
app.get('/v1/functions', guard('functions.read'), (_req, res) => res.json({ total: store.listFunctions().length, functions: store.listFunctions() }));

app.post('/v1/functions', guard('functions.write'), wrap((req, res) => res.status(201).json(store.createFunction(req.body || {}))));

app.get('/v1/functions/:id', guard('functions.read'), wrap((req, res) => {
  const f = store.getFunction(req.params.id);
  if (!f) return fail(res, new Error('Function not found'), 404);
  const desc = db.prepare('SELECT value FROM settings WHERE key=?').get('fn_desc_' + f.id) as any;
  res.json({ ...f, description: desc?.value || '' });
}));

app.patch('/v1/functions/:id', guard('functions.write'), wrap((req, res) => {
  const f = store.updateFunction(req.params.id, req.body || {});
  if (!f) return fail(res, new Error('Function not found'), 404);
  res.json(f);
}));

app.delete('/v1/functions/:id', guard('functions.write'), wrap((req, res) => res.json({ ok: store.deleteFunction(req.params.id) })));

app.post('/v1/functions/:id/executions', guard('functions.execute'), wrap(async (req, res) => {
  const r = await store.executeFunction(req.params.id, req.body ?? {}, 'manual');
  res.json(r);
}));

app.get('/v1/functions/:id/executions', guard('functions.read'), wrap((req, res) => {
  res.json({ total: 0, executions: store.listExecutions(req.params.id, 20) });
}));

app.get('/v1/executions', guard('functions.read'), (_req, res) => res.json({ executions: store.listExecutions(undefined, 30) }));

/* ---------------------------------------------------------------- sites */
app.get('/v1/sites', guard('sites.read'), (_req, res) => res.json({ total: store.listSites().length, sites: store.listSites() }));

app.post('/v1/sites', guard('sites.write'), wrap((req, res) => res.status(201).json(store.createSite(req.body || {}))));

app.get('/v1/sites/:id', guard('sites.read'), wrap((req, res) => {
  const s = store.getSite(req.params.id);
  if (!s) return fail(res, new Error('Site not found'), 404);
  res.json(s);
}));

app.patch('/v1/sites/:id', guard('sites.write'), wrap((req, res) => {
  const s = store.updateSite(req.params.id, req.body || {});
  if (!s) return fail(res, new Error('Site not found'), 404);
  res.json(s);
}));

app.delete('/v1/sites/:id', guard('sites.write'), wrap((req, res) => res.json({ ok: store.deleteSite(req.params.id) })));

app.post('/v1/sites/:id/deployments', guard('sites.deploy'), wrap((req, res) => {
  const s = store.deploySite(req.params.id);
  if (!s) return fail(res, new Error('Site not found'), 404);
  res.json(s);
}));

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', ico: 'image/x-icon', md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', woff2: 'font/woff2',
};
const serveSite = (req: express.Request, res: express.Response) => {
  const f = store.siteFile(req.params.id, req.params[0] || '');
  if (!f) return fail(res, new Error('Site not found'), 404);
  const ext = path.extname(f.path).replace('.', '').toLowerCase();
  res.setHeader('Content-Type', MIME[ext] || 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(f.content);
};
app.get('/v1/sites/:id/preview', serveSite);
app.get('/v1/sites/:id/preview/*', serveSite);

/* ---------------------------------------------------------------- users */
app.get('/v1/users', guard('users.read'), wrap((req, res) => {
  let users = store.listUsers();
  const q = String(req.query.search || '').toLowerCase();
  if (q) users = users.filter((u) => u.name.toLowerCase().includes(q) || u.email.includes(q));
  res.json({ total: users.length, users });
}));

app.post('/v1/users', guard('users.write'), wrap((req, res) => res.status(201).json(store.createUser(req.body || {}))));

app.patch('/v1/users/:id', guard('users.write'), wrap((req, res) => {
  const u = store.updateUser(req.params.id, req.body || {});
  if (!u) return fail(res, new Error('User not found'), 404);
  res.json(u);
}));

app.delete('/v1/users/:id', guard('users.write'), wrap((req, res) => res.json({ ok: store.deleteUser(req.params.id) })));

app.post('/v1/account/sessions', wrap((req, res) => {
  const { email, password } = req.body || {};
  res.status(201).json(store.login(email, password));
}));

/* ------------------------------------------------------------- messaging */
app.get('/v1/messaging/messages', guard('messaging.read'), (_req, res) => res.json({ messages: store.listMessages() }));

app.post('/v1/messaging/messages', guard('messaging.write'), wrap((req, res) => {
  const m = store.sendMessage(req.body || {});
  res.status(201).json(m);
}));

/* -------------------------------------------------------------- api keys */
app.get('/v1/api-keys', guard('keys.read'), (_req, res) => res.json({ keys: store.listApiKeys() }));
app.post('/v1/api-keys', guard('keys.write'), wrap((req, res) => res.status(201).json(store.createApiKey(req.body?.name || 'New key', req.body?.scopes || []))));
app.delete('/v1/api-keys/:id', guard('keys.write'), wrap((req, res) => res.json({ ok: store.deleteApiKey(req.params.id) })));

/* ------------------------------------------------------------------ logs */
app.get('/v1/logs', guard('logs.read'), (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  res.json({ logs: store.listLogs(limit) });
});

/* -------------------------------------------------------------- realtime */
app.get('/v1/realtime', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ at: now() })}\n\n`);
  const onEvent = (e: any) => res.write(`event: message\ndata: ${JSON.stringify(e)}\n\n`);
  bus.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); bus.off('event', onEvent); });
});

/* -------------------------------------------------------------------- ai */
app.get('/v1/ai/status', (_req, res) => {
  const cfg = getAiConfig();
  res.json({
    provider: 'DeepSeek', model: cfg.model, configured: cfg.configured,
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    mode: cfg.configured ? 'deepseek' : 'demo',
  });
});

app.post('/v1/ai/chat', wrap(async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return fail(res, new Error('messages[] is required'));
  const result = await chat(messages);
  res.json(result);
}));

app.post('/v1/settings/ai', wrap((req, res) => {
  const { apiKey, model } = req.body || {};
  if (typeof apiKey === 'string') store.setSetting('deepseek_api_key', apiKey.trim());
  if (typeof model === 'string' && model.trim()) store.setSetting('deepseek_model', model.trim());
  res.json({ ok: true, ...maskedAi() });
}));

app.get('/v1/settings/ai', (_req, res) => res.json(maskedAi()));

function maskedAi() {
  const cfg = getAiConfig();
  const stored = store.getSetting('deepseek_api_key') || '';
  const envKey = process.env.DEEPSEEK_API_KEY || '';
  const source = envKey ? 'env' : stored ? 'settings' : 'none';
  return {
    configured: cfg.configured, model: cfg.model, source,
    keyPreview: cfg.key ? cfg.key.slice(0, 5) + '••••••••' + cfg.key.slice(-4) : '',
  };
}

/* ------------------------------------------------------------------ docs */
app.get('/v1/docs/raw', (_req, res) => {
  const p = path.join(DOCS_DIR, 'Appwrite-核心功能分析.md');
  if (!fs.existsSync(p)) return fail(res, new Error('Docs not generated'), 404);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="appwrite-core-analysis.md"');
  res.send(fs.readFileSync(p, 'utf8'));
});

app.get('/v1/docs', (_req, res) => {
  const candidates = ['Appwrite-核心功能分析.md', 'appwrite-core-analysis.md'];
  for (const name of candidates) {
    const p = path.join(DOCS_DIR, name);
    if (fs.existsSync(p)) {
      return res.json({ title: name, markdown: fs.readFileSync(p, 'utf8') });
    }
  }
  res.json({ title: 'Docs', markdown: '# 文档尚未生成\n\n请稍后刷新。' });
});

/* --------------------------------------------------------- static client */
if (fs.existsSync(WEB_DIST)) {
  app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/v1')) return next();
    res.sendFile(path.join(WEB_DIST, 'index.html'));
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ ok: false, error: err?.message || 'Internal error' });
});

const PORT = Number(process.env.PORT) || 5174;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ⚡ Studio BaaS API ready on http://localhost:${PORT}`);
  console.log(`  → DeepSeek: ${getAiConfig().configured ? 'configured' : 'demo mode (no API key)'}\n`);
});
