import type { ExecContext, ExecutionOutcome } from './types.js';
import { resolveRuntime } from './registry.js';

export * from './types.js';
export {
  DEFAULT_RUNTIME_ID, defaultTemplateFor, getRuntimeInfo, listRuntimes,
  normalizeRuntimeId, registerRuntime, resolveRuntime,
} from './registry.js';

export interface RunFunctionInput {
  runtime: string;
  code: string;
  entrypoint: string;
  timeout: number;
  env: Record<string, string>;
  ctx: ExecContext;
}

/**
 * 函数执行的唯一入口。上层只提供「哪个运行时 + 代码 + 上下文」，
 * 具体是线程、子进程还是将来的容器，由运行时自己决定。
 */
export async function runFunction(input: RunFunctionInput): Promise<ExecutionOutcome> {
  const def = resolveRuntime(input.runtime);
  const outcome = await def.execute({
    code: input.code,
    entrypoint: input.entrypoint || def.entrypoint,
    timeout: input.timeout,
    env: input.env,
    ctx: input.ctx,
  });
  return { ...outcome, runtime: outcome.runtime || def.id };
}
