/**
 * 函数执行 worker —— 独立的 V8 isolate，死循环可以被主线程 terminate 掉。
 *
 * 为什么是纯 JS：开发态用 tsx 跑 TS，而 Node 的 worker 不会继承主线程的
 * ESM loader hooks（实测 `execArgv: ['--import','tsx']` 无效），所以这个文件
 * 必须是 Node 能直接加载的 .mjs。tsc 用 allowJs 原样复制到 dist/functions/engines/。
 *
 * 数据访问不在 worker 里做：better-sqlite3 连接留在主线程，worker 通过
 * SharedArrayBuffer + Atomics.wait 发起**同步** RPC。这样函数里 `databases.*`
 * 依旧能同步取到值，同时保证项目隔离、事件广播、单写连接都不受影响。
 *
 * 沙箱 API 与 engines/vm.ts 保持一致，改动需同步。
 */
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const { code, env, timeoutMs, req, meta, sab } = workerData;

const nodeRequire = createRequire(import.meta.url);
const ALLOWED_MODULES = new Set([
  'crypto', 'node:crypto', 'url', 'node:url', 'util', 'node:util',
  'querystring', 'node:querystring', 'buffer', 'node:buffer', 'uuid',
]);

/* ------------------------------------------------------------ sync bridge */
const flag = new Int32Array(sab, 0, 2);
const shared = new Uint8Array(sab, 8);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function rpc(ns, method, args) {
  Atomics.store(flag, 0, 0);
  Atomics.store(flag, 1, 0);
  parentPort.postMessage({ type: 'rpc', ns, method, args });
  // 主线程处理完会写回 payload 并 notify；等待上限略大于执行超时
  const waited = Atomics.wait(flag, 0, 0, timeoutMs + 5000);
  if (waited === 'timed-out') {
    throw new Error(`Backend call ${ns}.${method}() timed out`);
  }
  const len = Atomics.load(flag, 1);
  if (!len) return null;
  const text = decoder.decode(shared.subarray(0, len));
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Malformed response for ${ns}.${method}()`);
  }
  if (payload && payload.error) throw new Error(payload.error);
  return payload ? payload.value : null;
}

/* ---------------------------------------------------------------- sandbox */
function transpile(source) {
  let js = source;
  js = js.replace(/export\s+default\s+/g, 'module.exports.default = ');
  js = js.replace(/^\s*export\s+(const|let|var|async\s+function|function|class)\s+/gm, '$1 ');
  js = js.replace(
    /^\s*import\s+([\w*\s{},$]+?)\s+from\s+['"]([^'"]+)['"];?/gm,
    (_m, names, mod) => {
      const n = names.trim();
      if (n.startsWith('{')) return `const ${n} = require('${mod}');`;
      if (n.startsWith('*')) return `const ${n.replace(/\*\s*as\s*/, '')} = require('${mod}');`;
      return `const ${n} = require('${mod}');`;
    },
  );
  return js;
}

const logs = [];
const errors = [];
const stringify = (v) => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
};

const res = {
  status: 200,
  headers: {},
  body: null,
  json(body) { this.body = body; this.headers['content-type'] = 'application/json'; return this; },
  text(body) { this.body = body; this.headers['content-type'] = 'text/plain'; return this; },
  send(body) { this.body = body; return this; },
  redirect(url) { this.status = 302; this.headers.location = url; this.body = url; return this; },
};

const sandboxConsole = {
  log: (...a) => logs.push(a.map(stringify).join(' ')),
  info: (...a) => logs.push(a.map(stringify).join(' ')),
  warn: (...a) => logs.push('[warn] ' + a.map(stringify).join(' ')),
  error: (...a) => {
    const m = a.map(stringify).join(' ');
    logs.push('ERROR ' + m);
    errors.push(m);
  },
  debug: (...a) => logs.push(a.map(stringify).join(' ')),
};

const ctx = {
  req,
  res,
  log: (...a) => logs.push(a.map(stringify).join(' ')),
  error: (...a) => {
    const m = a.map(stringify).join(' ');
    logs.push('ERROR ' + m);
    errors.push(m);
  },
  env,
  databases: {
    listCollections: () => rpc('databases', 'listCollections', []),
    listDocuments: (cid, opts) => rpc('databases', 'listDocuments', [cid, opts]),
    getDocument: (cid, did) => rpc('databases', 'getDocument', [cid, did]),
    createDocument: (cid, data) => rpc('databases', 'createDocument', [cid, data]),
    updateDocument: (cid, did, data) => rpc('databases', 'updateDocument', [cid, did, data]),
    deleteDocument: (cid, did) => rpc('databases', 'deleteDocument', [cid, did]),
  },
  storage: {
    listFiles: (bid) => rpc('storage', 'listFiles', [bid]),
    listBuckets: () => rpc('storage', 'listBuckets', []),
  },
  users: {
    list: () => rpc('users', 'list', []),
  },
  meta,
};

function finish(failure) {
  let body = res.body;
  try { body = body === undefined ? null : JSON.parse(JSON.stringify(body)); } catch { body = String(body); }
  parentPort.postMessage({
    type: 'result', ok: !failure, failure: failure || null,
    status: res.status, headers: res.headers, body, logs, errors,
  });
}

async function main() {
  let wrapper;
  try {
    const js = transpile(code);
    const sandbox = {
      console: sandboxConsole,
      module: { exports: {} },
      exports: {},
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      setTimeout: (fn, ms, ...args) => setTimeout(fn, Math.min(ms ?? 0, 5000), ...args),
      clearTimeout,
      setInterval: undefined,
      clearInterval: undefined,
      Promise,
      fetch: async () => { throw new Error('Outbound network access is disabled in the sandbox'); },
      process: { env: { ...env }, platform: 'linux', version: 'v22' },
      require: (name) => {
        if (!ALLOWED_MODULES.has(name)) throw new Error(`Module "${name}" is not available in the function runtime`);
        if (name === 'uuid') return { v4: () => crypto.randomUUID() };
        return nodeRequire(name);
      },
    };
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });

    wrapper = new vm.Script(
      `(function (exports, module, require, __ctx) {\n${js}\n})`,
      { filename: 'main.js' },
    ).runInContext(context, { timeout: Math.min(timeoutMs, 30000) });
    wrapper.call(sandbox.exports, sandbox.exports, sandbox.module, sandbox.require, ctx);
    sandbox.__ctx = ctx;
    sandbox.__module = sandbox.module;

    const fn = sandbox.module.exports.default ?? sandbox.module.exports;
    if (typeof fn !== 'function') {
      return finish('Entrypoint must export a default function, e.g. `export default async ({ req, res }) => { ... }`');
    }

    sandbox.__call = () => fn(ctx);
    const invoke = new vm.Script('__result = __call()', { filename: 'invoke.js' });
    try {
      invoke.runInContext(context, { timeout: timeoutMs });
    } catch (e) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        return finish(`Execution timed out after ${timeoutMs / 1000}s (blocking loop terminated)`);
      }
      throw e;
    }
    const out = await Promise.race([
      sandbox.__result,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Execution timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
    if (out !== undefined && res.body === null) res.body = out;
    finish(null);
  } catch (e) {
    finish(e && e.message ? e.message : String(e));
  }
}

main();
