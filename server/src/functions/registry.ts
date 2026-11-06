import { spawnSync } from 'node:child_process';
import { executeJavaScript } from './engines/javascript.js';
import { executeViaBridge } from './engines/subprocess.js';
import { PYTHON_HARNESS } from './harnesses/python.js';
import { RuntimeError, type RuntimeDefinition, type RuntimeInfo } from './types.js';

/**
 * 运行时注册表。
 *
 * 内置两个「真正跑通过」的运行时：
 *   - node-22  ：worker 线程 + vm 降级，进程内执行
 *   - python-3 ：子进程 + studio-bridge/1 协议
 *
 * 新增语言只需要 `registerRuntime({...})`：提供 probe/execute 两个函数，
 * 协议层（databases/storage/users/env/log）由 subprocess.ts 统一提供。
 * 详见 docs/函数运行时架构.md。
 */

const NODE_VERSION = process.versions.node;

const NODE_TEMPLATES = [
  {
    id: 'hello',
    label: 'Hello world',
    description: '返回一个 JSON 响应，确认运行时可用',
    code: `export default async ({ req, res, log }) => {
  log('Hello from the edge');
  return res.json({ ok: true, runtime: 'node-22', method: req.method });
};`,
  },
  {
    id: 'rest',
    label: 'REST proxy',
    description: '读取集合文档并聚合成一个响应',
    code: `export default async ({ req, res, log, databases }) => {
  const products = databases.listDocuments('products', { limit: 5 });
  log('loaded', products.total, 'products');
  return res.json({ count: products.total, items: products.documents });
};`,
  },
  {
    id: 'cron',
    label: 'Scheduled job',
    description: '适合挂在 cron 上的汇总任务',
    code: `export default async ({ res, log, databases }) => {
  log('Running scheduled aggregation at', new Date().toISOString());
  const orders = databases.listDocuments('orders', { limit: 100 });
  const revenue = orders.documents.reduce((s, o) => s + Number(o.data.total || 0), 0);
  return res.json({ revenue, orders: orders.total });
};`,
  },
];

const PYTHON_TEMPLATES = [
  {
    id: 'hello',
    label: 'Hello world',
    description: '返回一个 JSON 响应，确认运行时可用',
    code: `def handler(ctx):
    ctx.log("Hello from Python")
    return ctx.res.json({"ok": True, "runtime": "python-3", "method": ctx.req["method"]})
`,
  },
  {
    id: 'rest',
    label: 'REST proxy',
    description: '读取集合文档并聚合成一个响应',
    code: `def handler(ctx):
    products = ctx.databases.list_documents("products", {"limit": 5})
    ctx.log("loaded", products["total"], "products")
    return ctx.res.json({"count": products["total"], "items": products["documents"]})
`,
  },
  {
    id: 'cron',
    label: 'Scheduled job',
    description: '适合挂在 cron 上的汇总任务',
    code: `def handler(ctx):
    orders = ctx.databases.list_documents("orders", {"limit": 100})
    revenue = sum(float(o["data"].get("total") or 0) for o in orders["documents"])
    ctx.log("aggregated", orders["total"], "orders")
    return ctx.res.json({"revenue": revenue, "orders": orders["total"]})
`,
  },
];

const pythonBin = process.env.STUDIO_PYTHON_BIN || 'python3';

function probeCommand(command: string, args: string[]) {
  const res = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  if (res.error) {
    return { available: false, reason: `${command} 不可用：${(res.error as any).code || res.error.message}` };
  }
  const out = `${res.stdout || ''}${res.stderr || ''}`.trim();
  const version = (out.match(/\d+\.\d+\.\d+/) || [])[0];
  return { available: res.status === 0, reason: res.status === 0 ? undefined : out.split('\n')[0], binary: command, version };
}

const pythonRuntime: RuntimeDefinition = {
  id: 'python-3',
  label: 'Python 3',
  language: 'python',
  version: '3.x',
  extension: 'py',
  entrypoint: 'main.py',
  protocol: 'studio-bridge/1',
  color: '#3b82f6',
  templates: PYTHON_TEMPLATES,
  probe: () => probeCommand(pythonBin, ['-V']),
  execute: async (input) => {
    const outcome = await executeViaBridge(
      {
        id: 'python-3',
        command: pythonBin,
        // -I 隔离模式（忽略 PYTHON* 环境与用户 site-packages），-B 不写 .pyc
        args: ['-I', '-B'],
        extension: 'py',
        harnessName: 'studio_harness.py',
        harnessSource: PYTHON_HARNESS,
        memoryMb: 256,
      },
      input,
    );
    return { ...outcome, runtime: 'python-3' };
  },
};

const nodeRuntime: RuntimeDefinition = {
  id: 'node-22',
  label: 'Node.js 22',
  language: 'javascript',
  version: NODE_VERSION,
  extension: 'js',
  entrypoint: 'src/main.js',
  protocol: 'studio-worker/1',
  color: '#f7df1e',
  templates: NODE_TEMPLATES,
  probe: () => ({
    available: true,
    binary: process.execPath,
    version: NODE_VERSION,
  }),
  execute: async (input) => ({ ...(await executeJavaScript(input)), runtime: 'node-22' }),
};

const definitions = new Map<string, RuntimeDefinition>([[nodeRuntime.id, nodeRuntime], [pythonRuntime.id, pythonRuntime]]);

/** 历史值 / 简写 → 规范 id；迁移与控制台选择共用一张表 */
const ALIASES: Record<string, string> = {
  node: 'node-22', nodejs: 'node-22', js: 'node-22', javascript: 'node-22',
  'node-18': 'node-22', 'node-18.0': 'node-22', 'node-20': 'node-22', 'node-20.0': 'node-22',
  'node-22.0': 'node-22',
  python: 'python-3', python3: 'python-3', py: 'python-3',
  'python-3.10': 'python-3', 'python-3.11': 'python-3', 'python-3.12': 'python-3', 'python-3.13': 'python-3',
};

export const DEFAULT_RUNTIME_ID = nodeRuntime.id;

export function normalizeRuntimeId(id: string | undefined | null): string {
  const raw = String(id || '').trim();
  if (!raw) return DEFAULT_RUNTIME_ID;
  if (definitions.has(raw)) return raw;
  return ALIASES[raw.toLowerCase()] || raw;
}

/** 注册/覆盖运行时；插件式扩展只需在启动时调用一次 */
export function registerRuntime(def: RuntimeDefinition): void {
  definitions.set(def.id, def);
}

const probeCache = new Map<string, { at: number; value: ReturnType<RuntimeDefinition['probe']> }>();
const PROBE_TTL = 60_000;

function availabilityOf(def: RuntimeDefinition) {
  const hit = probeCache.get(def.id);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit.value;
  let value: ReturnType<RuntimeDefinition['probe']>;
  try {
    value = def.probe();
  } catch (e: any) {
    value = { available: false, reason: e?.message || String(e) };
  }
  probeCache.set(def.id, { at: Date.now(), value });
  return value;
}

function toInfo(def: RuntimeDefinition): RuntimeInfo {
  return {
    id: def.id, label: def.label, language: def.language, version: def.version,
    extension: def.extension, entrypoint: def.entrypoint, protocol: def.protocol,
    color: def.color, templates: def.templates, availability: availabilityOf(def),
  };
}

export function listRuntimes(): RuntimeInfo[] {
  return [...definitions.values()].map(toInfo);
}

export function getRuntimeInfo(id: string): RuntimeInfo | undefined {
  const def = definitions.get(normalizeRuntimeId(id));
  return def ? toInfo(def) : undefined;
}

/** 解析并校验运行时；未知 id 直接 400，不要等到执行时才炸 */
export function resolveRuntime(id: string | undefined | null): RuntimeDefinition {
  const canonical = normalizeRuntimeId(id);
  const def = definitions.get(canonical);
  if (!def) {
    const known = [...definitions.keys()].join(', ');
    throw new RuntimeError(`Unknown runtime "${id}". Available runtimes: ${known}`);
  }
  const availability = availabilityOf(def);
  if (!availability.available) {
    throw new RuntimeError(`Runtime ${def.id} is not available on this host${availability.reason ? `: ${availability.reason}` : ''}`);
  }
  return def;
}

export function defaultTemplateFor(id: string) {
  const def = definitions.get(normalizeRuntimeId(id));
  return def?.templates[0]?.code || '';
}
