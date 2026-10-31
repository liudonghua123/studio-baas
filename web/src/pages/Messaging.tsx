import { useEffect, useState } from 'react';
import { Send, Mail, MessageSquare, Bell, RefreshCw, CheckCircle2, Clock } from 'lucide-react';
import { api } from '../api';
import type { Message } from '../types';
import { Badge, Empty, Loading, useToast } from '../components/ui';
import { fmtDateTime, statusTone, timeAgo } from '../lib/format';
import { statusLabel } from '../lib/status';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';

const channels = [
  { id: 'email', label: 'Email', icon: Mail, hint: 'SMTP / Sendgrid / Resend provider' },
  { id: 'sms', label: 'SMS', icon: MessageSquare, hint: 'Twilio-compatible gateway' },
  { id: 'push', label: 'Push', icon: Bell, hint: 'APNs / FCM web push' },
];

export default function Messaging() {
  const toast = useToast();
  const t = useT();
  const { can } = useAuth();
  const [channel, setChannel] = useState('email');
  const [recipient, setRecipient] = useState('mia@northwind.io');
  const [subject, setSubject] = useState('Your order is on the way');
  const [body, setBody] = useState('Hi Mia,\n\nGood news — your Aurora order has shipped and will arrive within 2 business days.\n\n— Aurora Studio');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { setMessages((await api.messages()).messages); } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const send = async () => {
    if (!recipient || !body) return;
    setBusy(true);
    try {
      await api.sendMessage({ channel, recipient, subject, body });
      toast.push(t('Message queued'));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Send size={11} /> {t('Messaging')}</div>
          <h1>{t('Send messages')}</h1>
          <p>{t('One API for email, SMS and push — with delivery logs, retries and provider failover.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={load}><RefreshCw size={14} /> {t('Refresh')}</button>
        </div>
      </div>

      <div className="split" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head"><div className="card-title">{t('Compose')}</div></div>
          <div className="card-body">
            <div className="bucket-tabs">
              {channels.map((c) => (
                <div key={c.id} className={`bucket-chip pointer ${channel === c.id ? 'active' : ''}`} onClick={() => setChannel(c.id)}>
                  <c.icon size={13} /> {t(c.label)}
                </div>
              ))}
            </div>
            <div className="field">
              <label className="label">{t('Recipient')} <span className="req">*</span></label>
              <input className="input" placeholder={channel === 'sms' ? '+49 151 1234 5678' : channel === 'email' ? 'user@example.com' : t('device token')} value={recipient} onChange={(e) => setRecipient(e.target.value)} />
              <div className="hint">{t(channels.find((c) => c.id === channel)?.hint || '')}</div>
            </div>
            {channel !== 'sms' && (
              <div className="field">
                <label className="label">{t('Subject')}</label>
                <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
            )}
            <div className="field">
              <label className="label">{t('Body')} <span className="req">*</span></label>
              <textarea className="textarea" style={{ minHeight: 140 }} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="flex">
              <button className="btn primary" onClick={send} disabled={busy || !recipient || !body || !can('messaging.write')}>
                <Send size={14} /> {busy ? t('Sending…') : t('Send message')}
              </button>
              <span className="tiny dim" style={{ marginLeft: 'auto' }}>{t('delivered via {channel} provider', { channel: t(channels.find((c) => c.id === channel)?.label || channel) })}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div className="card-title">{t('Delivery log')}</div>
            <span className="badge" style={{ marginLeft: 'auto' }}>{messages.length}</span>
          </div>
          <div className="card-body tight">
            {loading ? <Loading /> : messages.length === 0 ? <Empty title={t('No messages yet')} /> : (
              <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                {messages.map((m) => (
                  <div key={m.id} style={{ padding: '11px 15px', borderBottom: '1px solid rgba(255,255,255,.045)' }}>
                    <div className="flex" style={{ gap: 8 }}>
                      <Badge tone={m.channel === 'email' ? 'blue' : m.channel === 'sms' ? 'violet' : 'amber'}>{m.channel}</Badge>
                      <span className="tiny" style={{ color: 'var(--muted)' }}>{m.recipient}</span>
                      <span style={{ marginLeft: 'auto' }}><Badge tone={statusTone(m.status)} dot>{t(statusLabel(m.status))}</Badge></span>
                    </div>
                    {m.subject && <div style={{ fontSize: 12, fontWeight: 550, marginTop: 6 }}>{m.subject}</div>}
                    <div className="tiny dim" style={{ marginTop: 2, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.body}</div>
                    <div className="tiny dim" style={{ marginTop: 5, fontSize: 10 }}>{timeAgo(m.createdAt)} · {fmtDateTime(m.createdAt)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid-stats" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginTop: 14 }}>
        {[
          { label: 'Sent today', value: messages.filter((m) => new Date(m.createdAt).toDateString() === new Date().toDateString()).length, icon: Send },
          { label: 'Email', value: messages.filter((m) => m.channel === 'email').length, icon: Mail },
          { label: 'SMS', value: messages.filter((m) => m.channel === 'sms').length, icon: MessageSquare },
          { label: 'Push', value: messages.filter((m) => m.channel === 'push').length, icon: Bell },
        ].map((s) => (
          <div className="stat" key={s.label}>
            <div className="stat-label"><s.icon size={12} /> {t(s.label)}</div>
            <div className="stat-value" style={{ fontSize: 22 }}>{s.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
