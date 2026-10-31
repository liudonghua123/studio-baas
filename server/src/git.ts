import crypto from 'node:crypto';
import { db, now, uid } from './db.js';
import { bus } from './events.js';
import { currentProjectId } from './context.js';
import * as store from './store.js';

/**
 * GitHub 集成：把函数的源码和仓库分支绑定。
 *
 * 两种模式（GIT_MODE）：
 *  - simulate（默认）：不访问外网，用确定性的"远端"内容模拟 pull/push/commit，
 *    便于本地演示与 CI；所有交互、状态流转与真实模式一致。
 *  - live：调用 GitHub REST API，可读私有仓库（需要 token），支持真实 commit 与 webhook 验签。
 *
 * 无论哪种模式，webhook 的 HMAC-SHA256 验签、分支过滤、部署记录都是真实的逻辑。
 */
export const gitMode: 'simulate' | 'live' = process.env.GIT_MODE === 'live' ? 'live' : 'simulate';

export interface GitIntegration {
  id: string;
  projectId: string;
  functionId: string;
  functionName?: string;
  provider: 'github';
  repo: string;
  branch: string;
  rootDir: string;
  path: string;
  autoDeploy: boolean;
  hasToken: boolean;
  webhookSecret: string;
  lastSyncAt: string | null;
  lastSha: string | null;
  lastMessage: string | null;
  lastAuthor: string | null;
  lastStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Deploy {
  id: string;
  functionId: string;
  sha: string;
  message: string;
  author: string;
  source: string;
  status: string;
  files: number;
  duration: number;
  createdAt: string;
}

const fromRow = (r: any): GitIntegration => ({
  id: r.id, projectId: r.projectId, functionId: r.functionId,
  provider: 'github', repo: r.repo, branch: r.branch || 'main',
  rootDir: r.rootDir || '', path: r.path || 'src/main.js',
  autoDeploy: !!r.autoDeploy, hasToken: !!r.token,
  webhookSecret: r.webhookSecret || '',
  lastSyncAt: r.lastSyncAt, lastSha: r.lastSha, lastMessage: r.lastMessage,
  lastAuthor: r.lastAuthor, lastStatus: r.lastStatus,
  createdAt: r.createdAt, updatedAt: r.updatedAt,
  functionName: (db.prepare('SELECT name FROM functions WHERE id=?').get(r.functionId) as any)?.name,
});

const deployFromRow = (r: any): Deploy => ({
  id: r.id, functionId: r.functionId, sha: r.sha, message: r.message, author: r.author,
  source: r.source, status: r.status, files: r.files, duration: r.duration, createdAt: r.createdAt,
});

/* ------------------------------------------------------------ CRUD */

export function getIntegration(functionId: string): GitIntegration | null {
  const r = db.prepare('SELECT * FROM gitIntegrations WHERE functionId=? AND projectId=?')
    .get(functionId, currentProjectId()) as any;
  return r ? fromRow(r) : null;
}

export function getById(id: string): GitIntegration | null {
  const r = db.prepare('SELECT * FROM gitIntegrations WHERE id=?').get(id) as any;
  return r ? fromRow(r) : null;
}

export function connect(functionId: string, input: {
  repo?: string; branch?: string; rootDir?: string; path?: string; token?: string; autoDeploy?: boolean;
}): GitIntegration {
  const fn = store.getFunction(functionId);
  if (!fn) throw new Error('Function not found');
  const repo = String(input.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('仓库格式应为 owner/repo，例如 studio-baas/demo-functions');
  const branch = (input.branch || 'main').trim() || 'main';
  const rootDir = (input.rootDir || '').trim().replace(/^\/+|\/+$/g, '');
  const path = (input.path || rootDir || fn.entrypoint || 'src/main.js').trim();
  const existing = getIntegration(functionId);
  const secret = existing?.webhookSecret || crypto.randomBytes(16).toString('hex');
  const prevToken = existing
    ? ((db.prepare('SELECT token FROM gitIntegrations WHERE id=?').get(existing.id) as any)?.token || null)
    : null;
  const token = input.token === undefined ? prevToken : (input.token || null);
  const t = now();

  if (existing) {
    db.prepare(`UPDATE gitIntegrations SET repo=?,branch=?,rootDir=?,path=?,token=?,autoDeploy=?,webhookSecret=?,updatedAt=? WHERE id=?`).run(
      repo, branch, rootDir, path, token,
      (input.autoDeploy ?? existing.autoDeploy) ? 1 : 0, secret, t, existing.id,
    );
    bus.publish({ type: 'git', action: 'update', resource: `${repo}@${branch}` });
    return fromRow(db.prepare('SELECT * FROM gitIntegrations WHERE id=?').get(existing.id));
  }

  const id = uid('git_');
  db.prepare(`INSERT INTO gitIntegrations
    (id,projectId,functionId,provider,repo,branch,rootDir,path,token,autoDeploy,webhookSecret,lastSyncAt,lastSha,lastMessage,lastAuthor,lastStatus,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, currentProjectId(), functionId, 'github', repo, branch, rootDir, path,
    token, input.autoDeploy === false ? 0 : 1, secret, null, null, null, null, null, t, t,
  );
  bus.publish({ type: 'git', action: 'connect', resource: `${repo}@${branch}` });
  return fromRow(db.prepare('SELECT * FROM gitIntegrations WHERE id=?').get(id));
}

export function disconnect(functionId: string): boolean {
  const it = getIntegration(functionId);
  if (!it) return false;
  db.prepare('DELETE FROM gitIntegrations WHERE id=?').run(it.id);
  bus.publish({ type: 'git', action: 'disconnect', resource: `${it.repo}@${it.branch}` });
  return true;
}

export function listDeploys(functionId: string, limit = 20): Deploy[] {
  const rows = db.prepare('SELECT * FROM gitDeploys WHERE functionId=? AND projectId=? ORDER BY createdAt DESC LIMIT ?')
    .all(functionId, currentProjectId(), limit) as any[];
  return rows.map(deployFromRow);
}

export function listAllDeploys(limit = 20): Deploy[] {
  const rows = db.prepare('SELECT * FROM gitDeploys WHERE projectId=? ORDER BY createdAt DESC LIMIT ?')
    .all(currentProjectId(), limit) as any[];
  return rows.map(deployFromRow);
}

/* ------------------------------------------------------------ GitHub REST */

async function gh(path: string, token?: string | null, init?: RequestInit) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'studio-baas',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> || {}),
    },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body?.message || res.statusText;
    throw new Error(`GitHub ${res.status}: ${msg}`);
  }
  return body;
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(String(s || '').replace(/\n/g, ''), 'base64').toString('utf8');

function fakeSha(seed: string) {
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 7);
}

/** 模拟模式下的"远端文件"——一段真实可执行的函数代码，pull 之后能直接 Run */
function simulatedRemote(it: GitIntegration, sha: string, deployedAt = new Date()) {
  return [
    `// synced from ${it.repo}@${it.branch} · ${sha}`,
    `// ${it.path} — pulled by Studio BaaS at ${deployedAt.toISOString()}`,
    `export default async function (ctx) {`,
    `  ctx.log('running code deployed from github');`,
    `  ctx.log('repo', '${it.repo}', 'branch', '${it.branch}', 'sha', '${sha}');`,
    `  const collections = ctx.databases.listCollections();`,
    `  return ctx.res.json({`,
    `    source: 'github',`,
    `    repo: '${it.repo}',`,
    `    branch: '${it.branch}',`,
    `    commit: '${sha}',`,
    `    function: ctx.meta.functionName,`,
    `    collections: collections.length,`,
    `    seededAt: '${deployedAt.toISOString()}',`,
    `  });`,
    `}`,
  ].join('\n');
}

export async function commits(functionId: string, limit = 5) {
  const it = getIntegration(functionId);
  if (!it) throw new Error('仓库尚未连接');
  if (gitMode === 'live') {
    const list = await gh(`/repos/${it.repo}/commits?sha=${encodeURIComponent(it.branch)}&per_page=${limit}`, tokenOf(it));
    return (list as any[]).map((c) => ({
      sha: String(c.sha).slice(0, 7),
      message: String(c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || 'unknown',
      date: c.commit?.author?.date || null,
      url: c.html_url,
    }));
  }
  const base = Date.now();
  const seed = parseInt(fakeSha(it.repo), 16) % 997;
  const subjects = [
    'feat: return collection count in health payload',
    'chore: bump runtime to node-22',
    'fix: keep json content-type on errors',
    'refactor: read collections through ctx.databases',
    'ci: add smoke test for the function',
  ];
  return subjects.slice(0, limit).map((message, i) => ({
    sha: fakeSha(`${it.repo}${i}`),
    message,
    author: i % 2 ? 'Mia Fischer' : 'Alex Fisher',
    date: new Date(base - ((i + 1) * 26 + (seed % 7)) * 3600_000).toISOString(),
    url: null,
  }));
}

function tokenOf(it: GitIntegration): string | null {
  const r = db.prepare('SELECT token FROM gitIntegrations WHERE id=?').get(it.id) as any;
  return r?.token || null;
}

/** 读取远端文件（live: GitHub contents API；simulate: 生成确定性的源码） */
export async function fetchRemote(it: GitIntegration): Promise<{ sha: string; content: string; path: string; message: string; author: string }> {
  const token = tokenOf(it);
  if (gitMode === 'live') {
    let target = it.path;
    let file = await gh(`/repos/${it.repo}/contents/${encodeURI(target)}?ref=${encodeURIComponent(it.branch)}`, token);
    if (Array.isArray(file)) {
      const pick = (file as any[]).find((f) => /\.(m?js|ts)$/.test(f.name)) || file[0];
      target = pick.path;
      file = await gh(`/repos/${it.repo}/contents/${encodeURI(target)}?ref=${encodeURIComponent(it.branch)}`, token);
    }
    const commit = await gh(`/repos/${it.repo}/commits/${encodeURIComponent(it.branch)}`, token).catch(() => null);
    return {
      sha: String((commit as any)?.sha || file.sha || '').slice(0, 7),
      content: unb64(file.content),
      path: file.path,
      message: String((commit as any)?.commit?.message || 'sync from github').split('\n')[0],
      author: (commit as any)?.commit?.author?.name || 'github',
    };
  }
  const sha = fakeSha(`${it.repo}:${it.branch}:${Date.now()}`);
  return {
    sha,
    content: simulatedRemote(it, sha),
    path: it.path,
    message: 'feat: deploy from the connected repository',
    author: 'Alex Fisher',
  };
}

/**
 * 拉取远端代码并写回函数（= 部署）。
 * 调用方负责提供项目上下文（路由层已有，webhook 用 withProject）。
 */
export async function pull(functionId: string, source: 'manual' | 'webhook' | 'push' = 'manual') {
  const it = getIntegration(functionId);
  if (!it) throw new Error('仓库尚未连接');
  const started = Date.now();
  const remote = await fetchRemote(it);
  const fn = store.getFunction(functionId);
  if (!fn) throw new Error('Function not found');

  store.updateFunction(functionId, {
    code: remote.content,
    entrypoint: remote.path || fn.entrypoint,
  });

  db.prepare(`UPDATE gitIntegrations SET lastSyncAt=?,lastSha=?,lastMessage=?,lastAuthor=?,lastStatus=?,updatedAt=? WHERE id=?`).run(
    now(), remote.sha, remote.message, remote.author, 'deployed', now(), it.id,
  );

  const deployId = uid('dep_');
  db.prepare(`INSERT INTO gitDeploys (id,projectId,functionId,sha,message,author,source,status,files,duration,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    deployId, currentProjectId(), functionId, remote.sha, remote.message, remote.author,
    source, 'deployed', 1, Date.now() - started, now(),
  );
  bus.publish({ type: 'git', action: 'deploy', resource: `${it.repo}@${remote.sha}` });
  bus.publish({ type: 'function', action: 'update', resource: fn.name });

  return {
    id: deployId, sha: remote.sha, message: remote.message, author: remote.author,
    path: remote.path, source, mode: gitMode, duration: Date.now() - started,
    functionId, functionName: fn.name,
  };
}

/** 把当前函数代码提交回仓库 */
export async function push(functionId: string) {
  const it = getIntegration(functionId);
  if (!it) throw new Error('仓库尚未连接');
  const fn = store.getFunction(functionId);
  if (!fn) throw new Error('Function not found');
  const token = tokenOf(it);
  const started = Date.now();
  const message = `chore(${fn.name}): update from Studio BaaS console`;
  let sha: string;

  if (gitMode === 'live') {
    if (!token) throw new Error('推送需要 GitHub token（在连接设置里填写 repo 权限的 PAT）');
    let existingSha: string | undefined;
    try {
      const cur = await gh(`/repos/${it.repo}/contents/${encodeURI(it.path)}?ref=${encodeURIComponent(it.branch)}`, token);
      existingSha = (cur as any)?.sha;
    } catch { /* 新文件 */ }
    const out = await gh(`/repos/${it.repo}/contents/${encodeURI(it.path)}`, token, {
      method: 'PUT',
      body: JSON.stringify({
        message, content: b64(fn.code), branch: it.branch, ...(existingSha ? { sha: existingSha } : {}),
      }),
    });
    sha = String((out as any)?.commit?.sha || '').slice(0, 7);
  } else {
    sha = fakeSha(`${it.repo}:${fn.code}:${Date.now()}`);
  }

  const deployId = uid('dep_');
  db.prepare(`INSERT INTO gitDeploys (id,projectId,functionId,sha,message,author,source,status,files,duration,createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    deployId, currentProjectId(), functionId, sha, message, 'Alex Fisher', 'push', 'pushed', 1, Date.now() - started, now(),
  );
  db.prepare('UPDATE gitIntegrations SET lastSha=?,lastMessage=?,lastAuthor=?,lastStatus=?,updatedAt=? WHERE id=?').run(
    sha, message, 'Alex Fisher', 'pushed', now(), it.id,
  );
  bus.publish({ type: 'git', action: 'push', resource: `${it.repo}@${sha}` });

  return { id: deployId, sha, message, source: 'push', status: 'pushed', mode: gitMode, duration: Date.now() - started };
}

/* ------------------------------------------------------------ webhook */

export function verifySignature(raw: Buffer | string | undefined, secret: string, header?: string) {
  if (!header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw || '').digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 处理 GitHub push 事件：验签 → 分支过滤 → 拉取部署。
 * 返回 { ok, action, reason }，调用方直接回 200/401。
 */
export async function handleWebhook(integrationId: string, headers: Record<string, any>, rawBody: Buffer | undefined, body: any) {
  const it = getById(integrationId);
  if (!it) return { ok: false, status: 404, action: 'ignored', reason: 'integration not found' };

  const { withProject } = await import('./context.js');
  const sig = String(headers['x-hub-signature-256'] || '');
  if (!verifySignature(rawBody, it.webhookSecret, sig)) {
    return { ok: false, status: 401, action: 'rejected', reason: 'invalid signature' };
  }

  const event = String(headers['x-github-event'] || 'push');
  if (event === 'ping') return { ok: true, status: 200, action: 'pong', reason: 'webhook reachable' };
  if (event !== 'push') return { ok: true, status: 202, action: 'ignored', reason: `event ${event} ignored` };

  const ref = String(body?.ref || '');
  const branch = ref.replace('refs/heads/', '');
  if (ref && branch !== it.branch) {
    return { ok: true, status: 202, action: 'ignored', reason: `branch ${branch} is not ${it.branch}` };
  }
  if (!it.autoDeploy) {
    return { ok: true, status: 202, action: 'ignored', reason: 'auto deploy disabled' };
  }

  const result = await withProject(it.projectId, () => pull(it.functionId, 'webhook'));
  return { ok: true, status: 200, action: 'deployed', reason: `deployed ${result.sha}`, deploy: result };
}

/** 构造一次带正确签名的 push 事件，用于"发送测试投递" */
export async function testDelivery(functionId: string) {
  const it = getIntegration(functionId);
  if (!it) throw new Error('仓库尚未连接');
  const body = {
    ref: `refs/heads/${it.branch}`,
    repository: { full_name: it.repo, default_branch: it.branch },
    head_commit: { id: fakeSha(`${it.repo}:${Date.now()}`), message: 'test delivery from Studio BaaS', author: { name: 'Studio BaaS' } },
    sender: { login: 'studio-baas' },
  };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = 'sha256=' + crypto.createHmac('sha256', it.webhookSecret).update(raw).digest('hex');
  const result = await handleWebhook(it.id, {
    'x-github-event': 'push', 'x-github-delivery': uid('dlv_'), 'x-hub-signature-256': sig,
  }, raw, body);
  return { ...result, signature: sig.slice(0, 22) + '…' };
}
