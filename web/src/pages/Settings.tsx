import { useEffect, useState } from 'react';
import { Settings2, KeyRound, Sparkles, Plus, Trash2, ShieldAlert, Database as DbIcon, Globe2, Brain, Palette, Sun, Moon, Monitor } from 'lucide-react';
import { api } from '../api';
import type { ApiKey } from '../types';
import { Badge, CopyButton, Loading, Modal, useToast } from '../components/ui';
import { fmtDate, timeAgo } from '../lib/format';
import { LANGS } from '../lib/i18n';
import { useI18n } from '../lib/locale';
import { useTheme } from '../lib/theme';
import SsoCard from '../components/SsoCard';
import MfaCard from '../components/MfaCard';

const SCOPES = ['databases.read', 'databases.write', 'storage.read', 'storage.write', 'functions.execute', 'users.read', 'users.write', 'sites.write'];

export default function Settings() {
  const toast = useToast();
  const { t, lang, setLang } = useI18n();
  const { mode, setMode } = useTheme();
  const [project, setProject] = useState<any>(null);
  const [ai, setAi] = useState<{
    configured: boolean; provider: string; providerLabel: string; model: string;
    baseUrl: string; keyless: boolean; source: string; keyPreview: string;
  } | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('deepseek-chat');
  const [provider, setProvider] = useState('deepseek');
  const [baseUrl, setBaseUrl] = useState('');
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
      setProvider(a.provider);
      setBaseUrl(a.baseUrl);
      setKeys(k.keys);
    } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, []);

  const saveAi = async () => {
    setSaving(true);
    try {
      const r = await api.saveAiSettings({ apiKey, model, provider, baseUrl });
      setAi(r);
      setApiKey('');
      toast.push(t('AI configuration saved'));
    } catch (e: any) { toast.push(e.message, 'err'); }
    setSaving(false);
  };

  const createKey = async () => {
    try {
      const k = await api.createApiKey(keyForm.name || t('Untitled key'), keyForm.scopes);
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
          <div className="eyebrow"><Settings2 size={11} /> {t('Settings')}</div>
          <h1>{t('Project settings')}</h1>
          <p>{t('Manage your project, AI operator credentials and API access.')}</p>
        </div>
      </div>

      {!project ? <Loading /> : (
        <div className="stack">
          <MfaCard />

          <div className="card">
            <div className="card-head">
              <div className="card-title">{t('Project')}</div>
              <Badge tone="green" dot>{t('healthy')}</Badge>
            </div>
            <div className="card-body">
              <div className="input-row" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 18 }}>
                {[
                  { label: t('Name'), value: project.name, icon: DbIcon },
                  { label: t('Project ID'), value: project.id, icon: KeyRound, mono: true },
                  { label: t('Region'), value: String(project.region).toUpperCase(), icon: Globe2 },
                  { label: t('Plan'), value: project.plan, icon: Sparkles },
                ].map((x) => (
                  <div key={x.label}>
                    <div className="tiny dim flex" style={{ gap: 5, marginBottom: 5 }}><x.icon size={11} /> {x.label}</div>
                    <div className={x.mono ? 'mono' : ''} style={{ fontSize: 14, fontWeight: 550, textTransform: x.label === t('Plan') ? 'capitalize' : undefined }}>{x.value}</div>
                  </div>
                ))}
              </div>
              <div className="divider" />
              <div className="tiny dim">
                {t('Created {date} · The Studio BaaS API is available at {endpoint} on this host.', {
                  date: fmtDate(project.createdAt),
                  endpoint: '/v1',
                })}
              </div>
            </div>
          </div>

          <SsoCard />

          <div className="card">
            <div className="card-head">
              <div className="flex" style={{ gap: 8 }}>
                <Palette size={15} style={{ color: 'var(--violet-text)' }} />
                <div>
                  <div className="card-title">{t('Appearance')}</div>
                  <div className="card-sub">{t('Theme and interface language for this browser')}</div>
                </div>
              </div>
            </div>
            <div className="card-body">
              <div className="input-row" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 26 }}>
                <div>
                  <label className="label">{t('Theme')}</label>
                  <div className="seg">
                    <button className={mode === 'light' ? 'on' : ''} onClick={() => setMode('light')}>
                      <Sun size={12} /> {t('Light')}
                    </button>
                    <button className={mode === 'dark' ? 'on' : ''} onClick={() => setMode('dark')}>
                      <Moon size={12} /> {t('Dark')}
                    </button>
                    <button className={mode === 'system' ? 'on' : ''} onClick={() => setMode('system')}>
                      <Monitor size={12} /> {t('System')}
                    </button>
                  </div>
                  <div className="hint">{t('System follows your OS setting. Applies to this browser only.')}</div>
                </div>
                <div>
                  <label className="label">{t('Interface language')}</label>
                  <div className="seg">
                    {LANGS.map((l) => (
                      <button key={l.id} className={lang === l.id ? 'on' : ''} onClick={() => setLang(l.id)}>
                        {l.label}
                      </button>
                    ))}
                  </div>
                  <div className="hint">{t('Translates the console UI only — your data, code and keys stay untouched.')}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="flex" style={{ gap: 8 }}>
                <Brain size={15} style={{ color: 'var(--violet-text)' }} />
                <div>
                  <div className="card-title">{t('AI operator · {provider}', { provider: ai?.providerLabel || 'DeepSeek' })}</div>
                  <div className="card-sub">{t('Powers the console assistant with tool-calling across every service')}</div>
                </div>
              </div>
              <div style={{ marginLeft: 'auto' }}>
                <Badge tone={ai?.configured ? 'green' : 'amber'} dot>{ai?.configured ? t('Key configured') : t('Demo mode')}</Badge>
              </div>
            </div>
            <div className="card-body">
              <div className="input-row" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
                <div className="field">
                  <label className="label">{t('Provider')}</label>
                  <select
                    className="select"
                    value={provider}
                    onChange={(e) => {
                      const next = e.target.value;
                      setProvider(next);
                      // Presets exist so switching provider does not leave a
                      // half-configured form behind.
                      const preset: Record<string, { baseUrl: string; model: string }> = {
                        deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
                        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
                        ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
                        custom: { baseUrl: '', model: '' },
                      };
                      setBaseUrl(preset[next]?.baseUrl ?? '');
                      setModel(preset[next]?.model ?? '');
                    }}
                  >
                    <option value="deepseek">DeepSeek</option>
                    <option value="openai">OpenAI</option>
                    <option value="ollama">Ollama (local)</option>
                    <option value="custom">Custom / gateway</option>
                  </select>
                  <div className="hint">{t('Any OpenAI-compatible endpoint works.')}</div>
                </div>
                <div className="field">
                  <label className="label">{t('Model')}</label>
                  <input
                    className="input mono" list="ai-models" value={model}
                    onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat"
                  />
                  <datalist id="ai-models">
                    <option value="deepseek-chat" />
                    <option value="deepseek-reasoner" />
                    <option value="gpt-4o-mini" />
                    <option value="gpt-4o" />
                    <option value="llama3.1" />
                  </datalist>
                  <div className="hint">{t('Tool calling must be supported.')}</div>
                </div>
              </div>
              <div className="field">
                <label className="label">{t('API key')}</label>
                <input
                  className="input mono" type="password"
                  placeholder={ai?.keyPreview || (provider === 'ollama' ? t('not required for a local server') : 'sk-…')}
                  value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                />
                <div className="hint">
                  {ai?.source === 'env' ? t('Loaded from an environment variable (takes precedence).')
                    : ai?.source === 'settings' ? t('Stored in project settings · {preview}', { preview: ai.keyPreview })
                      : t('No key yet — the assistant runs in demo mode with a local rule engine that still executes real tools.')}
                </div>
              </div>
              <div className="field">
                <label className="label">{t('Base URL')}</label>
                <input
                  className="input mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'https://api.deepseek.com'}
                />
                <div className="hint">{t('Leave the default unless you route through a gateway.')}</div>
              </div>
              <div className="flex">
                <button className="btn primary" onClick={saveAi} disabled={saving}>{saving ? t('Saving…') : t('Save AI settings')}</button>
                <span className="tiny dim" style={{ marginLeft: 'auto' }}>
                  {t('The operator can read and write documents, deploy sites, edit and run functions.')}
                </span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div className="flex" style={{ gap: 8 }}>
                <KeyRound size={15} style={{ color: 'var(--amber-text)' }} />
                <div>
                  <div className="card-title">{t('API keys')}</div>
                  <div className="card-sub">{t('Server-side credentials with scoped access')}</div>
                </div>
              </div>
              <button className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={() => setNewKey(true)}>
                <Plus size={12} /> {t('Create key')}
              </button>
            </div>
            <div className="card-body tight">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Name')}</th><th>{t('Secret')}</th><th>{t('Scopes')}</th>
                    <th>{t('Last used')}</th><th>{t('Created')}</th><th />
                  </tr>
                </thead>
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
                          if (!confirm(t('Revoke API key “{name}”?', { name: k.name }))) return;
                          await api.deleteApiKey(k.id); toast.push(t('Key revoked')); load();
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
                <ShieldAlert size={15} style={{ color: 'var(--pink-text)' }} />
                <div>
                  <div className="card-title">{t('Security notes')}</div>
                  <div className="card-sub">{t('This studio is a local demo of the Appwrite platform')}</div>
                </div>
              </div>
            </div>
            <div className="card-body">
              <ul className="tiny muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
                <li>
                  {t('Function code runs in a dedicated')} <span className="mono">worker_threads</span>{' '}
                  {t('isolate: the timeout terminates the thread, so a runaway loop cannot stall the API. It is still a shared kernel, not a hardened container.')}
                </li>
                <li>{t('API keys are stored as SHA-256 digests — the plaintext is returned once on creation, and the list only shows a preview.')}</li>
                <li>
                  {t('Document-level permissions')} (<span className="mono">read(&quot;user:…&quot;)</span>, <span className="mono">team:…/role</span>){' '}
                  {t('are enforced on list, get, update and delete when a collection enables document security.')}
                </li>
                <li>
                  {t('Files are stored on the local filesystem under')} <span className="mono">server/data/uploads</span>
                  {t('; bucket encryption flags are metadata only in this demo.')}
                </li>
                <li>
                  <b>{t('View as role')}</b>{' '}
                  {t('is a demo affordance: without a session you can claim any role, but a signed-in session can only look down. Set')}{' '}
                  <span className="mono">STUDIO_ALLOW_ACT_AS=0</span> {t('to disable it.')}
                </li>
                <li>
                  {t('Never commit a real DeepSeek key. Prefer the')} <span className="mono">DEEPSEEK_API_KEY</span>{' '}
                  {t('environment variable.')}
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}

      <Modal open={newKey} onClose={() => setNewKey(false)} title={t('Create API key')}
        subtitle={t('Scopes limit what the key can do.')}
        footer={<>
          <button className="btn ghost" onClick={() => setNewKey(false)}>{t('Cancel')}</button>
          <button className="btn primary" onClick={createKey}>{t('Create key')}</button>
        </>}
      >
        <div className="field">
          <label className="label">{t('Name')}</label>
          <input className="input" autoFocus placeholder={t('Production server')} value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">{t('Scopes')}</label>
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

      <Modal open={!!created} onClose={() => setCreated(null)} title={t('API key created')}
        subtitle={t('Copy it now — only a SHA-256 digest is stored, so it cannot be shown again.')}
        footer={<button className="btn primary" onClick={() => setCreated(null)}>{t('Done')}</button>}
      >
        <div className="field">
          <label className="label">{t('Secret')}</label>
          <div className="flex">
            <input className="input mono" readOnly value={created?.secret || ''} />
            <CopyButton text={created?.secret || ''} />
          </div>
        </div>
        <div className="hint">
          {t('Send it as the')} <span className="mono">x-api-key</span> {t('header. The list only ever shows a preview.')}
        </div>
      </Modal>
    </div>
  );
}
