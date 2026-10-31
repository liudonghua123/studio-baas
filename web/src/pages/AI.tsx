import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, Send, Trash2, ChevronDown, ChevronRight, Wrench, CheckCircle2, XCircle,
  Database, Boxes, Globe2, Users, Send as SendIcon, Terminal, BarChart3, Loader2, Zap, Bot,
} from 'lucide-react';
import { api } from '../api';
import type { AiStatus, ToolTrace } from '../types';
import { Badge, useToast } from '../components/ui';
import { renderMarkdown } from '../lib/markdown';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  traces?: ToolTrace[];
  animate?: boolean;
  pending?: boolean;
}

const SUGGESTIONS = [
  '给我一个项目概览，说明文档、用户和函数的情况',
  '列出所有集合以及每个集合的文档数量',
  '执行 Store analytics 函数并解释结果',
  '显示最近的错误日志并给出修复建议',
];

const CAPABILITIES = [
  { icon: Database, label: 'Databases', text: '建集合、加字段、增删改查文档' },
  { icon: Boxes, label: 'Functions', text: '读改代码、执行并读取日志' },
  { icon: Globe2, label: 'Sites', text: '改 HTML/CSS/JS 并部署上线' },
  { icon: Users, label: 'Auth', text: '创建用户、查看状态与标签' },
  { icon: SendIcon, label: 'Messaging', text: '发送邮件 / SMS / Push' },
  { icon: BarChart3, label: 'Insights', text: '指标、执行记录与请求日志' },
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
        ? { ...m, content: `请求失败：${e.message}`, pending: false }
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
            <h1>DeepSeek Operator</h1>
            <p>{status ? `${status.provider} · ${status.model}` : 'Connecting…'} · {toolCount} tools available</p>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={status?.mode === 'deepseek' ? 'green' : 'amber'} dot>
              {status?.mode === 'deepseek' ? 'Live model' : 'Demo mode'}
            </Badge>
            {messages.length > 0 && (
              <button className="btn sm ghost" onClick={() => setMessages([])}><Trash2 size={12} /> Clear</button>
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
                    <div style={{ fontSize: 18, fontWeight: 620, letterSpacing: '-0.02em' }}>What should we build today?</div>
                    <div className="tiny dim">I can operate every service in this project through tool calls.</div>
                  </div>
                </div>

                {status?.mode === 'demo' && (
                  <div className="card" style={{ padding: '10px 14px', marginBottom: 16, borderColor: 'rgba(251,191,36,.25)', background: 'rgba(251,191,36,.045)' }}>
                    <div className="flex tiny" style={{ gap: 8, color: '#fcd34d' }}>
                      <Zap size={13} />
                      <span>
                        No <span className="mono">DEEPSEEK_API_KEY</span> detected — running a local rule engine that still performs real tool calls.
                        Add a key in <b>Settings → AI</b> for full autonomous multi-step planning.
                      </span>
                    </div>
                  </div>
                )}

                <div className="quick-grid" style={{ marginBottom: 18 }}>
                  {CAPABILITIES.map((c) => (
                    <div key={c.label} className="quick-card">
                      <div className="qi"><c.icon size={14} /></div>
                      <div><b>{c.label}</b><small>{c.text}</small></div>
                    </div>
                  ))}
                </div>

                <div className="tiny dim" style={{ marginBottom: 8 }}>Try one of these</div>
                <div className="chips">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
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
                {['列出所有集合', '执行 Order webhook', '最近的错误日志', '项目指标概览'].map((s) => (
                  <button key={s} className="chip" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          <div className="composer">
            <textarea
              ref={boxRef}
              placeholder="Ask DeepSeek to query data, run functions, edit sites… (⌘↵ to send)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); send(); }
              }}
              rows={2}
            />
            <div className="composer-bar">
              <span className="hint flex" style={{ gap: 5 }}><Bot size={11} /> tools: {toolCount} · {status?.mode === 'deepseek' ? 'deepseek tool-calling' : 'local rule engine'}</span>
              <button className="send-btn" onClick={() => send()} disabled={!input.trim() || busy}>
                {busy ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>

      <aside className="ai-side">
        <h3>Connected tools</h3>
        {!status ? <div className="skeleton" style={{ height: 120 }} /> : (
          <div style={{ maxHeight: 340, overflowY: 'auto', marginBottom: 20 }}>
            {status.tools.map((t) => (
              <div className="tool-pill" key={t.name} title={t.description}>
                <Wrench size={10} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
              </div>
            ))}
          </div>
        )}
        <h3>Model</h3>
        <div className="card" style={{ padding: 12, background: 'rgba(255,255,255,.02)' }}>
          <div className="flex" style={{ gap: 7, marginBottom: 7 }}>
            <span className="status-dot" style={{ background: status?.mode === 'deepseek' ? 'var(--green)' : 'var(--amber)' }} />
            <b style={{ fontSize: 12 }}>{status?.model || '—'}</b>
          </div>
          <div className="tiny dim" style={{ lineHeight: 1.6 }}>
            {status?.mode === 'deepseek'
              ? 'OpenAI-compatible tool calling, up to 6 planning steps per turn.'
              : 'Demo mode: deterministic intents mapped to real tools. Add a key in Settings.'}
          </div>
        </div>
        <h3 style={{ marginTop: 20 }}>How it works</h3>
        <ol className="tiny dim" style={{ paddingLeft: 16, lineHeight: 1.8, margin: 0 }}>
          <li>Your message goes to the harness with 26 tool schemas.</li>
          <li>DeepSeek picks tools; the server executes them against the live project.</li>
          <li>Results feed back into the model for the final answer.</li>
          <li>Every call is traced below the reply — audit exactly what changed.</li>
        </ol>
        <div className="divider" />
        <div className="tiny dim" style={{ lineHeight: 1.6 }}>
          <b style={{ color: 'var(--muted)' }}>With a key:</b> “把 aurora-storefront 的 hero 标题改掉并部署” — the agent edits index.html and redeploys.
        </div>
      </aside>
    </div>
  );
}

function Message({ msg }: { msg: Msg }) {
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
                  <Wrench size={10} /> {msg.traces.length} tool call{msg.traces.length > 1 ? 's' : ''} executed
                </div>
                {msg.traces.map((t) => {
                  const Icon = toolIcon(t.name);
                  const open = openTraces[t.id];
                  return (
                    <div className="trace-card" key={t.id}>
                      <div className="trace-head" onClick={() => setOpenTraces((s) => ({ ...s, [t.id]: !s[t.id] }))}>
                        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="trace-icon"><Icon size={10} /></span>
                        <span className="trace-name">{t.name}</span>
                        <span style={{ color: 'var(--dim)', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.summary}</span>
                        {t.ok ? <CheckCircle2 size={11} className="trace-ok" style={{ marginLeft: 'auto' }} /> : <XCircle size={11} className="trace-fail" style={{ marginLeft: 'auto' }} />}
                        <span className="trace-time">{t.duration}ms</span>
                      </div>
                      {open && (
                        <div className="trace-body">
                          <div style={{ color: '#8b93a8' }}>→ args</div>
                          {JSON.stringify(t.args, null, 2)}
                          <div style={{ color: '#8b93a8', marginTop: 8 }}>← result</div>
                          {JSON.stringify(t.result, null, 2)}
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
