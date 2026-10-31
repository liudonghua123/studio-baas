import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Database, Plus, Search, Trash2, Pencil, RefreshCw, SlidersHorizontal,
  ChevronLeft, ChevronRight, Rows3, X, Check, Type, Hash, ToggleLeft, Calendar,
  Mail, Link2, List, AlignLeft, FileJson, Table2, ShieldCheck, ShieldOff, Lock, KeyRound,
} from 'lucide-react';
import IndexesModal from '../components/IndexesModal';
import { api } from '../api';
import type { Attribute, Collection, Doc } from '../types';
import { Badge, CopyButton, Drawer, Empty, Loading, Modal, useToast } from '../components/ui';
import { fmtDateTime, pretty, statusTone } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';

const ICONS: Record<string, string> = { package: '📦', 'shopping-bag': '🛍️', users: '👥', 'file-text': '📄', database: '🗄️' };
const TYPE_ICON: Record<string, any> = {
  string: Type, text: AlignLeft, integer: Hash, float: Hash, boolean: ToggleLeft,
  datetime: Calendar, email: Mail, url: Link2, enum: List,
};

const DEFAULT_PERMS = ['read("any")', 'update("users")', 'delete("users")'];

export default function Databases() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const t = useT();
  const { can, me } = useAuth();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [active, setActive] = useState<Collection | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [docLoading, setDocLoading] = useState(false);

  const [newCol, setNewCol] = useState(false);
  const [colForm, setColForm] = useState({ name: '', key: '', icon: 'database', color: '#6C5CE7', documentSecurity: false });
  const [attrModal, setAttrModal] = useState(false);
  const [idxModal, setIdxModal] = useState(false);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [docDrawer, setDocDrawer] = useState<'create' | 'edit' | null>(null);
  const [docData, setDocData] = useState<Record<string, any>>({});
  const [permText, setPermText] = useState('');
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('{}');
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ type: 'collection' | 'doc'; id: string; name: string } | null>(null);
  const LIMIT = 10;

  const loadCollections = async () => {
    try {
      const r = await api.collections();
      setCollections(r.collections);
      const found = r.collections.find((c) => c.id === id) || r.collections[0] || null;
      setActive(found);
      if (found && !id) nav(`/databases/${found.id}`, { replace: true });
    } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };

  const loadDocs = async (col: Collection | null = active, q = search, p = page) => {
    if (!col) return;
    setDocLoading(true);
    try {
      const r = await api.documents(col.id, { limit: LIMIT, offset: p * LIMIT, search: q });
      setDocs(r.documents);
      setTotal(r.total);
    } catch (e: any) { toast.push(e.message, 'err'); }
    setDocLoading(false);
  };

  useEffect(() => { loadCollections(); }, [id]);
  useEffect(() => { setPage(0); setSearch(''); }, [id]);
  useEffect(() => { if (active) loadDocs(active, search, page); }, [active?.id, page, search]);

  const columns = useMemo(() => {
    if (!active?.attributes) return [];
    return active.attributes.filter((a) => ['string', 'enum', 'integer', 'float', 'boolean', 'email', 'datetime'].includes(a.type)).slice(0, 4);
  }, [active]);

  const openCreate = () => {
    setEditing(null);
    setDocData({});
    setPermText(DEFAULT_PERMS.join('\n'));
    setJsonText('{}');
    setJsonMode(false);
    setDocDrawer('create');
  };
  const openEdit = (d: Doc) => {
    setEditing(d);
    setDocData({ ...d.data });
    setPermText((d.permissions?.length ? d.permissions : DEFAULT_PERMS).join('\n'));
    setJsonText(JSON.stringify(d.data, null, 2));
    setJsonMode(false);
    setDocDrawer('edit');
  };

  const parsePerms = () =>
    permText.split('\n').map((s) => s.trim()).filter(Boolean);

  const toggleSecurity = async () => {
    if (!active) return;
    try {
      const c = await api.updateCollection(active.id, { documentSecurity: !active.documentSecurity });
      toast.push(c.documentSecurity ? t('Document-level security enabled') : t('Document-level security disabled'));
      await loadCollections();
      await loadDocs();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const saveDoc = async () => {
    if (!active) return;
    // 提交前先做一遍必填/类型校验：避免为了一个空字段往返一次服务器，
    // 也把错误定位到具体输入框而不是只弹一条 toast
    if (!jsonMode) {
      const errs: Record<string, string> = {};
      for (const a of active.attributes || []) {
        const v = docData[a.key];
        const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
        if (a.required && empty) errs[a.key] = 'This field is required';
        else if (!empty && (a.type === 'integer' || a.type === 'float') && !Number.isFinite(Number(v))) {
          errs[a.key] = a.type === 'integer' ? 'Must be a whole number' : 'Must be a number';
        } else if (!empty && a.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) {
          errs[a.key] = 'Must be a valid email';
        }
      }
      setFieldErrors(errs);
      if (Object.keys(errs).length) {
        toast.push(t('{n} field(s) need attention', { n: Object.keys(errs).length }), 'err');
        return;
      }
    }
    setSaving(true);
    try {
      let payload = docData;
      if (jsonMode) {
        try { payload = JSON.parse(jsonText); } catch { throw new Error(t('Invalid JSON payload')); }
      }
      if (editing) {
        await api.updateDocument(active.id, editing.id, payload, active.documentSecurity ? parsePerms() : undefined);
        toast.push(t('Document updated'));
      } else {
        await api.createDocument(active.id, payload, active.documentSecurity ? parsePerms() : undefined);
        toast.push(t('Document created'));
      }
      setDocDrawer(null);
      loadDocs();
      loadCollections();
    } catch (e: any) { toast.push(e.message, 'err'); }
    setSaving(false);
  };

  const createCollection = async () => {
    setSaving(true);
    try {
      const c = await api.createCollection(colForm);
      toast.push(t('Collection “{name}” created', { name: c.name }));
      setNewCol(false);
      setColForm({ name: '', key: '', icon: 'database', color: '#6C5CE7', documentSecurity: false });
      await loadCollections();
      nav(`/databases/${c.id}`);
    } catch (e: any) { toast.push(e.message, 'err'); }
    setSaving(false);
  };

  const doDelete = async () => {
    if (!confirm) return;
    try {
      if (confirm.type === 'collection') {
        await api.deleteCollection(confirm.id);
        toast.push(t('Collection deleted'));
        setActive(null);
        nav('/databases');
        await loadCollections();
      } else if (active) {
        await api.deleteDocument(active.id, confirm.id);
        toast.push(t('Document deleted'));
        loadDocs();
        loadCollections();
      }
    } catch (e: any) { toast.push(e.message, 'err'); }
    setConfirm(null);
  };

  const pages = Math.max(1, Math.ceil(total / LIMIT));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Database size={11} /> {t('Databases')}</div>
          <h1>{t('Collections')}</h1>
          <p>{t('Model your data with typed attributes, document-level permissions and instant REST APIs.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => loadDocs()}><RefreshCw size={14} /> {t('Refresh')}</button>
          <button className="btn primary" onClick={() => setNewCol(true)}><Plus size={14} /> {t('Create collection')}</button>
        </div>
      </div>

      <div className="split-3">
        <div className="card" style={{ position: 'sticky', top: 12 }}>
          <div className="card-head" style={{ padding: '12px 14px' }}>
            <div className="card-title">{t('All collections')}</div>
            <span className="badge" style={{ marginLeft: 'auto' }}>{collections.length}</span>
          </div>
          <div className="col-list">
            {collections.map((c) => (
              <div
                key={c.id}
                className={`col-item pointer ${active?.id === c.id ? 'active' : ''}`}
                onClick={() => nav(`/databases/${c.id}`)}
              >
                <div className="col-icon" style={{ background: `${c.color}22`, color: c.color }}>{ICONS[c.icon] || '🗄️'}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="col-name">{c.name}</div>
                  <div className="col-key">{c.key}</div>
                </div>
                <span className="count">{c.documentCount}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: 8, borderTop: '1px solid var(--line)' }}>
            <button className="btn ghost sm" style={{ width: '100%' }} disabled={!can('databases.write')} title={can('databases.write') ? '' : t('Requires the developer role or above')} onClick={() => setNewCol(true)}><Plus size={12} /> {t('New collection')}</button>
          </div>
        </div>

        <div className="stack">
          {loading ? <div className="card"><Loading /></div> : !active ? (
            <div className="card"><Empty title={t('No collections yet')} hint={t('Create your first collection to start modeling data.')} icon={<Database size={26} />} /></div>
          ) : (
            <>
              <div className="card">
                <div className="card-head" style={{ alignItems: 'flex-start' }}>
                  <div className="col-icon" style={{ background: `${active.color}22`, color: active.color, width: 34, height: 34, borderRadius: 9, fontSize: 15 }}>
                    {ICONS[active.icon] || '🗄️'}
                  </div>
                  <div>
                    <div className="card-title" style={{ fontSize: 15 }}>{active.name}</div>
                    <div className="card-sub">
                      <span className="mono">{active.key}</span> · {t('{n} documents', { n: total })} · {t('{n} attributes', { n: active.attributes?.length || 0 })}
                    </div>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button className="btn sm ghost" onClick={() => setAttrModal(true)}><SlidersHorizontal size={12} /> {t('Attributes')}</button>
                    <button className="btn sm ghost" onClick={() => setIdxModal(true)}><KeyRound size={12} /> {t('Indexes')}</button>
                    <button className="btn sm danger" onClick={() => setConfirm({ type: 'collection', id: active.id, name: active.name })}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
                <div style={{ padding: '10px 18px', display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--line)' }}>
                  {active.attributes?.map((a) => {
                    const I = TYPE_ICON[a.type] || Type;
                    return (
                      <span key={a.id} className="badge" style={{ fontFamily: 'var(--mono)', fontSize: 10, gap: 5 }}>
                        <I size={10} style={{ opacity: 0.6 }} /> {a.key}
                        <span style={{ color: 'var(--dim)' }}>:{a.type}{a.required ? ' *' : ''}</span>
                      </span>
                    );
                  })}
                  {!active.attributes?.length && <span className="tiny dim">{t('No attributes — add one to start storing data.')}</span>}
                  <button
                    className={`btn sm ${active.documentSecurity ? '' : 'ghost'}`}
                    style={{ marginLeft: 'auto' }}
                    onClick={toggleSecurity}
                    disabled={!can('databases.write')}
                    title={active.documentSecurity
                      ? t('Each document decides who can read / write it')
                      : t('Access is decided by the project role only')}
                  >
                    {active.documentSecurity ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
                    {active.documentSecurity ? t('Document security') : t('No document security')}
                  </button>
                </div>

                <div className="toolbar">
                  <div className="searchbox">
                    <Search size={13} />
                    <input
                      className="input" placeholder={t('Search documents…')} value={search}
                      onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                      style={{ border: 0, background: 'transparent', height: 28, padding: 0, fontSize: 12 }}
                    />
                  </div>
                  <span className="tiny dim" style={{ marginLeft: 4 }}>{t('{n} total', { n: total })}</span>
                  <div className="toolbar-spacer" />
                  <button className="btn sm primary" disabled={!can('databases.write')} onClick={openCreate}><Plus size={12} /> {t('Add document')}</button>
                </div>

                <div className="card-body tight" style={{ overflowX: 'auto' }}>
                  {docLoading ? <Loading rows={4} /> : docs.length === 0 ? (
                    <Empty title={t('No documents')} hint={t('Add a document or adjust your search.')} icon={<Rows3 size={24} />} />
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 150 }}>{t('Document ID')}</th>
                          {columns.map((c) => <th key={c.id}>{c.key}</th>)}
                          <th style={{ width: 100 }}>{t('Updated')}</th>
                          <th style={{ width: 84 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {docs.map((d) => (
                          <tr key={d.id} className="pointer" onClick={() => openEdit(d)}>
                            <td>
                              <span className="row-id">{d.id}</span>
                              {active.documentSecurity && (
                                <span title={d.permissions?.join(' · ')} style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
                                  <Lock size={10} style={{ opacity: 0.4 }} />
                                </span>
                              )}
                            </td>
                            {columns.map((c) => (
                              <td key={c.id}>
                                {c.type === 'enum' || c.type === 'boolean' ? (
                                  <Badge tone={statusTone(String(d.data[c.key]))}>{pretty(d.data[c.key]) || '—'}</Badge>
                                ) : c.type === 'email' ? (
                                  <span className="cell-sub">{pretty(d.data[c.key]) || '—'}</span>
                                ) : (
                                  <span className="truncate" style={{ display: 'block', maxWidth: 220 }}>{pretty(d.data[c.key]) || <span className="dim">—</span>}</span>
                                )}
                              </td>
                            ))}
                            <td className="dim tiny">{fmtDateTime(d.updatedAt)}</td>
                            <td onClick={(e) => e.stopPropagation()}>
                              <div className="row-actions">
                                <button className="mini-btn" onClick={() => openEdit(d)}><Pencil size={12} /></button>
                                <button className="mini-btn danger" onClick={() => setConfirm({ type: 'doc', id: d.id, name: d.id })}><Trash2 size={12} /></button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                <div className="flex" style={{ padding: '10px 14px', borderTop: '1px solid var(--line)' }}>
                  <span className="tiny dim">{t('Showing {from}–{to} of {total}', { from: docs.length ? page * LIMIT + 1 : 0, to: page * LIMIT + docs.length, total })}</span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <button className="mini-btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft size={14} /></button>
                    <span className="tiny dim" style={{ padding: '0 6px', alignSelf: 'center' }}>{page + 1} / {pages}</span>
                    <button className="mini-btn" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></button>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">{t('REST endpoint')}</div>
                  <Badge tone="green" dot>{t('Live')}</Badge>
                </div>
                <div className="card-body" style={{ paddingTop: 12 }}>
                  <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <code className="mono" style={{ background: 'var(--code-bg)', border: '1px solid var(--line)', padding: '7px 10px', borderRadius: 7, color: 'var(--code-accent)' }}>
                      GET /v1/databases/collections/{active.id}/documents
                    </code>
                    <CopyButton text={`/v1/databases/collections/${active.id}/documents`} label={t('Copy')} />
                    <button className="btn sm ghost" onClick={() => nav('/docs')}>{t('API docs')}</button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* create collection */}
      <Modal
        open={newCol} onClose={() => setNewCol(false)} title={t('Create collection')}
        subtitle={t('Collections are typed tables exposed over REST and GraphQL.')}
        footer={<>
          <button className="btn ghost" onClick={() => setNewCol(false)}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!colForm.name || saving} onClick={createCollection}>{saving ? t('Creating…') : t('Create')}</button>
        </>}
      >
        <div className="field">
          <label className="label">{t('Name')} <span className="req">*</span></label>
          <input className="input" autoFocus placeholder={t('e.g. Reviews')} value={colForm.name}
            onChange={(e) => setColForm({ ...colForm, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">{t('Key')}</label>
          <input className="input mono" placeholder={t('auto-generated from name')} value={colForm.key}
            onChange={(e) => setColForm({ ...colForm, key: e.target.value })} />
          <div className="hint">{t('Lowercase identifier used in API calls. Must be unique.')}</div>
        </div>
        <div className="input-row">
          <div className="field">
            <label className="label">{t('Icon')}</label>
            <select className="select" value={colForm.icon} onChange={(e) => setColForm({ ...colForm, icon: e.target.value })}>
              <option value="database">{t('Database')}</option>
              <option value="package">{t('Package')}</option>
              <option value="shopping-bag">{t('Shopping bag')}</option>
              <option value="users">{t('Users')}</option>
              <option value="file-text">{t('Document')}</option>
            </select>
          </div>
          <div className="field">
            <label className="label">{t('Accent')}</label>
            <input type="color" className="input" style={{ height: 36, padding: 4 }} value={colForm.color}
              onChange={(e) => setColForm({ ...colForm, color: e.target.value })} />
          </div>
        </div>
        <label className="flex pointer" style={{ gap: 8, alignItems: 'flex-start', fontSize: 12, marginTop: 4 }}>
          <input type="checkbox" checked={colForm.documentSecurity}
            onChange={(e) => setColForm({ ...colForm, documentSecurity: e.target.checked })} style={{ marginTop: 2 }} />
          <span>
            {t('Document-level security')}
            <span className="hint" style={{ display: 'block', marginTop: 2 }}>
              {t('Each document carries its own')} <code className="mono">read("…")</code> {t('rules. Off by default — the project role decides.')}
            </span>
          </span>
        </label>
      </Modal>

      {/* indexes + query plan */}
      <IndexesModal
        open={idxModal} onClose={() => setIdxModal(false)} collection={active}
        onChanged={async () => { await loadCollections(); }}
      />

      {/* attributes */}
      <AttributeModal
        open={attrModal} onClose={() => setAttrModal(false)} collection={active}
        onChanged={async () => { await loadCollections(); await loadDocs(); }}
      />

      {/* document drawer */}
      <Drawer
        open={!!docDrawer} onClose={() => { setDocDrawer(null); setFieldErrors({}); }}
        title={editing ? t('Edit document') : t('New document')}
        subtitle={active ? `${active.name} · ${active.key}` : ''}
        footer={<>
          <button className="btn ghost" onClick={() => setDocDrawer(null)}>{t('Cancel')}</button>
          <button className="btn primary" onClick={saveDoc} disabled={saving}>
            <Check size={14} /> {saving ? t('Saving…') : editing ? t('Save changes') : t('Create document')}
          </button>
        </>}
      >
        <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="tiny dim">{editing ? <span className="mono">{editing.id}</span> : t('Fields marked * are required')}</div>
          <div className="flex" style={{ gap: 4 }}>
            <button className={`btn sm ${jsonMode ? 'ghost' : ''}`} onClick={() => setJsonMode(false)}><Table2 size={12} /> {t('Form')}</button>
            <button className={`btn sm ${jsonMode ? '' : 'ghost'}`} onClick={() => { setJsonText(JSON.stringify(docData, null, 2)); setJsonMode(true); }}>
              <FileJson size={12} /> JSON
            </button>
          </div>
        </div>
        {jsonMode ? (
          <textarea className="textarea mono" style={{ minHeight: 320, fontSize: 12 }} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
        ) : (
          active?.attributes?.map((a) => (
            <div key={a.id}>
              <DocField attr={a} value={docData[a.key]} error={fieldErrors[a.key]}
                onChange={(v) => {
                  setDocData((d) => ({ ...d, [a.key]: v }));
                  if (fieldErrors[a.key]) setFieldErrors((e) => { const n = { ...e }; delete n[a.key]; return n; });
                }} />
              {fieldErrors[a.key] && (
                <div className="tiny" style={{ color: 'var(--red-text)', marginTop: 2, marginBottom: 12 }}>
                  {t(fieldErrors[a.key])}
                </div>
              )}
            </div>
          ))
        )}
        {!active?.attributes?.length && <div className="hint">{t('This collection has no attributes. Use JSON mode to store arbitrary data.')}</div>}

        {active?.documentSecurity && (
          <div className="field" style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
            <label className="label"><Lock size={11} /> {t('Document permissions')}</label>
            <textarea
              className="textarea mono" style={{ minHeight: 92, fontSize: 12 }}
              value={permText} onChange={(e) => setPermText(e.target.value)}
              placeholder={'read("any")\nupdate("users")\ndelete("users")'}
            />
            <div className="hint">
              {t('One rule per line. Targets:')} <code className="mono">any</code>, <code className="mono">users</code>,
              {' '}<code className="mono">user:&lt;id&gt;</code>, <code className="mono">team:&lt;projectId&gt;/&lt;role&gt;</code>{t('.')}
              {' '}<code className="mono">write(…)</code> {t('covers update + delete. Read is enforced on list & get.')}
            </div>
            <div className="flex" style={{ gap: 6, marginTop: 4 }}>
              <button className="btn sm ghost" onClick={() => setPermText(DEFAULT_PERMS.join('\n'))}>{t('Use defaults')}</button>
              <button className="btn sm ghost" onClick={() => setPermText(`read("user:${me?.principal?.id || 'usr_x'}")\nupdate("user:${me?.principal?.id || 'usr_x'}")\ndelete("user:${me?.principal?.id || 'usr_x'}")`)}>
                {t('Only me')}
              </button>
            </div>
          </div>
        )}
      </Drawer>

      <Modal
        open={!!confirm} onClose={() => setConfirm(null)} title={t('Confirm deletion')}
        subtitle={t('This action cannot be undone.')}
        footer={<>
          <button className="btn ghost" onClick={() => setConfirm(null)}>{t('Cancel')}</button>
          <button className="btn danger" onClick={doDelete}>{confirm?.type === 'collection' ? t('Delete collection') : t('Delete document')}</button>
        </>}
      >
        <p style={{ margin: 0, fontSize: 13 }}>
          {confirm?.type === 'collection'
            ? <>{t('You are about to delete')} <b>{confirm?.name}</b> {t('and all of its documents.')}</>
            : <>{t('You are about to delete')} <b>{confirm?.name}</b>{t('.')}</>}
        </p>
      </Modal>
    </div>
  );
}

function DocField({ attr, value, onChange, error }: { attr: Attribute; value: any; onChange: (v: any) => void; error?: string }) {
  const t = useT();
  const I = TYPE_ICON[attr.type] || Type;
  if (attr.type === 'boolean') {
    return (
      <div className="field">
        <label className="label"><I size={11} /> {attr.key}</label>
        <label className="flex pointer" style={{ gap: 8, fontSize: 12 }}>
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {value ? 'true' : 'false'}
        </label>
      </div>
    );
  }
  if (attr.type === 'enum') {
    return (
      <div className="field">
        <label className="label"><I size={11} /> {attr.key}{attr.required && <span className="req">*</span>}</label>
        <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('— select —')}</option>
          {attr.elements?.map((el) => <option key={el} value={el}>{el}</option>)}
        </select>
      </div>
    );
  }
  if (attr.type === 'text') {
    return (
      <div className="field">
        <label className="label"><I size={11} /> {attr.key}{attr.required && <span className="req">*</span>}</label>
        <textarea className="textarea" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
      </div>
    );
  }
  return (
    <div className="field">
      <label className="label"><I size={11} /> {attr.key}{attr.required && <span className="req">*</span>}
        <span className="dim" style={{ marginLeft: 6, fontWeight: 400 }}>{attr.type}</span>
      </label>
      <input
        className="input" value={value ?? ''}
        type={attr.type === 'integer' || attr.type === 'float' ? 'number' : attr.type === 'datetime' ? 'date' : 'text'}
        onChange={(e) => onChange(attr.type === 'integer' || attr.type === 'float' ? e.target.value : e.target.value)}
      />
    </div>
  );
}

function AttributeModal({ open, onClose, collection, onChanged }: {
  open: boolean; onClose: () => void; collection: Collection | null; onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const t = useT();
  const [form, setForm] = useState({ key: '', type: 'string', required: false, elements: '' });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!collection) return;
    setBusy(true);
    try {
      await api.addAttribute(collection.id, {
        key: form.key, type: form.type, required: form.required,
        elements: form.type === 'enum' ? form.elements.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      });
      toast.push(t('Attribute added'));
      setForm({ key: '', type: 'string', required: false, elements: '' });
      await onChanged();
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <Modal open={open} onClose={onClose} title={t('Attributes')}
      subtitle={collection ? t('{name} schema', { name: collection.name }) : ''} wide
    >
      <div className="stack">
        <div className="card" style={{ background: 'var(--w1)' }}>
          <div className="card-body tight">
            <table className="table">
              <thead><tr><th>{t('Key')}</th><th>{t('Type')}</th><th>{t('Required')}</th><th>{t('Enum values')}</th><th /></tr></thead>
              <tbody>
                {collection?.attributes?.map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ color: 'var(--violet-text)' }}>{a.key}</td>
                    <td><Badge>{a.type}</Badge></td>
                    <td className="dim">{a.required ? t('yes') : t('no')}</td>
                    <td className="dim tiny">{a.elements?.join(', ') || '—'}</td>
                    <td className="right">
                      <button className="mini-btn danger" onClick={async () => {
                        try { await api.deleteAttribute(collection.id, a.id); toast.push(t('Attribute removed')); await onChanged(); }
                        catch (e: any) { toast.push(e.message, 'err'); }
                      }}><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
                {!collection?.attributes?.length && <tr><td colSpan={5} className="dim" style={{ textAlign: 'center', padding: 20 }}>{t('No attributes yet')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="divider" />
        <div className="section-title">{t('Add attribute')}</div>
        <div className="input-row">
          <div className="field">
            <label className="label">{t('Key')}</label>
            <input className="input mono" placeholder={t('e.g. rating')} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
          </div>
          <div className="field">
            <label className="label">{t('Type')}</label>
            <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {['string', 'text', 'integer', 'float', 'boolean', 'email', 'url', 'datetime', 'enum'].map((ty) => <option key={ty}>{ty}</option>)}
            </select>
          </div>
        </div>
        {form.type === 'enum' && (
          <div className="field">
            <label className="label">{t('Allowed values')}</label>
            <input className="input" placeholder={t('draft, published, archived')} value={form.elements} onChange={(e) => setForm({ ...form, elements: e.target.value })} />
          </div>
        )}
        <label className="flex pointer tiny" style={{ gap: 7 }}>
          <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />
          {t('Required attribute')}
        </label>
        <div className="flex">
          <button className="btn primary" disabled={!form.key || busy} onClick={add}><Plus size={14} /> {t('Add attribute')}</button>
          <button className="btn ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>{t('Done')}</button>
        </div>
      </div>
    </Modal>
  );
}
