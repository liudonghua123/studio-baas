import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Globe2, Plus, ExternalLink, RefreshCw, GitBranch, ChevronRight, Code2 } from 'lucide-react';
import { api } from '../api';
import type { Site } from '../types';
import { Badge, Empty, Loading, Modal, useToast } from '../components/ui';
import { statusTone, timeAgo } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';

export default function Sites() {
  const t = useT();
  const [sites, setSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', framework: 'static' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { can } = useAuth();
  const nav = useNavigate();

  const load = async () => {
    try { setSites((await api.sites()).sites); } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!form.name) return;
    setBusy(true);
    try {
      const s = await api.createSite({ name: form.name, framework: form.framework });
      toast.push(t('Site created'));
      nav(`/sites/${s.id}`);
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Globe2 size={11} /> {t('Sites')}</div>
          <h1>{t('Hosting')}</h1>
          <p>{t('Edit HTML, CSS and JS in the browser, preview the result live, then deploy to your domain.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={load}><RefreshCw size={14} /> {t('Refresh')}</button>
          <button className="btn primary" disabled={!can('sites.write')} onClick={() => setOpen(true)}><Plus size={14} /> {t('Create site')}</button>
        </div>
      </div>

      {loading ? <div className="card"><Loading /></div> : sites.length === 0 ? (
        <div className="card"><Empty title={t('No sites yet')} hint={t('Create a site to start editing and previewing pages.')} icon={<Globe2 size={26} />} /></div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
          {sites.map((s) => (
            <div key={s.id} className="card" style={{ overflow: 'hidden', cursor: 'pointer' }} onClick={() => nav(`/sites/${s.id}`)}>
              <div style={{ height: 178, background: 'var(--code-bg)', borderBottom: '1px solid var(--line)', position: 'relative', overflow: 'hidden' }}>
                <iframe
                  src={`/v1/sites/${s.id}/preview/index.html`}
                  title={s.name}
                  style={{
                    width: 1100, height: 620, border: 0, transform: 'scale(0.292)', transformOrigin: 'top left',
                    pointerEvents: 'none', position: 'absolute', top: 0, left: 0,
                  }}
                />
                <div style={{ position: 'absolute', top: 9, left: 9, display: 'flex', gap: 6 }}>
                  <Badge tone={statusTone(s.status)} dot>{s.status}</Badge>
                </div>
              </div>
              <div style={{ padding: '13px 15px' }}>
                <div className="flex" style={{ gap: 8 }}>
                  <b style={{ fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em' }}>{s.name}</b>
                  <ChevronRight size={14} style={{ marginLeft: 'auto', color: 'var(--dim)' }} />
                </div>
                <div className="flex" style={{ gap: 6, marginTop: 5, fontSize: 11, color: 'var(--dim)' }}>
                  <ExternalLink size={10} />
                  <span className="mono">{s.domain}</span>
                </div>
                <div className="flex" style={{ gap: 12, marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line)', fontSize: 10.5, color: 'var(--dim)' }}>
                  <span className="flex" style={{ gap: 4 }}><Code2 size={10} /> {t('{n} files', { n: s.files.length })}</span>
                  <span className="flex" style={{ gap: 4 }}><GitBranch size={10} /> {s.framework}</span>
                  <span style={{ marginLeft: 'auto' }}>{timeAgo(s.updatedAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={t('Create site')}
        subtitle={t('A starter index.html is generated for you.')}
        footer={<>
          <button className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!form.name || busy} onClick={create}>{busy ? t('Creating…') : t('Create site')}</button>
        </>}
      >
        <div className="field">
          <label className="label">{t('Site name')} <span className="req">*</span></label>
          <input className="input" autoFocus placeholder={t('e.g. marketing-site')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="hint">{t('A domain like')} <span className="mono">{form.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'my-site'}.studio.app</span> {t('is assigned automatically.')}</div>
        </div>
        <div className="field">
          <label className="label">{t('Framework')}</label>
          <select className="select" value={form.framework} onChange={(e) => setForm({ ...form, framework: e.target.value })}>
            <option value="static">{t('Static HTML')}</option>
            <option value="react">{t('React SPA')}</option>
            <option value="next">{t('Next.js')}</option>
            <option value="astro">{t('Astro')}</option>
          </select>
        </div>
      </Modal>
    </div>
  );
}
