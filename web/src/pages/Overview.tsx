import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Database, FolderOpen, Boxes, Users, ArrowUpRight, ArrowDownRight, RefreshCw, Plus,
  Activity, Zap, Globe2, Send, CheckCircle2, AlertCircle, Terminal,
} from 'lucide-react';
import { api } from '../api';
import type { Metrics } from '../types';
import { AreaChart, Sparkline } from '../components/Charts';
import { Badge, Loading, useToast } from '../components/ui';
import { fmtBytes, fmtNum, statusTone, timeAgo, fmtDuration } from '../lib/format';
import { useT } from '../lib/locale';

export default function Overview() {
  const [m, setM] = useState<Metrics | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();
  const t = useT();
  const nav = useNavigate();

  const load = async (spin = false) => {
    if (spin) setRefreshing(true);
    try { setM(await api.metrics()); } catch (e: any) { toast.push(e.message, 'err'); }
    setRefreshing(false);
  };
  useEffect(() => { load(); const t = setInterval(() => load(), 20000); return () => clearInterval(t); }, []);

  if (!m) return <div className="page"><Loading rows={6} /></div>;

  const reqSeries = m.trend.map((t) => t.requests);
  const errSeries = m.trend.map((t) => t.errors);
  const delta = reqSeries.length > 7
    ? Math.round(((reqSeries.slice(-7).reduce((a, b) => a + b, 0) / 7) / Math.max(reqSeries.slice(0, 7).reduce((a, b) => a + b, 0) / 7, 1) - 1) * 100)
    : 0;
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const stats: { label: string; value: string; foot: string; params: Record<string, string | number>; raw?: boolean; icon: typeof Database; spark: number[]; color: string; to: string }[] = [
    { label: 'Documents', value: fmtNum(m.documents), foot: '{n} collections', params: { n: m.collections }, icon: Database, spark: reqSeries, color: 'var(--violet)', to: '/databases' },
    { label: 'Files stored', value: fmtNum(m.files), foot: fmtBytes(m.storageBytes), params: {}, raw: true, icon: FolderOpen, spark: reqSeries.map((v) => v * 0.4 + 20), color: '#22d3ee', to: '/storage' },
    { label: 'Function runs · 24h', value: fmtNum(m.executions24h), foot: '{n} functions deployed', params: { n: m.functions }, icon: Boxes, spark: reqSeries.map((v) => v * 0.2 + 6), color: '#fd366e', to: '/functions' },
    { label: 'End users', value: fmtNum(m.users), foot: '{n} messages sent', params: { n: m.messages }, icon: Users, spark: reqSeries.map((v) => v * 0.1 + 4), color: '#34d399', to: '/auth' },
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><span className="status-dot" /> {t('Project healthy · {region}', { region: m.project?.region?.toUpperCase() ?? '' })}</div>
          <h1>{t('{greeting}, Alex', { greeting: t(greet) })}</h1>
          <p>
            {t('{project} is running on the Studio BaaS edge.', { project: m.project?.name ?? '' })}{' '}
            {m.failedExecutions === 1
              ? t('{requests} API requests in the last 24 hours, {failed} failed execution.', { requests: fmtNum(m.requests24h), failed: m.failedExecutions })
              : t('{requests} API requests in the last 24 hours, {failed} failed executions.', { requests: fmtNum(m.requests24h), failed: m.failedExecutions })}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => load(true)} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} /> {t('Refresh')}
          </button>
          <button className="btn primary" onClick={() => nav('/databases')}><Plus size={14} /> {t('New collection')}</button>
        </div>
      </div>

      <div className="grid-stats">
        {stats.map((s) => (
          <Link to={s.to} key={s.label} className="stat">
            <div className="stat-label"><s.icon size={13} /> {t(s.label)}</div>
            <div className="stat-value">{s.value}</div>
            <div className="stat-foot">{s.raw ? s.foot : t(s.foot, s.params)}</div>
            <div className="stat-spark"><Sparkline data={s.spark} color={s.color} width={120} height={44} /></div>
          </Link>
        ))}
      </div>

      <div className="split" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('API traffic')}</div>
              <div className="card-sub">{t('Requests and errors · last 14 days')}</div>
            </div>
            <div className="flex" style={{ marginLeft: 'auto', gap: 14, fontSize: 11, color: 'var(--dim)' }}>
              <span className="flex" style={{ gap: 6 }}><i style={{ width: 14, height: 2, background: 'linear-gradient(90deg,#8b5cf6,#fd366e)', borderRadius: 2 }} /> {t('Requests')}</span>
              <span className="flex" style={{ gap: 6 }}><i style={{ width: 14, height: 2, background: '#fd366e', opacity: 0.5, borderRadius: 2 }} /> {t('Errors')}</span>
            </div>
          </div>
          <div className="card-body" style={{ paddingBottom: 8 }}>
            <div className="flex" style={{ alignItems: 'flex-end', gap: 12, marginBottom: 6 }}>
              <div style={{ fontSize: 28, fontWeight: 620, letterSpacing: '-0.03em', lineHeight: 1 }}>{fmtNum(m.requests24h)}</div>
              <div className={`delta ${delta < 0 ? 'down' : ''}`} style={{ fontSize: 12, paddingBottom: 3 }}>
                {delta >= 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />} {Math.abs(delta)}%
              </div>
              <div className="dim tiny" style={{ paddingBottom: 3 }}>{t('vs. previous week')}</div>
            </div>
            <AreaChart data={m.trend} height={228} />
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('Service health')}</div>
              <div className="card-sub">{t('All regions · realtime')}</div>
            </div>
            <Badge tone="green" dot>{t('Operational')}</Badge>
          </div>
          <div className="card-body" style={{ paddingTop: 10, paddingBottom: 12 }}>
            {m.services.map((s) => (
              <div className="health-row" key={s.name}>
                <span className="name">{t(s.name)}</span>
                <div className="health-bar"><span style={{ width: `${Math.min(100, Math.max(12, ((s.uptime - 99.5) / 0.5) * 100))}%` }} /></div>
                <span className="lat">{s.latency}ms</span>
              </div>
            ))}
            <div className="divider" style={{ margin: '12px 0 10px' }} />
            <div className="flex" style={{ justifyContent: 'space-between' }}>
              <div>
                <div className="tiny dim">{t('Average uptime')}</div>
                <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em' }}>99.96%</div>
              </div>
              <div className="right">
                <div className="tiny dim">{t('Edge PoPs')}</div>
                <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.02em' }}>302</div>
              </div>
              <div className="right">
                <div className="tiny dim">{t('Errors / 24h')}</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--pink-text)', letterSpacing: '-0.02em' }}>{errSeries.at(-1)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="split" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('Recent executions')}</div>
              <div className="card-sub">{t('Serverless invocations across all functions')}</div>
            </div>
            <Link to="/functions" className="btn sm ghost" style={{ marginLeft: 'auto' }}>{t('View all')} <ArrowUpRight size={12} /></Link>
          </div>
          <div className="card-body tight">
            <table className="table">
              <thead>
                <tr><th>{t('Function')}</th><th>{t('Status')}</th><th>{t('Trigger')}</th><th className="right">{t('Duration')}</th><th className="right">{t('When')}</th></tr>
              </thead>
              <tbody>
                {m.recentExecutions.slice(0, 5).map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="flex" style={{ gap: 7 }}>
                        <Terminal size={12} style={{ color: 'var(--dim)' }} />
                        <span className="cell-main">{e.functionName}</span>
                      </div>
                    </td>
                    <td><Badge tone={statusTone(e.status)} dot>{e.status}</Badge></td>
                    <td className="dim">{e.triggerType}</td>
                    <td className="right mono">{fmtDuration(e.duration)}</td>
                    <td className="right dim">{timeAgo(e.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('Documents by collection')}</div>
              <div className="card-sub">{t('Distribution across your database')}</div>
            </div>
          </div>
          <div className="card-body">
            {m.topCollections.map((c) => {
              const max = Math.max(...m.topCollections.map((x) => x.documents), 1);
              return (
                <div className="bar-row" key={c.key}>
                  <div className="bar-top">
                    <span style={{ color: 'var(--muted)' }}>{c.name}</span>
                    <span className="mono dim">{c.documents}</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(c.documents / max) * 100}%`, background: `linear-gradient(90deg, ${c.color}, ${c.color}88)` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="quick-grid">
        <Link to="/functions" className="quick-card">
          <div className="qi" style={{ color: '#fd366e' }}><Zap size={14} /></div>
          <div><b>{t('Write a cloud function')}</b><small>{t('Edit Node 22 code in the browser and execute it instantly.')}</small></div>
        </Link>
        <Link to="/sites" className="quick-card">
          <div className="qi" style={{ color: 'var(--violet)' }}><Globe2 size={14} /></div>
          <div><b>{t('Ship a site live')}</b><small>{t('Edit HTML/CSS/JS with a live iframe preview and deploy.')}</small></div>
        </Link>
        <Link to="/ai" className="quick-card">
          <div className="qi" style={{ color: '#22d3ee' }}><Activity size={14} /></div>
          <div><b>{t('Ask the AI operator')}</b><small>{t('DeepSeek can query, create and deploy across every service.')}</small></div>
        </Link>
        <Link to="/messaging" className="quick-card">
          <div className="qi" style={{ color: '#34d399' }}><Send size={14} /></div>
          <div><b>{t('Send a message')}</b><small>{t('Email, SMS or push through the unified messaging API.')}</small></div>
        </Link>
      </div>
    </div>
  );
}
