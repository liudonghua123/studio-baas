export interface Project {
  id: string; name: string; key: string; region: string; plan: string; status: string;
  color: string; description: string; createdAt: string; updatedAt: string;
  stats?: { collections: number; functions: number; sites: number; members: number };
}

export interface Collection {
  id: string; name: string; key: string; icon: string; color: string;
  documentSecurity: boolean; enabled: boolean; createdAt: string; updatedAt: string;
  attributes?: Attribute[]; documentCount?: number;
}
export interface CollectionIndex {
  id: string; collectionId: string; key: string; type: 'key' | 'unique';
  attributes: string[]; orders: ('ASC' | 'DESC')[];
  status: 'available' | 'failed'; error: string | null; createdAt: string;
}
export interface QueryPlan {
  plan: { id: number; parent: number; detail: string }[];
  index: string | null; terms: string[]; narrowed: boolean;
  fullScan: boolean; tempBTree: boolean; sql: string;
}
export interface Attribute {
  id: string; collectionId: string; key: string; type: string; required: boolean;
  array: boolean; size?: number; defaultVal?: string | null; elements?: string[]; createdAt: string;
}
export interface Doc {
  id: string; collectionId: string; data: Record<string, any>;
  permissions: string[]; createdAt: string; updatedAt: string;
}
export interface Bucket {
  id: string; name: string; maxFileSize: number; allowedExtensions: string[];
  compression: string; encryption: boolean; imageTransform: boolean;
  createdAt: string; fileCount: number; totalSize: number;
}
export interface FileItem {
  id: string; bucketId: string; name: string; mimeType: string; size: number;
  createdAt: string; url: string;
}
export interface FunctionDef {
  id: string; name: string; runtime: string; entrypoint: string; code: string;
  schedule: string; timeout: number; env: Record<string, string>; enabled: boolean;
  executeAccess: string; createdAt: string; updatedAt: string;
  executions?: number; lastExecution?: { createdAt: string; status: string } | null;
  description?: string;
}
export interface FunctionDomain {
  id: string; projectId: string; functionId: string; hostname: string;
  status: 'pending' | 'verifying' | 'active' | 'failed';
  verificationToken: string; dnsRecord: string;
  sslStatus: 'pending' | 'issued' | 'failed';
  createdAt: string; verifiedAt: string | null; lastCheckAt: string | null; note?: string;
}
export interface Schedule {
  id: string; projectId: string; functionId: string; functionName?: string;
  cron: string; timezone: string; enabled: boolean;
  nextRunAt: string | null; lastRunAt: string | null; lastStatus: string | null;
  description?: string; createdAt: string;
}
export interface GitIntegration {
  id: string; projectId: string; functionId: string; functionName?: string;
  provider: 'github'; repo: string; branch: string; rootDir: string; path: string;
  autoDeploy: boolean; hasToken: boolean; webhookSecret: string;
  lastSyncAt: string | null; lastSha: string | null; lastMessage: string | null;
  lastAuthor: string | null; lastStatus: string | null;
  createdAt: string; updatedAt: string;
}
export interface GitDeploy {
  id: string; functionId: string; sha: string; message: string; author: string;
  source: string; status: string; files: number; duration: number; createdAt: string;
}
export interface GitCommit {
  sha: string; message: string; author: string; date: string | null; url: string | null;
}
export interface Execution {
  id: string; functionId: string; functionName: string; status: string; triggerType: string;
  duration: number; logs: string[]; response: any; errors: string[]; createdAt: string;
  statusCode?: number;
}
export interface FunctionVersion {
  id: string; functionId: string; version: number; code: string;
  label: string | null; createdBy: string | null; createdAt: string;
}
export interface SiteFile { path: string; content: string }
export interface Site {
  id: string; name: string; framework: string; domain: string; entrypoint: string;
  buildCommand: string; files: SiteFile[]; status: string; buildLogs: string[];
  createdAt: string; updatedAt: string; fileCount?: number;
}
export interface User {
  id: string; name: string; email: string; status: string; emailVerified: boolean;
  labels: string[]; prefs: Record<string, any>; createdAt: string; lastLoginAt: string | null;
}
export interface Member {
  id: string; projectId: string; userId: string; name: string; email: string;
  avatarColor: string; role: string; status: string; addedAt: string;
}
export interface Me {
  principal: { type: string; id: string; name: string; role?: string; scopes?: string[] };
  projectId: string; role: string; permissions: string[];
}
export interface Message {
  id: string; channel: string; recipient: string; subject: string; body: string;
  status: string; createdAt: string;
}
export interface ApiKey {
  id: string; name: string; scopes: string[];
  /** 列表接口只返回预览（standard_ab12••••3f9c） */
  preview: string;
  /** 仅创建响应里出现一次，之后不可再取 */
  secret?: string;
  lastUsedAt: string | null; createdAt: string;
}
export interface LogEntry {
  id: string; method: string; path: string; status: number; duration: number;
  service: string; ip: string; createdAt: string;
}
export interface Metrics {
  documents: number; files: number; storageBytes: number; functions: number;
  executions24h: number; failedExecutions: number; users: number; sites: number;
  collections: number; messages: number; requests24h: number;
  trend: { date: string; requests: number; errors: number }[];
  topCollections: { name: string; key: string; color: string; documents: number }[];
  services: { name: string; status: string; latency: number; uptime: number }[];
  recentExecutions: Execution[];
  recentLogs: LogEntry[];
  project: { id: string; name: string; region: string; plan: string; createdAt: string };
}
export interface ToolTrace {
  id: string; name: string; args: Record<string, any>; result: any;
  ok: boolean; duration: number; summary: string;
}
export interface AiStatus {
  provider: string;
  providerId: 'deepseek' | 'openai' | 'ollama' | 'custom';
  model: string; configured: boolean; baseUrl: string; keyless?: boolean;
  mode: 'live' | 'demo';
  tools: { name: string; description: string; parameters: any; dangerous?: boolean }[];
}
export interface ChatReply {
  text: string; traces: ToolTrace[]; model: string;
  mode: 'deepseek' | 'demo';
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
export interface AiSession {
  id: string; title: string; model: string | null; provider: string | null;
  messages: number; createdAt: string; updatedAt: string;
}
export interface AiMessage {
  id: string; sessionId: string; role: 'user' | 'assistant'; content: string;
  traces: ToolTrace[]; createdAt: string;
}
export interface PendingCall {
  id: string; name: string; args: Record<string, any>; summary: string; description: string;
}
export type AgentEvent =
  | { type: 'meta'; mode: 'model' | 'demo'; provider: string; model: string; sessionId?: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; phase: 'start' | 'end'; trace: ToolTrace }
  | { type: 'approval'; token: string; calls: PendingCall[] }
  | { type: 'done'; text: string; traces: ToolTrace[]; usage?: Record<string, number>; sessionId?: string; steps: number }
  | { type: 'error'; message: string };

export interface Webhook {
  id: string; url: string; events: string[]; description: string | null;
  enabled: boolean; deliveries: number; failures: number;
  lastStatus: number | null; lastError: string | null; lastDeliveryAt: string | null;
  createdAt: string; updatedAt: string;
  /** only present on the create / rotate response */
  secret?: string;
}
export interface WebhookDelivery {
  id: string; webhookId: string; event: string; status: number | null;
  duration: number; error: string | null; attempts: number; createdAt: string;
}
