import { useEffect, useRef, useState } from 'react';
import {
  CalendarClock, CheckCircle2, Clock, Loader2, Pause, Play, Plus, RefreshCw, Trash2, Zap,
} from 'lucide-react';
import { api } from '../api';
import type { Schedule } from '../types';
import { Badge, Empty, Modal, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { fmtInZone, timeAgo, timeUntil, zoneLabel } from '../lib/format';

const PRESETS = [
  { cron: '*/5 * * * *', label: 'Every 5 minutes' },
  { cron: '*/15 * * * *', label: 'Every 15 minutes' },
  { cron: '0 * * * *', label: 'Hourly' },
  { cron: '0 2 * * *', label: 'Daily at 02:00' },
  { cron: '0 9 * * 1', label: 'Mondays at 09:00' },
];

const TZS = ['UTC', 'Europe/Berlin', 'Europe/London', 'America/New_York', 'Asia/Shanghai', 'Asia/Tokyo'];

export default function SchedulesTab({ functionId, functionName }: { functionId: string; functionName: string }) {
  const toast = useToast();
  const { can } = useAuth();
  const [list, setList] = useState<Schedule[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ cron: '0 2 * * *', timezone: 'UTC' });
  const [preview, setPreview] = useState<{ next: string[]; description: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = async () => {
    try { setList((await api.schedules(functionId)).schedules); } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, [functionId]);

  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setError('');
    timer.current = window.setTimeout(() => {
      api.cronPreview(form.cron, form.timezone)
        .then((p) => { setPreview(p); setError(''); })
        .catch((e: any) => { setPreview(null); setError(e.message); });
    }, 300);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [form.cron, form.timezone]);

  const create = async () => {
    try {
      await api.createSchedule(functionId, form);
      toast.push('调度已创建');
      setOpen(false);
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const toggle = async (s: Schedule) => {
    try {
      await api.updateSchedule(s.id, { enabled: !s.enabled });
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const runNow = async (s: Schedule) => {
    setBusy(s.id);
    try {
      const r = await api.runSchedule(s.id);
      toast.push(r.status === 'completed' ? `执行完成（${r.duration}ms）` : '执行失败', r.status === 'completed' ? 'ok' : 'err');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const remove = async (s: Schedule) => {
    if (!window.confirm(`删除调度 ${s.cron}？`)) return;
    try { await api.deleteSchedule(s.id); toast.push('已删除'); load(); } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const writable = can('functions.write');
  const runnable = can('functions.execute');

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">Scheduled executions</div>
            <div className="card-sub">按 cron 定时触发 {functionName}，执行记录与手动调用一样可追溯</div>
          </div>
          <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!writable} onClick={() => setOpen(true)}>
            <Plus size={13} /> Add schedule
          </button>
        </div>
        <div className="card-body tight">
          {list.length === 0 ? (
            <Empty title="没有定时任务" hint="添加一个 cron 表达式，函数会按计划自动执行" icon={<CalendarClock size={26} />} />
          ) : (
            <table className="table">
              <thead>
                <tr><th>Schedule</th><th>Timezone</th><th>Next run</th><th>Last run</th><th style={{ width: 132 }} /></tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <div className="flex" style={{ gap: 8 }}>
                        <span className="mono" style={{ fontSize: 12 }}>{s.cron}</span>
                        <Badge tone={s.enabled ? 'green' : 'amber'}>{s.enabled ? 'active' : 'paused'}</Badge>
                      </div>
                      <div className="tiny dim" style={{ marginTop: 2 }}>{s.description}</div>
                    </td>
                    <td className="tiny dim mono">{s.timezone}</td>
                    <td>
                      <div className="tiny">
                        {s.nextRunAt ? fmtInZone(s.nextRunAt, s.timezone) : '—'}
                        <span className="dim"> {zoneLabel(s.timezone)}</span>
                      </div>
                      <div className="tiny dim">{s.nextRunAt ? timeUntil(s.nextRunAt) : ''}</div>
                    </td>
                    <td>
                      {s.lastRunAt ? (
                        <div className="flex" style={{ gap: 6 }}>
                          <Badge tone={s.lastStatus === 'completed' ? 'green' : 'red'} dot>{s.lastStatus}</Badge>
                          <span className="tiny dim">{timeAgo(s.lastRunAt)}</span>
                        </div>
                      ) : <span className="tiny dim">never</span>}
                    </td>
                    <td>
                      <div className="flex" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <button className="mini-btn" title="Run now" disabled={!runnable || busy === s.id} onClick={() => runNow(s)}>
                          {busy === s.id ? <Loader2 size={12} className="spin" /> : <Zap size={12} />}
                        </button>
                        <button className="mini-btn" title={s.enabled ? 'Pause' : 'Resume'} disabled={!writable} onClick={() => toggle(s)}>
                          {s.enabled ? <Pause size={12} /> : <Play size={12} />}
                        </button>
                        <button className="mini-btn" title="Delete" disabled={!writable} onClick={() => remove(s)}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Clock size={14} style={{ color: 'var(--dim)', marginTop: 2 }} />
          <div className="tiny dim" style={{ lineHeight: 1.7 }}>
            调度器每 15 秒扫描一次到期任务，命中后用 <span className="mono">trigger=schedule</span> 执行函数，payload 注入
            <span className="mono"> scheduledAt / cron / source </span>。时区按 IANA 名称解析，跨时区团队不会算错时间。
          </div>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Add schedule" subtitle={`触发 ${functionName}`}
        footer={<>
          <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn primary" disabled={!!error || !form.cron} onClick={create}>Create schedule</button>
        </>}>
        <div className="field"><label>Preset</label>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button key={p.cron} className={`btn sm ${form.cron === p.cron ? 'primary' : 'ghost'}`}
                onClick={() => setForm({ ...form, cron: p.cron })}>{p.label}</button>
            ))}
          </div>
        </div>
        <div className="field-row">
          <div className="field"><label>Cron expression</label>
            <input className="input mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            <div className="hint">分 时 日 月 周，例如 0 2 * * *</div>
          </div>
          <div className="field"><label>Timezone</label>
            <select className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TZS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        {error ? (
          <div className="tiny" style={{ color: '#ff8aa6' }}>{error}</div>
        ) : preview && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' }}>
            <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="tiny dim">Next runs</span>
              <span className="tiny" style={{ color: '#00b894' }}><RefreshCw size={10} /> {preview.description}</span>
            </div>
            {preview.next.map((n, i) => (
              <div key={i} className="flex" style={{ justifyContent: 'space-between', padding: '2px 0' }}>
                <span className="tiny mono" style={{ color: 'var(--muted)' }}>
                  {fmtInZone(n, form.timezone)}
                  <span className="dim"> {zoneLabel(form.timezone)}</span>
                </span>
                <span className="tiny dim">{timeUntil(n)}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
