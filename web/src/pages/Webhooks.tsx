import { Fragment, useEffect, useState } from 'react';
import {
  Webhook as WebhookIcon, Plus, Send, RotateCw, Trash2, Copy, AlertTriangle,
  CheckCircle2, XCircle, Clock, ChevronDown, ChevronRight, Power,
} from 'lucide-react';
import { api } from '../api';
import type { Webhook, WebhookDelivery } from '../types';
import { Badge, Empty, Loading, Modal, useToast } from '../components/ui';
import { fmtDateTime, timeAgo } from '../lib/format';
import { useT } from '../lib/locale';

/** Mirrors the event names the server publishes; free-form values are still allowed. */
const EVENT_GROUPS: { label: string; events: string[] }[] = [
  { label: 'Documents', events: ['document.create', 'document.update', 'document.delete', 'document.bulk-create'] },
  { label: 'Collections', events: ['collection.create', 'collection.update', 'collection.delete'] },
  { label: 'Functions', events: ['function.create', 'function.update', 'function.delete', 'execution.create'] },
  { label: 'Sites', events: ['site.create', 'site.update', 'site.delete'] },
  { label: 'Storage', events: ['file.create', 'file.delete'] },
  { label: 'Auth', events: ['user.create', 'user.update', 'user.delete'] },
  { label: 'Messaging', events: ['message.create'] },
];

const statusTone = (s: number | null) => (s === null ? 'red' : s < 300 ? 'green' : s < 400 ? 'blue' : 'red');

export default function Webhooks() {
  const toast = useToast();
  const t = useT();

  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ url: '', description: '', events: ['*'] as string[] });
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);

  const [expanded, setExpanded] = useState<string>('');
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);

  const load = async () => {
    try { setHooks((await api.webhooks()).webhooks); } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  useEffect(() => { void load(); }, []);

  const toggleEvent = (ev: string) => {
    setForm((f) => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter((x) => x !== ev) : [...f.events.filter((x) => x !== '*'), ev],
    }));
  };

  const create = async () => {
    if (!form.url.trim()) return toast.push(t('A URL is required'), 'err');
    setSaving(true);
    try {
      const hook = await api.createWebhook({
        url: form.url.trim(),
        events: form.events.length ? form.events : ['*'],
        description: form.description.trim() || undefined,
      });
      setOpen(false);
      setForm({ url: '', description: '', events: ['*'] });
      if (hook.secret) setSecret({ name: hook.url, value: hook.secret });
      await load();
      toast.push(t('Webhook created'), 'ok');
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const rotate = async (hook: Webhook) => {
    if (!window.confirm(t('Rotate the signing secret? The old one stops working immediately.'))) return;
    try {
      const next = await api.rotateWebhook(hook.id);
      if (next.secret) setSecret({ name: next.url, value: next.secret });
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const test = async (hook: Webhook) => {
    try {
      const r = await api.testWebhook(hook.id);
      const d = r.delivery;
      toast.push(d?.status && d.status < 300
        ? t('Test delivered ({status} in {ms}ms)', { status: d.status, ms: Math.round(d.duration) })
        : t('Test failed: {error}', { error: d?.error || t('no response') }), d?.status && d.status < 300 ? 'ok' : 'err');
      await load();
      if (expanded === hook.id) await loadDeliveries(hook.id);
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const toggle = async (hook: Webhook) => {
    try {
      await api.updateWebhook(hook.id, { enabled: !hook.enabled });
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const remove = async (hook: Webhook) => {
    if (!window.confirm(t('Delete this webhook? Delivery history goes with it.'))) return;
    try {
      await api.deleteWebhook(hook.id);
      await load();
      toast.push(t('Webhook deleted'), 'ok');
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const loadDeliveries = async (id: string) => {
    try { setDeliveries((await api.webhookDeliveries(id, 20)).deliveries); } catch { setDeliveries([]); }
  };

  const expand = async (hook: Webhook) => {
    if (expanded === hook.id) { setExpanded(''); return; }
    setExpanded(hook.id);
    await loadDeliveries(hook.id);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><WebhookIcon size={11} /> {t('Integrations')}</div>
          <h1>{t('Webhooks')}</h1>
          <p>{t('Push project events to any HTTP endpoint. Every delivery is signed with HMAC-SHA256.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setOpen(true)}><Plus size={14} /> {t('New webhook')}</button>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <span className="tiny dim">
            {hooks.length === 1 ? t('{n} subscription', { n: 1 }) : t('{n} subscriptions', { n: hooks.length })}
            {' · '}
            {t('{n} deliveries', { n: hooks.reduce((a, h) => a + h.deliveries, 0) })}
          </span>
          <div className="toolbar-spacer" />
          <span className="tiny dim">{t('Retries: 3 attempts on 5xx / timeout')}</span>
        </div>
        <div className="card-body tight">
          {loading ? <Loading rows={3} /> : hooks.length === 0 ? (
            <Empty
              title={t('No webhooks yet')}
              hint={t('Subscribe to document.created and get a POST the moment a row is written.')}
              icon={<WebhookIcon size={26} />}
            />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th>{t('Endpoint')}</th>
                  <th style={{ width: 260 }}>{t('Events')}</th>
                  <th style={{ width: 90 }}>{t('Status')}</th>
                  <th style={{ width: 110 }} className="right">{t('Deliveries')}</th>
                  <th style={{ width: 120 }}>{t('Last delivery')}</th>
                  <th style={{ width: 150 }} className="right" />
                </tr>
              </thead>
              <tbody>
                {hooks.map((h) => (
                  <Fragment key={h.id}>
                    <tr>
                      <td>
                        <button className="icon-btn" onClick={() => expand(h)}>
                          {expanded === h.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      </td>
                      <td>
                        <div className="mono" style={{ fontSize: 11.5 }}>{h.url}</div>
                        {h.description && <div className="tiny dim">{h.description}</div>}
                      </td>
                      <td>
                        <div className="flex" style={{ gap: 3, flexWrap: 'wrap' }}>
                          {h.events.slice(0, 3).map((e) => <Badge key={e} tone="violet">{e}</Badge>)}
                          {h.events.length > 3 && <Badge>+{h.events.length - 3}</Badge>}
                        </div>
                      </td>
                      <td>
                        {h.lastStatus === null
                          ? <Badge>{t('Not called')}</Badge>
                          : <Badge tone={statusTone(h.lastStatus)} dot>{h.lastStatus}</Badge>}
                      </td>
                      <td className="right mono dim">
                        {h.deliveries}
                        {h.failures > 0 && <span style={{ color: 'var(--err-text)' }}> · {h.failures} {t('failed')}</span>}
                      </td>
                      <td className="dim tiny">{h.lastDeliveryAt ? timeAgo(h.lastDeliveryAt) : '—'}</td>
                      <td className="right">
                        <div className="flex" style={{ gap: 2, justifyContent: 'flex-end' }}>
                          <button className="icon-btn" title={h.enabled ? t('Disable') : t('Enable')} onClick={() => toggle(h)}
                            style={{ color: h.enabled ? 'var(--green-text)' : 'var(--dim)' }}>
                            <Power size={13} />
                          </button>
                          <button className="icon-btn" title={t('Send test event')} onClick={() => test(h)}><Send size={12} /></button>
                          <button className="icon-btn" title={t('Rotate secret')} onClick={() => rotate(h)}><RotateCw size={12} /></button>
                          <button className="icon-btn danger" title={t('Delete')} onClick={() => remove(h)}><Trash2 size={12} /></button>
                        </div>
                      </td>
                    </tr>
                    {expanded === h.id && (
                      <tr>
                        <td />
                        <td colSpan={6} style={{ background: 'var(--w1)', padding: '10px 14px' }}>
                          {deliveries.length === 0 ? (
                            <div className="tiny dim">{t('No deliveries yet. Hit “Send test event” to try it.')}</div>
                          ) : (
                            <table className="table" style={{ fontSize: 11 }}>
                              <thead>
                                <tr><th>{t('Event')}</th><th>{t('Status')}</th><th>{t('Attempts')}</th><th>{t('Duration')}</th><th>{t('Time')}</th></tr>
                              </thead>
                              <tbody>
                                {deliveries.map((d) => (
                                  <tr key={d.id}>
                                    <td><span className="mono">{d.event}</span></td>
                                    <td>
                                      {d.status === null
                                        ? <span className="flex" style={{ gap: 4, color: 'var(--err-text)' }}><XCircle size={11} /> {d.error}</span>
                                        : <span className="flex" style={{ gap: 4, color: d.status < 300 ? 'var(--green-text)' : 'var(--err-text)' }}>
                                            {d.status < 300 ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />} {d.status}
                                          </span>}
                                    </td>
                                    <td className="mono dim">{d.attempts}</td>
                                    <td className="mono dim">{Math.round(d.duration)}ms</td>
                                    <td className="dim tiny flex" style={{ gap: 4 }}><Clock size={10} /> {fmtDateTime(d.createdAt)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('New webhook')}
        subtitle={t('The endpoint receives a JSON POST for every matching event.')}
        footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button>
            <button className="btn primary" onClick={create} disabled={saving}>
              {saving ? t('Creating…') : t('Create webhook')}
            </button>
          </>
        }
      >
        <div className="field">
          <label>{t('Endpoint URL')}</label>
          <input className="input" placeholder="https://example.com/hooks/studio" value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })} />
        </div>
        <div className="field">
          <label>{t('Description')}</label>
          <input className="input" placeholder={t('Optional')} value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="field">
          <label>{t('Events')}</label>
          <div className="tiny dim" style={{ marginBottom: 8 }}>
            {t('Pick individual events, or leave everything unselected to subscribe to all.')}
          </div>
          <div className="flex" style={{ gap: 6, marginBottom: 10 }}>
            <button className={`chip${form.events.includes('*') ? ' on' : ''}`}
              onClick={() => setForm({ ...form, events: ['*'] })}>* {t('All events')}</button>
          </div>
          {EVENT_GROUPS.map((g) => (
            <div key={g.label} style={{ marginBottom: 8 }}>
              <div className="tiny dim" style={{ marginBottom: 4 }}>{t(g.label)}</div>
              <div className="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                {g.events.map((ev) => (
                  <button key={ev} className={`chip${form.events.includes(ev) ? ' on' : ''}`} onClick={() => toggleEvent(ev)}>
                    {ev}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Modal>

      <Modal
        open={!!secret}
        onClose={() => setSecret(null)}
        title={t('Signing secret')}
        subtitle={t('Shown once. Copy it now — the list only keeps a digest.')}
        footer={<button className="btn primary" onClick={() => setSecret(null)}>{t('Done')}</button>}
      >
        <div className="field">
          <label>{secret?.name}</label>
          <div className="flex" style={{ gap: 6 }}>
            <input className="input mono" readOnly value={secret?.value || ''} onFocus={(e) => e.currentTarget.select()} />
            <button className="btn ghost" onClick={() => {
              navigator.clipboard?.writeText(secret?.value || '');
              toast.push(t('Copied'), 'ok');
            }}><Copy size={13} /></button>
          </div>
        </div>
        <div className="tiny dim" style={{ lineHeight: 1.7 }}>
          {t('Verify every request with')}{' '}
          <code className="mono">X-Studio-Signature: t=&lt;unix&gt;,v1=&lt;hmac&gt;</code>{' '}
          {t('computed over')} <code className="mono">{"`${t}.${rawBody}`"}</code>.
        </div>
      </Modal>
    </div>
  );
}
