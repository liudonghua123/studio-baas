/**
 * The agent loop: model → tool calls → model, with a human in the middle for
 * anything that writes.
 *
 * Two things matter here beyond "call the API":
 *
 *  - **Approval.** A model that can delete collections or send email needs a
 *    stop button. Calls are partitioned into read-only (run immediately) and
 *    mutating (parked until the caller approves), and the parked run keeps its
 *    message history so resuming does not re-ask the model — which would give a
 *    different plan and break the promise the user just approved.
 *  - **Streaming.** Deltas are forwarded as they arrive, so a slow tool call
 *    reads as progress instead of a frozen screen.
 */
import { tools, toolMap, SYSTEM_PROMPT, demoAgent, type ChatResult, type ToolTrace } from '../ai.js';
import { getAiConfig, streamChat, type AiConfig, type ChatMessage, type ToolCall } from './provider.js';
import { listCollections, listFunctions, listSites, listBuckets, getMetrics } from '../store.js';
import { currentProjectId, currentPrincipal } from '../context.js';
import { can } from '../auth.js';

/* ------------------------------------------------------------------ types */

export interface PendingCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  description: string;
}

export type AgentEvent =
  | { type: 'meta'; mode: 'model' | 'demo'; provider: string; model: string; sessionId?: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool'; phase: 'start' | 'end'; trace: ToolTrace }
  | { type: 'approval'; token: string; calls: PendingCall[] }
  | { type: 'done'; text: string; traces: ToolTrace[]; usage?: Record<string, number>; sessionId?: string; steps: number }
  | { type: 'error'; message: string };

export interface AgentOptions {
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** tool names the user already allowed for this turn */
  approvals?: string[];
  /** skip approval entirely (used by trusted server-side jobs) */
  approveAll?: boolean;
  sessionId?: string;
  /** route/resource the user is looking at, injected into the system prompt */
  context?: { route?: string; resource?: string; resourceType?: string };
  signal?: AbortSignal;
}

interface PendingRun {
  token: string;
  projectId: string;
  cfg: AiConfig;
  messages: ChatMessage[];
  calls: ToolCall[];
  text: string;
  traces: ToolTrace[];
  usage?: Record<string, number>;
  sessionId?: string;
  steps: number;
  createdAt: number;
}

/* -------------------------------------------------------------- approvals */

// In-memory is the right scope: a pending approval is tied to a live turn, and
// the process restarting is a perfectly good reason to ask again.
const pending = new Map<string, PendingRun>();
const PENDING_TTL = 10 * 60 * 1000;

function sweep() {
  const cutoff = Date.now() - PENDING_TTL;
  for (const [k, v] of pending) if (v.createdAt < cutoff) pending.delete(k);
}

export { isDangerous, permissionFor } from './permissions.js';

import { isDangerous, permissionFor } from './permissions.js';

const allowedForCaller = (name: string) => {
  const perm = permissionFor(name);
  return !perm || can(perm, currentPrincipal());
};

/* -------------------------------------------------------------- context */

function contextBlock(ctx: AgentOptions['context']): string {
  if (!ctx) return '';
  const lines: string[] = [];
  if (ctx.route) lines.push(`用户当前所在页面：${ctx.route}`);
  if (ctx.resource) lines.push(`当前选中资源：${ctx.resourceType || 'resource'} \`${ctx.resource}\``);
  try {
    const cols = listCollections().slice(0, 8).map((c) => `${c.name}(${c.key}, ${c.documentCount ?? 0} 条)`);
    if (cols.length) lines.push(`集合：${cols.join('、')}`);
    const fns = listFunctions().slice(0, 6).map((f) => f.name);
    if (fns.length) lines.push(`云函数：${fns.join('、')}`);
    const sites = listSites().slice(0, 6).map((s) => s.name);
    if (sites.length) lines.push(`站点：${sites.join('、')}`);
    const m = getMetrics();
    lines.push(`规模：${m.documents} 文档 / ${m.files} 文件 / ${m.users} 用户`);
  } catch { /* context is a bonus, never a failure */ }
  return lines.length ? `\n\n## 当前项目上下文\n${lines.join('\n')}` : '';
}

/* --------------------------------------------------------------- helpers */

const parseArgs = (raw: string): Record<string, any> => {
  try { const v = JSON.parse(raw || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

const clip = (v: unknown, n = 6000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} chars truncated)` : s;
};

/** Only advertise tools the caller may actually use. */
function toolSchema() {
  return tools
    .filter((t) => allowedForCaller(t.name))
    .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

async function execute(call: ToolCall): Promise<ToolTrace> {
  const name = call.function.name;
  const args = parseArgs(call.function.arguments);
  const def = toolMap.get(name);
  const started = Date.now();
  let result: unknown;
  let ok = true;
  try {
    if (!def) throw new Error(`Unknown tool "${name}"`);
    const perm = permissionFor(name);
    if (perm && !can(perm, currentPrincipal())) {
      throw new Error(`Missing permission: ${perm}. Your role cannot perform this action.`);
    }
    result = await def.run(args);
  } catch (e: any) {
    ok = false;
    result = { error: e?.message || String(e) };
  }
  return {
    id: call.id,
    name,
    args,
    result,
    ok,
    duration: Date.now() - started,
    summary: def ? def.summary(args) : name,
  };
}

/* ------------------------------------------------------------- demo path */

async function* runDemo(opts: AgentOptions): AsyncGenerator<AgentEvent> {
  const history = opts.messages.map((m) => ({ role: m.role, content: m.content }));
  yield { type: 'meta', mode: 'demo', provider: 'rule engine', model: 'local', sessionId: opts.sessionId };

  let result: ChatResult;
  try {
    result = await demoAgent(history);
  } catch (e: any) {
    yield { type: 'error', message: e?.message || String(e) };
    return;
  }

  for (const tr of result.traces) yield { type: 'tool', phase: 'end', trace: tr };
  // Chunked so the console gets the same typewriter feel as a live model.
  for (let i = 0; i < result.text.length; i += 28) {
    yield { type: 'delta', text: result.text.slice(i, i + 28) };
    await new Promise((r) => setTimeout(r, 6));
  }
  yield {
    type: 'done', text: result.text, traces: result.traces,
    sessionId: opts.sessionId, steps: result.traces.length,
  };
}

/* --------------------------------------------------------------- the loop */

const MAX_STEPS = 8;

export async function* runAgent(options: AgentOptions): AsyncGenerator<AgentEvent> {
  // Escape hatch for trusted automation. Off by default: a model that can delete
  // collections should not be able to do so unattended.
  const opts: AgentOptions = { ...options, approveAll: options.approveAll ?? process.env.AI_APPROVAL === 'off' };
  const cfg = getAiConfig();
  if (!cfg.configured) {
    yield* runDemo(opts);
    return;
  }

  const approved = new Set((opts.approvals || []).map(String));
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT + contextBlock(opts.context) },
    ...opts.messages.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
  ];

  yield { type: 'meta', mode: 'model', provider: cfg.provider, model: cfg.model, sessionId: opts.sessionId };
  yield* loop(cfg, messages, [], 0, approved, opts, undefined);
}

/**
 * The resumable half. Kept separate so `resume()` can replay an approved batch
 * without re-running the model call that produced it.
 */
async function* loop(
  cfg: AiConfig,
  messages: ChatMessage[],
  traces: ToolTrace[],
  step: number,
  approved: Set<string>,
  opts: AgentOptions,
  sessionId: string | undefined,
): AsyncGenerator<AgentEvent> {
  const schemas = toolSchema();

  for (; step < MAX_STEPS; step++) {
    let text = '';
    let usage: Record<string, number> | undefined;
    let assistant: ChatMessage | null = null;

    try {
      for await (const ev of streamChat(cfg, messages, schemas, opts.signal)) {
        if (ev.type === 'delta') { text += ev.text; yield { type: 'delta', text: ev.text }; }
        else if (ev.type === 'reasoning') yield { type: 'reasoning', text: ev.text };
        else if (ev.type === 'usage') usage = ev.usage;
        else if (ev.type === 'message') assistant = ev.message;
        else if (ev.type === 'error') throw new Error(ev.message);
      }
    } catch (e: any) {
      yield { type: 'error', message: e?.message || String(e) };
      return;
    }
    if (!assistant) { yield { type: 'error', message: 'Empty response from the model' }; return; }

    messages.push(assistant);
    const calls = assistant.tool_calls || [];

    if (!calls.length) {
      yield { type: 'done', text: assistant.content || '', traces, usage, sessionId, steps: step + 1 };
      return;
    }

    const parked = calls.filter((c) => isDangerous(c.function.name) && !opts.approveAll && !approved.has(c.function.name));
    if (parked.length) {
      sweep();
      const token = `appr_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      pending.set(token, {
        token, projectId: currentProjectId(), cfg, messages, calls, text, traces, usage, sessionId, steps: step, createdAt: Date.now(),
      });
      yield {
        type: 'approval',
        token,
        calls: parked.map((c) => {
          const args = parseArgs(c.function.arguments);
          const def = toolMap.get(c.function.name);
          return {
            id: c.id,
            name: c.function.name,
            args,
            summary: def ? def.summary(args) : c.function.name,
            description: def?.description || '',
          };
        }),
      };
      // The turn is not finished; the client resumes it with the token.
      return;
    }

    // Read-only calls are independent, so run them together; writes stay ordered
    // because a later call may depend on an earlier one.
    const auto = calls.filter((c) => !isDangerous(c.function.name));
    const writes = calls.filter((c) => isDangerous(c.function.name));

    for (const call of auto) yield { type: 'tool', phase: 'start', trace: { id: call.id, name: call.function.name, args: parseArgs(call.function.arguments), result: null, ok: true, duration: 0, summary: toolMap.get(call.function.name)?.summary(parseArgs(call.function.arguments)) || call.function.name } };
    const autoTraces = await Promise.all(auto.map((c) => execute(c)));
    for (const tr of autoTraces) {
      traces.push(tr);
      yield { type: 'tool', phase: 'end', trace: tr };
      messages.push({ role: 'tool', tool_call_id: tr.id, content: clip(tr.result) });
    }

    for (const call of writes) {
      const args = parseArgs(call.function.arguments);
      yield { type: 'tool', phase: 'start', trace: { id: call.id, name: call.function.name, args, result: null, ok: true, duration: 0, summary: toolMap.get(call.function.name)?.summary(args) || call.function.name } };
      const tr = await execute(call);
      traces.push(tr);
      yield { type: 'tool', phase: 'end', trace: tr };
      messages.push({ role: 'tool', tool_call_id: tr.id, content: clip(tr.result) });
    }
  }

  yield {
    type: 'done',
    text: '工具调用轮次已达上限（8 轮）。请把任务拆成更小的步骤，我再继续执行。',
    traces, sessionId, steps: MAX_STEPS,
  };
}

/* --------------------------------------------------------------- approve */

export async function* resumeAgent(token: string, input: { approved?: string[]; denied?: string[] }): AsyncGenerator<AgentEvent> {
  sweep();
  const run = pending.get(token);
  if (!run) {
    yield { type: 'error', message: 'This approval request expired. Ask again and I will re-plan.' };
    return;
  }
  pending.delete(token);

  const okIds = new Set(input.approved || []);
  const denied = new Set(input.denied || []);

  // Any call the user did not approve (and did not explicitly deny) is treated
  // as denied — silence is not consent.
  for (const call of run.calls) {
    if (!okIds.has(call.id)) denied.add(call.id);
  }

  for (const call of run.calls) {
    if (denied.has(call.id)) {
      run.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: 'The user declined this action. Do not retry it; ask what they would prefer.' }) });
    }
  }

  for (const call of run.calls) {
    if (!okIds.has(call.id)) continue;
    const args = parseArgs(call.function.arguments);
    yield { type: 'tool', phase: 'start', trace: { id: call.id, name: call.function.name, args, result: null, ok: true, duration: 0, summary: toolMap.get(call.function.name)?.summary(args) || call.function.name } };
    const tr = await execute(call);
    run.traces.push(tr);
    yield { type: 'tool', phase: 'end', trace: tr };
    run.messages.push({ role: 'tool', tool_call_id: call.id, content: clip(tr.result) });
  }

  const approvedNames = new Set(
    run.calls.filter((c) => okIds.has(c.id)).map((c) => c.function.name),
  );
  yield* loop(run.cfg, run.messages, run.traces, run.steps + 1, approvedNames, {
    messages: [], sessionId: run.sessionId, approveAll: false,
  }, run.sessionId);
}

/* ----------------------------------------------------- non-streaming shim */

/** Collect the streamed events into one payload — used by `/v1/ai/chat` and tests. */
export async function chatOnce(opts: AgentOptions): Promise<ChatResult & { sessionId?: string }> {
  let text = '';
  let traces: ToolTrace[] = [];
  let model = 'local';
  let mode: 'deepseek' | 'demo' = 'demo';
  let usage: ChatResult['usage'];
  for await (const ev of runAgent({ ...opts, approveAll: opts.approveAll ?? true })) {
    if (ev.type === 'meta') { model = ev.model; mode = ev.mode === 'model' ? 'deepseek' : 'demo'; }
    else if (ev.type === 'delta') text += ev.text;
    else if (ev.type === 'done') { text = ev.text; traces = ev.traces; usage = ev.usage as any; }
    else if (ev.type === 'tool') { if (ev.phase === 'end') traces.push(ev.trace); }
    else if (ev.type === 'error') throw new Error(ev.message);
  }
  return { text, traces, model, mode, usage };
}

/** Exported for tests: how many runs are waiting on a human. */
export const pendingApprovals = () => pending.size;
