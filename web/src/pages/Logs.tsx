import { useEffect, useMemo, useState } from 'react';
import { ScrollText, RefreshCw, Filter, Search } from 'lucide-react';
import { api } from '../api';
import type { LogEntry } from '../types';
import { Badge, Empty, Loading, useToast } from '../components/ui';
import { fmtDateTime } from '../lib/format';

export default function Logs() {
  const toast = useToast();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [service, setService] = useState('all');
  const [q, setQ] = useState('');
  const [auto, setAuto] = useState(true);

  const load = async () => {
    try { setLogs((await api.logs(150)).logs); } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [auto]);

  const services = useMemo(() => ['all', ...Array.from(new Set(logs.map((l) => l.service)))], [logs]);
  const filtered = logs.filter((l) => (service === 'all' || l.service === service) && (!q || l.path.includes(q) || String(l.status).includes(q)));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><ScrollText size={11} /> Observability</div>
          <h1>Request logs</h1>
          <p>Every API call across databases, storage, functions, sites and messaging.</p>
        </div>
        <div className="page-actions">
          <label className="btn ghost" style={{ cursor: 'pointer' }}>
            <span className={`status-dot`} style={{ background: auto ? 'var(--green)' : 'var(--dim)' }} />
            {auto ? 'Live tail on' : 'Live tail off'}
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} style={{ display: 'none' }} />
          </label>
          <button className="btn ghost" onClick={load}><RefreshCw size={14} /> Refresh</button>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="searchbox">
            <Search size={13} />
            <input className="input" placeholder="Filter path or status…" value={q} onChange={(e) => setQ(e.target.value)}
              style={{ border: 0, background: 'transparent', height: 28, padding: 0, fontSize: 12 }} />
          </div>
          <div className="flex" style={{ gap: 4, marginLeft: 8 }}>
            <Filter size={12} style={{ color: 'var(--dim)' }} />
            {services.map((s) => (
              <button key={s} className={`chip`} style={service === s ? { borderColor: 'rgba(253,54,110,.45)', color: 'var(--text)' } : {}} onClick={() => setService(s)}>{s}</button>
            ))}
          </div>
          <div className="toolbar-spacer" />
          <span className="tiny dim">{filtered.length} entries</span>
        </div>
        <div className="card-body tight" style={{ maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
          {loading ? <Loading rows={6} /> : filtered.length === 0 ? <Empty title="No logs" /> : (
            <table className="table">
              <thead><tr><th style={{ width: 56 }}>Method</th><th>Path</th><th style={{ width: 80 }}>Status</th><th style={{ width: 80 }} className="right">Duration</th><th style={{ width: 100 }}>Service</th><th style={{ width: 110 }}>IP</th><th style={{ width: 130 }}>Time</th></tr></thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id}>
                    <td><span className={`method ${l.method.toLowerCase()}`}>{l.method}</span></td>
                    <td className="mono" style={{ fontSize: 11 }}>{l.path}</td>
                    <td><span className={`status-code ${l.status < 400 ? 'ok' : 'err'}`}>{l.status}</span></td>
                    <td className="right mono dim">{Math.round(l.duration)}ms</td>
                    <td><Badge>{l.service}</Badge></td>
                    <td className="mono dim tiny">{l.ip}</td>
                    <td className="dim tiny">{fmtDateTime(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
