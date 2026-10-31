import vm from 'node:vm';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const ALLOWED_MODULES = new Set([
  'crypto', 'node:crypto', 'url', 'node:url', 'util', 'node:util',
  'querystring', 'node:querystring', 'buffer', 'node:buffer', 'uuid',
]);

export interface ExecContext {
  req: { method: string; path: string; headers: Record<string, string>; body: any; query: Record<string, string> };
  res: {
    status: number; headers: Record<string, string>; body: any;
    json(b: any): any; text(b: string): any; send(b: any): any; redirect(u: string): any;
  };
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
  env: Record<string, string>;
  databases: Record<string, (...args: any[]) => any>;
  storage: Record<string, (...args: any[]) => any>;
  users: Record<string, (...args: any[]) => any>;
  meta: Record<string, unknown>;
}

/** Transpile a small subset of ESM (default export + named imports) to CJS. */
export function transpile(code: string): string {
  let js = code;
  js = js.replace(/export\s+default\s+/g, 'module.exports.default = ');
  js = js.replace(/^\s*export\s+(const|let|var|async\s+function|function|class)\s+/gm, '$1 ');
  js = js.replace(
    /^\s*import\s+([\w*\s{},$]+?)\s+from\s+['"]([^'"]+)['"];?/gm,
    (_m, names: string, mod: string) => {
      const n = names.trim();
      if (n.startsWith('{')) return `const ${n} = require('${mod}');`;
      if (n.startsWith('*')) return `const ${n.replace(/\*\s*as\s*/, '')} = require('${mod}');`;
      return `const ${n} = require('${mod}');`;
    },
  );
  return js;
}

export async function executeFunctionCode(code: string, ctx: ExecContext, timeoutSec = 15): Promise<any> {
  const js = transpile(code);
  const sandboxConsole = {
    log: (...a: any[]) => ctx.log(...a),
    info: (...a: any[]) => ctx.log(...a),
    warn: (...a: any[]) => ctx.log('[warn]', ...a),
    error: (...a: any[]) => ctx.error(...a),
    debug: (...a: any[]) => ctx.log(...a),
  };
  const sandbox: Record<string, any> = {
    console: sandboxConsole,
    module: { exports: {} as any },
    exports: {},
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout: (fn: (...args: any[]) => void, ms?: number, ...args: any[]) => setTimeout(fn, Math.min(ms ?? 0, 5000), ...args),
    clearTimeout,
    Promise,
    fetch: async () => { throw new Error('Outbound network access is disabled in the sandbox'); },
    process: { env: { ...ctx.env }, platform: 'linux', version: 'v22' },
    require: (name: string) => {
      if (!ALLOWED_MODULES.has(name)) {
        throw new Error(`Module "${name}" is not available in the function runtime`);
      }
      if (name === 'uuid') return { v4: () => crypto.randomUUID() };
      return nodeRequire(name);
    },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });

  const wrapper = new vm.Script(
    `(function (exports, module, require, __ctx) {\n${js}\n})`,
    { filename: 'main.js' },
  ).runInContext(context, { timeout: Math.min(timeoutSec * 1000, 30000) });

  wrapper.call(sandbox.exports, sandbox.exports, sandbox.module, sandbox.require, ctx);

  const fn = sandbox.module.exports.default ?? sandbox.module.exports;
  if (typeof fn !== 'function') {
    throw new Error('Entrypoint must export a default function, e.g. `export default async ({ req, res }) => { ... }`');
  }

  let timer: NodeJS.Timeout;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Execution timed out after ${timeoutSec}s`)), timeoutSec * 1000);
  });
  try {
    // 关键：`while (true) {}` 这类同步死循环不会让出事件循环，Promise.race 根本
    // 没机会执行，整个 Node 进程（含所有 HTTP 请求）会被一起冻住。
    // 因此把「调用函数」这一步也放进 vm 并带上 timeout，由 V8 强制中断。
    sandbox.__call = () => fn(ctx);
    const invoke = new vm.Script('__result = __call()', { filename: 'invoke.js' });
    try {
      invoke.runInContext(context, { timeout: timeoutSec * 1000 });
    } catch (e: any) {
      if (e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new Error(`Execution timed out after ${timeoutSec}s (blocking loop terminated)`);
      }
      throw e;
    }
    return await Promise.race([sandbox.__result, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
