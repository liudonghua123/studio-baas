import { useEffect, useState } from 'react';
import { Settings2, KeyRound, Sparkles, Plus, Trash2, Copy, Check, ShieldAlert, Database as DbIcon, Globe2, Brain } from 'lucide-react';
import { api } from '../api';
import type { ApiKey } from '../types';
import { Badge, CopyButton, Loading, Modal, useToast } from '../components/ui';
import { fmtDate, fmtDateTime, timeAgo } from '../lib/format';

const SCOPES = ['databases.read', 'databases.write', 'storage.read', 'storage.write', 'functions.execute', 'users.read', 'users.write', 'sites.write'];

export default function Settings() {
  const toast = useToast();
  const [project, setProject] = useState<any>(null);
  const [ai, setAi] = useState<{ configured: boolean; model: string; source: string; keyPreview: string } | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('deepseek-chat');
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState(false);
  const [keyForm, setKeyForm] = useState({ name: '', scopes: ['databases.read', 'databases.write'] });
  const [created, setCreated] = useState<ApiKey | null>(null);

  const load = async () => {
    try {
      const [p, a, k] = await Promise.all([api.project(), api.aiSettings(), api.apiKeys()]);
      setProject(p);
      setAi(a);
      setModel(a.model);
      setKeys(k.keys);
    } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, []);

  const saveAi = async () => {
    setSaving(true);
    try {
      const r = await api.saveAiSettings({ apiKey, model });
      setAi(r);
      setApiKey('');
      toast.push('AI configuration saved');
    } catch (e: any) { toast.push(e.message, 'err'); }
    setSaving(false);
  };

  const createKey = async () => {
    try {
      const k = await api.createApiKey(keyForm.name || 'Untitled key', keyForm.scopes);
      setNewKey(false);
      setCreated(k);
      setKeyForm({ name: '', scopes: ['databases.read', 'databases.write'] });
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Settings2 size={11} /> Settings</div>
          <h1>Project settings</h1>
          <p>Manage your project, AI operator credentials and API access.</p>
        </div>
      </div>

      {!project ? <Loading /> : (
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <div className="card-title">Project</div>
              <Badge tone="green" dot>healthy</Badge>
            </div>
            <div className="card-body">
              <div className="input-row" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 18 }}>
                {[
                  { label: 'Name', value: project.name, icon: DbIcon },
                  { label: 'Project ID', value: project.id, icon: KeyRound, mono: true },
                  { label: 'Region', value: String(project.region).toUpperCase(), icon: Globe2 },
                  { label: 'Plan', value: project.plan, icon: Sparkles },
                ].map((x) => (
                  <div key={x.label}>
                    <div className="tiny dim flex" style={{ gap: 5, marginBottom: 5 }}><x.icon size={11} /> {x.label}</div>
                    <div className={x.mono ? 'mono' : ''} style={{ fontSize: 14, fontWeight: 550, textTransform: x.label === 'Plan' ? 'capitalize' : undefined }}>{x.value}</div>
                  </div>
                ))}
              </div>
              <div className="divider" />
              <div className="tiny dim">Created {fmtDate(project.createdAt)} · The Studio BaaS API is available at <span className="mono">/v1</span> on this host.</div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="flex" style={{ gap: 8 }}>
                <Brain size={15} style={{ color: '#c4b5fd' }} />
                <div>
                  <div className="card-title">AI operator · DeepSeek</div>
                  <div className="card-sub">Powers the console assistant with tool-calling across every service</div>
                </div>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <Badge tone={ai?.configured ? 'green' : 'amber'} dot>{ai?.configured ? 'Key configured' : 'Demo mode'}</Badge>
              </div>
            </div>
            <div className="card-body">
              <div className="input-row" style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
                <div className="field">
                  <label className="label">DeepSeek API key</label>
                  <input
                    className="input mono" type="password" placeholder={ai?.keyPreview || 'sk-…'}
                    value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  />
                  <div className="hint">
                    {ai?.source === 'env' ? 'Loaded from DEEPSEEK_API_KEY environment variable (takes precedence).'
                      : ai?.source === 'settings' ? `Stored in project settings · ${ai.keyPreview}`
                        : 'No key yet — the assistant runs in demo mode with a local rule engine that still executes real tools.'}
                  </div>
                </div>
                <div className="field">
                  <label className="label">Model</label>
                  <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="deepseek-chat">deepseek-chat</option>
                    <option value="deepseek-reasoner">deepseek-reasoner</option>
                  </select>
                  <div className="hint">OpenAI-compatible endpoint · api.deepseek.com</div>
                </div>
              </div>
              <div className="flex">
                <button className="btn primary" onClick={saveAi} disabled={saving}>{saving ? 'Saving…' : 'Save AI settings'}</button>
                <span className="tiny dim" style={{ marginLeft: 'auto' }}>
                  The operator can read/write documents, deploy sites, edit and run functions.
                </span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="flex" style={{ gap: 8 }}>
                <KeyRound size={15} style={{ color: '#fcd34d' }} />
                <div>
                  <div className="card-title">API keys</div>
                  <div className="card-sub">Server-side credentials with scoped access</div>
                </div>
              </div>
              <button className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={() => setNewKey(true)}><Plus size={12} /> Create key</button>
            </div>
            <div className="card-body tight">
              <table className="table">
                <thead><tr><th>Name</th><th>Secret</th><th>Scopes</th><th>Last used</th><th>Created</th><th /></tr></thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id}>
                      <td className="cell-main">{k.name}</td>
                      <td><span className="mono tiny dim">{k.preview || '—'}</span></td>
                      <td><div className="flex" style={{ gap: 4, flexWrap: 'wrap' }}>{k.scopes.slice(0, 2).map((s) => <Badge key={s} tone="violet">{s}</Badge>)}{k.scopes.length > 2 && <Badge>+{k.scopes.length - 2}</Badge>}</div></td>
                      <td className="dim tiny">{timeAgo(k.lastUsedAt)}</td>
                      <td className="dim tiny">{fmtDate(k.createdAt)}</td>
                      <td className="right">
                        <button className="mini-btn danger" onClick={async () => {
                          if (!confirm(`Revoke API key "${k.name}"?`)) return;
                          await api.deleteApiKey(k.id); toast.push('Key revoked'); load();
                        }}><Trash2 size={12} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card" style={{ borderColor: 'rgba(253,54,110,.2)' }}>
            <div className="card-head">
              <div className="flex" style={{ gap: 8 }}>
                <ShieldAlert size={15} style={{ color: '#ff8aa6' }} />
                <div>
                  <div className="card-title">Security notes</div>
                  <div className="card-sub">This studio is a local demo of the Appwrite platform</div>
                </div>
              </div>
            </div>
            <div className="card-body">
              <ul className="tiny muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                <li>Function code runs in a dedicated <span className="mono">worker_threads</span> isolate: the timeout terminates the thread, so a runaway loop can't stall the API. Still a shared kernel, not a hardened container.</li>
                <li>API keys are stored as SHA-256 digests — the plaintext is returned once on creation, and the list only shows a preview.</li>
                <li>Document-level permissions (<span className="mono">read("user:…")</span>, <span className="mono">team:…/role</span>) are enforced on list, get, update and delete when a collection enables document security.</li>
                <li>Files are stored on the local filesystem under <span className="mono">server/data/uploads</span>; bucket encryption flags are metadata only in this demo.</li>
                <li><b>View as role</b> is a demo affordance: without a session you can claim any role, but a signed-in session can only look <i>down</i>. Set <span className="mono">STUDIO_ALLOW_ACT_AS=0</span> to disable it.</li>
                <li>Never commit a real DeepSeek key. Prefer the <span className="mono">DEEPSEEK_API_KEY</span> environment variable.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      <Modal open={newKey} onClose={() => setNewKey(false)} title="Create API key"
        subtitle="Scopes limit what the key can do."
        footer={<>
          <button className="btn ghost" onClick={() => setNewKey(false)}>Cancel</button>
          <button className="btn primary" onClick={createKey}>Create key</button>
        </>}
      >
        <div className="field">
          <label className="label">Name</label>
          <input className="input" autoFocus placeholder="Production server" value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Scopes</label>
          <div className="flex-wrap" style={{ display: 'flex', gap: 6 }}>
            {SCOPES.map((s) => (
              <button key={s} className="chip" style={keyForm.scopes.includes(s) ? { borderColor: 'rgba(253,54,110,.5)', color: 'var(--text)' } : {}}
                onClick={() => setKeyForm((f) => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] }))}>
                {s}
              </button>
            ))}
          </div>
        </div>
      </Modal>

      <Modal open={!!created} onClose={() => setCreated(null)} title="API key created"
        subtitle="Copy it now — only a SHA-256 digest is stored, so it can't be shown again."
        footer={<button className="btn primary" onClick={() => setCreated(null)}>Done</button>}
      >
        <div className="field">
          <label className="label">Secret</label>
          <div className="flex">
            <input className="input mono" readOnly value={created?.secret || ''} />
            <button className="btn ghost" onClick={() => navigator.clipboard.writeText(created?.secret || '')}><Copy size={14} /></button>
          </div>
        </div>
        <div className="hint">Send it as the <span className="mono">x-api-key</span> header. The list only ever shows a preview.</div>
      </Modal>
    </div>
  );
}
