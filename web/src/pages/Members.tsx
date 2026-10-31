import React, { useEffect, useMemo, useState } from 'react';
import { Check, Crown, Minus, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { api } from '../api';
import type { Member } from '../types';
import { Badge, Empty, Modal, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { ROLE_META, roleColor, roleLabel } from '../lib/roles';
import { timeAgo } from '../lib/format';
import { useT } from '../lib/locale';

interface PermDef { id: string; group: string; label: string; roles: string[] }

export default function Members() {
  const toast = useToast();
  const t = useT();
  const { can, me } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [perms, setPerms] = useState<{ roles: any[]; permissions: PermDef[]; matrix: Record<string, string[]> } | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'developer' });
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [m, p] = await Promise.all([api.members(), api.permissions()]);
      setMembers(m.members);
      setPerms(p);
    } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const out: { group: string; items: PermDef[] }[] = [];
    for (const p of perms?.permissions || []) {
      const g = out.find((x) => x.group === p.group);
      if (g) g.items.push(p); else out.push({ group: p.group, items: [p] });
    }
    return out;
  }, [perms]);

  const changeRole = async (m: Member, role: string) => {
    try {
      await api.updateMember(m.id, role);
      toast.push(t('{name} → {role}', { name: m.name, role: t(roleLabel(role)) }));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const remove = async (m: Member) => {
    if (!window.confirm(t('Remove {name} from the project?', { name: m.name }))) return;
    try {
      await api.removeMember(m.id);
      toast.push(t('Member removed'));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const invite = async () => {
    if (!form.email.trim()) return toast.push(t('Email is required'), 'err');
    setBusy(true);
    try {
      await api.addMember(form);
      toast.push(t('Added to the project'));
      setOpen(false);
      setForm({ email: '', role: 'developer' });
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(false); }
  };

  const writable = can('members.write');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><ShieldCheck size={12} /> {t('Access control')}</div>
          <h1>{t('Members & roles')}</h1>
          <p className="page-sub">
            {t('Roles are scoped to a project: the same person can hold different permissions in different projects. API keys reuse the same permission points — humans and machines get equal rights.')}
          </p>
        </div>
        <div className="page-actions">
          <Badge tone="ok" dot>{t(roleLabel(me?.role))}</Badge>
          <button className="btn primary" disabled={!writable} title={writable ? '' : t('Requires admin or above')}
            onClick={() => setOpen(true)}>
            <UserPlus size={14} /> {t('Add member')}
          </button>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.45fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('Project members')}</div>
              <div className="card-sub">{t('{n} people have access to this project', { n: members.length })}</div>
            </div>
          </div>
          <div className="card-body tight">
            {members.length === 0 ? <Empty title={t('No members yet')} hint={t('Create a user in Auth, then invite them here.')} /> : (
              <table className="table">
                <thead>
                  <tr><th>{t('Member')}</th><th>{t('Role')}</th><th>{t('Added')}</th><th style={{ width: 44 }} /></tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <div className="member-row">
                          <div className="m-avatar" style={{ background: roleColor(m.role) }}>
                            {m.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}
                          </div>
                          <div>
                            <div className="cell-main">{m.name}{m.email === 'alex@aurora.io' && <span className="tiny dim"> · {t('you')}</span>}</div>
                            <div className="tiny dim">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {m.role === 'owner' ? (
                          <span className="role-pill" style={{ borderColor: 'rgba(253,54,110,.35)', color: 'var(--pink-text)' }}>
                            <Crown size={11} /> {t('Owner')}
                          </span>
                        ) : (
                          <select
                            className="input"
                            style={{ height: 28, width: 124, fontSize: 12 }}
                            value={m.role}
                            disabled={!writable}
                            onChange={(e) => changeRole(m, e.target.value)}
                          >
                            {ROLE_META.filter((r) => r.id !== 'owner').map((r) => (
                              <option key={r.id} value={r.id}>{t(r.label)}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="dim tiny">{timeAgo(m.addedAt)}</td>
                      <td>
                        <button className="icon-btn" disabled={!writable || m.role === 'owner'} onClick={() => remove(m)} title={t('Remove')}>
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('Your access')}</div>
              <div className="card-sub">{t('Resolved from your role in this project')}</div>
            </div>
            <Badge style={{ marginLeft: 'auto' }}>{t('{n} permissions', { n: me?.permissions?.length || 0 })}</Badge>
          </div>
          <div className="card-body" style={{ columnCount: 2, columnGap: 20 }}>
            {grouped.map((g) => (
              <div key={g.group} style={{ marginBottom: 10, breakInside: 'avoid' }}>
                <div className="tiny dim" style={{ letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{t(g.group)}</div>
                {g.items.map((p) => {
                  const allowed = !!me?.permissions?.includes(p.id);
                  return (
                    <div key={p.id} className="flex" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
                      <span style={{ color: allowed ? 'var(--text)' : 'var(--dim)' }}>{t(p.label)}</span>
                      {allowed ? <Check size={12} color="#00b894" /> : <Minus size={12} color="#4a4a58" />}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-head">
          <div>
            <div className="card-title">{t('Permission matrix')}</div>
            <div className="card-sub">{t('Roles × permission points; API key scopes use the same permission points.')}</div>
          </div>
        </div>
        <div className="card-body tight">
          <table className="matrix">
            <thead>
              <tr>
                <th>{t('Permission')}</th>
                {ROLE_META.map((r) => (
                  <th key={r.id} className="c">
                    <span className="role-pill" style={{ borderColor: `${r.color}55`, color: r.color }}>{t(r.label)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <React.Fragment key={g.group}>
                  <tr className="group"><td colSpan={5}>{t(g.group)}</td></tr>
                  {g.items.map((p) => (
                    <tr key={p.id}>
                      <td><span className="mono tiny" style={{ color: 'var(--muted)' }}>{p.id}</span></td>
                      {ROLE_META.map((r) => (
                        <td key={r.id} className="c">
                          {(perms?.matrix?.[r.id] || []).includes(p.id)
                            ? <Check size={13} color="#00b894" />
                            : <Minus size={12} color="#3a3a46" />}
                        </td>
                      ))}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('Add member')}
        subtitle={t('The invitee must already be a user in this project’s Auth.')}
        footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={invite}>{busy ? t('Adding…') : t('Add to project')}</button>
          </>
        }
      >
        <div className="field"><label>{t('Email')}</label>
          <input className="input" placeholder="person@example.com" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} autoFocus /></div>
        <div className="field"><label>{t('Role')}</label>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLE_META.filter((r) => r.id !== 'owner').map((r) => (
              <option key={r.id} value={r.id}>{t(r.label)} — {t(r.description)}</option>
            ))}
          </select>
        </div>
        <div className="tiny dim" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <Plus size={12} /> {t('Need a new user? Create one on the Auth page first, then come back to invite them.')}
        </div>
      </Modal>
    </div>
  );
}
