import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 每个请求一个上下文：当前项目 + 当前身份。
 * store 层所有查询都通过 currentProjectId() 做项目隔离，
 * 这样调用方（路由、AI 工具、定时任务、函数运行时）不必层层透传 projectId。
 */
export interface Principal {
  type: 'user' | 'key' | 'demo';
  id: string;              // userId / keyId / 'demo'
  name: string;
  role?: string;           // 用户在该项目中的角色
  scopes?: string[];       // API Key 的权限点
  /** 携带了凭据但无效（key 已删除、会话过期）时为 true，路由层据此返回 401 */
  invalid?: boolean;
  invalidReason?: string;
}

export interface RequestContext {
  projectId: string;
  principal: Principal | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const DEFAULT_PROJECT_ID = 'studio';

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentProjectId(): string {
  return storage.getStore()?.projectId || DEFAULT_PROJECT_ID;
}

export function currentPrincipal(): Principal | null {
  return storage.getStore()?.principal || null;
}

/** 在指定项目上下文中执行（用于定时任务、AI 工具等非 HTTP 场景） */
export function withProject<T>(projectId: string, fn: () => T): T {
  const cur = storage.getStore();
  return storage.run({ projectId, principal: cur?.principal || null }, fn);
}
