import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Sparkles, Send, Trash2, ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle,
  Database, Boxes, Globe2, Users, Send as SendIcon, Terminal, BarChart3, Loader2, Zap, Bot,
  Plus, MessageSquare, Pencil, ShieldAlert, Square, PanelLeftClose, PanelLeft, OctagonX,
} from 'lucide-react';
import { api, streamAgent } from '../api';
import type { AiSession, AiStatus, AgentEvent, PendingCall, ToolTrace } from '../types';
import { Badge, useToast } from '../components/ui';
import { renderMarkdown } from '../lib/markdown';
import { useT } from '../lib/locale';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  traces?: ToolTrace[];
  /** waiting for the first token */
  pending?: boolean;
  /** tokens are still arriving — render the caret */
  streaming?: boolean;
  approval?: { token: string; calls: PendingCall[] };
  error?: boolean;
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
  if (name.includes('user') || name.includes('member')) return Users;
  if (name.includes('message')) return SendIcon;
  if (name.includes('webhook')) return Globe2;
  if (name.includes('file') || name.includes('bucket')) return Wrench;
  if (name.includes('log') || name.includes('metric') || name.includes('execution')) return Terminal;
  return Wrench;
};

const onlyTurns = (list: Msg[]) =>
  list.filter((m) => m.content.trim() && !m.error).map((m) => ({ role: m.role, content: m.content }));

export default function AI() {
  const toast = useToast();
  const t = useT();
  const location = useLocation();

  const [status, setStatus] = useState<AiStatus | null>(null);
  const [sessions, setSessions] = useState<AiSession[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [showSessions, setShowSessions] = useState(true);
  const [renaming, setRenaming] = useState<string>('');

  const scroller = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** text of the current turn's user message — the server needs it to save the turn */
  const lastUserRef = useRef('');

  const active = sessions.find((s) => s.id === activeId) || null;

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => {});
    void refreshSessions(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy]);

  const openSession = async (id: string) => {
    abortRef.current?.abort();
    setBusy(false);
    setActiveId(id);
    try {
      const { messages: rows } = await api.aiSession(id);
      setMessages(rows.map((m) => ({
        id: m.id, role: m.role, content: m.content,
        traces: m.traces?.length ? m.traces : undefined,
      })));
    } catch (e: any) {
      toast.push(e.message, 'err');
    }
  };

  async function refreshSessions(openFirst = false) {
    try {
      const r = await api.aiSessions();
      setSessions(r.sessions);
      if (openFirst && r.sessions.length && !activeId) await openSession(r.sessions[0].id);
    } catch { /* sidebar is optional */ }
  }

  const newSession = () => {
    abortRef.current?.abort();
    setBusy(false);
    setActiveId('');
    setMessages([]);
    boxRef.current?.focus();
  };

  const removeSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(t('Delete this conversation?'))) return;
    await api.deleteAiSession(id).catch((err) => toast.push(err.message, 'err'));
    if (id === activeId) newSession();
    void refreshSessions();
  };

  const rename = async (id: string, title: string) => {
    setRenaming('');
    const clean = title.trim();
    if (!clean) return;
    await api.renameAiSession(id, clean).catch((err) => toast.push(err.message, 'err'));
    void refreshSessions();
  };

  /** Apply a streamed event to the assistant message with `id`. */
  const apply = (id: string, fn: (m: Msg) => Msg) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));

  const consume = async (path: string, body: unknown, assistantId: string) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    try {
      await streamAgent(path, body, (ev: AgentEvent) => {
        if (ev.type === 'meta') {
          setStatus((s) => (s ? { ...s, model: ev.model, mode: ev.mode === 'model' ? 'live' : 'demo' } : s));
        } else if (ev.type === 'delta') {
          apply(assistantId, (m) => ({ ...m, pending: false, streaming: true, content: m.content + ev.text }));
        } else if (ev.type === 'tool') {
          const tr = ev.trace;
          apply(assistantId, (m) => {
            const traces = [...(m.traces || [])];
            const i = traces.findIndex((x) => x.id === tr.id);
            if (ev.phase === 'start') {
              if (i < 0) traces.push({ ...tr, result: null, duration: 0 });
            } else if (i >= 0) traces[i] = tr;
            else traces.push(tr);
            return { ...m, pending: false, traces };
          });
        } else if (ev.type === 'approval') {
          apply(assistantId, (m) => ({ ...m, pending: false, streaming: false, approval: { token: ev.token, calls: ev.calls } }));
        } else if (ev.type === 'done') {
          apply(assistantId, (m) => ({
            ...m, pending: false, streaming: false, approval: undefined,
            content: ev.text || m.content, traces: ev.traces?.length ? ev.traces : m.traces,
          }));
          void refreshSessions();
        } else if (ev.type === 'error') {
          apply(assistantId, (m) => ({ ...m, pending: false, streaming: false, error: true, content: ev.message }));
        }
      }, controller.signal);
    } catch (e: any) {
      if (e?.name !== 'AbortError') {
        apply(assistantId, (m) => ({ ...m, pending: false, streaming: false, error: true, content: e.message }));
        toast.push(e.message, 'err');
      } else {
        apply(assistantId, (m) => ({ ...m, pending: false, streaming: false }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
      boxRef.current?.focus();
    }
  };

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput('');

    // The first turn of a new thread needs a session row so history survives a reload.
    let sessionId = activeId;
    if (!sessionId) {
      try {
        const s = await api.createAiSession({ title: content.slice(0, 60) });
        sessionId = s.id;
        setActiveId(s.id);
        setSessions((prev) => [s, ...prev]);
      } catch { /* keep chatting even if persistence fails */ }
    }

    const userMsg: Msg = { id: 'u' + Date.now(), role: 'user', content };
    const assistantId = 'a' + Date.now();
    lastUserRef.current = content;
    setMessages((prev) => [...prev, userMsg, { id: assistantId, role: 'assistant', content: '', pending: true, traces: [] }]);

    await consume('/v1/ai/chat/stream', {
      messages: onlyTurns([...messages, userMsg]),
      sessionId,
      context: { route: location.pathname },
    }, assistantId);
  };

  const decide = async (assistantId: string, token: string, approve: boolean, calls: PendingCall[]) => {
    apply(assistantId, (m) => ({ ...m, approval: undefined, pending: true }));
    await consume('/v1/ai/resume', {
      token,
      approved: approve ? calls.map((c) => c.id) : [],
      denied: approve ? [] : calls.map((c) => c.id),
      sessionId: activeId || undefined,
      userText: lastUserRef.current,
    }, assistantId);
  };

  const stop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const toolCount = status?.tools.length || 0;

  return (
    <div className={`ai-page${showSessions ? '' : ' collapsed'}`}>
      {showSessions && (
        <aside className="ai-sessions">
          <div className="ai-ses-head">
            <span>{t('Conversations')}</span>
            <button className="icon-btn" title={t('New conversation')} onClick={newSession}><Plus size={14} /></button>
          </div>
          <button className={`ses-new${!activeId ? ' on' : ''}`} onClick={newSession}>
            <MessageSquare size={13} /> {t('New chat')}
          </button>
          <div className="ses-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`ses-item${s.id === activeId ? ' on' : ''}`}
                onClick={() => openSession(s.id)}
              >
                {renaming === s.id ? (
                  <input
                    className="ses-input"
                    autoFocus
                    defaultValue={s.title}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => rename(s.id, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenaming('');
                    }}
                  />
                ) : (
                  <>
                    <span className="ses-title">{s.title}</span>
                    <span className="ses-tools">
                      <button className="icon-btn" title={t('Rename')} onClick={(e) => { e.stopPropagation(); setRenaming(s.id); }}><Pencil size={11} /></button>
                      <button className="icon-btn" title={t('Delete')} onClick={(e) => removeSession(s.id, e)}><Trash2 size={11} /></button>
                    </span>
                  </>
                )}
              </div>
            ))}
            {!sessions.length && <div className="ses-empty tiny dim">{t('No conversations yet.')}</div>}
          </div>
          <div className="ses-foot">
            <button className="icon-btn" title={t('Hide conversations')} onClick={() => setShowSessions(false)}>
              <PanelLeftClose size={14} />
            </button>
          </div>
        </aside>
      )}

      <div className="ai-main">
        <div className="ai-head">
          {!showSessions && (
            <button className="icon-btn" title={t('Show conversations')} onClick={() => setShowSessions(true)}>
              <PanelLeft size={15} />
            </button>
          )}
          <div className="ai-orb"><Sparkles size={17} color="#fff" /></div>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {active?.title || t('DeepSeek Operator')}
            </h1>
            <p>
              {status ? `${status.provider} · ${status.model}` : t('Connecting…')} · {t('{n} tools available', { n: toolCount })}
            </p>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={status?.mode === 'live' ? 'green' : 'amber'} dot>
              {status?.mode === 'live' ? t('Live model') : t('Demo mode')}
            </Badge>
            {messages.length > 0 && (
              <button className="btn sm ghost" onClick={newSession}><Plus size={12} /> {t('New')}</button>
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
                        {t('No API key configured — running a local rule engine that still performs real tool calls. Add a key in')}{' '}
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
              <Message key={m.id} msg={m} onDecide={decide} />
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
              placeholder={t('Ask the agent to query data, run functions, edit sites… (⌘↵ to send)')}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); send(); }
              }}
              rows={2}
            />
            <div className="composer-bar">
              <span className="hint flex" style={{ gap: 5 }}>
                <Bot size={11} /> {t('tools: {n}', { n: toolCount })} · {status?.mode === 'live' ? t('model tool-calling') : t('local rule engine')}
              </span>
              {busy ? (
                <button className="send-btn" onClick={stop} title={t('Stop')}><Square size={12} /></button>
              ) : (
                <button className="send-btn" onClick={() => send()} disabled={!input.trim()}><Send size={14} /></button>
              )}
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
                {tool.dangerous ? <ShieldAlert size={10} style={{ color: 'var(--amber-text)' }} /> : <Wrench size={10} />}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.name}</span>
              </div>
            ))}
          </div>
        )}
        <h3>{t('Model')}</h3>
        <div className="card" style={{ padding: 12, background: 'var(--w1)' }}>
          <div className="flex" style={{ gap: 7, marginBottom: 7 }}>
            <span className="status-dot" style={{ background: status?.mode === 'live' ? 'var(--green)' : 'var(--amber)' }} />
            <b style={{ fontSize: 12 }}>{status?.model || '—'}</b>
          </div>
          <div className="tiny dim" style={{ lineHeight: 1.6 }}>
            {status?.mode === 'live'
              ? t('OpenAI-compatible tool calling, up to 8 planning steps per turn.')
              : t('Demo mode: deterministic intents mapped to real tools. Add a key in Settings.')}
          </div>
        </div>
        <h3 style={{ marginTop: 20 }}>{t('How it works')}</h3>
        <ol className="tiny dim" style={{ paddingLeft: 16, lineHeight: 1.8, margin: 0 }}>
          <li>{t('Your message goes to the harness with {n} tool schemas.', { n: status?.tools?.length || 0 })}</li>
          <li>{t('The model picks the tools; read-only calls run immediately.')}</li>
          <li>{t('Anything that writes waits for your approval.')}</li>
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

function Message({ msg, onDecide }: { msg: Msg; onDecide: (id: string, token: string, approve: boolean, calls: PendingCall[]) => void }) {
  const t = useT();
  const [openTraces, setOpenTraces] = useState<Record<string, boolean>>({});

  const { html } = useMemo(() => renderMarkdown(msg.content), [msg.content]);

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
      <div style={{ maxWidth: 'calc(100% - 40px)', minWidth: 0, flex: 1 }}>
        {msg.pending && !msg.content ? (
          <div className="bubble"><span className="typing"><i /><i /><i /></span></div>
        ) : (
          <>
            {msg.content && (
              <div className={`bubble${msg.error ? ' bubble-error' : ''}`}>
                <span dangerouslySetInnerHTML={{ __html: html }} />
                {msg.streaming && <span className="caret" />}
              </div>
            )}

            {!!msg.traces?.length && (
              <div style={{ marginTop: 2 }}>
                <div className="tiny dim flex" style={{ gap: 5, margin: '7px 2px 0' }}>
                  <Wrench size={10} /> {msg.traces.length === 1 ? t('{n} tool call', { n: 1 }) : t('{n} tool calls', { n: msg.traces.length })}
                </div>
                {msg.traces.map((trace) => {
                  const Icon = toolIcon(trace.name);
                  const open = openTraces[trace.id];
                  const running = trace.duration === 0 && trace.result === null;
                  return (
                    <div className="trace-card" key={trace.id}>
                      <div className="trace-head" onClick={() => setOpenTraces((s) => ({ ...s, [trace.id]: !s[trace.id] }))}>
                        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="trace-icon"><Icon size={10} /></span>
                        <span className="trace-name">{trace.name}</span>
                        <span style={{ color: 'var(--dim)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{trace.summary}</span>
                        {running
                          ? <Loader2 size={11} className="spin" style={{ marginLeft: 'auto' }} />
                          : trace.ok
                            ? <CheckCircle2 size={11} className="trace-ok" style={{ marginLeft: 'auto' }} />
                            : <XCircle size={11} className="trace-fail" style={{ marginLeft: 'auto' }} />}
                        {!running && <span className="trace-time">{trace.duration}ms</span>}
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

            {msg.approval && (
              <div className="approval-card">
                <div className="approval-head">
                  <ShieldAlert size={14} />
                  <b>{t('Approval required')}</b>
                  <span className="tiny dim">{t('These actions change data. Nothing has run yet.')}</span>
                </div>
                <div className="approval-list">
                  {msg.approval.calls.map((call) => (
                    <div className="approval-call" key={call.id}>
                      <div className="flex" style={{ gap: 6, alignItems: 'center' }}>
                        <code>{call.name}</code>
                        <span>{call.summary}</span>
                      </div>
                      <pre>{JSON.stringify(call.args, null, 2)}</pre>
                    </div>
                  ))}
                </div>
                <div className="approval-actions">
                  <button className="btn sm danger" onClick={() => onDecide(msg.id, msg.approval!.token, false, msg.approval!.calls)}>
                    <OctagonX size={12} /> {t('Reject')}
                  </button>
                  <button className="btn sm primary" onClick={() => onDecide(msg.id, msg.approval!.token, true, msg.approval!.calls)}>
                    <CheckCircle2 size={12} /> {t('Approve & run')}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
