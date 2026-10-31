import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Database, Plus, Search, Trash2, Pencil, RefreshCw, SlidersHorizontal,
  ChevronLeft, ChevronRight, Rows3, X, Check, Type, Hash, ToggleLeft, Calendar,
  Mail, Link2, List, AlignLeft, FileJson, Table2,
} from 'lucide-react';
import { api } from '../api';
import type { Attribute, Collection, Doc } from '../types';
import { Badge, CopyButton, Drawer, Empty, Loading, Modal, useToast } from '../components/ui';
import { fmtDateTime, pretty, statusTone } from '../lib/format';
import { useAuth } from '../lib/auth';

const ICONS: Record<string, string> = { package: '📦', 'shopping-bag': '🛍️', users: '👥', 'file-text': '📄', database: '🗄️' };
const TYPE_ICON: Record<string, any> = {
  string: Type, text: AlignLeft, integer: Hash, float: Hash, boolean: ToggleLeft,
  datetime: Calendar, email: Mail, url: Link2, enum: List,
};

export default function Databases() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [active, setActive] = useState<Collection | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [docLoading, setDocLoading] = useState(false);

  const [newCol, setNewCol] = useState(false);
  const [colForm, setColForm] = useState({ name: '', key: '', icon: 'database', color: '#6C5CE7' });
  const [attrModal, setAttrModal] = useState(false);
  const [editing, setEditing] = useState<Doc | null>(null);
  const [docDrawer, setDocDrawer] = useState<'create' | 'edit' | null>(null);
  const [docData, setDocData] = useState<Record<string, any>>({});
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState('{}');
  const [saving, setSaving] = useState(false);
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
    setJsonText('{}');
    setJsonMode(false);
    setDocDrawer('create');
  };
  const openEdit = (d: Doc) => {
    setEditing(d);
    setDocData({ ...d.data });
    setJsonText(JSON.stringify(d.data, null, 2));
    setJsonMode(false);
    setDocDrawer('edit');
  };

  const saveDoc = async () => {
    if (!active) return;
    setSaving(true);
    try {
      let payload = docData;
      if (jsonMode) {
        try { payload = JSON.parse(jsonText); } catch { throw new Error('Invalid JSON payload'); }
      }
      if (editing) {
        await api.updateDocument(active.id, editing.id, payload);
        toast.push('Document updated');
      } else {
        await api.createDocument(active.id, payload);
        toast.push('Document created');
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
      toast.push(`Collection "${c.name}" created`);
      setNewCol(false);
      setColForm({ name: '', key: '', icon: 'database', color: '#6C5CE7' });
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
        toast.push('Collection deleted');
        setActive(null);
        nav('/databases');
        await loadCollections();
      } else if (active) {
        await api.deleteDocument(active.id, confirm.id);
        toast.push('Document deleted');
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
          <div className="eyebrow"><Database size={11} /> Databases</div>
          <h1>Collections</h1>
          <p>Model your data with typed attributes, document-level permissions and instant REST APIs.</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => loadDocs()}><RefreshCw size={14} /> Refresh</button>
          <button className="btn primary" onClick={() => setNewCol(true)}><Plus size={14} /> Create collection</button>
        </div>
      </div>

      <div className="split-3">
        <div className="card" style={{ position: 'sticky', top: 12 }}>
          <div className="card-head" style={{ padding: '12px 14px' }}>
            <div className="card-title">All collections</div>
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
            <button className="btn ghost sm" style={{ width: '100%' }} disabled={!can('databases.write')} title={can('databases.write') ? '' : '需要 developer 及以上角色'} onClick={() => setNewCol(true)}><Plus size={12} /> New collection</button>
          </div>
        </div>

        <div className="stack">
          {loading ? <div className="card"><Loading /></div> : !active ? (
            <div className="card"><Empty title="No collections yet" hint="Create your first collection to start modeling data." icon={<Database size={26} />} /></div>
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
                      <span className="mono">{active.key}</span> · {total} documents · {active.attributes?.length || 0} attributes
                    </div>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <button className="btn sm ghost" onClick={() => setAttrModal(true)}><SlidersHorizontal size={12} /> Attributes</button>
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
                  {!active.attributes?.length && <span className="tiny dim">No attributes — add one to start storing data.</span>}
                </div>

                <div className="toolbar">
                  <div className="searchbox">
                    <Search size={13} />
                    <input
                      className="input" placeholder="Search documents…" value={search}
                      onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                      style={{ border: 0, background: 'transparent', height: 28, padding: 0, fontSize: 12 }}
                    />
                  </div>
                  <span className="tiny dim" style={{ marginLeft: 4 }}>{total} total</span>
                  <div className="toolbar-spacer" />
                  <button className="btn sm primary" disabled={!can('databases.write')} onClick={openCreate}><Plus size={12} /> Add document</button>
                </div>

                <div className="card-body tight" style={{ overflowX: 'auto' }}>
                  {docLoading ? <Loading rows={4} /> : docs.length === 0 ? (
                    <Empty title="No documents" hint="Add a document or adjust your search." icon={<Rows3 size={24} />} />
                  ) : (
                    <table className="table">
                      <thead>
                        <tr>
                          <th style={{ width: 150 }}>Document ID</th>
                          {columns.map((c) => <th key={c.id}>{c.key}</th>)}
                          <th style={{ width: 100 }}>Updated</th>
                          <th style={{ width: 84 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {docs.map((d) => (
                          <tr key={d.id} className="pointer" onClick={() => openEdit(d)}>
                            <td><span className="row-id">{d.id}</span></td>
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
                  <span className="tiny dim">Showing {docs.length ? page * LIMIT + 1 : 0}–{page * LIMIT + docs.length} of {total}</span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <button className="mini-btn" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}><ChevronLeft size={14} /></button>
                    <span className="tiny dim" style={{ padding: '0 6px', alignSelf: 'center' }}>{page + 1} / {pages}</span>
                    <button className="mini-btn" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></button>
                  </div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <div className="card-title">REST endpoint</div>
                  <Badge tone="green" dot>Live</Badge>
                </div>
                <div className="card-body" style={{ paddingTop: 12 }}>
                  <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <code className="mono" style={{ background: '#08080c', border: '1px solid var(--line)', padding: '7px 10px', borderRadius: 7, color: '#a5b4fc' }}>
                      GET /v1/databases/collections/{active.id}/documents
                    </code>
                    <CopyButton text={`/v1/databases/collections/${active.id}/documents`} label="Copy" />
                    <button className="btn sm ghost" onClick={() => nav('/docs')}>API docs</button>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* create collection */}
      <Modal
        open={newCol} onClose={() => setNewCol(false)} title="Create collection"
        subtitle="Collections are typed tables exposed over REST and GraphQL."
        footer={<>
          <button className="btn ghost" onClick={() => setNewCol(false)}>Cancel</button>
          <button className="btn primary" disabled={!colForm.name || saving} onClick={createCollection}>{saving ? 'Creating…' : 'Create'}</button>
        </>}
      >
        <div className="field">
          <label className="label">Name <span className="req">*</span></label>
          <input className="input" autoFocus placeholder="e.g. Reviews" value={colForm.name}
            onChange={(e) => setColForm({ ...colForm, name: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">Key</label>
          <input className="input mono" placeholder="auto-generated from name" value={colForm.key}
            onChange={(e) => setColForm({ ...colForm, key: e.target.value })} />
          <div className="hint">Lowercase identifier used in API calls. Must be unique.</div>
        </div>
        <div className="input-row">
          <div className="field">
            <label className="label">Icon</label>
            <select className="select" value={colForm.icon} onChange={(e) => setColForm({ ...colForm, icon: e.target.value })}>
              <option value="database">Database</option>
              <option value="package">Package</option>
              <option value="shopping-bag">Shopping bag</option>
              <option value="users">Users</option>
              <option value="file-text">Document</option>
            </select>
          </div>
          <div className="field">
            <label className="label">Accent</label>
            <input type="color" className="input" style={{ height: 36, padding: 4 }} value={colForm.color}
              onChange={(e) => setColForm({ ...colForm, color: e.target.value })} />
          </div>
        </div>
      </Modal>

      {/* attributes */}
      <AttributeModal
        open={attrModal} onClose={() => setAttrModal(false)} collection={active}
        onChanged={async () => { await loadCollections(); await loadDocs(); }}
      />

      {/* document drawer */}
      <Drawer
        open={!!docDrawer} onClose={() => setDocDrawer(null)}
        title={editing ? 'Edit document' : 'New document'}
        subtitle={active ? `${active.name} · ${active.key}` : ''}
        footer={<>
          <button className="btn ghost" onClick={() => setDocDrawer(null)}>Cancel</button>
          <button className="btn primary" onClick={saveDoc} disabled={saving}>
            <Check size={14} /> {saving ? 'Saving…' : editing ? 'Save changes' : 'Create document'}
          </button>
        </>}
      >
        <div className="flex" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <div className="tiny dim">{editing ? <span className="mono">{editing.id}</span> : 'Fields marked * are required'}</div>
          <div className="flex" style={{ gap: 4 }}>
            <button className={`btn sm ${jsonMode ? 'ghost' : ''}`} onClick={() => setJsonMode(false)}><Table2 size={12} /> Form</button>
            <button className={`btn sm ${jsonMode ? '' : 'ghost'}`} onClick={() => { setJsonText(JSON.stringify(docData, null, 2)); setJsonMode(true); }}>
              <FileJson size={12} /> JSON
            </button>
          </div>
        </div>
        {jsonMode ? (
          <textarea className="textarea mono" style={{ minHeight: 320, fontSize: 12 }} value={jsonText} onChange={(e) => setJsonText(e.target.value)} />
        ) : (
          active?.attributes?.map((a) => (
            <DocField key={a.id} attr={a} value={docData[a.key]} onChange={(v) => setDocData((d) => ({ ...d, [a.key]: v }))} />
          ))
        )}
        {!active?.attributes?.length && <div className="hint">This collection has no attributes. Use JSON mode to store arbitrary data.</div>}
      </Drawer>

      <Modal
        open={!!confirm} onClose={() => setConfirm(null)} title="Confirm deletion"
        subtitle={`This action cannot be undone.`}
        footer={<>
          <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
          <button className="btn danger" onClick={doDelete}>Delete {confirm?.type === 'collection' ? 'collection' : 'document'}</button>
        </>}
      >
        <p style={{ margin: 0, fontSize: 13 }}>
          You are about to delete <b>{confirm?.name}</b>
          {confirm?.type === 'collection' ? ' and all of its documents.' : '.'}
        </p>
      </Modal>
    </div>
  );
}

function DocField({ attr, value, onChange }: { attr: Attribute; value: any; onChange: (v: any) => void }) {
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
          <option value="">— select —</option>
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
      toast.push('Attribute added');
      setForm({ key: '', type: 'string', required: false, elements: '' });
      await onChanged();
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(false);
  };

  return (
    <Modal open={open} onClose={onClose} title="Attributes"
      subtitle={collection ? `${collection.name} schema` : ''} wide
    >
      <div className="stack">
        <div className="card" style={{ background: 'rgba(255,255,255,0.02)' }}>
          <div className="card-body tight">
            <table className="table">
              <thead><tr><th>Key</th><th>Type</th><th>Required</th><th>Enum values</th><th /></tr></thead>
              <tbody>
                {collection?.attributes?.map((a) => (
                  <tr key={a.id}>
                    <td className="mono" style={{ color: '#c4b5fd' }}>{a.key}</td>
                    <td><Badge>{a.type}</Badge></td>
                    <td className="dim">{a.required ? 'yes' : 'no'}</td>
                    <td className="dim tiny">{a.elements?.join(', ') || '—'}</td>
                    <td className="right">
                      <button className="mini-btn danger" onClick={async () => {
                        try { await api.deleteAttribute(collection.id, a.id); toast.push('Attribute removed'); await onChanged(); }
                        catch (e: any) { toast.push(e.message, 'err'); }
                      }}><Trash2 size={12} /></button>
                    </td>
                  </tr>
                ))}
                {!collection?.attributes?.length && <tr><td colSpan={5} className="dim" style={{ textAlign: 'center', padding: 20 }}>No attributes yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div className="divider" />
        <div className="section-title">Add attribute</div>
        <div className="input-row">
          <div className="field">
            <label className="label">Key</label>
            <input className="input mono" placeholder="e.g. rating" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
          </div>
          <div className="field">
            <label className="label">Type</label>
            <select className="select" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {['string', 'text', 'integer', 'float', 'boolean', 'email', 'url', 'datetime', 'enum'].map((t) => <option key={t}>{t}</option>)}
            </select>
          </div>
        </div>
        {form.type === 'enum' && (
          <div className="field">
            <label className="label">Allowed values</label>
            <input className="input" placeholder="draft, published, archived" value={form.elements} onChange={(e) => setForm({ ...form, elements: e.target.value })} />
          </div>
        )}
        <label className="flex pointer tiny" style={{ gap: 7 }}>
          <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} />
          Required attribute
        </label>
        <div className="flex">
          <button className="btn primary" disabled={!form.key || busy} onClick={add}><Plus size={14} /> Add attribute</button>
          <button className="btn ghost" onClick={onClose} style={{ marginLeft: 'auto' }}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
