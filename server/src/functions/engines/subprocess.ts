import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExecContext, ExecutionOutcome, RunInput } from '../types.js';
import { RuntimeError } from '../types.js';

/**
 * 语言无关的子进程桥（studio-bridge/1）。
 *
 * 主进程 spawn 一个解释器，跑我们在临时目录里生成的 harness + 用户代码：
 *
 *   子进程 stdout（每行一个 JSON 帧）
 *     {"t":"log","level":"log","line":"..."}                  —— 用户 print / console.log
 *     {"t":"rpc","id":1,"ns":"databases","method":"getDocument","args":[...]}
 *     {"t":"result","status":200,"headers":{},"body":...,"failure":null}
 *   主进程 stdin
 *     {"id":1,"value":...} / {"id":1,"error":"..."}
 *
 * 为什么用同步 RPC 而不是把数据库也搬进子进程：better-sqlite3 是同步 API，
 * 一条语句几毫秒；子进程发起调用后阻塞读 stdin，主进程查完立刻回一行。
 * 这样用户代码里 `databases.get_document(...)` 依旧是同步取值，同时保持
 * 单写连接、项目隔离和事件广播都在主进程里。
 *
 * 隔离边界说明：这是**进程级**隔离（独立 PID、独立内存、超时可 SIGKILL），
 * 配合 harness 里的 rlimit / 网络守卫属于「防手滑」，不是容器级安全边界。
 */

export interface BridgeSpec {
  /** 运行时 id，仅用于错误信息 */
  id: string;
  command: string;
  args: string[];
  /** 用户代码文件后缀，例如 py */
  extension: string;
  harnessName: string;
  harnessSource: string;
  memoryMb: number;
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_LOG_LINES = 2000;
const MAX_LOG_CHARS = 512 * 1024;

export function executeViaBridge(spec: BridgeSpec, input: RunInput): Promise<ExecutionOutcome> {
  const { code, entrypoint, timeout, env, ctx } = input;
  const timeoutMs = Math.max(1, Math.round(timeout * 1000));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-fn-'));
  const entry = sanitizeEntry(entrypoint, spec.extension);
  const entryAbs = path.join(dir, entry);
  fs.mkdirSync(path.dirname(entryAbs), { recursive: true });
  fs.writeFileSync(entryAbs, code, 'utf8');
  fs.writeFileSync(path.join(dir, spec.harnessName), spec.harnessSource, 'utf8');
  // 请求体可能很大，走文件而不是环境变量；harness 启动时读一次
  fs.writeFileSync(
    path.join(dir, 'studio_request.json'),
    JSON.stringify({ req: ctx.req, meta: ctx.meta }),
    'utf8',
  );

  const logs: string[] = [];
  const errors: string[] = [];
  let logChars = 0;
  let truncated = false;

  const pushLog = (line: string, level = 'log') => {
    if (logs.length >= MAX_LOG_LINES || logChars >= MAX_LOG_CHARS) {
      if (!truncated) {
        truncated = true;
        logs.push('[log output truncated]');
      }
      return;
    }
    logChars += line.length;
    if (level === 'error') {
      errors.push(line);
      logs.push('ERROR ' + line);
    } else if (level === 'warn') {
      logs.push('[warn] ' + line);
    } else {
      logs.push(line);
    }
  };

  return new Promise<ExecutionOutcome>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...spec.args, spec.harnessName], {
        cwd: dir,
        // 只给函数自己的变量 + 最小系统变量，绝不继承宿主进程的环境（会带出密钥）
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          LANG: process.env.LANG || 'C.UTF-8',
          HOME: dir,
          TMPDIR: dir,
          // 用户变量先放，系统变量后放：函数不能靠同名变量改掉入口/超时/内存上限
          ...env,
          STUDIO_RUNTIME: spec.id,
          STUDIO_ENTRYPOINT: entry,
          STUDIO_TIMEOUT: String(timeout),
          STUDIO_MEMORY_MB: String(spec.memoryMb),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e: any) {
      cleanup(dir);
      reject(new RuntimeError(`Failed to start ${spec.id}: ${e?.message || e}`));
      return;
    }

    let settled = false;
    let buffer = '';
    const decoder = new StringDecoder('utf8');

    const killTree = () => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };

    const finish = (failure: string | null, out?: Partial<ExecutionOutcome>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 结果已拿到就立刻收掉进程，避免用户留下的线程/子进程继续占资源
      killTree();
      cleanup(dir);
      resolve({
        value: out?.value ?? null,
        logs,
        errors,
        failure: failure || undefined,
        status: out?.status,
        headers: out?.headers,
      });
    };

    const timer = setTimeout(() => {
      pushLog(`Execution timed out after ${timeout}s`);
      finish(`Execution timed out after ${timeout}s (process killed)`);
    }, timeoutMs + 500);

    const send = (frame: unknown) => {
      if (settled) return;
      try {
        child.stdin?.write(JSON.stringify(frame) + '\n');
      } catch { /* child exited mid-call */ }
    };

    const handleFrame = (frame: any) => {
      if (!frame || typeof frame !== 'object') return;
      switch (frame.t) {
        case 'log':
          pushLog(String(frame.line ?? ''), String(frame.level || 'log'));
          return;
        case 'rpc': {
          let payload: { id: unknown; value?: unknown; error?: string };
          try {
            const ns = ctx[frame.ns as keyof ExecContext] as any;
            const fn = ns?.[frame.method];
            if (typeof fn !== 'function') throw new Error(`Unknown runtime API ${frame.ns}.${frame.method}`);
            const value = fn(...(Array.isArray(frame.args) ? frame.args : []));
            if (value && typeof value.then === 'function') {
              throw new Error(`${frame.ns}.${frame.method}() returned a Promise; the function runtime only supports synchronous calls`);
            }
            payload = { id: frame.id, value: value === undefined ? null : value };
          } catch (e: any) {
            payload = { id: frame.id, error: e?.message || String(e) };
          }
          let frameOut: unknown = payload;
          try {
            const text = JSON.stringify(payload);
            if (text.length > MAX_FRAME_BYTES) {
              frameOut = { id: frame.id, error: `Response too large (>${MAX_FRAME_BYTES} bytes)` };
            }
          } catch (e: any) {
            frameOut = { id: frame.id, error: `Value is not serializable: ${e?.message || e}` };
          }
          send(frameOut);
          return;
        }
        case 'result':
          finish(frame.failure || null, {
            value: frame.body,
            status: typeof frame.status === 'number' ? frame.status : undefined,
            headers: frame.headers && typeof frame.headers === 'object' ? frame.headers : undefined,
          });
          return;
        default:
          return;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (buffer.length > MAX_FRAME_BYTES) {
        pushLog(`Protocol frame exceeded ${MAX_FRAME_BYTES} bytes`);
        return finish('Function produced an oversized response');
      }
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let frame: any;
        try {
          frame = JSON.parse(line);
        } catch {
          // 用户绕过 print 直接写 fd 1 时会走到这里：当成日志，别让整个执行失败
          pushLog(line);
          continue;
        }
        handleFrame(frame);
        if (settled) return;
      }
    });

    // 子进程被杀后继续写 stdin 会触发 EPIPE；没有监听器会冒泡成未捕获异常
    child.stdin?.on('error', () => {});

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = decoder.write(chunk);
      for (const line of text.split('\n')) if (line.trim()) pushLog(line, 'error');
    });

    child.on('error', (err: any) => {
      if (settled) return;
      cleanup(dir);
      settled = true;
      clearTimeout(timer);
      if (err?.code === 'ENOENT') {
        reject(new RuntimeError(`Runtime interpreter "${spec.command}" was not found on this host`));
        return;
      }
      reject(new RuntimeError(`Failed to start ${spec.id}: ${err?.message || err}`));
    });

    child.on('exit', (codeNum) => {
      if (settled) return;
      // 没等到 result 就退出：把已有的日志带上，给出可读原因
      const tail = logs.slice(-3).join(' | ');
      finish(`Function exited with code ${codeNum} before returning a result${tail ? ` (${tail})` : ''}`);
    });
  });
}

function sanitizeEntry(entrypoint: string, extension: string): string {
  const cleaned = String(entrypoint || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const safe = cleaned.split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
  const withExt = safe && safe.includes('.') ? safe : `main.${extension}`;
  // 只允许一层子目录，防止 user 通过 entrypoint 跳出临时目录
  return withExt.split('/').slice(-2).join('/');
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
