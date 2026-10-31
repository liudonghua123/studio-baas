import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Play, Save, Trash2, Clock, Terminal, Settings2, Plus, X,
  ChevronRight, CheckCircle2, AlertCircle, Loader2, Boxes, KeyRound,
  Code2, Globe2, CalendarClock, GitBranch,
} from 'lucide-react';
import { api } from '../api';
import type { Execution, FunctionDef } from '../types';
import CodeEditor from '../components/CodeEditor';
import { Badge, Empty, Loading, Modal, useToast } from '../components/ui';
import { fmtDuration, statusTone, timeAgo, fmtDateTime } from '../lib/format';
import { useAuth } from '../lib/auth';
import DomainsTab from '../components/DomainsTab';

export default function FunctionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [fn, setFn] = useState<FunctionDef | null>(null);
  const [code, setCode] = useState('');
  const [dirty, setDirty] = useState(false);
  const [execs, setExecs] = useState<Execution[]>([]);
  const [result, setResult] = useState<Execution | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'response' | 'logs'>('logs');
  const [payloadOpen, setPayloadOpen] = useState(false);
  const [payload, setPayload] = useState('{\n  "email": "demo@aurora.io",\n  "customer": "Demo User",\n  "tier": "pro",\n  "items": [{ "price": 148, "qty": 1 }]\n}');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [envOpen, setEnvOpen] = useState(false);
  const [envRows, setEnvRows] = useState<{ k: string; v: string }[]>([]);
  const [meta, setMeta] = useState({ name: '', timeout: 15, schedule: '' });
  const [view, setView] = useState<'code' | 'domains'>('code');

  const load = async () => {
    try {
      const f = await api.function(id!);
      setFn(f);
      setCode(f.code);
      setDirty(false);
      setMeta({ name: f.name, timeout: f.timeout, schedule: f.schedule });
      setEnvRows(Object.entries(f.env).map(([k, v]) => ({ k, v })));
      setExecs((await api.executions(id!)).executions);
    } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, [id]);

  const save = async (silent = false) => {
    if (!fn) return;
    setSaving(true);
    try {
      const f = await api.updateFunction(fn.id, { code });
      setFn(f);
      setDirty(false);
      if (!silent) toast.push('Code saved');
    } catch (e: any) { toast.push(e.message, 'err'); throw e; }
    setSaving(false);
  };

  const run = async () => {
    if (!fn) return;
    setRunning(true);
    try {
      if (dirty) await save(true);
      let body: any = {};
      try { body = JSON.parse(payload || '{}'); } catch { throw new Error('Payload must be valid JSON'); }
      const r = await api.execute(fn.id, body);
      setResult(r);
      setTab(r.errors.length ? 'logs' : 'response');
      setExecs((await api.executions(fn.id)).executions);
      toast.push(r.status === 'completed' ? `Completed in ${fmtDuration(r.duration)}` : 'Execution failed', r.status === 'completed' ? 'ok' : 'err');
    } catch (e: any) { toast.push(e.message, 'err'); }
    setRunning(false);
  };

  const saveEnv = async () => {
    if (!fn) return;
    const env: Record<string, string> = {};
    envRows.forEach((r) => { if (r.k.trim()) env[r.k.trim()] = r.v; });
    try {
      const f = await api.updateFunction(fn.id, { env });
      setFn(f);
      setEnvOpen(false);
      toast.push('Environment variables saved');
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const saveSettings = async () => {
    if (!fn) return;
    try {
      const f = await api.updateFunction(fn.id, { name: meta.name, timeout: meta.timeout, schedule: meta.schedule });
      setFn(f);
      setSettingsOpen(false);
      toast.push('Function settings updated');
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const lines = useMemo(() => (result?.logs?.length ? result.logs : []), [result]);

  if (!fn) return <div className="page"><Loading rows={5} /></div>;

  return (
    <div className="page">
      <button className="back-btn" onClick={() => nav('/functions')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={13} /> All functions
      </button>

      <div className="detail-head">
        <div className="fn-title">
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(253,54,110,.12)', display: 'grid', placeItems: 'center', color: '#ff8aa6' }}>
            <Boxes size={17} />
          </div>
          <div>
            <h1>{fn.name}</h1>
            <div className="flex tiny dim" style={{ gap: 8, marginTop: 2 }}>
              <span className="mono">{fn.entrypoint}</span>
              <span>·</span>
              <span>{fn.runtime}</span>
              <span>·</span>
              <span>timeout {fn.timeout}s</span>
            </div>
          </div>
          <Badge tone={fn.enabled ? 'green' : 'amber'} dot>{fn.enabled ? 'enabled' : 'disabled'}</Badge>
          {dirty && <Badge tone="amber">unsaved</Badge>}
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => setSettingsOpen(true)}><Settings2 size={14} /> Settings</button>
          <button className="btn" onClick={() => save()} disabled={saving || !dirty || !can('functions.write')}><Save size={14} /> {saving ? 'Saving…' : 'Save code'}</button>
          <button className="btn primary" disabled={!can('functions.execute')} onClick={() => setPayloadOpen(true)}><Play size={14} /> Execute</button>
        </div>
      </div>

      <div className="fn-tabs">
        <button className={`tab ${view === 'code' ? 'active' : ''}`} onClick={() => setView('code')}>
          <Code2 size={13} /> Code
        </button>
        <button className={`tab ${view === 'domains' ? 'active' : ''}`} onClick={() => setView('domains')}>
          <Globe2 size={13} /> Domains
        </button>
      </div>

      {view === 'code' ? (<div className="fn-grid">
        <div className="stack">
          <div className="card">
            <div className="editor-head">
              <span className="file">{fn.entrypoint}</span>
              {dirty && <span className="dirty-dot" title="Unsaved changes" />}
              <span style={{ marginLeft: 'auto' }}>Node.js 22 · ESM</span>
            </div>
            <CodeEditor value={code} onChange={(v) => { setCode(v); setDirty(true); }} language="javascript" height={440} />
          </div>

          <div className="card">
            <div className="card-head" style={{ padding: '10px 14px' }}>
              <Terminal size={14} style={{ color: 'var(--dim)' }} />
              <span className="card-title">Execution output</span>
              {result && (
                <>
                  <Badge tone={statusTone(result.status)} dot>{result.status}</Badge>
                  <span className="tiny dim mono">{fmtDuration(result.duration)}</span>
                  {result.statusCode && <span className="tiny dim mono">HTTP {result.statusCode}</span>}
                </>
              )}
              <div className="flex" style={{ marginLeft: 'auto', gap: 2 }}>
                <button className={`tab ${tab === 'logs' ? 'active' : ''}`} style={{ padding: '4px 8px' }} onClick={() => setTab('logs')}>
                  Logs {result && <span className="count">{result.logs.length}</span>}
                </button>
                <button className={`tab ${tab === 'response' ? 'active' : ''}`} style={{ padding: '4px 8px' }} onClick={() => setTab('response')}>Response</button>
                {result && <button className="mini-btn" onClick={() => setResult(null)}><X size={12} /></button>}
              </div>
            </div>
            <div className="card-body" style={{ padding: 12 }}>
              {!result ? (
                <div className="console">
                  <div className="log-line dim">▸ Waiting for an execution…</div>
                  <div className="log-line dim">▸ Click "Execute" to run this function with a JSON payload.</div>
                </div>
              ) : tab === 'logs' ? (
                <div className="console">
                  {lines.length === 0 && <div className="log-line dim">No log output.</div>}
                  {lines.map((l, i) => (
                    <div className="log-line" key={i}>
                      <span className="ln">{i + 1}</span>
                      <span style={{ color: l.startsWith('ERROR') ? '#ff8aa6' : undefined, whiteSpace: 'pre-wrap' }}>{l}</span>
                    </div>
                  ))}
                  {result.errors.map((e, i) => (
                    <div className="log-line" key={'e' + i} style={{ color: '#ff8aa6' }}>
                      <span className="ln">!</span><span>{e}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <pre className="console mono" style={{ margin: 0, fontSize: 11.5, color: '#a5f3d0' }}>
                  {JSON.stringify(result.response, null, 2)}
                </pre>
              )}
            </div>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><div className="card-title">Overview</div></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Runtime</dt><dd>{fn.runtime}</dd>
                <dt>Entrypoint</dt><dd className="mono">{fn.entrypoint}</dd>
                <dt>Timeout</dt><dd>{fn.timeout}s</dd>
                <dt>Schedule</dt><dd className="mono">{fn.schedule || 'manual'}</dd>
                <dt>Execute access</dt><dd><Badge tone="blue">{fn.executeAccess}</Badge></dd>
                <dt>Executions</dt><dd>{execs.length}</dd>
                <dt>Created</dt><dd>{fmtDateTime(fn.createdAt)}</dd>
              </dl>
              <div className="divider" style={{ margin: '14px 0 12px' }} />
              <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                <span className="tiny dim">Environment</span>
                <button className="mini-btn" onClick={() => setEnvOpen(true)}><Plus size={12} /></button>
              </div>
              {Object.entries(fn.env).length ? Object.entries(fn.env).map(([k, v]) => (
                <div key={k} className="flex tiny" style={{ justifyContent: 'space-between', padding: '3px 0' }}>
                  <span className="mono" style={{ color: '#c4b5fd' }}>{k}</span>
                  <span className="mono dim">{v.startsWith('sk-') ? '••••••' : v}</span>
                </div>
              )) : <div className="tiny dim">No variables set</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">Payload</div>
              <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={() => setPayloadOpen(true)}>Edit</button>
            </div>
            <div className="card-body" style={{ padding: 12 }}>
              <pre className="mono" style={{ margin: 0, fontSize: 10.5, color: '#8b93a8', maxHeight: 130, overflow: 'auto' }}>
                {payload}
              </pre>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="card-title">Recent executions</div>
              <Link to="/functions" className="tiny dim" style={{ marginLeft: 'auto' }}>history</Link>
            </div>
            <div className="card-body tight">
              {execs.length === 0 ? <Empty title="No runs yet" /> : execs.slice(0, 6).map((e) => (
                <div key={e.id} className="flex pointer" style={{ padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,.04)', gap: 8 }}
                  onClick={() => { setResult(e); setTab(e.errors.length ? 'logs' : 'response'); }}>
                  {e.status === 'completed'
                    ? <CheckCircle2 size={13} style={{ color: 'var(--green)' }} />
                    : <AlertCircle size={13} style={{ color: '#ff8aa6' }} />}
                  <div style={{ minWidth: 0 }}>
                    <div className="tiny" style={{ color: 'var(--muted)' }}>{e.triggerType}</div>
                    <div className="tiny dim">{timeAgo(e.createdAt)}</div>
                  </div>
                  <span className="mono tiny dim" style={{ marginLeft: 'auto' }}>{fmtDuration(e.duration)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>) : (
        <DomainsTab functionId={fn.id} functionName={fn.name} />
      )}

      <Modal open={payloadOpen} onClose={() => setPayloadOpen(false)} title="Execute function"
        subtitle="Payload is passed to the function as req.body."
        footer={<>
          <button className="btn ghost" onClick={() => setPayloadOpen(false)}>Cancel</button>
          <button className="btn primary" onClick={() => { setPayloadOpen(false); run(); }} disabled={running}>
            {running ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {running ? 'Running…' : 'Run function'}
          </button>
        </>}
      >
        <textarea className="textarea mono" style={{ minHeight: 260, fontSize: 12 }} value={payload} onChange={(e) => setPayload(e.target.value)} />
        <div className="hint">Tip: the AI assistant can also execute this function with its own payload.</div>
      </Modal>

      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Function settings"
        footer={<>
          <button className="btn ghost" onClick={() => setSettingsOpen(false)}>Cancel</button>
          <button className="btn primary" onClick={saveSettings}>Save</button>
        </>}
      >
        <div className="field">
          <label className="label">Name</label>
          <input className="input" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
        </div>
        <div className="input-row">
          <div className="field">
            <label className="label">Timeout (seconds)</label>
            <input className="input" type="number" value={meta.timeout} onChange={(e) => setMeta({ ...meta, timeout: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label className="label">Schedule (cron)</label>
            <input className="input mono" placeholder="*/15 * * * *" value={meta.schedule} onChange={(e) => setMeta({ ...meta, schedule: e.target.value })} />
          </div>
        </div>
        <button className="btn danger sm" onClick={async () => {
          if (!confirm(`Delete function "${fn.name}"?`)) return;
          await api.deleteFunction(fn.id);
          toast.push('Function deleted');
          nav('/functions');
        }}><Trash2 size={12} /> Delete function</button>
      </Modal>

      <Modal open={envOpen} onClose={() => setEnvOpen(false)} title="Environment variables"
        subtitle="Available to your code through the env argument."
        footer={<>
          <button className="btn ghost" onClick={() => setEnvOpen(false)}>Cancel</button>
          <button className="btn primary" onClick={saveEnv}>Save variables</button>
        </>}
      >
        {envRows.map((r, i) => (
          <div className="flex" key={i} style={{ marginBottom: 8 }}>
            <input className="input mono" placeholder="KEY" style={{ flex: 1 }} value={r.k}
              onChange={(e) => setEnvRows((rows) => rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
            <input className="input mono" placeholder="value" style={{ flex: 1.4 }} value={r.v}
              onChange={(e) => setEnvRows((rows) => rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
            <button className="mini-btn danger" onClick={() => setEnvRows((rows) => rows.filter((_, j) => j !== i))}><X size={12} /></button>
          </div>
        ))}
        <button className="btn sm ghost" onClick={() => setEnvRows((r) => [...r, { k: '', v: '' }])}><Plus size={12} /> Add variable</button>
        <div className="hint"><KeyRound size={10} style={{ verticalAlign: -1 }} /> Values are stored encrypted at rest in the studio database.</div>
      </Modal>
    </div>
  );
}
