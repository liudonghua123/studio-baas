import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Boxes, Database, Globe2, Plus, Trash2, Users2, ArrowRight, Layers } from 'lucide-react';
import { api, currentProjectId, setProject } from '../api';
import type { Project } from '../types';
import { Badge, Empty, Modal, useToast } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useT } from '../lib/locale';

export default function Projects() {
  const nav = useNavigate();
  const toast = useToast();
  const t = useT();
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState<Project[]>([]);
  const [open, setOpen] = useState(params.get('new') === '1');
  const [form, setForm] = useState({ name: '', region: 'fra', plan: 'free', description: '' });
  const [busy, setBusy] = useState(false);
  const active = currentProjectId();

  const load = async () => {
    try { setList((await api.projects()).projects); } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!form.name.trim()) return toast.push(t('Project name is required'), 'err');
    setBusy(true);
    try {
      const p = await api.createProject(form);
      toast.push(t('Project {name} created', { name: p.name }));
      setOpen(false);
      setParams({});
      setForm({ name: '', region: 'fra', plan: 'free', description: '' });
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(false); }
  };

  const remove = async (p: Project) => {
    if (!window.confirm(t('Delete project {name}? Its collections, functions, sites and files go with it.', { name: p.name }))) return;
    try {
      await api.deleteProject(p.id);
      toast.push(t('Project deleted'));
      if (active === p.id) setProject('');
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const enter = (p: Project) => {
    setProject(p.id);
    nav('/');
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Layers size={12} /> {t('Workspace')}</div>
          <h1>{t('Projects')}</h1>
          <p className="page-sub">
            {t('Each project has its own collections, buckets, functions, sites, members and API keys. Switching projects only changes the current context — data is never shared.')}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setOpen(true)}><Plus size={14} /> {t('New project')}</button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="card"><Empty title={t('No projects yet')} hint={t('Create a project to get started.')} /></div>
      ) : (
        <div className="proj-grid">
          {list.map((p) => (
            <div className={`proj-card ${p.id === active ? 'current' : ''}`} key={p.id}>
              <div className="proj-card-top">
                <div className="proj-avatar" style={{ background: p.color }}>{p.name.slice(0, 1)}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="proj-name">{p.name}</div>
                  <div className="proj-key mono">{p.key}</div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {p.id === active && <Badge tone="ok" dot>{t('current')}</Badge>}
                </div>
              </div>

              <p className="proj-desc">{p.description || t('No description yet.')}</p>

              <div className="proj-stats">
                <div><Database size={12} /><b>{p.stats?.collections ?? 0}</b><span>{t('collections')}</span></div>
                <div><Boxes size={12} /><b>{p.stats?.functions ?? 0}</b><span>{t('functions')}</span></div>
                <div><Globe2 size={12} /><b>{p.stats?.sites ?? 0}</b><span>{t('sites')}</span></div>
                <div><Users2 size={12} /><b>{p.stats?.members ?? 0}</b><span>{t('members')}</span></div>
              </div>

              <div className="proj-meta-row">
                <span className="mono">{p.region.toUpperCase()}</span>
                <span className="dim">·</span>
                <span>{p.plan}</span>
                <span className="dim">·</span>
                <span className="dim">{t('created {time}', { time: timeAgo(p.createdAt) })}</span>
              </div>

              <div className="proj-actions">
                <button className="btn sm" onClick={() => enter(p)}>
                  {p.id === active ? t('Open console') : t('Switch & open')} <ArrowRight size={12} />
                </button>
                <button className="btn sm ghost" onClick={() => { setProject(p.id); nav('/members'); }}>{t('Members')}</button>
                <button className="icon-btn" style={{ marginLeft: 'auto' }} title={t('Delete project')} onClick={() => remove(p)}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => { setOpen(false); setParams({}); }}
        title={t('New project')}
        subtitle={t('Resources are isolated per project, with members and permissions configured separately.')}
        footer={
          <>
            <button className="btn ghost" onClick={() => { setOpen(false); setParams({}); }}>{t('Cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={create}>{busy ? t('Creating…') : t('Create project')}</button>
          </>
        }
      >
        <div className="field"><label>{t('Name')}</label>
          <input className="input" placeholder={t('e.g. Acme Production')} value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></div>
        <div className="field-row">
          <div className="field"><label>{t('Region')}</label>
            <select className="input" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>
              <option value="fra">{t('Frankfurt (fra)')}</option>
              <option value="ams">{t('Amsterdam (ams)')}</option>
              <option value="iad">{t('Washington (iad)')}</option>
              <option value="sgp">{t('Singapore (sgp)')}</option>
            </select>
          </div>
          <div className="field"><label>{t('Plan')}</label>
            <select className="input" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
              <option value="free">{t('Free')}</option>
              <option value="pro">{t('Pro')}</option>
              <option value="enterprise">{t('Enterprise')}</option>
            </select>
          </div>
        </div>
        <div className="field"><label>{t('Description')}</label>
          <textarea className="input" rows={3} placeholder={t('What lives in this project?')}
            value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
