import { useEffect, useMemo, useState } from 'react';
import { ScrollText, RefreshCw, Filter, Search } from 'lucide-react';
import { api } from '../api';
import type { LogEntry } from '../types';
import { Badge, Empty, Loading, useToast } from '../components/ui';
import { fmtDateTime } from '../lib/format';
import { useT } from '../lib/locale';

/** Service values stay English in the payload; display names come from the dictionary. */
const SERVICE_LABELS: Record<string, string> = {
  all: 'All',
  databases: 'Databases',
  storage: 'Storage',
  functions: 'Functions',
  sites: 'Sites',
  messaging: 'Messaging',
  account: 'Auth',
  auth: 'Auth',
  users: 'Auth',
  core: 'Core',
};

export default function Logs() {
  const toast = useToast();
  const t = useT();
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
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [auto]);

  const services = useMemo(() => ['all', ...Array.from(new Set(logs.map((l) => l.service)))], [logs]);
  const filtered = logs.filter((l) => (service === 'all' || l.service === service) && (!q || l.path.includes(q) || String(l.status).includes(q)));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><ScrollText size={11} /> {t('Observability')}</div>
          <h1>{t('Request logs')}</h1>
          <p>{t('Every API call across databases, storage, functions, sites and messaging.')}</p>
        </div>
        <div className="page-actions">
          <label className="btn ghost" style={{ cursor: 'pointer' }}>
            <span className={`status-dot`} style={{ background: auto ? 'var(--green)' : 'var(--dim)' }} />
            {auto ? t('Live tail on') : t('Live tail off')}
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} style={{ display: 'none' }} />
          </label>
          <button className="btn ghost" onClick={load}><RefreshCw size={14} /> {t('Refresh')}</button>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="searchbox">
            <Search size={13} />
            <input className="input" placeholder={t('Filter path or status…')} value={q} onChange={(e) => setQ(e.target.value)}
              style={{ border: 0, background: 'transparent', height: 28, padding: 0, fontSize: 12 }} />
          </div>
          <div className="flex" style={{ gap: 4, marginLeft: 8 }}>
            <Filter size={12} style={{ color: 'var(--dim)' }} />
            {services.map((s) => (
              <button key={s} className={`chip`} style={service === s ? { borderColor: 'rgba(253,54,110,.45)', color: 'var(--text)' } : {}} onClick={() => setService(s)}>{SERVICE_LABELS[s] ? t(SERVICE_LABELS[s]) : s}</button>
            ))}
          </div>
          <div className="toolbar-spacer" />
          <span className="tiny dim">{t('{n} entries', { n: filtered.length })}</span>
        </div>
        <div className="card-body tight" style={{ maxHeight: 'calc(100vh - 260px)', overflowY: 'auto' }}>
          {loading ? <Loading rows={6} /> : filtered.length === 0 ? <Empty title={t('No logs')} /> : (
            <table className="table">
              <thead><tr><th style={{ width: 56 }}>{t('Method')}</th><th>{t('Path')}</th><th style={{ width: 80 }}>{t('Status')}</th><th style={{ width: 80 }} className="right">{t('Duration')}</th><th style={{ width: 100 }}>{t('Service')}</th><th style={{ width: 110 }}>IP</th><th style={{ width: 130 }}>{t('Time')}</th></tr></thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id}>
                    <td><span className={`method ${l.method.toLowerCase()}`}>{l.method}</span></td>
                    <td className="mono" style={{ fontSize: 11 }}>{l.path}</td>
                    <td><span className={`status-code ${l.status < 400 ? 'ok' : 'err'}`}>{l.status}</span></td>
                    <td className="right mono dim">{Math.round(l.duration)}ms</td>
                    <td><Badge>{SERVICE_LABELS[l.service] ? t(SERVICE_LABELS[l.service]) : l.service}</Badge></td>
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
