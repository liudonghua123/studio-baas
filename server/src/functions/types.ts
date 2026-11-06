/**
 * 函数运行时的公共契约。
 *
 * 这里刻意不出现任何 Node / Python 的细节：上层（store、HTTP 路由、控制台）
 * 只认 `RuntimeDefinition`，新增一门语言 = 注册一个新的 definition + 一个执行器。
 */

export interface ExecRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  query: Record<string, string>;
}

export interface ExecResponse {
  status: number;
  headers: Record<string, string>;
  body: any;
  json(body: any): ExecResponse;
  text(body: string): ExecResponse;
  send(body: any): ExecResponse;
  redirect(url: string): ExecResponse;
}

export interface ExecContext {
  req: ExecRequest;
  res: ExecResponse;
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
  env: Record<string, string>;
  databases: Record<string, (...args: any[]) => any>;
  storage: Record<string, (...args: any[]) => any>;
  users: Record<string, (...args: any[]) => any>;
  meta: Record<string, unknown>;
}

/** 一次执行的产出：日志跨进程/线程带回来，错误单独标记，便于落库时区分 */
export interface ExecutionOutcome {
  value: any;
  logs: string[];
  errors: string[];
  failure?: string;
  /** 函数设置的响应状态/头；降级路径直接写在同一对象上，无需回传 */
  status?: number;
  headers?: Record<string, string>;
  /** 实际使用的运行时（含版本），用于执行记录 */
  runtime?: string;
}

export interface RuntimeTemplate {
  id: string;
  label: string;
  description: string;
  code: string;
}

/** 执行器收到的、与语言无关的输入 */
export interface RunInput {
  code: string;
  entrypoint: string;
  timeout: number;
  env: Record<string, string>;
  ctx: ExecContext;
}

export type RuntimeProtocol = 'studio-worker/1' | 'studio-bridge/1';

export interface RuntimeAvailability {
  available: boolean;
  /** 不可用时给用户看的原因，例如 `python3 不在 PATH 中` */
  reason?: string;
  /** 解释器绝对路径或版本号，仅用于展示 */
  binary?: string;
  version?: string;
}

export interface RuntimeInfo {
  id: string;
  label: string;
  language: string;
  version: string;
  extension: string;
  entrypoint: string;
  protocol: RuntimeProtocol;
  /** 控制台用的强调色（十六进制） */
  color: string;
  availability: RuntimeAvailability;
  templates: RuntimeTemplate[];
}

export interface RuntimeDefinition extends Omit<RuntimeInfo, 'availability'> {
  /** 运行时探测结果由 registry 缓存后注入 */
  probe: () => RuntimeAvailability;
  execute: (input: RunInput) => Promise<ExecutionOutcome>;
}

/** 带 HTTP 状态码的领域错误；路由层据此返回 400 而不是 500 */
export class RuntimeError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}
