import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Boxes, Plus, Zap, Clock, ChevronRight, Terminal, Trash2, RefreshCw, Code2 } from 'lucide-react';
import { api } from '../api';
import type { Execution, FunctionDef, RuntimeInfo } from '../types';
import { Badge, Empty, Loading, Modal, useToast } from '../components/ui';
import { statusTone, timeAgo, fmtDuration } from '../lib/format';
import { statusLabel } from '../lib/status';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';

/** Trigger values come from the API; only the label is translated. */
const TRIGGER_LABEL: Record<string, string> = { manual: 'Manual', schedule: 'Schedule', http: 'HTTP', event: 'Event' };
const triggerLabel = (v: string) => TRIGGER_LABEL[v] ?? v;

export default function Functions() {
  const [fns, setFns] = useState<FunctionDef[]>([]);
  const [execs, setExecs] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', runtime: 'node-22', template: 'hello' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { can } = useAuth();
  const t = useT();
  const nav = useNavigate();

  const load = async () => {
    try {
      const [list, execs, rts] = await Promise.all([
        api.functions(), api.allExecutions(), api.runtimes(),
      ]);
      setFns(list.functions);
      setExecs(execs.executions);
      setRuntimes(rts.runtimes);
      // 默认选中第一个可用运行时；本机只有 Python 时也不要用 JS 模板建函数
      const available = rts.runtimes.filter((r) => r.availability.available);
      setForm((f) => (available.some((r) => r.id === f.runtime) ? f : { ...f, runtime: available[0]?.id || f.runtime }));
    } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const selected = runtimes.find((r) => r.id === form.runtime);
  const template = selected?.templates.find((tpl) => tpl.id === form.template) || selected?.templates[0];

  const create = async () => {
    if (!form.name || !selected || !template) return;
    setBusy(true);
    try {
      const f = await api.createFunction({ name: form.name, runtime: selected.id, code: template.code, entrypoint: selected.entrypoint });
      toast.push(t('Function created'));
      setOpen(false);
      nav(`/functions/${f.id}`);
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Boxes size={11} /> {t('Functions')}</div>
          <h1>{t('Serverless functions')}</h1>
          <p>{t('Write, edit and execute Node.js or Python code directly in the browser — no deploy pipeline required.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={load}><RefreshCw size={14} /> {t('Refresh')}</button>
          <button className="btn primary" disabled={!can('functions.write')} onClick={() => setOpen(true)}><Plus size={14} /> {t('Create function')}</button>
        </div>
      </div>

      {loading ? <div className="card"><Loading rows={3} /></div> : fns.length === 0 ? (
        <div className="card"><Empty title={t('No functions yet')} hint={t('Create a function to run backend logic on demand or on a schedule.')} icon={<Boxes size={26} />} /></div>
      ) : (
        <div className="card">
          <div className="card-body tight">
            <table className="table">
              <thead>
                <tr><th>{t('Function')}</th><th>{t('Runtime')}</th><th>{t('Trigger')}</th><th className="right">{t('Executions')}</th><th>{t('Last run')}</th><th /></tr>
              </thead>
              <tbody>
                {fns.map((f) => (
                  <tr key={f.id} className="pointer" onClick={() => nav(`/functions/${f.id}`)}>
                    <td>
                      <div className="flex" style={{ gap: 10 }}>
                        <div style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(253,54,110,.12)', display: 'grid', placeItems: 'center', color: 'var(--pink-text)' }}>
                          <Code2 size={14} />
                        </div>
                        <div>
                          <div className="cell-main">{f.name}</div>
                          <div className="cell-sub mono">{f.entrypoint}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {(() => {
                        const rt = runtimes.find((r) => r.id === f.runtime);
                        return (
                          <span className="runtime-chip" title={rt?.protocol || f.runtime}>
                            <i style={{ background: rt?.color || '#8b5cf6' }} />
                            {rt?.label || f.runtime}
                          </span>
                        );
                      })()}
                    </td>
                    <td>
                      {f.schedule ? <span className="flex tiny dim" style={{ gap: 5 }}><Clock size={11} /> {f.schedule}</span> : <span className="tiny dim">{t('Manual')}</span>}
                    </td>
                    <td className="right mono">{f.executions}</td>
                    <td>
                      {f.lastExecution ? (
                        <div className="flex" style={{ gap: 7 }}>
                          <Badge tone={statusTone(f.lastExecution.status)} dot>{t(statusLabel(f.lastExecution.status))}</Badge>
                          <span className="tiny dim">{timeAgo(f.lastExecution.createdAt)}</span>
                        </div>
                      ) : <span className="tiny dim">{t('never')}</span>}
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
              <div className="card-title">{t('Recent executions')}</div>
              <div className="card-sub">{t('Synchronous and scheduled invocations')}</div>
            </div>
            <span className="badge" style={{ marginLeft: 'auto' }}>{execs.length}</span>
          </div>
          <div className="card-body tight">
            <table className="table">
              <thead><tr><th>{t('Function')}</th><th>{t('Status')}</th><th>{t('Trigger')}</th><th className="right">{t('Duration')}</th><th className="right">{t('When')}</th></tr></thead>
              <tbody>
                {execs.slice(0, 6).map((e) => (
                  <tr key={e.id} className="pointer" onClick={() => nav(`/functions/${e.functionId}`)}>
                    <td className="cell-main">{e.functionName}</td>
                    <td><Badge tone={statusTone(e.status)} dot>{t(statusLabel(e.status))}</Badge></td>
                    <td className="dim tiny">{t(triggerLabel(e.triggerType))}</td>
                    <td className="right mono dim">{fmtDuration(e.duration)}</td>
                    <td className="right dim tiny">{timeAgo(e.createdAt)}</td>
                  </tr>
                ))}
                {execs.length === 0 && <tr><td colSpan={5} className="dim" style={{ textAlign: 'center', padding: 18 }}>{t('No executions yet')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">{t('Invocations by function')}</div></div>
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
                <div className="tiny dim">{t('Success rate')}</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{execs.length ? Math.round((execs.filter((e) => e.status === 'completed').length / execs.length) * 100) : 100}%</div>
              </div>
              <div className="right">
                <div className="tiny dim">{t('Failed')}</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--pink-text)' }}>{execs.filter((e) => e.status === 'failed').length}</div>
              </div>
              <div className="right">
                <div className="tiny dim">{t('Avg duration')}</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{execs.length ? Math.round(execs.reduce((a, e) => a + e.duration, 0) / execs.length) : 0}ms</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={t('Create function')}
        subtitle={t('Pick a runtime — the starter template is written in that language.')}
        footer={<>
          <button className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!form.name || busy || !selected?.availability.available} onClick={create}>{busy ? t('Creating…') : t('Create function')}</button>
        </>}
      >
        <div className="field">
          <label className="label">{t('Name')} <span className="req">*</span></label>
          <input className="input" autoFocus placeholder={t('e.g. Stripe webhook')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">{t('Runtime')}</label>
          <div className="runtime-grid">
            {runtimes.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`runtime-option ${form.runtime === r.id ? 'active' : ''}`}
                disabled={!r.availability.available}
                title={r.availability.reason || ''}
                onClick={() => setForm({ ...form, runtime: r.id, template: r.templates[0]?.id || 'hello' })}
              >
                <span className="runtime-dot" style={{ background: r.color }} />
                <span>
                  <b>{r.label}</b>
                  <em>
                    {r.availability.available
                      ? `${r.availability.version || r.version} · ${r.protocol}`
                      : t('not installed on this host')}
                  </em>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="label">{t('Template')}</label>
          <select className="select" value={template?.id || ''} onChange={(e) => setForm({ ...form, template: e.target.value })}>
            {(selected?.templates || []).map((tpl) => <option key={tpl.id} value={tpl.id}>{t(tpl.label)}</option>)}
          </select>
        </div>
        <pre className="mono" style={{ background: 'var(--code-bg)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, fontSize: 10.5, overflowX: 'auto', color: 'var(--code-accent)', margin: 0 }}>
          {template?.code || ''}
        </pre>
      </Modal>
    </div>
  );
}
