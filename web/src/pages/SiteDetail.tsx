import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Globe2, Rocket, RefreshCw, Monitor, Tablet, Smartphone, ExternalLink,
  FileCode2, FilePlus2, Trash2, Check, Loader2, Terminal, ChevronDown, ChevronRight, Plus, X,
} from 'lucide-react';
import { api } from '../api';
import type { Site, SiteFile } from '../types';
import CodeEditor from '../components/CodeEditor';
import { Badge, Loading, Modal, useToast } from '../components/ui';
import { statusTone, timeAgo } from '../lib/format';
import { useAuth } from '../lib/auth';

const langOf = (p: string) => (p.endsWith('.html') ? 'html' : p.endsWith('.css') ? 'css' : p.endsWith('.json') ? 'json' : 'javascript');

export default function SiteDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [site, setSite] = useState<Site | null>(null);
  const [files, setFiles] = useState<SiteFile[]>([]);
  const [current, setCurrent] = useState('index.html');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewKey, setPreviewKey] = useState(Date.now());
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [adding, setAdding] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [logsOpen, setLogsOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filesRef = useRef<SiteFile[]>([]);
  filesRef.current = files;

  const load = async () => {
    try {
      const s = await api.site(id!);
      setSite(s);
      setFiles(s.files);
      setCurrent(s.entrypoint || s.files[0]?.path || 'index.html');
      setDirty(false);
    } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); return () => { if (timer.current) clearTimeout(timer.current); }; }, [id]);

  const persist = async (list: SiteFile[], silent = true) => {
    if (!site) return;
    setSaving(true);
    try {
      const s = await api.updateSite(site.id, { files: list });
      setSite(s);
      setDirty(false);
      setPreviewKey(Date.now());
      if (!silent) toast.push('Saved & preview refreshed');
    } catch (e: any) { toast.push(e.message, 'err'); }
    setSaving(false);
  };

  const onChange = (content: string) => {
    const next = filesRef.current.map((f) => (f.path === current ? { ...f, content } : f));
    setFiles(next);
    setDirty(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => persist(next), 900);
  };

  const saveNow = () => {
    if (timer.current) clearTimeout(timer.current);
    persist(filesRef.current, false);
  };

  const addFile = () => {
    if (!newPath.trim()) return;
    const p = newPath.trim().replace(/^\/+/, '');
    if (files.some((f) => f.path === p)) { toast.push('File already exists', 'err'); return; }
    const next = [...files, { path: p, content: '' }];
    setFiles(next);
    setCurrent(p);
    setAdding(false);
    setNewPath('');
    persist(next, false);
  };

  const removeFile = (p: string) => {
    if (p === site?.entrypoint) { toast.push('Cannot delete the entrypoint file', 'err'); return; }
    const next = files.filter((f) => f.path !== p);
    setFiles(next);
    if (current === p) setCurrent(site?.entrypoint || next[0]?.path || 'index.html');
    persist(next, false);
  };

  const deploy = async () => {
    if (!site) return;
    if (dirty) await persist(filesRef.current);
    try {
      const s = await api.deploySite(site.id);
      setSite(s);
      setLogsOpen(true);
      toast.push('Deployment live');
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  if (!site) return <div className="page"><Loading rows={5} /></div>;
  const activeFile = files.find((f) => f.path === current) || files[0];
  const width = device === 'mobile' ? 390 : device === 'tablet' ? 768 : '100%';

  return (
    <div className="page" style={{ maxWidth: 1600 }}>
      <button className="back-btn" onClick={() => nav('/sites')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={13} /> All sites
      </button>

      <div className="detail-head" style={{ marginBottom: 14 }}>
        <div className="fn-title">
          <div style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(139,92,246,.14)', display: 'grid', placeItems: 'center', color: '#c4b5fd' }}>
            <Globe2 size={17} />
          </div>
          <div>
            <h1>{site.name}</h1>
            <div className="flex tiny dim" style={{ gap: 8, marginTop: 2 }}>
              <ExternalLink size={10} />
              <a href={site.domain} target="_blank" rel="noreferrer" className="mono">{site.domain}</a>
              <span>·</span><span>{site.framework}</span>
            </div>
          </div>
          <Badge tone={statusTone(site.status)} dot>{site.status}</Badge>
          {dirty && <Badge tone="amber">saving…</Badge>}
        </div>
        <div className="page-actions">
          <div className="flex" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 2 }}>
            <button className="mini-btn" style={{ background: device === 'desktop' ? 'rgba(255,255,255,.07)' : undefined }} onClick={() => setDevice('desktop')} title="Desktop"><Monitor size={13} /></button>
            <button className="mini-btn" style={{ background: device === 'tablet' ? 'rgba(255,255,255,.07)' : undefined }} onClick={() => setDevice('tablet')} title="Tablet"><Tablet size={13} /></button>
            <button className="mini-btn" style={{ background: device === 'mobile' ? 'rgba(255,255,255,.07)' : undefined }} onClick={() => setDevice('mobile')} title="Mobile"><Smartphone size={13} /></button>
          </div>
          <button className="btn ghost" onClick={saveNow} disabled={saving || !can('sites.write')}>
            {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {saving ? 'Saving' : 'Save'}
          </button>
          <button className="btn primary" disabled={!can('sites.deploy')} onClick={deploy}><Rocket size={14} /> Deploy</button>
        </div>
      </div>

      <div className="site-grid">
        <div className="stack" style={{ minHeight: 0 }}>
          <div className="file-tree" style={{ flex: 1 }}>
            <div className="flex" style={{ justifyContent: 'space-between' }}>
              <div className="tree-label">Files</div>
              <button className="mini-btn" onClick={() => setAdding(true)}><FilePlus2 size={12} /></button>
            </div>
            {files.map((f) => (
              <div key={f.path} className={`file-item ${current === f.path ? 'active' : ''}`} onClick={() => {
                if (dirty) persist(filesRef.current);
                setCurrent(f.path);
              }}>
                <FileCode2 size={13} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path}</span>
                {f.path !== site.entrypoint && current === f.path && (
                  <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); removeFile(f.path); }}><Trash2 size={10} /></button>
                )}
              </div>
            ))}
            <div className="tree-label" style={{ marginTop: 12 }}>Build logs</div>
            <div
              className="file-item" onClick={() => setLogsOpen(!logsOpen)}
              style={{ justifyContent: 'space-between' }}
            >
              <span className="flex" style={{ gap: 7 }}><Terminal size={12} /> latest build</span>
              {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </div>
            {logsOpen && (
              <div className="console" style={{ maxHeight: 180, marginTop: 4, padding: 8 }}>
                {site.buildLogs.map((l, i) => (
                  <div key={i} className="log-line" style={{ fontSize: 9.5, color: l.includes('✓') ? '#6ee7b7' : undefined }}>{l}</div>
                ))}
              </div>
            )}
          </div>
          <div className="card" style={{ padding: 12 }}>
            <div className="tiny dim" style={{ marginBottom: 6 }}>Live sync</div>
            <div className="flex" style={{ gap: 6, fontSize: 10.5, color: 'var(--muted)' }}>
              {saving ? <Loader2 size={11} className="spin" /> : <span className="status-dot" />}
              {saving ? 'Saving to edge…' : `Preview updated ${timeAgo(new Date(previewKey).toISOString())}`}
            </div>
            <div className="tiny dim" style={{ marginTop: 8, lineHeight: 1.5 }}>
              Edits auto-save after 0.9s and hot-reload the iframe.
            </div>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
          <div className="editor-head">
            <FileCode2 size={12} />
            <span className="file">{activeFile?.path}</span>
            {dirty && <span className="dirty-dot" />}
            <span style={{ marginLeft: 'auto' }}>{activeFile?.content.split('\n').length || 0} lines</span>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            <CodeEditor
              value={activeFile?.content || ''}
              onChange={onChange}
              language={langOf(activeFile?.path || 'index.html')}
              height="100%"
            />
          </div>
        </div>

        <div className="preview-pane" style={{ minHeight: 0 }}>
          <div className="preview-bar">
            <div className="preview-url">https://{site.domain}/{site.entrypoint}</div>
            <button className="mini-btn" onClick={() => setPreviewKey(Date.now())} title="Reload preview"><RefreshCw size={12} /></button>
            <a className="mini-btn" href={`/v1/sites/${site.id}/preview/${site.entrypoint}`} target="_blank" rel="noreferrer" title="Open in new tab"><ExternalLink size={12} /></a>
          </div>
          <div style={{ flex: 1, display: 'flex', justifyContent: 'center', background: '#06060a', minHeight: 0, padding: device === 'desktop' ? 0 : 10 }}>
            <iframe
              key={previewKey}
              src={`/v1/sites/${site.id}/preview/${site.entrypoint}?t=${previewKey}`}
              title="preview"
              style={{ width, height: '100%', border: 0, background: '#fff', borderRadius: device === 'desktop' ? 0 : 10, transition: 'width .25s ease' }}
            />
          </div>
          <div className="preview-bar" style={{ borderTop: '1px solid var(--line)', borderBottom: 0, justifyContent: 'space-between' }}>
            <span className="preview-status"><span className="status-dot" /> Live preview</span>
            <span className="preview-status">auto-saved · {files.length} files</span>
          </div>
        </div>
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="New file"
        subtitle="Add HTML, CSS, JS or any static asset path."
        footer={<>
          <button className="btn ghost" onClick={() => setAdding(false)}>Cancel</button>
          <button className="btn primary" disabled={!newPath} onClick={addFile}><Plus size={14} /> Create file</button>
        </>}
      >
        <div className="field">
          <label className="label">File path</label>
          <input className="input mono" autoFocus placeholder="about.html" value={newPath} onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addFile()} />
          <div className="hint">Relative to the site root, e.g. <span className="mono">assets/app.js</span></div>
        </div>
      </Modal>
    </div>
  );
}
