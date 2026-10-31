import { useEffect, useState } from 'react';
import { Users, UserPlus, Search, Trash2, ShieldCheck, Mail, RefreshCw, MoreHorizontal } from 'lucide-react';
import { api } from '../api';
import type { User } from '../types';
import { Badge, Empty, Loading, Modal, useToast } from '../components/ui';
import { fmtDate, initials, statusTone, timeAgo } from '../lib/format';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';

export default function Auth() {
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState({ name: '', email: '', password: '', labels: '' });
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const t = useT();
  const { can } = useAuth();

  const load = async (q = search) => {
    try { setUsers((await api.users(q)).users); } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(''); }, []);
  useEffect(() => {
    const timer = setTimeout(() => load(search), 250);
    return () => clearTimeout(timer);
  }, [search]);

  const create = async () => {
    setBusy(true);
    try {
      await api.createUser({
        name: form.name, email: form.email, password: form.password || undefined,
        labels: form.labels.split(',').map((s) => s.trim()).filter(Boolean),
      });
      toast.push(t('User created'));
      setOpen(false);
      setForm({ name: '', email: '', password: '', labels: '' });
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(false);
  };

  const toggleStatus = async (u: User) => {
    try {
      await api.updateUser(u.id, { status: u.status === 'blocked' ? 'active' : 'blocked' });
      toast.push(u.status === 'blocked' ? t('User unblocked') : t('User blocked'));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const verified = users.filter((u) => u.emailVerified).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Users size={11} /> {t('Auth')}</div>
          <h1>{t('Users')}</h1>
          <p>{t('Email/password, magic URL, OAuth and anonymous sessions — all with row-level permissions.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => load()}><RefreshCw size={14} /> {t('Refresh')}</button>
          <button className="btn primary" disabled={!can('users.write')} onClick={() => setOpen(true)}><UserPlus size={14} /> {t('Create user')}</button>
        </div>
      </div>

      <div className="grid-stats" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))' }}>
        <div className="stat">
          <div className="stat-label"><Users size={12} /> {t('Total users')}</div>
          <div className="stat-value">{users.length}</div>
          <div className="stat-foot">{t('{n} active', { n: users.filter((u) => u.status === 'active').length })}</div>
        </div>
        <div className="stat">
          <div className="stat-label"><ShieldCheck size={12} /> {t('Email verified')}</div>
          <div className="stat-value">{verified}</div>
          <div className="stat-foot">{t('{pct}% of users', { pct: users.length ? Math.round((verified / users.length) * 100) : 0 })}</div>
        </div>
        <div className="stat">
          <div className="stat-label"><Mail size={12} /> {t('Sessions')}</div>
          <div className="stat-value">{users.filter((u) => u.lastLoginAt).length}</div>
          <div className="stat-foot">{t('signed in during last 30 days')}</div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="searchbox">
            <Search size={13} />
            <input className="input" placeholder={t('Search by name or email…')} value={search} onChange={(e) => setSearch(e.target.value)}
              style={{ border: 0, background: 'transparent', height: 28, padding: 0, fontSize: 12 }} />
          </div>
          <div className="toolbar-spacer" />
          <span className="tiny dim">{t('{n} users', { n: users.length })}</span>
        </div>
        <div className="card-body tight">
          {loading ? <Loading rows={4} /> : users.length === 0 ? (
            <Empty title={t('No users found')} hint={t('Invite a user or adjust your search.')} icon={<Users size={26} />} />
          ) : (
            <table className="table">
              <thead>
                <tr><th>{t('User')}</th><th>{t('Status')}</th><th>{t('Labels')}</th><th>{t('Verified')}</th><th>{t('Last login')}</th><th>{t('Created')}</th><th /></tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="flex" style={{ gap: 10 }}>
                        <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'linear-gradient(140deg,#2b2b33,#1a1a20)', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 600 }}>
                          {initials(u.name)}
                        </div>
                        <div>
                          <div className="cell-main">{u.name}</div>
                          <div className="cell-sub">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td><Badge tone={statusTone(u.status)} dot>{u.status}</Badge></td>
                    <td>
                      <div className="flex" style={{ gap: 4, flexWrap: 'wrap' }}>
                        {u.labels.length ? u.labels.map((l) => <Badge key={l} tone="violet">{l}</Badge>) : <span className="dim tiny">—</span>}
                      </div>
                    </td>
                    <td>{u.emailVerified ? <ShieldCheck size={13} style={{ color: 'var(--green)' }} /> : <span className="dim tiny">{t('unverified')}</span>}</td>
                    <td className="dim tiny">{timeAgo(u.lastLoginAt)}</td>
                    <td className="dim tiny">{fmtDate(u.createdAt)}</td>
                    <td>
                      <div className="row-actions">
                        <button className="mini-btn" onClick={() => setEditing(u)}><MoreHorizontal size={13} /></button>
                        <button className="mini-btn danger" onClick={async () => {
                          if (!confirm(t('Delete user {name}?', { name: u.name }))) return;
                          await api.deleteUser(u.id); toast.push(t('User deleted')); load();
                        }}><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title={t('Create user')}
        subtitle={t('Users can sign in with email and password.')}
        footer={<>
          <button className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button>
          <button className="btn primary" disabled={!form.name || !form.email || busy} onClick={create}>{busy ? t('Creating…') : t('Create user')}</button>
        </>}
      >
        <div className="input-row">
          <div className="field">
            <label className="label">{t('Name')} <span className="req">*</span></label>
            <input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label className="label">{t('Email')} <span className="req">*</span></label>
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
        </div>
        <div className="field">
          <label className="label">{t('Temporary password')}</label>
          <input className="input" type="text" placeholder={t('Generated if left empty')} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </div>
        <div className="field">
          <label className="label">{t('Labels')}</label>
          <input className="input" placeholder="beta, vip" value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} />
        </div>
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.name || ''} subtitle={editing?.email}>
        {editing && (
          <>
            <dl className="kv" style={{ marginBottom: 16 }}>
              <dt>{t('User ID')}</dt><dd className="mono">{editing.id}</dd>
              <dt>{t('Status')}</dt><dd><Badge tone={statusTone(editing.status)}>{editing.status}</Badge></dd>
              <dt>{t('Verified')}</dt><dd>{editing.emailVerified ? t('Yes') : t('No')}</dd>
              <dt>{t('Created')}</dt><dd>{fmtDate(editing.createdAt)}</dd>
              <dt>{t('Last login')}</dt><dd>{timeAgo(editing.lastLoginAt)}</dd>
            </dl>
            <div className="flex">
              <button className="btn ghost sm" onClick={async () => {
                await api.updateUser(editing.id, { emailVerified: !editing.emailVerified });
                toast.push(t('Verification updated')); setEditing(null); load();
              }}>{t('Toggle verification')}</button>
              <button className="btn danger sm" onClick={() => { toggleStatus(editing); setEditing(null); }}>
                {editing.status === 'blocked' ? t('Unblock user') : t('Block user')}
              </button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
