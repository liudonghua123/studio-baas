import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashApiKey, previewApiKey } from './apikey.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.resolve(here, '../data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'studio.db'));
db.pragma('journal_mode = WAL');

/** SQLite 没有 `ADD COLUMN IF NOT EXISTS`，用 PRAGMA 自行判断 */
function hasColumn(table: string, column: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((c) => c.name === column);
}
function addColumn(table: string, column: string, ddl: string) {
  if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, region TEXT, plan TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, icon TEXT, color TEXT,
    documentSecurity INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attributes (
    id TEXT PRIMARY KEY, collectionId TEXT NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL,
    required INTEGER DEFAULT 0, array INTEGER DEFAULT 0, size INTEGER, defaultVal TEXT,
    elements TEXT, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY, collectionId TEXT NOT NULL, data TEXT NOT NULL,
    permissions TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS buckets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, maxFileSize INTEGER, allowedExtensions TEXT,
    compression TEXT, encryption INTEGER, imageTransform INTEGER, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY, bucketId TEXT NOT NULL, name TEXT NOT NULL, mimeType TEXT,
    size INTEGER, path TEXT, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS functions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT, entrypoint TEXT, code TEXT,
    schedule TEXT, timeout INTEGER DEFAULT 15, env TEXT, enabled INTEGER DEFAULT 1,
    executeAccess TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS executions (
    id TEXT PRIMARY KEY, functionId TEXT NOT NULL, status TEXT, triggerType TEXT,
    duration REAL, logs TEXT, response TEXT, errors TEXT, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, framework TEXT, domain TEXT, entrypoint TEXT,
    buildCommand TEXT, files TEXT, status TEXT, buildLogs TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, passwordHash TEXT,
    status TEXT, emailVerified INTEGER, labels TEXT, prefs TEXT, createdAt TEXT NOT NULL,
    lastLoginAt TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, secret TEXT NOT NULL, expiresAt TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, channel TEXT, recipient TEXT, subject TEXT, body TEXT,
    status TEXT, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS apiKeys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, scopes TEXT, secret TEXT,
    secretHash TEXT, preview TEXT,
    lastUsedAt TEXT, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY, method TEXT, path TEXT, status INTEGER, duration REAL,
    service TEXT, ip TEXT, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT
  );
  CREATE TABLE IF NOT EXISTS functionDomains (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, functionId TEXT NOT NULL,
    hostname TEXT NOT NULL UNIQUE, status TEXT NOT NULL, verificationToken TEXT,
    sslStatus TEXT, note TEXT, createdAt TEXT NOT NULL, verifiedAt TEXT, lastCheckAt TEXT
  );
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, functionId TEXT NOT NULL, cron TEXT NOT NULL,
    timezone TEXT, enabled INTEGER DEFAULT 1, nextRunAt TEXT, lastRunAt TEXT, lastStatus TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS collectionIndexes (
    id TEXT PRIMARY KEY, collectionId TEXT NOT NULL, key TEXT NOT NULL, type TEXT NOT NULL,
    attributes TEXT NOT NULL, orders TEXT, status TEXT NOT NULL, error TEXT,
    createdAt TEXT NOT NULL, UNIQUE(collectionId, key)
  );
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL,
    createdAt TEXT NOT NULL, UNIQUE(projectId, userId)
  );
  CREATE TABLE IF NOT EXISTS gitIntegrations (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, functionId TEXT NOT NULL, provider TEXT DEFAULT 'github',
    repo TEXT NOT NULL, branch TEXT DEFAULT 'main', rootDir TEXT, path TEXT, token TEXT,
    autoDeploy INTEGER DEFAULT 1, webhookSecret TEXT, lastSyncAt TEXT, lastSha TEXT,
    lastMessage TEXT, lastAuthor TEXT, lastStatus TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gitDeploys (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, functionId TEXT NOT NULL, sha TEXT,
    message TEXT, author TEXT, source TEXT, status TEXT, files INTEGER DEFAULT 1,
    duration REAL, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, provider TEXT, model TEXT, systemPrompt TEXT,
    tools TEXT, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS functionVersions (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, functionId TEXT NOT NULL,
    version INTEGER NOT NULL, code TEXT NOT NULL, label TEXT, createdBy TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS aiSessions (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, title TEXT NOT NULL,
    model TEXT, provider TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS aiMessages (
    id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, role TEXT NOT NULL,
    content TEXT NOT NULL, traces TEXT, createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, url TEXT NOT NULL, events TEXT NOT NULL,
    secret TEXT, enabled INTEGER DEFAULT 1, description TEXT,
    deliveries INTEGER DEFAULT 0, failures INTEGER DEFAULT 0,
    lastStatus INTEGER, lastError TEXT, lastDeliveryAt TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS webhookDeliveries (
    id TEXT PRIMARY KEY, webhookId TEXT NOT NULL, projectId TEXT NOT NULL,
    event TEXT NOT NULL, status INTEGER, duration REAL, error TEXT,
    attempts INTEGER DEFAULT 1, createdAt TEXT NOT NULL
  );
  -- 身份源（SSO）：oauth2 / oidc / cas / ldap，配置整体存 JSON，密文字段在应用层加解密
  CREATE TABLE IF NOT EXISTS authProviders (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1, config TEXT NOT NULL, defaultRole TEXT,
    createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
  );
  -- 外部身份 → 本地用户。一个用户可以有多个身份（先密码登录，后绑定企业账号）
  CREATE TABLE IF NOT EXISTS authIdentities (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, providerId TEXT NOT NULL,
    subject TEXT NOT NULL, email TEXT, data TEXT, lastLoginAt TEXT,
    createdAt TEXT NOT NULL, UNIQUE(providerId, subject)
  );
  -- 一次性 state（CSRF）+ PKCE verifier + nonce，10 分钟过期，用后即删
  CREATE TABLE IF NOT EXISTS authStates (
    id TEXT PRIMARY KEY, providerId TEXT NOT NULL, projectId TEXT NOT NULL,
    verifier TEXT, nonce TEXT, returnTo TEXT, appOrigin TEXT, callbackUrl TEXT,
    createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_docs_col ON documents(collectionId);
  CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(createdAt);
  CREATE INDEX IF NOT EXISTS idx_exec_fn ON executions(functionId);
  CREATE INDEX IF NOT EXISTS idx_schedules_fn ON schedules(functionId);
  CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(nextRunAt);
  CREATE INDEX IF NOT EXISTS idx_domains_fn ON functionDomains(functionId);
  CREATE INDEX IF NOT EXISTS idx_domains_host ON functionDomains(hostname);
  CREATE INDEX IF NOT EXISTS idx_members_project ON members(projectId);
  CREATE INDEX IF NOT EXISTS idx_members_user ON members(userId);
  CREATE INDEX IF NOT EXISTS idx_fnver_fn ON functionVersions(functionId, version DESC);
  CREATE INDEX IF NOT EXISTS idx_aiSessions_project ON aiSessions(projectId, updatedAt DESC);
  CREATE INDEX IF NOT EXISTS idx_aiMessages_session ON aiMessages(sessionId, createdAt);
  CREATE INDEX IF NOT EXISTS idx_webhooks_project ON webhooks(projectId);
  CREATE INDEX IF NOT EXISTS idx_webhookDeliveries_hook ON webhookDeliveries(webhookId, createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_authProviders_project ON authProviders(projectId);
  CREATE INDEX IF NOT EXISTS idx_authIdentities_user ON authIdentities(userId);
  CREATE INDEX IF NOT EXISTS idx_authStates_expiry ON authStates(expiresAt);
  `);

  /* ------------------------------------------- project scoping columns */
  // 升级已有库：所有资源挂到 projectId 上，历史数据归入第一个项目
  addColumn('projects', 'key', 'TEXT');
  addColumn('projects', 'status', "TEXT DEFAULT 'active'");
  addColumn('projects', 'color', "TEXT DEFAULT '#fd366e'");
  addColumn('projects', 'description', 'TEXT');
  addColumn('projects', 'updatedAt', 'TEXT');
  addColumn('projects', 'ownerId', 'TEXT');

  for (const t of ['collections', 'buckets', 'functions', 'sites', 'messages', 'apiKeys', 'logs', 'executions']) {
    addColumn(t, 'projectId', "TEXT DEFAULT 'studio'");
    db.exec(`UPDATE ${t} SET projectId='studio' WHERE projectId IS NULL OR projectId=''`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_project ON ${t}(projectId)`);
  }
  db.exec(`UPDATE projects SET key=lower(replace(name,' ','-')) WHERE key IS NULL OR key=''`);
  db.exec(`UPDATE projects SET status='active' WHERE status IS NULL`);
  db.exec(`UPDATE projects SET updatedAt=createdAt WHERE updatedAt IS NULL`);

  /* ------------------------------------------------ api key hashing (v1.7) */
  addColumn('apiKeys', 'secretHash', 'TEXT');
  addColumn('apiKeys', 'preview', 'TEXT');
  // 历史数据是明文 secret：就地转成摘要 + 预览，然后把明文抹掉。
  // 转换后旧密钥依然可用（校验是「对明文做 sha256 再比对」）。
  const legacy = db.prepare(
    "SELECT id, secret FROM apiKeys WHERE (secretHash IS NULL OR secretHash='') AND secret IS NOT NULL AND secret<>''",
  ).all() as { id: string; secret: string }[];
  if (legacy.length) {
    const upd = db.prepare('UPDATE apiKeys SET secretHash=?, preview=?, secret=NULL WHERE id=?');
    db.transaction(() => { for (const k of legacy) upd.run(hashApiKey(k.secret), previewApiKey(k.secret), k.id); })();
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_apiKeys_hash ON apiKeys(secretHash)');

  /* -------------------------------------------- function versions (v1.8) */
  backfillFunctionVersions();
}

/**
 * 老库 / 种子数据里的函数没有历史版本：给每个函数补一条 v1 作为「当前代码」的基线。
 * 幂等——已经有版本的函数会被跳过，所以可以在每次启动、以及 seed 之后再调一次。
 */
export function backfillFunctionVersions() {
  const unversioned = db.prepare(
    `SELECT f.id, f.code, f.createdAt, COALESCE(f.projectId,'studio') AS projectId FROM functions f
     WHERE NOT EXISTS (SELECT 1 FROM functionVersions v WHERE v.functionId=f.id)`,
  ).all() as { id: string; code: string; createdAt: string; projectId: string }[];
  if (unversioned.length) {
    const ins = db.prepare(
      'INSERT INTO functionVersions (id,projectId,functionId,version,code,label,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?)',
    );
    db.transaction(() => {
      for (const f of unversioned) {
        ins.run(`fv_${f.id}_1`, f.projectId, f.id, 1, f.code, 'initial', 'system', f.createdAt);
      }
    })();
  }
}

export const now = () => new Date().toISOString();
export const uid = (prefix: string) =>
  prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
