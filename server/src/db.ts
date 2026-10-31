import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, userId TEXT NOT NULL, role TEXT NOT NULL,
    createdAt TEXT NOT NULL, UNIQUE(projectId, userId)
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, provider TEXT, model TEXT, systemPrompt TEXT,
    tools TEXT, createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_docs_col ON documents(collectionId);
  CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(createdAt);
  CREATE INDEX IF NOT EXISTS idx_exec_fn ON executions(functionId);
  CREATE INDEX IF NOT EXISTS idx_domains_fn ON functionDomains(functionId);
  CREATE INDEX IF NOT EXISTS idx_domains_host ON functionDomains(hostname);
  CREATE INDEX IF NOT EXISTS idx_members_project ON members(projectId);
  CREATE INDEX IF NOT EXISTS idx_members_user ON members(userId);
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
}

export const now = () => new Date().toISOString();
export const uid = (prefix: string) =>
  prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
