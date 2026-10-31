import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Globe2, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { FunctionDomain } from '../types';
import { Badge, CopyButton, Empty, Modal, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';
import { timeAgo } from '../lib/format';

const tone = (s: string) => (s === 'active' ? 'green' : s === 'failed' ? 'red' : s === 'verifying' ? 'blue' : 'amber');

export default function DomainsTab({ functionId, functionName }: { functionId: string; functionName: string }) {
  const toast = useToast();
  const { can } = useAuth();
  const t = useT();
  const [list, setList] = useState<FunctionDomain[]>([]);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try { setList((await api.domains(functionId)).domains); } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, [functionId]);

  const add = async () => {
    if (!host.trim()) return toast.push(t('Enter a domain'), 'err');
    try {
      await api.addDomain(functionId, host.trim());
      setOpen(false);
      setHost('');
      toast.push(t('Domain added — finish DNS verification'));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const verify = async (d: FunctionDomain) => {
    setBusy(d.id);
    try {
      const r = await api.verifyDomain(functionId, d.id);
      toast.push(r.status === 'active' ? t('{host} is live', { host: d.hostname }) : t('Verification failed: {reason}', { reason: r.note || t('no TXT record') }), r.status === 'active' ? 'ok' : 'err');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const remove = async (d: FunctionDomain) => {
    if (!window.confirm(t('Unbind {host}?', { host: d.hostname }))) return;
    try {
      await api.deleteDomain(functionId, d.id);
      toast.push(t('Domain removed'));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const active = list.filter((d) => d.status === 'active');

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('Custom domains')}</div>
              <div className="card-sub">{t('Point your own domain at this function — requests are routed in by the Host header.')}</div>
            </div>
            <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!can('functions.write')}
              onClick={() => setOpen(true)}>
              <Plus size={13} /> {t('Add domain')}
            </button>
          </div>
          <div className="card-body tight">
            {list.length === 0 ? (
              <Empty title={t('No domains yet')} hint={t('Adding a domain generates a TXT record to verify ownership.')} icon={<Globe2 size={26} />} />
            ) : (
              <table className="table">
                <thead>
                  <tr><th>{t('Hostname')}</th><th>{t('Status')}</th><th>SSL</th><th>{t('Added')}</th><th style={{ width: 96 }} /></tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="dom-row">
                          <Globe2 size={13} style={{ color: 'var(--dim)' }} />
                          <span className="dom-host">{d.hostname}</span>
                        </div>
                        {d.status !== 'active' && (
                          <div className="dns-box" style={{ marginTop: 6 }}>
                            <div className="tiny dim" style={{ marginBottom: 3, letterSpacing: '0.06em' }}>TXT · _studio-baas</div>
                            <div className="flex" style={{ justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ wordBreak: 'break-all' }}>{d.dnsRecord}</span>
                              <CopyButton text={d.dnsRecord} />
                            </div>
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge tone={tone(d.status)} dot>{d.status}</Badge>
                        {d.note && d.status !== 'active' && <div className="tiny dim" style={{ marginTop: 4, maxWidth: 240 }}>{d.note}</div>}
                      </td>
                      <td><Badge tone={d.sslStatus === 'issued' ? 'green' : 'amber'}>{d.sslStatus}</Badge></td>
                      <td className="dim tiny" style={{ whiteSpace: 'nowrap' }}>{timeAgo(d.createdAt)}</td>
                      <td>
                        <div className="flex" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <button className="mini-btn" title={t('Verify DNS')} disabled={!can('functions.write') || busy === d.id}
                            onClick={() => verify(d)}>
                            {busy === d.id ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                          </button>
                          <button className="mini-btn" title={t('Remove')} disabled={!can('functions.write')} onClick={() => remove(d)}>
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
          <div className="card-head"><div className="card-title">{t('Request routing')}</div></div>
          <div className="card-body">
            {active.length === 0 ? (
              <div className="tiny dim">{t('Once a domain is verified, every request it receives is routed to')} <b>{functionName}</b>{t('. The path, query string, headers and body pass through untouched on the')} <span className="mono">req</span> {t('object.')}</div>
            ) : (
              <>
                <div className="tiny dim" style={{ marginBottom: 8 }}>
                  {t('Verified domains capture every path and forward it to')} <b>{functionName}</b>{t('. Test it locally — no real DNS needed:')}
                </div>
                <pre className="dns-box" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{`curl -X POST http://localhost:5174/checkout \\
  -H "Host: ${active[0].hostname}" \\
  -H "content-type: application/json" \\
  -d '{"email":"demo@aurora.io"}'`}</pre>
                <div className="tiny dim" style={{ marginTop: 8 }}>
                  {t('In production, CNAME the domain to your entrypoint. The TLS certificate is issued automatically after verification (simulated in this demo).')}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">{t('How verification works')}</div></div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            ['Add the domain', 'Generates a one-time verification token and writes it to the functionDomains table'],
            ['Create a TXT record', 'Add a TXT record for _studio-baas at your DNS provider, with a value like studio-baas-verify=…'],
            ['Click verify', 'The server reads the TXT record and compares it; DOMAIN_VERIFY_MODE=strict enforces a real check'],
            ['TLS + routing', 'Once verified, the domain is marked active, a certificate is issued and Host requests start routing to the function'],
          ].map(([title, desc], i) => (
            <div key={title} className="flex" style={{ gap: 9, alignItems: 'flex-start' }}>
              <span className="step-num">{i + 1}</span>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 550 }}>{t(title)}</div>
                <div className="tiny dim" style={{ lineHeight: 1.6 }}>{t(desc)}</div>
              </div>
            </div>
          ))}
          <div className="divider" />
          <div className="tiny dim" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <ShieldCheck size={13} style={{ marginTop: 2, color: 'var(--green-text)' }} />
            {t('The default simulate mode keeps local demos simple; set')} <span className="mono">DOMAIN_VERIFY_MODE=strict</span> {t('to verify against real DNS.')}
          </div>
          {list.some((d) => d.status === 'failed') && (
            <div className="tiny" style={{ display: 'flex', gap: 6, color: 'var(--pink-text)' }}>
              <AlertCircle size={13} style={{ marginTop: 2 }} /> {t('A domain failed verification — retry after DNS has propagated.')}
            </div>
          )}
          {active.length > 0 && (
            <div className="tiny" style={{ display: 'flex', gap: 6, color: 'var(--green-text)' }}>
              <CheckCircle2 size={13} style={{ marginTop: 2 }} /> {t('{n} domains are receiving traffic.', { n: active.length })}
            </div>
          )}
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={t('Add custom domain')}
        subtitle={t('Bind to {name}', { name: functionName })}
        footer={<>
          <button className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button>
          <button className="btn primary" onClick={add}>{t('Add domain')}</button>
        </>}>
        <div className="field"><label>{t('Hostname')}</label>
          <input className="input" placeholder="api.example.com" value={host}
            onChange={(e) => setHost(e.target.value)} autoFocus />
          <div className="hint">{t('No protocol or path — e.g. api.aurora.io')}</div>
        </div>
      </Modal>
    </div>
  );
}
