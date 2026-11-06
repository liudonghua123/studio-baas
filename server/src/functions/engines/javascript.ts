import { Worker } from 'node:worker_threads';
import { runInSandbox } from './vm.js';
import { currentPrincipal, currentProjectId, runWithContext, type Principal } from '../../context.js';
import type { ExecContext, ExecutionOutcome, RunInput } from '../types.js';

const PAYLOAD_BYTES = 2 * 1024 * 1024;
const WORKER_URL = new URL('./javascript-worker.mjs', import.meta.url);

/**
 * 执行 JavaScript / Node 函数。
 *
 * 默认走 worker 线程：`await null; while(true){}` 这类「异步后的死循环」在主线程里
 * 无法中断（vm 的 timeout 只覆盖同步段，Promise.race 又依赖事件循环），会让整个
 * 后端失去响应。放进独立线程后，主线程只要 timer 到点就 `terminate()`，服务照常。
 *
 * 降级顺序：worker → 同进程 vm（`FUNCTION_ISOLATION=vm` 可强制），
 * 保证在受限环境（无 SharedArrayBuffer / worker 启动失败）里功能不中断。
 */
export async function executeJavaScript(input: RunInput): Promise<ExecutionOutcome> {
  const { code, ctx, timeout } = input;
  if (process.env.FUNCTION_ISOLATION === 'vm') {
    return { value: await runInSandbox(code, ctx, timeout), logs: [], errors: [] };
  }
  try {
    return await runIsolated(code, ctx, timeout);
  } catch (e: any) {
    if (e?.code !== 'WORKER_UNAVAILABLE') throw e;
    console.warn('[runtime] worker unavailable, falling back to in-process vm:', e.message);
    return { value: await runInSandbox(code, ctx, timeout), logs: [], errors: [] };
  }
}

function runIsolated(code: string, ctx: ExecContext, timeoutSec: number): Promise<ExecutionOutcome> {
  const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000));
  // 触发器 / 定时任务里没有 HTTP 上下文，但项目与身份必须跟着线程走
  const scope: { projectId: string; principal: Principal | null } = {
    projectId: currentProjectId(),
    principal: currentPrincipal(),
  };

  let sab: SharedArrayBuffer;
  try {
    sab = new SharedArrayBuffer(8 + PAYLOAD_BYTES);
  } catch {
    const e: any = new Error('SharedArrayBuffer is unavailable in this environment');
    e.code = 'WORKER_UNAVAILABLE';
    return Promise.reject(e);
  }

  return new Promise<ExecutionOutcome>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_URL, {
        workerData: {
          code, env: ctx.env, timeoutMs, sab,
          req: ctx.req, meta: ctx.meta,
        },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
        stdout: false,
        stderr: false,
      });
    } catch (e: any) {
      e.code = 'WORKER_UNAVAILABLE';
      return reject(e);
    }

    let settled = false;
    const flag = new Int32Array(sab, 0, 2);
    const shared = new Uint8Array(sab, 8);
    const enc = new TextEncoder();

    const finish = (err: Error | null, out?: ExecutionOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 结果已经拿到，直接终止线程，避免用户留下的 interval/长任务继续占资源
      worker.terminate().catch(() => {});
      err ? reject(err) : resolve(out!);
    };

    // 比 worker 内部超时多给 750ms：优先让 worker 自己给出可读的错误信息
    const timer = setTimeout(() => {
      finish(new Error(`Execution timed out after ${timeoutSec}s (worker terminated)`));
    }, timeoutMs + 750);

    worker.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'rpc') {
        // 注意：这里必须同步执行——worker 正阻塞在 Atomics.wait 上等结果
        let payload: string;
        try {
          const ns = ctx[msg.ns as keyof ExecContext] as any;
          const fn = ns?.[msg.method];
          if (typeof fn !== 'function') throw new Error(`Unknown runtime API ${msg.ns}.${msg.method}`);
          const value = runWithContext(scope, () => fn(...(Array.isArray(msg.args) ? msg.args : [])));
          if (value && typeof value.then === 'function') {
            throw new Error(`${msg.ns}.${msg.method}() returned a Promise; the isolated runtime only supports synchronous calls`);
          }
          payload = JSON.stringify({ value: value === undefined ? null : value });
        } catch (e: any) {
          payload = JSON.stringify({ error: e?.message || String(e) });
        }
        const bytes = enc.encode(payload);
        if (bytes.length > PAYLOAD_BYTES) {
          const errBytes = enc.encode(JSON.stringify({ error: `Response too large (>${PAYLOAD_BYTES} bytes)` }));
          shared.set(errBytes, 0);
          Atomics.store(flag, 1, errBytes.length);
        } else {
          shared.set(bytes, 0);
          Atomics.store(flag, 1, bytes.length);
        }
        Atomics.store(flag, 0, 1);
        Atomics.notify(flag, 0);
        return;
      }
      if (msg.type === 'result') {
        finish(null, {
          value: msg.body,
          logs: Array.isArray(msg.logs) ? msg.logs : [],
          errors: Array.isArray(msg.errors) ? msg.errors : [],
          failure: msg.failure || undefined,
          status: typeof msg.status === 'number' ? msg.status : undefined,
          headers: msg.headers && typeof msg.headers === 'object' ? msg.headers : undefined,
        });
      }
    });

    worker.on('error', (err: any) => {
      if (settled) return;
      if (err?.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        return finish(new Error('Function exceeded the memory limit (256MB)'));
      }
      // 启动期错误（文件缺失、加载器未注册）视为环境问题，交由上层降级
      const code = String(err?.code || '');
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNKNOWN_FILE_EXTENSION') {
        const e: any = new Error(`Worker bootstrap failed: ${err.message}`);
        e.code = 'WORKER_UNAVAILABLE';
        return finish(e);
      }
      finish(new Error(err?.message || String(err)));
    });

    worker.on('exit', () => {
      if (!settled) finish(new Error('Function worker exited before returning a result'));
    });
  });
}
