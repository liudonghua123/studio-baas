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
export interface Execution {
  id: string; functionId: string; functionName: string; status: string; triggerType: string;
  duration: number; logs: string[]; response: any; errors: string[]; createdAt: string;
  statusCode?: number;
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
export interface Message {
  id: string; channel: string; recipient: string; subject: string; body: string;
  status: string; createdAt: string;
}
export interface ApiKey {
  id: string; name: string; scopes: string[]; secret: string;
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
  provider: string; model: string; configured: boolean; baseUrl: string;
  mode: 'deepseek' | 'demo';
  tools: { name: string; description: string; parameters: any }[];
}
export interface ChatReply {
  text: string; traces: ToolTrace[]; model: string;
  mode: 'deepseek' | 'demo';
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
