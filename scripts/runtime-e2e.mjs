#!/usr/bin/env node
/**
 * 多语言函数运行时端到端测试。
 *
 * 对着真实 API 跑，不做 mock：Node 走 worker 线程，Python 走子进程 +
 * studio-bridge/1 协议。断言覆盖「能跑通」之外的东西——超时能不能收掉进程、
 * 报错有没有 traceback、日志是不是实时回来、切语言会不会换模板、旧值能不能迁移。
 *
 * 脚本自己创建函数、自己删除，失败也会清理。
 */

const API = process.env.API_BASE || 'http://127.0.0.1:5174';
const PROJECT = process.env.PROJECT_ID || 'studio';

let pass = 0;
const failures = [];
let group = '';

function section(name) { group = name; console.log(`\n── ${name}`); }

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${group} / ${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-project-id': PROJECT },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

const created = [];

async function createFn(body) {
  const r = await api('POST', '/v1/functions', body);
  if (r.status === 201) created.push(r.json.id);
  return r;
}

const run = (id, payload = {}) => api('POST', `/v1/functions/${id}/executions`, payload);

async function cleanup() {
  for (const id of created.splice(0)) {
    try { await api('DELETE', `/v1/functions/${id}`); } catch { /* best effort */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  /* ------------------------------------------------------------ 运行时清单 */
  section('Runtime registry');
  const list = await api('GET', '/v1/runtimes');
  const runtimes = list.json?.runtimes || [];
  const node = runtimes.find((r) => r.id === 'node-22');
  const py = runtimes.find((r) => r.id === 'python-3');

  check('GET /v1/runtimes returns a list', list.status === 200 && Array.isArray(runtimes), `${list.status}`);
  check('Node.js runtime is registered and available', !!node && node.availability?.available === true, JSON.stringify(node?.availability));
  check('Python runtime is registered and available', !!py && py.availability?.available === true, JSON.stringify(py?.availability));
  check('each runtime declares language, entrypoint and protocol',
    runtimes.every((r) => r.language && r.entrypoint && r.protocol), `${runtimes.length}`);
  check('both runtimes ship starter templates',
    runtimes.every((r) => Array.isArray(r.templates) && r.templates.length >= 3), `${runtimes.map((r) => r.templates?.length)}`);
  check('Python is a subprocess bridge, Node is a worker isolate',
    py?.protocol === 'studio-bridge/1' && node?.protocol === 'studio-worker/1',
    `${py?.protocol} / ${node?.protocol}`);
  check('Python template is actually Python', /def handler\(ctx\)/.test(py?.templates?.[0]?.code || ''));

  /* --------------------------------------------------------------- Node */
  section('Node.js runtime');
  const nodeFn = await createFn({ name: 'e2e node hello' });
  check('creating without a runtime defaults to node-22',
    nodeFn.status === 201 && nodeFn.json.runtime === 'node-22', `${nodeFn.status} ${nodeFn.json?.runtime}`);
  check('Node entrypoint defaults to src/main.js', nodeFn.json?.entrypoint === 'src/main.js', nodeFn.json?.entrypoint);

  const nodeRun = await run(nodeFn.json.id, { ping: 'pong' });
  check('Node function completes', nodeRun.json.status === 'completed', JSON.stringify(nodeRun.json.errors || []).slice(0, 120));
  check('Node response carries the runtime', nodeRun.json.runtime === 'node-22', `${nodeRun.json.runtime}`);
  check('Node logs are captured', nodeRun.json.logs.includes('Hello from the edge'), JSON.stringify(nodeRun.json.logs));

  const badNode = await createFn({
    name: 'e2e node syntax',
    runtime: 'node-22',
    code: 'export default async ({ res }) => { return res.json({ ok: true } ',
  });
  const badNodeRun = await run(badNode.json.id);
  check('a Node syntax error fails the execution, not the server',
    badNodeRun.json.status === 'failed' && badNodeRun.json.errors.length > 0);

  /* ------------------------------------------------------------- Python */
  section('Python runtime');
  const pyCode = `def handler(ctx):
    ctx.log("python start", ctx.req.method)
    products = ctx.databases.list_documents("products", {"limit": 3})
    return ctx.res.json({
        "total": products["total"],
        "count": len(products["documents"]),
        "env": ctx.env.get("GREETING"),
        "name": ctx.meta.function_name if hasattr(ctx.meta, "function_name") else ctx.meta["functionName"],
    })
`;
  const pyFn = await createFn({
    name: 'e2e python hello', runtime: 'python-3', code: pyCode,
    env: { GREETING: 'hola' }, entrypoint: 'main.py',
  });
  check('creating a Python function keeps runtime and entrypoint',
    pyFn.status === 201 && pyFn.json.runtime === 'python-3' && pyFn.json.entrypoint === 'main.py',
    `${pyFn.status} ${pyFn.json?.runtime} ${pyFn.json?.entrypoint}`);

  const pyRun = await run(pyFn.json.id);
  const pr = pyRun.json.response || {};
  check('Python function completes', pyRun.json.status === 'completed', JSON.stringify(pyRun.json.errors || []).slice(0, 160));
  check('Python reads collections through the bridge', pr.total >= 3 && pr.count === 3, JSON.stringify(pr));
  check('Python sees function env vars', pr.env === 'hola', String(pr.env));
  check('Python gets req/meta as attribute-access objects', pr.name === 'e2e python hello', String(pr.name));
  check('Python print/log output is streamed back', (pyRun.json.logs || []).some((l) => l.startsWith('python start POST')), JSON.stringify(pyRun.json.logs));
  check('execution record stores the runtime', pyRun.json.runtime === 'python-3', `${pyRun.json.runtime}`);

  const asyncFn = await createFn({
    name: 'e2e python async',
    runtime: 'python-3',
    code: `import asyncio

async def handler(ctx):
    print("before await")
    await asyncio.sleep(0.05)
    print("after await")
    return {"async": True, "sum": 2 + 3}
`,
  });
  const asyncRun = await run(asyncFn.json.id);
  check('async def handlers are awaited', asyncRun.json.status === 'completed' && asyncRun.json.response?.async === true && asyncRun.json.response?.sum === 5,
    JSON.stringify(asyncRun.json.response));
  check('print() lands in logs in order',
    JSON.stringify(asyncRun.json.logs.slice(0, 2)) === JSON.stringify(['before await', 'after await']), JSON.stringify(asyncRun.json.logs));

  const errFn = await createFn({
    name: 'e2e python error',
    runtime: 'python-3',
    code: 'def handler(ctx):\n    raise ValueError("boom")\n',
  });
  const errRun = await run(errFn.json.id);
  check('exceptions fail the execution with a clean message',
    errRun.json.status === 'failed' && errRun.json.errors[0] === 'ValueError: boom', JSON.stringify(errRun.json.errors));
  const tb = (errRun.json.logs || []).join('\n');
  check('traceback points at the user file, not the temp dir', tb.includes('main.py') && !tb.includes('/tmp/studio-fn-'), tb.split('\n')[0] || '');

  const syntaxFn = await createFn({
    name: 'e2e python syntax', runtime: 'python-3',
    code: 'def handler(ctx)\n    return 1\n',
  });
  const syntaxRun = await run(syntaxFn.json.id);
  check('a Python syntax error is reported as failed',
    syntaxRun.json.status === 'failed' && /SyntaxError/.test(syntaxRun.json.errors.join(' ')), JSON.stringify(syntaxRun.json.errors).slice(0, 160));

  /* ------------------------------------------------------------ 超时与隔离 */
  section('Timeout and isolation');
  const slowFn = await createFn({
    name: 'e2e timeout', runtime: 'python-3', timeout: 1,
    code: 'def handler(ctx):\n    ctx.log("before loop")\n    while True:\n        pass\n',
  });
  const started = Date.now();
  const slowRun = await run(slowFn.json.id);
  const elapsed = Date.now() - started;
  check('an infinite loop is killed near the timeout', slowRun.json.status === 'failed' && elapsed < 4000, `${elapsed}ms`);
  check('timeout message is explicit', /timed out/i.test(slowRun.json.errors.join(' ')), JSON.stringify(slowRun.json.errors));
  check('logs written before the timeout survive', slowRun.json.logs.includes('before loop'), JSON.stringify(slowRun.json.logs));

  const netFn = await createFn({
    name: 'e2e network guard', runtime: 'python-3',
    code: `import urllib.request
def handler(ctx):
    try:
        urllib.request.urlopen("http://example.com", timeout=2)
        return {"net": "open"}
    except Exception as e:
        return {"net": "blocked", "kind": type(e).__name__, "message": str(e)}
`,
  });
  const netRun = await run(netFn.json.id);
  check('outbound network is blocked in Python', netRun.json.response?.net === 'blocked', JSON.stringify(netRun.json.response));
  check('the guard is explainable to the user', /network access is disabled/i.test(netRun.json.response?.message || ''), String(netRun.json.response?.message));

  // 三个 Python 函数并发：每个都是独立进程，RPC 不能串线
  const stamp = Date.now();
  const [c1, c2, c3] = await Promise.all([1, 2, 3].map((n) => createFn({
    name: `e2e concurrent ${n}`, runtime: 'python-3',
    code: `import time\ndef handler(ctx):\n    time.sleep(0.2)\n    return {"me": ${n}, "pid": __import__("os").getpid()}\n`,
  })));
  const results = await Promise.all([run(c1.json.id), run(c2.json.id), run(c3.json.id)]);
  const bodies = results.map((r) => r.json.response || {});
  const pids = bodies.map((b) => b.pid);
  check('concurrent Python executions all complete', results.every((r) => r.json.status === 'completed'), JSON.stringify(results.map((r) => r.json.status)));
  check('each execution answers with its own payload', bodies.map((b) => b.me).sort().join(',') === '1,2,3', JSON.stringify(bodies));
  check('each execution runs in its own process', new Set(pids).size === 3, JSON.stringify(pids));

  /* ------------------------------------------------------------ 切换与兼容 */
  section('Runtime switching and compatibility');
  const switchFn = await createFn({ name: 'e2e switch', runtime: 'node-22' });
  const switched = await api('PATCH', `/v1/functions/${switchFn.json.id}`, { runtime: 'python-3' });
  check('switching runtime rewrites the entrypoint', switched.json.runtime === 'python-3' && switched.json.entrypoint === 'main.py',
    `${switched.json?.runtime} ${switched.json?.entrypoint}`);
  check('a starter template is translated to the new language',
    /def handler\(ctx\)/.test(switched.json.code || ''), (switched.json.code || '').slice(0, 40));
  const switchedRun = await run(switched.json.id);
  check('the translated starter still runs', switchedRun.json.status === 'completed', JSON.stringify(switchedRun.json.errors).slice(0, 120));

  const customFn = await createFn({
    name: 'e2e switch custom', runtime: 'node-22',
    code: 'export default async ({ res }) => res.json({ custom: true });',
  });
  const kept = await api('PATCH', `/v1/functions/${customFn.json.id}`, { runtime: 'python-3' });
  check('hand-written code is never rewritten on switch', /export default/.test(kept.json.code || ''), (kept.json.code || '').slice(0, 40));

  const legacy = await createFn({ name: 'e2e legacy alias', runtime: 'node-18' });
  check('legacy runtime aliases are normalised on write', legacy.json.runtime === 'node-22', `${legacy.json?.runtime}`);

  const unknown = await api('POST', '/v1/functions', { name: 'e2e cobol', runtime: 'cobol-85' });
  check('unknown runtimes are rejected with 400', unknown.status === 400 && /Unknown runtime/.test(unknown.json.error || ''), `${unknown.status} ${unknown.json?.error}`);

  const detail = await api('GET', `/v1/functions/${pyFn.json.id}`);
  check('function detail exposes runtime metadata', detail.json.runtimeInfo?.id === 'python-3' && detail.json.runtimeInfo?.availability?.available === true);

  // 版本快照要记住运行时不只代码，否则 Node→Python 后回滚会得到「Python 跑 JS」
  const verFn = await createFn({ name: 'e2e versions', runtime: 'python-3', code: 'def handler(ctx):\n    return {"v": 1}\n' });
  await api('PATCH', `/v1/functions/${verFn.json.id}`, { code: 'def handler(ctx):\n    return {"v": 2}\n' });
  const vs = await api('GET', `/v1/functions/${verFn.json.id}/versions`);
  check('version snapshots carry the runtime and entrypoint',
    vs.json.versions.length >= 2 && vs.json.versions.every((v) => v.runtime === 'python-3' && v.entrypoint === 'main.py'),
    JSON.stringify(vs.json.versions.map((v) => `${v.runtime}/${v.entrypoint}`)));
  await api('PATCH', `/v1/functions/${verFn.json.id}`, { runtime: 'node-22' });
  const oldV = vs.json.versions[vs.json.versions.length - 1];
  const restored = await api('POST', `/v1/functions/${verFn.json.id}/versions/${oldV.id}/restore`);
  check('restoring an old version restores its runtime too',
    restored.json.runtime === 'python-3' && restored.json.entrypoint === 'main.py' && /def handler/.test(restored.json.code || ''),
    `${restored.json.runtime} ${restored.json.entrypoint}`);

  /* --------------------------------------------------------------- 历史 */
  section('Execution history');
  const hist = await api('GET', `/v1/functions/${pyFn.json.id}/executions`);
  check('execution history keeps the runtime per run',
    hist.json.executions.length >= 1 && hist.json.executions.every((e) => e.runtime === 'python-3'),
    JSON.stringify(hist.json.executions.map((e) => e.runtime)));

  if (process.env.KEEP === '1') return;
  section('Cleanup');
  const del = await api('DELETE', `/v1/functions/${pyFn.json.id}`);
  check('deleting a function still works', del.status === 200 && del.json.ok === true, `${del.status}`);
}

try {
  await main();
} catch (e) {
  failures.push(`fatal: ${e.message}`);
  console.error(`\n!! ${e.stack || e.message}`);
} finally {
  await cleanup();
}

const total = pass + failures.length;
console.log(`\n=== ${pass}/${total} checks passed · ${failures.length} failed ===`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
