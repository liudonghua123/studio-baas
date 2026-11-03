import type {
  AiStatus, ApiKey, Attribute, Bucket, ChatReply, Collection, Doc, Execution,
  FileItem, FunctionDef, FunctionDomain, FunctionVersion, CollectionIndex, QueryPlan, GitCommit, GitDeploy, GitIntegration,
  LogEntry, Me, Member, Message, Metrics, Project, Schedule, Site, User,
  AiSession, AiMessage, AgentEvent, Webhook, WebhookDelivery,
  PublicProvider, IdentityProvider, MfaStatus, MfaMethod, MfaPolicy, MfaGap, MfaAvailable, LoginResult,
} from './types';

export const PROJECT_KEY = 'studio.project';
export const currentProjectId = () => localStorage.getItem(PROJECT_KEY) || '';

/** 每个请求都带上项目与身份，服务端据此做隔离与 RBAC 判定 */
function baseHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const pid = currentProjectId();
  if (pid) h['x-project-id'] = pid;
  const token = localStorage.getItem('studio.session') || '';
  if (token) h['x-studio-session'] = token;
  const role = localStorage.getItem('studio.actAs') || '';
  if (role) h['x-studio-act-as'] = role;
  return h;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      ...baseHeaders(),
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(data?.error || data?.message || `Request failed (${res.status})`);
  return data as T;
}

const get = <T>(p: string) => request<T>(p);
const post = <T>(p: string, body?: any) => request<T>(p, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
const patch = <T>(p: string, body?: any) => request<T>(p, { method: 'PATCH', body: JSON.stringify(body || {}) });
const del = <T>(p: string) => request<T>(p, { method: 'DELETE' });
const put = <T>(p: string, body?: any) => request<T>(p, { method: 'PUT', body: JSON.stringify(body || {}) });

/**
 * Consume an SSE endpoint (`/v1/ai/chat/stream`, `/v1/ai/resume`).
 *
 * `EventSource` cannot POST, so the stream is read by hand. Frames are separated
 * by a blank line; anything that is not a `data:` line is a comment/heartbeat.
 */
export async function streamAgent(
  path: string,
  body: unknown,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...baseHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let message = `Request failed (${res.status})`;
    try { message = JSON.parse(text)?.error || message; } catch { /* keep default */ }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try { onEvent(JSON.parse(line.slice(5).trim()) as AgentEvent); } catch { /* skip malformed frame */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export const api = {
  metrics: () => get<Metrics>('/v1/metrics'),
  projects: () => get<{ projects: Project[]; currentProjectId: string }>('/v1/projects'),
  me: () => get<Me>('/v1/auth/me'),
  permissions: () => get<{ roles: any[]; permissions: any[]; matrix: Record<string, string[]> }>('/v1/permissions'),
  members: () => get<{ members: Member[]; me: Me }>('/v1/members'),
  addMember: (body: any) => post<Member>('/v1/members', body),
  updateMember: (id: string, role: string) => patch<Member>(`/v1/members/${id}`, { role }),
  removeMember: (id: string) => del(`/v1/members/${id}`),
  createProject: (body: any) => post<Project>('/v1/projects', body),
  updateProject: (id: string, body: any) => patch<Project>(`/v1/projects/${id}`, body),
  deleteProject: (id: string) => del(`/v1/projects/${id}`),
  project: () => get<{ id: string; name: string; region: string; plan: string }>('/v1/project'),

  collections: () => get<{ collections: Collection[] }>('/v1/databases/collections'),
  collection: (id: string) => get<Collection>(`/v1/databases/collections/${id}`),
  createCollection: (body: any) => post<Collection>('/v1/databases/collections', body),
  updateCollection: (id: string, body: any) => patch<Collection>(`/v1/databases/collections/${id}`, body),
  deleteCollection: (id: string) => del(`/v1/databases/collections/${id}`),
  addAttribute: (id: string, body: any) => post<Attribute>(`/v1/databases/collections/${id}/attributes`, body),
  deleteAttribute: (id: string, attrId: string) => del(`/v1/databases/collections/${id}/attributes/${attrId}`),
  indexes: (id: string) => get<{ total: number; indexes: CollectionIndex[] }>(`/v1/databases/collections/${id}/indexes`),
  createIndex: (id: string, body: any) => post<CollectionIndex>(`/v1/databases/collections/${id}/indexes`, body),
  deleteIndex: (id: string, indexId: string) => del(`/v1/databases/collections/${id}/indexes/${indexId}`),
  queryPlan: (id: string, params: Record<string, any> = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else if (v !== undefined && v !== '' && v !== null) qs.set(k, String(v));
    });
    return get<QueryPlan>(`/v1/databases/collections/${id}/query-plan?${qs}`);
  },
  documents: (id: string, params: Record<string, any> = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '' && v !== null) qs.set(k, String(v)); });
    return get<{ total: number; documents: Doc[]; limit: number; offset: number }>(`/v1/databases/collections/${id}/documents?${qs}`);
  },
  createDocument: (id: string, data: Record<string, any>, permissions?: string[]) =>
    post<Doc>(`/v1/databases/collections/${id}/documents`, { data, ...(permissions ? { permissions } : {}) }),
  updateDocument: (id: string, docId: string, data: Record<string, any>, permissions?: string[]) =>
    patch<Doc>(`/v1/databases/collections/${id}/documents/${docId}`, { data, ...(permissions ? { permissions } : {}) }),
  deleteDocument: (id: string, docId: string) => del(`/v1/databases/collections/${id}/documents/${docId}`),

  buckets: () => get<{ buckets: Bucket[] }>('/v1/storage/buckets'),
  createBucket: (body: any) => post<Bucket>('/v1/storage/buckets', body),
  deleteBucket: (id: string) => del(`/v1/storage/buckets/${id}`),
  files: (bucketId: string) => get<{ files: FileItem[] }>(`/v1/storage/buckets/${bucketId}/files`),
  upload: (bucketId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<FileItem>(`/v1/storage/buckets/${bucketId}/files`, { method: 'POST', body: fd });
  },
  deleteFile: (id: string) => del(`/v1/storage/files/${id}`),

  functions: () => get<{ functions: FunctionDef[] }>('/v1/functions'),
  function: (id: string) => get<FunctionDef>(`/v1/functions/${id}`),
  createFunction: (body: any) => post<FunctionDef>('/v1/functions', body),
  updateFunction: (id: string, body: any) => patch<FunctionDef>(`/v1/functions/${id}`, body),
  deleteFunction: (id: string) => del(`/v1/functions/${id}`),
  execute: (id: string, payload: any) => post<Execution>(`/v1/functions/${id}/executions`, payload),
  executions: (id: string) => get<{ executions: Execution[] }>(`/v1/functions/${id}/executions`),
  versions: (id: string) => get<{ total: number; versions: FunctionVersion[] }>(`/v1/functions/${id}/versions`),
  restoreVersion: (id: string, vid: string) => post<FunctionDef>(`/v1/functions/${id}/versions/${vid}/restore`),
  allExecutions: () => get<{ executions: Execution[] }>('/v1/executions'),
  domains: (id: string) => get<{ domains: FunctionDomain[] }>(`/v1/functions/${id}/domains`),
  addDomain: (id: string, hostname: string) => post<FunctionDomain>(`/v1/functions/${id}/domains`, { hostname }),
  verifyDomain: (id: string, domainId: string) => post<FunctionDomain>(`/v1/functions/${id}/domains/${domainId}/verify`),
  deleteDomain: (id: string, domainId: string) => del(`/v1/functions/${id}/domains/${domainId}`),
  schedules: (id: string) => get<{ schedules: Schedule[] }>(`/v1/functions/${id}/schedules`),
  allSchedules: () => get<{ schedules: Schedule[] }>('/v1/schedules'),
  createSchedule: (id: string, body: any) => post<Schedule>(`/v1/functions/${id}/schedules`, body),
  updateSchedule: (sid: string, body: any) => patch<Schedule>(`/v1/schedules/${sid}`, body),
  deleteSchedule: (sid: string) => del(`/v1/schedules/${sid}`),
  runSchedule: (sid: string) => post<Execution>(`/v1/schedules/${sid}/run`),
  cronPreview: (expr: string, tz = 'UTC') =>
    get<{ next: string[]; description: string }>(`/v1/cron/preview?expr=${encodeURIComponent(expr)}&tz=${encodeURIComponent(tz)}`),

  git: (id: string) => get<{ integration: GitIntegration | null; mode: 'simulate' | 'live'; deploys: GitDeploy[] }>(`/v1/functions/${id}/git`),
  connectGit: (id: string, body: any) => post<GitIntegration>(`/v1/functions/${id}/git`, body),
  updateGit: (id: string, body: any) => patch<GitIntegration>(`/v1/functions/${id}/git`, body),
  disconnectGit: (id: string) => del(`/v1/functions/${id}/git`),
  gitCommits: (id: string) => get<{ commits: GitCommit[] }>(`/v1/functions/${id}/git/commits`),
  gitPull: (id: string) => post<{ sha: string; message: string; author: string; path: string; mode: string; duration: number }>(`/v1/functions/${id}/git/pull`),
  gitPush: (id: string) => post<{ sha: string; message: string; mode: string }>(`/v1/functions/${id}/git/push`),
  gitTestDelivery: (id: string) => post<{ ok: boolean; action: string; reason: string; deploy?: any }>(`/v1/functions/${id}/git/test-delivery`),

  sites: () => get<{ sites: Site[] }>('/v1/sites'),
  site: (id: string) => get<Site>(`/v1/sites/${id}`),
  createSite: (body: any) => post<Site>('/v1/sites', body),
  updateSite: (id: string, body: any) => patch<Site>(`/v1/sites/${id}`, body),
  deploySite: (id: string) => post<Site>(`/v1/sites/${id}/deployments`),
  deleteSite: (id: string) => del(`/v1/sites/${id}`),

  users: (search = '') => get<{ users: User[] }>(`/v1/users?search=${encodeURIComponent(search)}`),
  createUser: (body: any) => post<User>('/v1/users', body),
  updateUser: (id: string, body: any) => patch<User>(`/v1/users/${id}`, body),
  deleteUser: (id: string) => del(`/v1/users/${id}`),

  messages: () => get<{ messages: Message[] }>('/v1/messaging/messages'),
  sendMessage: (body: any) => post<Message>('/v1/messaging/messages', body),

  apiKeys: () => get<{ keys: ApiKey[] }>('/v1/api-keys'),
  createApiKey: (name: string, scopes: string[]) => post<ApiKey>('/v1/api-keys', { name, scopes }),
  deleteApiKey: (id: string) => del(`/v1/api-keys/${id}`),

  logs: (limit = 60) => get<{ logs: LogEntry[] }>(`/v1/logs?limit=${limit}`),

  aiStatus: () => get<AiStatus>('/v1/ai/status'),
  aiChat: (messages: { role: string; content: string }[]) => post<ChatReply>('/v1/ai/chat', { messages }),
  aiSettings: () => get<{
    configured: boolean; provider: string; providerLabel: string; model: string;
    baseUrl: string; keyless: boolean; source: string; keyPreview: string;
  }>('/v1/settings/ai'),
  saveAiSettings: (body: { apiKey?: string; model?: string; provider?: string; baseUrl?: string }) =>
    post<any>('/v1/settings/ai', body),

  aiSessions: () => get<{ total: number; sessions: AiSession[] }>('/v1/ai/sessions'),
  aiSession: (id: string) => get<{ session: AiSession; messages: AiMessage[] }>(`/v1/ai/sessions/${id}`),
  createAiSession: (body: { title?: string } = {}) => post<AiSession>('/v1/ai/sessions', body),
  renameAiSession: (id: string, title: string) => patch<AiSession>(`/v1/ai/sessions/${id}`, { title }),
  deleteAiSession: (id: string) => del<{ ok: boolean }>(`/v1/ai/sessions/${id}`),

  webhooks: () => get<{ total: number; webhooks: Webhook[] }>('/v1/webhooks'),
  createWebhook: (body: { url: string; events?: string[]; description?: string }) => post<Webhook>('/v1/webhooks', body),
  updateWebhook: (id: string, body: Partial<{ url: string; events: string[]; description: string; enabled: boolean }>) =>
    patch<Webhook>(`/v1/webhooks/${id}`, body),
  deleteWebhook: (id: string) => del<{ ok: boolean }>(`/v1/webhooks/${id}`),
  rotateWebhook: (id: string) => post<Webhook>(`/v1/webhooks/${id}/rotate`),
  testWebhook: (id: string) => post<{ ok: boolean; delivery: WebhookDelivery }>(`/v1/webhooks/${id}/test`),
  webhookDeliveries: (id?: string, limit = 50) =>
    get<{ deliveries: WebhookDelivery[] }>(`/v1/webhooks/deliveries?limit=${limit}${id ? `&webhookId=${id}` : ''}`),

  bulkCreateDocuments: (collectionId: string, documents: Record<string, unknown>[]) =>
    post<{ total: number; documents: Doc[] }>(`/v1/databases/collections/${collectionId}/documents/bulk`, { documents }),

  /* ------------------------------------------------------------ SSO */
  // 登录页用：只拿到「有哪些按钮」，没有任何配置细节
  ssoProviders: (projectId?: string) =>
    get<{ providers: PublicProvider[]; projectId: string }>(
      `/v1/auth/sso/providers${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  ssoConfig: () => get<{ providers: IdentityProvider[] }>('/v1/auth/sso/config'),
  createSsoProvider: (body: Record<string, unknown>) => post<IdentityProvider>('/v1/auth/sso/config', body),
  updateSsoProvider: (id: string, body: Record<string, unknown>) =>
    patch<IdentityProvider>(`/v1/auth/sso/config/${id}`, body),
  deleteSsoProvider: (id: string) => del<{ ok: boolean }>(`/v1/auth/sso/config/${id}`),
  testSsoProvider: (id: string) => post<Record<string, any>>(`/v1/auth/sso/config/${id}/test`),
  startSso: (id: string, returnTo: string) =>
    post<{ url: string; state: string }>(`/v1/auth/sso/${id}/start`, { returnTo }),
  ldapLogin: (id: string, username: string, password: string) =>
    post<LoginResult>(`/v1/auth/sso/${id}/login`, { username, password }),
  logout: () => del<{ ok: boolean }>('/v1/account/sessions'),
  passwordLogin: (email: string, password: string) =>
    post<LoginResult>('/v1/account/sessions', { email, password }),

  /* -------------------------------------------------------------- MFA */
  mfaStatus: () => get<MfaStatus>('/v1/auth/mfa'),
  // 登录第二步：挑战 id 换回可用方式（不含任何账号信息）
  mfaChallenge: (id: string) =>
    get<{ challenge: string; expiresAt: string; methods: MfaAvailable; reason: any; provider: string | null }>(
      `/v1/auth/mfa/challenge/${encodeURIComponent(id)}`),
  mfaTotpBegin: (name?: string) =>
    post<{ methodId: string; secret: string; uri: string }>('/v1/auth/mfa/totp/begin', { name }),
  mfaTotpConfirm: (methodId: string, code: string) =>
    post<{ ok: boolean; recoveryCodes: string[] }>('/v1/auth/mfa/totp/confirm', { methodId, code }),
  mfaPasskeyBegin: (name?: string) =>
    post<{ ticket: string; options: any }>('/v1/auth/mfa/webauthn/begin', { name }),
  mfaPasskeyFinish: (ticket: string, response: any) =>
    post<{ ok: boolean; method: MfaMethod; recoveryCodesLeft: number }>('/v1/auth/mfa/webauthn/finish', { ticket, response }),
  mfaRename: (id: string, name: string) => patch<MfaMethod>(`/v1/auth/mfa/methods/${id}`, { name }),
  mfaDelete: (id: string) =>
    del<{ ok: boolean; remaining: number; warning: string | null }>(`/v1/auth/mfa/methods/${id}`),
  mfaRegenerateRecovery: () =>
    post<{ codes: string[] }>('/v1/auth/mfa/recovery/regenerate'),
  mfaVerify: (challenge: string, code: string, method?: string) =>
    post<LoginResult & { factor: string }>('/v1/auth/mfa/verify', { challenge, code, method }),
  mfaAssertBegin: (challenge: string) =>
    post<{ ticket: string; options: any }>('/v1/auth/mfa/webauthn/assert/begin', { challenge }),
  mfaAssertFinish: (ticket: string, response: any) =>
    post<LoginResult & { factor: string }>('/v1/auth/mfa/webauthn/assert/finish', { ticket, response }),
  mfaPolicies: () => get<{ policies: MfaPolicy[]; gaps: MfaGap[]; roles: string[] }>('/v1/auth/mfa/policies'),
  mfaSavePolicies: (policies: { scope: string; target: string; mode: string }[]) =>
    put<{ policies: MfaPolicy[]; gaps: MfaGap[] }>('/v1/auth/mfa/policies', { policies }),

  docs: () => get<{ title: string; markdown: string }>('/v1/docs'),

  health: () => get<{ ok: boolean; version: string }>('/v1/health'),
};

export const fileUrl = (id: string) => `/v1/storage/files/${id}/view`;
export const previewUrl = (siteId: string) => `/v1/sites/${siteId}/preview/${'index.html'}?t=${Date.now()}`;

export function setProject(id: string) {
  if (id) localStorage.setItem(PROJECT_KEY, id);
  else localStorage.removeItem(PROJECT_KEY);
  window.dispatchEvent(new Event('studio:project-changed'));
}
