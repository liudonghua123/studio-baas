import { useEffect, useRef, useState } from 'react';
import {
  CalendarClock, CheckCircle2, Clock, Loader2, Pause, Play, Plus, RefreshCw, Trash2, Zap,
} from 'lucide-react';
import { api } from '../api';
import type { Schedule } from '../types';
import { Badge, Empty, Modal, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';
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
  const t = useT();
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
      toast.push(t('Schedule created'));
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
      toast.push(r.status === 'completed' ? t('Completed in {duration}ms', { duration: r.duration }) : t('Execution failed'), r.status === 'completed' ? 'ok' : 'err');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const remove = async (s: Schedule) => {
    if (!window.confirm(t('Delete schedule {cron}?', { cron: s.cron }))) return;
    try { await api.deleteSchedule(s.id); toast.push(t('Deleted')); load(); } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const writable = can('functions.write');
  const runnable = can('functions.execute');

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title">{t('Scheduled executions')}</div>
            <div className="card-sub">{t('Triggers {name} on a cron schedule. Every run is logged like a manual invocation.', { name: functionName })}</div>
          </div>
          <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!writable} onClick={() => setOpen(true)}>
            <Plus size={13} /> {t('Add schedule')}
          </button>
        </div>
        <div className="card-body tight">
          {list.length === 0 ? (
            <Empty title={t('No schedules yet')} hint={t('Add a cron expression and the function runs automatically on that schedule.')} icon={<CalendarClock size={26} />} />
          ) : (
            <table className="table">
              <thead>
                <tr><th>{t('Schedule')}</th><th>{t('Timezone')}</th><th>{t('Next run')}</th><th>{t('Last run')}</th><th style={{ width: 132 }} /></tr>
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
                      ) : <span className="tiny dim">{t('never')}</span>}
                    </td>
                    <td>
                      <div className="flex" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        <button className="mini-btn" title={t('Run now')} disabled={!runnable || busy === s.id} onClick={() => runNow(s)}>
                          {busy === s.id ? <Loader2 size={12} className="spin" /> : <Zap size={12} />}
                        </button>
                        <button className="mini-btn" title={s.enabled ? t('Pause') : t('Resume')} disabled={!writable} onClick={() => toggle(s)}>
                          {s.enabled ? <Pause size={12} /> : <Play size={12} />}
                        </button>
                        <button className="mini-btn" title={t('Delete')} disabled={!writable} onClick={() => remove(s)}>
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
            {t('The scheduler scans for due jobs every 15 seconds and runs the function with')}{' '}
            <span className="mono">trigger=schedule</span>{' '}
            {t('and injects')} <span className="mono">scheduledAt / cron / source</span>{' '}
            {t('into the payload. Timezones are resolved by IANA name, so teams spread across zones never get the time wrong.')}
          </div>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={t('Add schedule')} subtitle={t('Triggers {name}', { name: functionName })}
        footer={<>
          <button className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!!error || !form.cron} onClick={create}>{t('Create schedule')}</button>
        </>}>
        <div className="field"><label>{t('Preset')}</label>
          <div className="flex" style={{ gap: 6, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button key={p.cron} className={`btn sm ${form.cron === p.cron ? 'primary' : 'ghost'}`}
                onClick={() => setForm({ ...form, cron: p.cron })}>{t(p.label)}</button>
            ))}
          </div>
        </div>
        <div className="field-row">
          <div className="field"><label>{t('Cron expression')}</label>
            <input className="input mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            <div className="hint">{t('Minute hour day month weekday, e.g. 0 2 * * *')}</div>
          </div>
          <div className="field"><label>{t('Timezone')}</label>
            <select className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TZS.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
        </div>

        {error ? (
          <div className="tiny" style={{ color: 'var(--pink-text)' }}>{error}</div>
        ) : preview && (
          <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' }}>
            <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span className="tiny dim">{t('Next runs')}</span>
              <span className="tiny" style={{ color: 'var(--green-text)' }}><RefreshCw size={10} /> {preview.description}</span>
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
