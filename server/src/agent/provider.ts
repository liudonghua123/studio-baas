/**
 * AI provider abstraction.
 *
 * Every supported backend speaks the OpenAI chat-completions dialect, so the
 * console is not tied to one vendor: DeepSeek is the default, but an OpenAI
 * key, a local Ollama, or any compatible gateway works by changing one env var.
 * Nothing above this file knows which provider is active.
 */
import { getSetting } from '../store.js';

export type ProviderId = 'deepseek' | 'openai' | 'ollama' | 'custom';

export interface AiConfig {
  provider: ProviderId;
  label: string;
  baseUrl: string;
  model: string;
  key: string;
  /** true when the request has everything it needs (key, or a keyless local server) */
  configured: boolean;
  /** providers that do not require an API key */
  keyless: boolean;
}

const PROVIDERS: Record<ProviderId, { label: string; baseUrl: string; model: string; keyEnv: string[]; keyless?: boolean }> = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyEnv: ['DEEPSEEK_API_KEY'] },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyEnv: ['OPENAI_API_KEY'] },
  ollama: { label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1', keyEnv: [], keyless: true },
  custom: { label: 'Custom', baseUrl: '', model: '', keyEnv: ['AI_API_KEY'] },
};

const firstEnv = (...keys: string[]) => keys.map((k) => process.env[k]).find((v) => v && v.trim()) || '';

function providerId(): ProviderId {
  const raw = (process.env.AI_PROVIDER || getSetting('ai_provider') || '').toLowerCase().trim();
  return (['deepseek', 'openai', 'ollama', 'custom'] as const).includes(raw as ProviderId)
    ? (raw as ProviderId)
    : 'deepseek';
}

export function getAiConfig(): AiConfig {
  const id = providerId();
  const meta = PROVIDERS[id];

  // Explicit overrides win: AI_BASE_URL / AI_MODEL / AI_API_KEY describe "the
  // endpoint I actually want", whatever the provider preset says.
  const baseUrl = (process.env.AI_BASE_URL || getSetting('ai_base_url') || meta.baseUrl).replace(/\/+$/, '');
  const model = process.env.AI_MODEL || getSetting('ai_model') || meta.model;
  const stored = getSetting(`${id}_api_key`) || getSetting('ai_api_key') || '';
  const key = firstEnv(...meta.keyEnv) || stored;
  const keyless = !!meta.keyless;

  return {
    provider: id,
    label: id === 'custom' ? (process.env.AI_PROVIDER_LABEL || 'Custom') : meta.label,
    baseUrl,
    model,
    key,
    // A keyless local server is "configured" the moment a base URL exists;
    // a hosted provider needs a key long enough to be real.
    configured: keyless ? !!baseUrl : key.trim().length >= 16,
    keyless,
  };
}

/* --------------------------------------------------------------- streaming */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: Record<string, number> }
  | { type: 'message'; message: ChatMessage }
  | { type: 'error'; message: string };

function endpoint(baseUrl: string) {
  return /\/chat\/completions$/.test(baseUrl) ? baseUrl : `${baseUrl}/chat/completions`;
}

/** Request body shared by streaming and non-streaming calls. */
export function buildBody(
  cfg: AiConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  stream: boolean,
) {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: 0.2,
    max_tokens: 2400,
    stream,
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = 'auto';
  }
  // Ask for the trailing usage frame. Providers that don't know the field ignore it.
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

async function post(cfg: AiConfig, body: unknown, signal?: AbortSignal) {
  const res = await fetch(endpoint(cfg.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const hint = res.status === 401 ? ' (check the API key in Settings → AI)'
      : res.status === 404 ? ' (check AI_BASE_URL and the model name)'
      : res.status === 429 ? ' (rate limited, retry shortly)'
      : '';
    throw new Error(`${cfg.label} API ${res.status}: ${txt.slice(0, 240)}${hint}`);
  }
  return res;
}

/**
 * Stream one assistant turn.
 *
 * Yields text deltas as they arrive, then a final `message` event holding the
 * assembled content and any tool calls. Tool-call arguments are streamed as
 * JSON fragments keyed by index, so they are concatenated before parsing.
 */
export async function* streamChat(
  cfg: AiConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await post(cfg, buildBody(cfg, messages, tools, true), signal);
  const ctype = res.headers.get('content-type') || '';

  // Some gateways quietly ignore `stream`. Treat a JSON answer as one big delta
  // instead of hanging on an empty body.
  if (!ctype.includes('event-stream')) {
    const data = await res.json() as any;
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Empty response from the model');
    if (data.usage) yield { type: 'usage', usage: data.usage };
    if (msg.content) yield { type: 'delta', text: msg.content };
    yield { type: 'message', message: { role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls || [] } };
    return;
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const consume = function* (payload: string): Generator<StreamEvent> {
    if (payload === '[DONE]') return;
    let json: any;
    try { json = JSON.parse(payload); } catch { return; }
    if (json.usage) yield { type: 'usage', usage: json.usage };
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      yield { type: 'reasoning', text: delta.reasoning_content };
    }
    if (delta.content) {
      content += delta.content;
      yield { type: 'delta', text: delta.content };
    }
    for (const tc of delta.tool_calls || []) {
      const i = typeof tc.index === 'number' ? tc.index : 0;
      const cur = calls.get(i) || { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      calls.set(i, cur);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; keep the tail for the next read.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          yield* consume(line.slice(5).trim());
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, c]) => c.name)
    .map(([i, c]) => ({ id: c.id || `call_${i}`, type: 'function' as const, function: { name: c.name, arguments: c.args || '{}' } }));

  yield {
    type: 'message',
    message: { role: 'assistant', content: content || (toolCalls.length ? null : ''), tool_calls: toolCalls },
  };
}
