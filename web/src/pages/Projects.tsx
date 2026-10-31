import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Boxes, Database, Globe2, Plus, Trash2, Users2, ArrowRight, Layers } from 'lucide-react';
import { api, currentProjectId, setProject } from '../api';
import type { Project } from '../types';
import { Badge, Empty, Modal, useToast } from '../components/ui';
import { timeAgo } from '../lib/format';

export default function Projects() {
  const nav = useNavigate();
  const toast = useToast();
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
    if (!form.name.trim()) return toast.push('请填写项目名称', 'err');
    setBusy(true);
    try {
      const p = await api.createProject(form);
      toast.push(`项目 ${p.name} 已创建`);
      setOpen(false);
      setParams({});
      setForm({ name: '', region: 'fra', plan: 'free', description: '' });
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(false); }
  };

  const remove = async (p: Project) => {
    if (!window.confirm(`删除项目 ${p.name}？其集合、函数、站点与文件都会一起删除。`)) return;
    try {
      await api.deleteProject(p.id);
      toast.push('项目已删除');
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
          <div className="eyebrow"><Layers size={12} /> WORKSPACE</div>
          <h1>Projects</h1>
          <p className="page-sub">
            每个项目拥有独立的集合、桶、函数、站点、成员与 API Key。切换项目只影响当前上下文，数据互不可见。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setOpen(true)}><Plus size={14} /> New project</button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="card"><Empty title="还没有项目" hint="创建一个项目开始使用" /></div>
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
                  {p.id === active && <Badge tone="ok" dot>current</Badge>}
                </div>
              </div>

              <p className="proj-desc">{p.description || 'No description yet.'}</p>

              <div className="proj-stats">
                <div><Database size={12} /><b>{p.stats?.collections ?? 0}</b><span>collections</span></div>
                <div><Boxes size={12} /><b>{p.stats?.functions ?? 0}</b><span>functions</span></div>
                <div><Globe2 size={12} /><b>{p.stats?.sites ?? 0}</b><span>sites</span></div>
                <div><Users2 size={12} /><b>{p.stats?.members ?? 0}</b><span>members</span></div>
              </div>

              <div className="proj-meta-row">
                <span className="mono">{p.region.toUpperCase()}</span>
                <span className="dim">·</span>
                <span>{p.plan}</span>
                <span className="dim">·</span>
                <span className="dim">created {timeAgo(p.createdAt)}</span>
              </div>

              <div className="proj-actions">
                <button className="btn sm" onClick={() => enter(p)}>
                  {p.id === active ? 'Open console' : 'Switch & open'} <ArrowRight size={12} />
                </button>
                <button className="btn sm ghost" onClick={() => { setProject(p.id); nav('/members'); }}>Members</button>
                <button className="icon-btn" style={{ marginLeft: 'auto' }} title="Delete project" onClick={() => remove(p)}>
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
        title="New project"
        subtitle="资源按项目隔离，可分别配置成员与权限"
        footer={
          <>
            <button className="btn ghost" onClick={() => { setOpen(false); setParams({}); }}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create project'}</button>
          </>
        }
      >
        <div className="field"><label>Name</label>
          <input className="input" placeholder="e.g. Acme Production" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></div>
        <div className="field-row">
          <div className="field"><label>Region</label>
            <select className="input" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })}>
              <option value="fra">Frankfurt (fra)</option>
              <option value="ams">Amsterdam (ams)</option>
              <option value="iad">Washington (iad)</option>
              <option value="sgp">Singapore (sgp)</option>
            </select>
          </div>
          <div className="field"><label>Plan</label>
            <select className="input" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
              <option value="free">Free</option>
              <option value="pro">Pro</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
        </div>
        <div className="field"><label>Description</label>
          <textarea className="input" rows={3} placeholder="What lives in this project?"
            value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
      </Modal>
    </div>
  );
}
