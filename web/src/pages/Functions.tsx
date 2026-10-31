import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Boxes, Plus, Zap, Clock, ChevronRight, Terminal, Trash2, RefreshCw, Code2 } from 'lucide-react';
import { api } from '../api';
import type { Execution, FunctionDef } from '../types';
import { Badge, Empty, Loading, Modal, useToast } from '../components/ui';
import { statusTone, timeAgo, fmtDuration } from '../lib/format';

const TEMPLATES: Record<string, string> = {
  'Hello world': `export default async ({ req, res, log }) => {
  log('Hello from the edge');
  return res.json({ ok: true, message: 'Hello world' });
};`,
  'REST proxy': `export default async ({ req, res, log, databases }) => {
  const products = databases.listDocuments('products', { limit: 5 });
  return res.json({ count: products.total, items: products.documents });
};`,
  'Scheduled job': `export default async ({ res, log, databases }) => {
  log('Running scheduled aggregation at', new Date().toISOString());
  const orders = databases.listDocuments('orders', { limit: 100 });
  const revenue = orders.documents.reduce((s, o) => s + Number(o.data.total || 0), 0);
  return res.json({ revenue, orders: orders.total });
};`,
};

export default function Functions() {
  const [fns, setFns] = useState<FunctionDef[]>([]);
  const [execs, setExecs] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', template: 'Hello world' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const nav = useNavigate();

  const load = async () => {
    try {
      setFns((await api.functions()).functions);
      setExecs((await api.allExecutions()).executions);
    } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!form.name) return;
    setBusy(true);
    try {
      const f = await api.createFunction({ name: form.name, code: TEMPLATES[form.template] });
      toast.push('Function created');
      setOpen(false);
      nav(`/functions/${f.id}`);
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Boxes size={11} /> Functions</div>
          <h1>Serverless functions</h1>
          <p>Write, edit and execute Node.js code directly in the browser — no deploy pipeline required.</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={load}><RefreshCw size={14} /> Refresh</button>
          <button className="btn primary" onClick={() => setOpen(true)}><Plus size={14} /> Create function</button>
        </div>
      </div>

      {loading ? <div className="card"><Loading rows={3} /></div> : fns.length === 0 ? (
        <div className="card"><Empty title="No functions yet" hint="Create a function to run backend logic on demand or on a schedule." icon={<Boxes size={26} />} /></div>
      ) : (
        <div className="card">
          <div className="card-body tight">
            <table className="table">
              <thead>
                <tr><th>Function</th><th>Runtime</th><th>Trigger</th><th className="right">Executions</th><th>Last run</th><th /></tr>
              </thead>
              <tbody>
                {fns.map((f) => (
                  <tr key={f.id} className="pointer" onClick={() => nav(`/functions/${f.id}`)}>
                    <td>
                      <div className="flex" style={{ gap: 10 }}>
                        <div style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(253,54,110,.12)', display: 'grid', placeItems: 'center', color: '#ff8aa6' }}>
                          <Code2 size={14} />
                        </div>
                        <div>
                          <div className="cell-main">{f.name}</div>
                          <div className="cell-sub mono">{f.entrypoint}</div>
                        </div>
                      </div>
                    </td>
                    <td><Badge tone="violet">{f.runtime}</Badge></td>
                    <td>
                      {f.schedule ? <span className="flex tiny dim" style={{ gap: 5 }}><Clock size={11} /> {f.schedule}</span> : <span className="tiny dim">Manual</span>}
                    </td>
                    <td className="right mono">{f.executions}</td>
                    <td>
                      {f.lastExecution ? (
                        <div className="flex" style={{ gap: 7 }}>
                          <Badge tone={statusTone(f.lastExecution.status)} dot>{f.lastExecution.status}</Badge>
                          <span className="tiny dim">{timeAgo(f.lastExecution.createdAt)}</span>
                        </div>
                      ) : <span className="tiny dim">never</span>}
                    </td>
                    <td className="right"><ChevronRight size={14} style={{ color: 'var(--dim)' }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="split" style={{ marginTop: 14, alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Recent executions</div>
              <div className="card-sub">Synchronous and scheduled invocations</div>
            </div>
            <span className="badge" style={{ marginLeft: 'auto' }}>{execs.length}</span>
          </div>
          <div className="card-body tight">
            <table className="table">
              <thead><tr><th>Function</th><th>Status</th><th>Trigger</th><th className="right">Duration</th><th className="right">When</th></tr></thead>
              <tbody>
                {execs.slice(0, 6).map((e) => (
                  <tr key={e.id} className="pointer" onClick={() => nav(`/functions/${e.functionId}`)}>
                    <td className="cell-main">{e.functionName}</td>
                    <td><Badge tone={statusTone(e.status)} dot>{e.status}</Badge></td>
                    <td className="dim tiny">{e.triggerType}</td>
                    <td className="right mono dim">{fmtDuration(e.duration)}</td>
                    <td className="right dim tiny">{timeAgo(e.createdAt)}</td>
                  </tr>
                ))}
                {execs.length === 0 && <tr><td colSpan={5} className="dim" style={{ textAlign: 'center', padding: 18 }}>No executions yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Invocations by function</div></div>
          <div className="card-body">
            {fns.map((f) => {
              const max = Math.max(...fns.map((x) => x.executions || 0), 1);
              return (
                <div className="bar-row" key={f.id}>
                  <div className="bar-top">
                    <span style={{ color: 'var(--muted)' }}>{f.name}</span>
                    <span className="mono dim">{f.executions}</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${((f.executions || 0) / max) * 100}%`, background: 'linear-gradient(90deg,#fd366e,#8b5cf6)' }} />
                  </div>
                </div>
              );
            })}
            <div className="divider" />
            <div className="flex" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="tiny dim">Success rate</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{execs.length ? Math.round((execs.filter((e) => e.status === 'completed').length / execs.length) * 100) : 100}%</div>
              </div>
              <div className="right">
                <div className="tiny dim">Failed</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: '#ff8aa6' }}>{execs.filter((e) => e.status === 'failed').length}</div>
              </div>
              <div className="right">
                <div className="tiny dim">Avg duration</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{execs.length ? Math.round(execs.reduce((a, e) => a + e.duration, 0) / execs.length) : 0}ms</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Create function"
        subtitle="Starts with an editable Node 22 template."
        footer={<>
          <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn primary" disabled={!form.name || busy} onClick={create}>{busy ? 'Creating…' : 'Create function'}</button>
        </>}
      >
        <div className="field">
          <label className="label">Name <span className="req">*</span></label>
          <input className="input" autoFocus placeholder="e.g. Stripe webhook" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Template</label>
          <select className="select" value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
            {Object.keys(TEMPLATES).map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <pre className="mono" style={{ background: '#08080c', border: '1px solid var(--line)', borderRadius: 8, padding: 12, fontSize: 10.5, overflowX: 'auto', color: '#a5b4fc', margin: 0 }}>
          {TEMPLATES[form.template]}
        </pre>
      </Modal>
    </div>
  );
}
