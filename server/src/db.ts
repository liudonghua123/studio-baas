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
  -- 第二因素：TOTP 存密文 secret，WebAuthn 存 COSE 公钥与 credential id。
  -- 一个用户可以有多个（手机 + 笔记本的 Touch ID），approvedAt 为空的 TOTP 还没被验证过，
  -- 不能被用来登录 —— 否则「添加上一步失败」就等于给自己留了个死胡同。
  CREATE TABLE IF NOT EXISTS mfaMethods (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
    secret TEXT, credentialId TEXT, publicKey TEXT, algorithm INTEGER,
    counter INTEGER DEFAULT 0, transports TEXT, aaguid TEXT,
    verifiedAt TEXT, lastUsedAt TEXT, lastCounter INTEGER,
    createdAt TEXT NOT NULL
  );
  -- 恢复码：只存 sha256，用掉即删。每次重新生成会清空旧的一批
  CREATE TABLE IF NOT EXISTS mfaRecoveryCodes (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, codeHash TEXT NOT NULL,
    usedAt TEXT, createdAt TEXT NOT NULL
  );
  -- 策略：按角色或按人要求 / 豁免二次验证。空表 = 不强制
  CREATE TABLE IF NOT EXISTS mfaPolicies (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL,
    scope TEXT NOT NULL, target TEXT NOT NULL,
    mode TEXT NOT NULL, createdAt TEXT NOT NULL,
    UNIQUE(projectId, scope, target)
  );
  -- 登录第一步（密码 / SSO / LDAP）通过后的一次性票据：换会话必须完成第二因素。
  -- 把「已证明的第一因素」和「待证明的第二因素」分开，避免半登录状态拿到会话。
  CREATE TABLE IF NOT EXISTS mfaChallenges (
    id TEXT PRIMARY KEY, userId TEXT NOT NULL, projectId TEXT NOT NULL,
    kind TEXT NOT NULL, purpose TEXT NOT NULL, data TEXT,
    attempts INTEGER DEFAULT 0, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL
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
  CREATE INDEX IF NOT EXISTS idx_mfaMethods_user ON mfaMethods(userId);
  CREATE INDEX IF NOT EXISTS idx_mfaRecovery_user ON mfaRecoveryCodes(userId);
  CREATE INDEX IF NOT EXISTS idx_mfaPolicies_project ON mfaPolicies(projectId);
  CREATE INDEX IF NOT EXISTS idx_mfaChallenges_expiry ON mfaChallenges(expiresAt);
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

  /* ------------------------------------------ multi-runtime functions (v1.13) */
  // 注意：版本表的列要先补齐，再跑 backfill——老库上 backfill 的 INSERT 会带上这两列
  // 执行记录带上「当时用的运行时」：函数之后换语言，历史仍然说得清
  addColumn('executions', 'runtime', 'TEXT');
  // 只迁移已知的历史写法，不用 LIKE 'node-%'：将来加 node-24 时不会被这条语句改掉
  db.exec(`UPDATE functions SET runtime='node-22'
    WHERE runtime IS NULL OR runtime='' OR lower(runtime) IN
      ('node','nodejs','node-18','node-18.0','node-20','node-20.0')`);
  db.exec(`UPDATE functions SET runtime='python-3'
    WHERE lower(runtime) IN ('python','python3','py','python-3.10','python-3.11','python-3.12','python-3.13')`);
  // 语言换了但入口还留着 .js 的老数据，补成该语言的默认入口
  db.exec(`UPDATE functions SET entrypoint='main.py'
    WHERE runtime='python-3' AND (entrypoint IS NULL OR entrypoint='' OR entrypoint LIKE '%.js')`);

  // 版本快照也要记住当时的语言：否则 Node→Python 后回滚旧版本，会得到「Python 运行时跑 JS」
  addColumn('functionVersions', 'runtime', 'TEXT');
  addColumn('functionVersions', 'entrypoint', 'TEXT');
  db.exec(`UPDATE functionVersions SET runtime=(SELECT runtime FROM functions f WHERE f.id=functionVersions.functionId)
    WHERE runtime IS NULL OR runtime=''`);
  db.exec(`UPDATE functionVersions SET entrypoint=(SELECT entrypoint FROM functions f WHERE f.id=functionVersions.functionId)
    WHERE entrypoint IS NULL OR entrypoint=''`);

  /* -------------------------------------------- function versions (v1.8) */
  backfillFunctionVersions();

  /* ------------------------------------------------ step-up auth (v1.12) */
  // assurance: 'single' 只有第一因素 | 'multi' 通过了第二因素 | 'pending' 策略要求但还没过
  addColumn('sessions', 'assurance', "TEXT DEFAULT 'single'");
  addColumn('sessions', 'mfaAt', 'TEXT');
  db.exec("UPDATE sessions SET assurance='single' WHERE assurance IS NULL OR assurance=''");
}

/**
 * 老库 / 种子数据里的函数没有历史版本：给每个函数补一条 v1 作为「当前代码」的基线。
 * 幂等——已经有版本的函数会被跳过，所以可以在每次启动、以及 seed 之后再调一次。
 */
export function backfillFunctionVersions() {
  const unversioned = db.prepare(
    `SELECT f.id, f.code, f.createdAt, COALESCE(f.projectId,'studio') AS projectId, f.runtime, f.entrypoint
     FROM functions f WHERE NOT EXISTS (SELECT 1 FROM functionVersions v WHERE v.functionId=f.id)`,
  ).all() as { id: string; code: string; createdAt: string; projectId: string; runtime: string; entrypoint: string }[];
  if (unversioned.length) {
    const ins = db.prepare(
      'INSERT INTO functionVersions (id,projectId,functionId,version,code,label,createdBy,createdAt,runtime,entrypoint) VALUES (?,?,?,?,?,?,?,?,?,?)',
    );
    db.transaction(() => {
      for (const f of unversioned) {
        ins.run(`fv_${f.id}_1`, f.projectId, f.id, 1, f.code, 'initial', 'system', f.createdAt, f.runtime, f.entrypoint);
      }
    })();
  }
}

export const now = () => new Date().toISOString();
export const uid = (prefix: string) =>
  prefix + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
