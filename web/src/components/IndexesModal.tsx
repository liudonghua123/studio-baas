import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Gauge, KeyRound, Plus, Search, Trash2, Zap } from 'lucide-react';
import { api } from '../api';
import type { Collection, CollectionIndex, QueryPlan } from '../types';
import { Badge, Empty, Modal, useToast } from './ui';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { useT } from '../lib/locale';

const META_ATTRS = ['$id', '$createdAt', '$updatedAt'];

/**
 * 索引管理 + 查询计划检查器。
 *
 * 计划检查器是这个功能的「可信度来源」：它调用的是真实执行那条 SQL 的
 * EXPLAIN QUERY PLAN（后端共用同一个 SQL 构造函数），所以「用了哪个索引」
 * 不是前端的猜测。
 */
export default function IndexesModal({
  open, onClose, collection, onChanged,
}: {
  open: boolean; onClose: () => void; collection: Collection | null;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const { can } = useAuth();
  const writable = can('databases.write');

  const [tab, setTab] = useState<'indexes' | 'plan'>('indexes');
  const [list, setList] = useState<CollectionIndex[]>([]);
  const [busy, setBusy] = useState(false);

  const [key, setKey] = useState('');
  const [type, setType] = useState<'key' | 'unique'>('key');
  const [picked, setPicked] = useState<string[]>([]);
  const [dirs, setDirs] = useState<Record<string, 'ASC' | 'DESC'>>({});

  const [queryText, setQueryText] = useState('');
  const [plan, setPlan] = useState<QueryPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  const attrs = useMemo(
    () => (collection?.attributes || []).filter((a) => !a.array).map((a) => a.key),
    [collection],
  );
  const candidates = useMemo(() => [...META_ATTRS, ...attrs], [attrs]);

  const load = async () => {
    if (!collection) return;
    try { setList((await api.indexes(collection.id)).indexes); }
    catch (e: any) { toast.push(e.message, 'err'); }
  };

  useEffect(() => {
    if (open && collection) {
      load();
      setKey('');
      setPicked([]);
      setDirs({});
      setPlan(null);
      setPlanError(null);
      setQueryText(attrs[0] ? `equal("${attrs[0]}","")` : 'orderDesc("$createdAt")');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, collection?.id]);

  const toggle = (a: string) => {
    setPicked((cur) => {
      const next = cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a];
      if (!cur.includes(a) && !key) setKey(next.join('_').replace(/^\$/, ''));
      return next;
    });
  };

  const create = async () => {
    if (!collection) return;
    if (!key.trim() || !picked.length) { toast.push(t('A key and at least one attribute are required'), 'err'); return; }
    setBusy(true);
    try {
      const idx = await api.createIndex(collection.id, {
        key: key.trim(), type, attributes: picked,
        orders: picked.map((a) => dirs[a] || 'ASC'),
      });
      if (idx.status === 'failed') {
        toast.push(t('Index saved but not built: {error}', { error: idx.error ?? '' }), 'err');
      } else {
        toast.push(t('Index “{key}” is available', { key: idx.key }));
      }
      setKey(''); setPicked([]); setDirs({});
      await load();
      onChanged?.();
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(false);
  };

  const remove = async (idx: CollectionIndex) => {
    if (!collection) return;
    try {
      await api.deleteIndex(collection.id, idx.id);
      toast.push(t('Index “{key}” dropped', { key: idx.key }));
      await load();
      onChanged?.();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const runPlan = async () => {
    if (!collection) return;
    setPlanBusy(true); setPlanError(null);
    try {
      const queries = queryText.split('\n').map((s) => s.trim()).filter(Boolean);
      setPlan(await api.queryPlan(collection.id, { 'queries[]': queries, limit: 25 }));
    } catch (e: any) {
      setPlan(null); setPlanError(e.message);
    }
    setPlanBusy(false);
  };

  const verdict = (p: QueryPlan) => p.fullScan
    ? { tone: 'red', label: 'Full table scan' }
    : p.narrowed
      ? { tone: 'green', label: 'Index lookup' }
      : { tone: 'amber', label: 'Collection scan' };

  return (
    <Modal open={open} onClose={onClose} title={t('Indexes')}
      subtitle={collection ? `${collection.name} · ${collection.key}` : ''} wide
    >
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button className={`tab ${tab === 'indexes' ? 'active' : ''}`} onClick={() => setTab('indexes')}>
          <KeyRound size={13} /> {t('Indexes')}
        </button>
        <button className={`tab ${tab === 'plan' ? 'active' : ''}`} onClick={() => setTab('plan')}>
          <Gauge size={13} /> {t('Query plan')}
        </button>
      </div>

      {tab === 'indexes' ? (
        <div className="stack">
          <div className="card" style={{ background: 'var(--w1)' }}>
            <div className="card-body tight">
              <table className="table">
                <thead>
                  <tr><th>{t('Key')}</th><th>{t('Type')}</th><th>{t('Attributes')}</th><th>{t('Status')}</th><th style={{ width: 90 }}>{t('Created')}</th><th /></tr>
                </thead>
                <tbody>
                  {list.map((i) => (
                    <tr key={i.id}>
                      <td className="mono" style={{ color: 'var(--violet-text)' }}>{i.key}</td>
                      <td><Badge tone={i.type === 'unique' ? 'blue' : ''}>{i.type}</Badge></td>
                      <td className="mono tiny">
                        {i.attributes.map((a, n) => (
                          <span key={a}>
                            {n > 0 && <span className="dim">, </span>}
                            {a}
                            <span className="dim">{i.type === 'unique' ? '' : ` ${i.orders[n] || 'ASC'}`}</span>
                          </span>
                        ))}
                      </td>
                      <td>
                        {i.status === 'available'
                          ? <Badge tone="green" dot>{t('available')}</Badge>
                          : <Badge tone="red" dot>{t('failed')}</Badge>}
                        {i.status === 'failed' && i.error && (
                          <div className="tiny" style={{ color: 'var(--danger)', marginTop: 4 }}>{i.error}</div>
                        )}
                      </td>
                      <td className="dim tiny">{timeAgo(i.createdAt)}</td>
                      <td className="right">
                        <button className="mini-btn danger" disabled={!writable} onClick={() => remove(i)} title={t('Drop index')}>
                          <Trash2 size={12} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!list.length && (
                    <tr><td colSpan={6} className="dim" style={{ textAlign: 'center', padding: 20 }}>
                      {t('No indexes — every filtered query scans the whole collection.')}
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="divider" />
          <div className="section-title">{t('New index')}</div>
          <div className="input-row">
            <div className="field">
              <label className="label">{t('Key')}</label>
              <input className="input mono" placeholder="status_total" value={key}
                onChange={(e) => setKey(e.target.value)} />
            </div>
            <div className="field" style={{ maxWidth: 160 }}>
              <label className="label">{t('Type')}</label>
              <select className="select" value={type} onChange={(e) => setType(e.target.value as 'key' | 'unique')}>
                <option value="key">key</option>
                <option value="unique">unique</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label className="label">{t('Attributes (order matters — leftmost is used first)')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {candidates.map((a) => {
                const on = picked.includes(a);
                const pos = picked.indexOf(a) + 1;
                return (
                  <button key={a} type="button"
                    className={`btn sm ${on ? '' : 'ghost'}`}
                    style={{ fontFamily: 'var(--mono)', fontSize: 11 }}
                    onClick={() => toggle(a)}>
                    {on ? <Check size={11} /> : <Plus size={11} />}
                    {a}{on && ` ${pos}`}
                    {on && type === 'key' && (
                      <span
                        role="button"
                        tabIndex={0}
                        title={t('Toggle sort direction')}
                        style={{ marginLeft: 4, opacity: 0.7 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDirs((d) => ({ ...d, [a]: (d[a] || 'ASC') === 'ASC' ? 'DESC' : 'ASC' }));
                        }}
                      >
                        {(dirs[a] || 'ASC') === 'ASC' ? '↑' : '↓'}
                      </span>
                    )}
                  </button>
                );
              })}
              {!candidates.length && <span className="tiny dim">{t('Add an attribute first.')}</span>}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              {t('A composite index serves filters on its')} <i>{t('prefix')}</i>: <code className="mono">(status, total)</code>{' '}
              {t('accelerates')} <code className="mono">equal("status")</code> {t('and')}{' '}
              <code className="mono">equal("status") + greaterThan("total")</code>{t(', but')}{' '}
              <code className="mono">greaterThan("total")</code> {t('on its own is not served. Unique indexes reject duplicate values inside this collection only.')}
            </div>
          </div>

          <div className="flex" style={{ justifyContent: 'flex-end' }}>
            <button className="btn primary" disabled={!writable || busy} onClick={create}>
              <Plus size={13} /> {busy ? t('Building…') : t('Create index')}
            </button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <div className="field">
            <label className="label">{t('Query (one Appwrite query per line)')}</label>
            <textarea className="input mono" rows={3} value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder={'equal("status","paid")\ngreaterThan("total",300)\norderDesc("$createdAt")'} />
            <div className="hint">{t('This runs the same')} <span className="mono">EXPLAIN QUERY PLAN</span> {t('the list endpoint would execute.')}</div>
          </div>
          <div className="flex">
            <button className="btn primary" onClick={runPlan} disabled={planBusy}>
              <Search size={13} /> {planBusy ? t('Explaining…') : t('Explain')}
            </button>
            {collection?.attributes?.length ? (
              <span className="tiny dim">{t('Try: {queries}', { queries: collection.attributes.slice(0, 3).map((a) => `equal("${a.key}","…")`).join(' · ') })}</span>
            ) : null}
          </div>

          {planError && (
            <div className="card" style={{ borderColor: 'rgba(255,107,107,0.4)' }}>
              <div className="card-body tiny" style={{ color: 'var(--danger)' }}>{planError}</div>
            </div>
          )}

          {plan && (
            <>
              <div className="card" style={{ background: 'var(--w1)' }}>
                <div className="card-body">
                  <div className="flex" style={{ gap: 10 }}>
                    <Badge tone={verdict(plan).tone} dot>{t(verdict(plan).label)}</Badge>
                    {plan.index && <span className="mono tiny">{plan.index}</span>}
                    {plan.tempBTree && <Badge tone="amber"><AlertTriangle size={10} /> {t('temp B-tree sort')}</Badge>}
                  </div>
                  <div className="tiny dim" style={{ marginTop: 8 }}>
                    {plan.fullScan
                      ? t('No index matched — SQLite reads every document in the collection.')
                      : plan.narrowed
                        ? t('Index conditions: {terms}', { terms: plan.terms.join(' · ') })
                        : t('Only collectionId is served by the index, so the whole collection is still scanned. Add an index that starts with your filter attribute.')}
                  </div>
                </div>
              </div>

              <div className="card" style={{ background: 'var(--w1)' }}>
                <div className="card-body tight">
                  <table className="table">
                    <thead><tr><th style={{ width: 44 }}>id</th><th style={{ width: 60 }}>parent</th><th>detail</th></tr></thead>
                    <tbody>
                      {plan.plan.map((s) => (
                        <tr key={s.id}>
                          <td className="mono tiny dim">{s.id}</td>
                          <td className="mono tiny dim">{s.parent}</td>
                          <td className="mono tiny">{s.detail}</td>
                        </tr>
                      ))}
                      {!plan.plan.length && <tr><td colSpan={3} className="dim" style={{ textAlign: 'center', padding: 16 }}>{t('No plan rows')}</td></tr>}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="tiny dim mono" style={{ wordBreak: 'break-all' }}>
                <Zap size={11} style={{ verticalAlign: -1 }} /> {plan.sql}
              </div>
            </>
          )}

          {!plan && !planError && (
            <Empty title={t('No plan yet')} hint={t('Run Explain to see whether the query can use an index.')} icon={<Gauge size={22} />} />
          )}
        </div>
      )}
    </Modal>
  );
}
