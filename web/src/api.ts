import type {
  AiStatus, ApiKey, Attribute, Bucket, ChatReply, Collection, Doc, Execution,
  FileItem, FunctionDef, FunctionDomain, LogEntry, Me, Member, Message, Metrics, Project, Site, User,
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
  deleteCollection: (id: string) => del(`/v1/databases/collections/${id}`),
  addAttribute: (id: string, body: any) => post<Attribute>(`/v1/databases/collections/${id}/attributes`, body),
  deleteAttribute: (id: string, attrId: string) => del(`/v1/databases/collections/${id}/attributes/${attrId}`),
  documents: (id: string, params: Record<string, any> = {}) => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '' && v !== null) qs.set(k, String(v)); });
    return get<{ total: number; documents: Doc[]; limit: number; offset: number }>(`/v1/databases/collections/${id}/documents?${qs}`);
  },
  createDocument: (id: string, data: Record<string, any>) => post<Doc>(`/v1/databases/collections/${id}/documents`, { data }),
  updateDocument: (id: string, docId: string, data: Record<string, any>) => patch<Doc>(`/v1/databases/collections/${id}/documents/${docId}`, { data }),
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
  allExecutions: () => get<{ executions: Execution[] }>('/v1/executions'),
  domains: (id: string) => get<{ domains: FunctionDomain[] }>(`/v1/functions/${id}/domains`),
  addDomain: (id: string, hostname: string) => post<FunctionDomain>(`/v1/functions/${id}/domains`, { hostname }),
  verifyDomain: (id: string, domainId: string) => post<FunctionDomain>(`/v1/functions/${id}/domains/${domainId}/verify`),
  deleteDomain: (id: string, domainId: string) => del(`/v1/functions/${id}/domains/${domainId}`),

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
  aiSettings: () => get<{ configured: boolean; model: string; source: string; keyPreview: string }>('/v1/settings/ai'),
  saveAiSettings: (body: { apiKey?: string; model?: string }) => post<any>('/v1/settings/ai', body),

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
