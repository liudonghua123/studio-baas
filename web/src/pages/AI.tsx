import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Send, Trash2, ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle,
  Database, Boxes, Globe2, Users, Send as SendIcon, Terminal, BarChart3, Loader2, Zap, Bot,
} from 'lucide-react';
import { api } from '../api';
import type { AiStatus, ToolTrace } from '../types';
import { Badge, useToast } from '../components/ui';
import { renderMarkdown } from '../lib/markdown';
import { useT } from '../lib/locale';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  traces?: ToolTrace[];
  animate?: boolean;
  pending?: boolean;
}

const SUGGESTIONS = [
  'Give me a project overview — documents, users and functions',
  'List every collection with its document count',
  'Run the Store analytics function and explain the result',
  'Show the latest error logs and suggest fixes',
];

const CAPABILITIES = [
  { icon: Database, label: 'Databases', text: 'Create collections, add fields, read and write documents' },
  { icon: Boxes, label: 'Functions', text: 'Read and edit code, run it and inspect logs' },
  { icon: Globe2, label: 'Sites', text: 'Edit HTML/CSS/JS and deploy live' },
  { icon: Users, label: 'Auth', text: 'Create users, check status and labels' },
  { icon: SendIcon, label: 'Messaging', text: 'Send email / SMS / push' },
  { icon: BarChart3, label: 'Insights', text: 'Metrics, executions and request logs' },
];

const toolIcon = (name: string) => {
  if (name.startsWith('list_documents') || name.includes('document')) return Database;
  if (name.includes('function') || name.includes('execute')) return Boxes;
  if (name.includes('site')) return Globe2;
  if (name.includes('user')) return Users;
  if (name.includes('message')) return SendIcon;
  if (name.includes('file') || name.includes('bucket')) return Wrench;
  if (name.includes('log') || name.includes('metric') || name.includes('execution')) return Terminal;
  return Wrench;
};

export default function AI() {
  const toast = useToast();
  const t = useT();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { api.aiStatus().then(setStatus).catch(() => {}); }, []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput('');
    const userMsg: Msg = { id: 'u' + Date.now(), role: 'user', content };
    const pendingId = 'a' + Date.now();
    const history = [...messages, userMsg];
    setMessages([...history, { id: pendingId, role: 'assistant', content: '', pending: true }]);
    setBusy(true);
    try {
      const reply = await api.aiChat(history.map((m) => ({ role: m.role, content: m.content })));
      setMessages((prev) => prev.map((m) => (m.id === pendingId
        ? { ...m, content: reply.text, traces: reply.traces, pending: false, animate: true }
        : m)));
    } catch (e: any) {
      setMessages((prev) => prev.map((m) => (m.id === pendingId
        ? { ...m, content: t('Request failed: {message}', { message: e.message }), pending: false }
        : m)));
      toast.push(e.message, 'err');
    }
    setBusy(false);
    boxRef.current?.focus();
  };

  const toolCount = status?.tools.length || 0;

  return (
    <div className="ai-page">
      <div className="ai-main">
        <div className="ai-head">
          <div className="ai-orb"><Sparkles size={17} color="#fff" /></div>
          <div>
            <h1>{t('DeepSeek Operator')}</h1>
            <p>{status ? `${status.provider} · ${status.model}` : t('Connecting…')} · {t('{n} tools available', { n: toolCount })}</p>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={status?.mode === 'deepseek' ? 'green' : 'amber'} dot>
              {status?.mode === 'deepseek' ? t('Live model') : t('Demo mode')}
            </Badge>
            {messages.length > 0 && (
              <button className="btn sm ghost" onClick={() => setMessages([])}><Trash2 size={12} /> {t('Clear')}</button>
            )}
          </div>
        </div>

        <div className="chat-scroll" ref={scroller}>
          <div className="chat-inner">
            {messages.length === 0 && (
              <div style={{ paddingTop: 18, minHeight: 'calc(100vh - 330px)', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <div className="ai-orb" style={{ width: 40, height: 40, borderRadius: 13 }}><Sparkles size={19} color="#fff" /></div>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 620, letterSpacing: '-0.02em' }}>{t('What should we build today?')}</div>
                    <div className="tiny dim">{t('I can operate every service in this project through tool calls.')}</div>
                  </div>
                </div>

                {status?.mode === 'demo' && (
                  <div className="card" style={{ padding: '10px 14px', marginBottom: 16, borderColor: 'rgba(251,191,36,.25)', background: 'rgba(251,191,36,.045)' }}>
                    <div className="flex tiny" style={{ gap: 8, color: 'var(--amber-text)' }}>
                      <Zap size={13} />
                      <span>
                        <span className="mono">DEEPSEEK_API_KEY</span>{' '}
                        {t('is not set — running a local rule engine that still performs real tool calls. Add a key in')}{' '}
                        <b>{t('Settings → AI')}</b>{' '}
                        {t('for full autonomous multi-step planning.')}
                      </span>
                    </div>
                  </div>
                )}

                <div className="quick-grid" style={{ marginBottom: 18 }}>
                  {CAPABILITIES.map((c) => (
                    <div key={c.label} className="quick-card">
                      <div className="qi"><c.icon size={14} /></div>
                      <div><b>{t(c.label)}</b><small>{t(c.text)}</small></div>
                    </div>
                  ))}
                </div>

                <div className="tiny dim" style={{ marginBottom: 8 }}>{t('Try one of these')}</div>
                <div className="chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chip" onClick={() => send(t(s))}>{t(s)}</button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m) => (
              <Message key={m.id} msg={m} />
            ))}

            {busy && messages.every((m) => !m.pending) && (
              <div className="msg ai">
                <div className="msg-avatar"><Sparkles size={13} /></div>
                <div className="bubble"><span className="typing"><i /><i /><i /></span></div>
              </div>
            )}
          </div>
        </div>

        <div className="composer-wrap">
          {messages.length > 0 && (
            <div className="composer" style={{ boxShadow: 'none', border: 0, padding: '0 0 8px', background: 'transparent' }}>
              <div className="chips" style={{ maxWidth: 780, margin: '0 auto' }}>
                {['List all collections', 'Run the Order webhook', 'Latest error logs', 'Project metrics overview'].map((s) => (
                  <button key={s} className="chip" onClick={() => send(t(s))}>{t(s)}</button>
                ))}
              </div>
            </div>
          )}
          <div className="composer">
            <textarea
              ref={boxRef}
              placeholder={t('Ask DeepSeek to query data, run functions, edit sites… (⌘↵ to send)')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); send(); }
              }}
              rows={2}
            />
            <div className="composer-bar">
              <span className="hint flex" style={{ gap: 5 }}><Bot size={11} /> {t('tools: {n}', { n: toolCount })} · {status?.mode === 'deepseek' ? t('deepseek tool-calling') : t('local rule engine')}</span>
              <button className="send-btn" onClick={() => send()} disabled={!input.trim() || busy}>
                {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      <aside className="ai-side">
        <h3>{t('Connected tools')}</h3>
        {!status ? <div className="skeleton" style={{ height: 120 }} /> : (
          <div style={{ maxHeight: 340, overflowY: 'auto', marginBottom: 20 }}>
            {status.tools.map((tool) => (
              <div className="tool-pill" key={tool.name} title={t(tool.description)}>
                <Wrench size={10} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.name}</span>
              </div>
            ))}
          </div>
        )}
        <h3>{t('Model')}</h3>
        <div className="card" style={{ padding: 12, background: 'rgba(255,255,255,.02)' }}>
          <div className="flex" style={{ gap: 7, marginBottom: 7 }}>
            <span className="status-dot" style={{ background: status?.mode === 'deepseek' ? 'var(--green)' : 'var(--amber)' }} />
            <b style={{ fontSize: 12 }}>{status?.model || '—'}</b>
          </div>
          <div className="tiny dim" style={{ lineHeight: 1.6 }}>
            {status?.mode === 'deepseek'
              ? t('OpenAI-compatible tool calling, up to 6 planning steps per turn.')
              : t('Demo mode: deterministic intents mapped to real tools. Add a key in Settings.')}
          </div>
        </div>
        <h3 style={{ marginTop: 20 }}>{t('How it works')}</h3>
        <ol className="tiny dim" style={{ paddingLeft: 16, lineHeight: 1.8, margin: 0 }}>
          <li>{t('Your message goes to the harness with {n} tool schemas.', { n: status?.tools?.length || 0 })}</li>
          <li>{t('DeepSeek picks the tools; the server executes them against the live project.')}</li>
          <li>{t('Results feed back into the model for the final answer.')}</li>
          <li>{t('Every call is traced below the reply — audit exactly what changed.')}</li>
        </ol>
        <div className="divider" />
        <div className="tiny dim" style={{ lineHeight: 1.6 }}>
          <b style={{ color: 'var(--muted)' }}>{t('With a key:')}</b> {t('“Change the hero headline on aurora-storefront and redeploy” — the agent edits index.html and redeploys.')}
        </div>
      </aside>
    </div>
  );
}

function Message({ msg }: { msg: Msg }) {
  const t = useT();
  const [shown, setShown] = useState(msg.animate ? '' : msg.content);
  const [openTraces, setOpenTraces] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!msg.animate) { setShown(msg.content); return; }
    let i = 0;
    setShown('');
    const step = Math.max(2, Math.ceil(msg.content.length / 160));
    const timer = setInterval(() => {
      i += step;
      setShown(msg.content.slice(0, i));
      if (i >= msg.content.length) clearInterval(timer);
    }, 14);
    return () => clearInterval(timer);
  }, [msg.content, msg.animate]);

  const { html } = useMemo(() => renderMarkdown(shown), [shown]);

  if (msg.role === 'user') {
    return (
      <div className="msg user">
        <div className="msg-avatar">AF</div>
        <div className="bubble" style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</div>
      </div>
    );
  }

  return (
    <div className="msg ai">
      <div className="msg-avatar"><Sparkles size={13} /></div>
      <div style={{ maxWidth: 'calc(100% - 40px)', minWidth: 0 }}>
        {msg.pending ? (
          <div className="bubble"><span className="typing"><i /><i /><i /></span></div>
        ) : (
          <>
            <div className="bubble" dangerouslySetInnerHTML={{ __html: html }} />
            {!!msg.traces?.length && (
              <div style={{ marginTop: 2 }}>
                <div className="tiny dim flex" style={{ gap: 5, margin: '7px 2px 0' }}>
                  <Wrench size={10} /> {msg.traces.length === 1 ? t('{n} tool call executed', { n: 1 }) : t('{n} tool calls executed', { n: msg.traces.length })}
                </div>
                {msg.traces.map((trace) => {
                  const Icon = toolIcon(trace.name);
                  const open = openTraces[trace.id];
                  return (
                    <div className="trace-card" key={trace.id}>
                      <div className="trace-head" onClick={() => setOpenTraces((s) => ({ ...s, [trace.id]: !s[trace.id] }))}>
                        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="trace-icon"><Icon size={10} /></span>
                        <span className="trace-name">{trace.name}</span>
                        <span style={{ color: 'var(--dim)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trace.summary}</span>
                        {trace.ok ? <CheckCircle2 size={11} className="trace-ok" style={{ marginLeft: 'auto' }} /> : <XCircle size={11} className="trace-fail" style={{ marginLeft: 'auto' }} />}
                        <span className="trace-time">{trace.duration}ms</span>
                      </div>
                      {open && (
                        <div className="trace-body">
                          <div style={{ color: 'var(--log-dim)' }}>→ {t('args')}</div>
                          {JSON.stringify(trace.args, null, 2)}
                          <div style={{ color: 'var(--log-dim)', marginTop: 8 }}>← {t('result')}</div>
                          {JSON.stringify(trace.result, null, 2)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
