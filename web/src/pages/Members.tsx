import React, { useEffect, useMemo, useState } from 'react';
import { Check, Crown, Minus, Plus, ShieldCheck, Trash2, UserPlus } from 'lucide-react';
import { api } from '../api';
import type { Member } from '../types';
import { Badge, Empty, Modal, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { ROLE_META, roleColor, roleLabel } from '../lib/roles';
import { timeAgo } from '../lib/format';

interface PermDef { id: string; group: string; label: string; roles: string[] }

export default function Members() {
  const toast = useToast();
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
      toast.push(`${m.name} → ${roleLabel(role)}`);
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const remove = async (m: Member) => {
    if (!window.confirm(`将 ${m.name} 从项目中移除？`)) return;
    try {
      await api.removeMember(m.id);
      toast.push('成员已移除');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const invite = async () => {
    if (!form.email.trim()) return toast.push('请填写邮箱', 'err');
    setBusy(true);
    try {
      await api.addMember(form);
      toast.push('已加入项目');
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
          <div className="eyebrow"><ShieldCheck size={12} /> ACCESS CONTROL</div>
          <h1>Members &amp; roles</h1>
          <p className="page-sub">
            角色是项目级的：同一个人在不同项目可以拥有不同权限。API Key 复用同一套权限点，人机同权。
          </p>
        </div>
        <div className="page-actions">
          <Badge tone="ok" dot>{roleLabel(me?.role)}</Badge>
          <button className="btn primary" disabled={!writable} title={writable ? '' : '需要 admin 及以上角色'}
            onClick={() => setOpen(true)}>
            <UserPlus size={14} /> Add member
          </button>
        </div>
      </div>

      <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.45fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Project members</div>
              <div className="card-sub">{members.length} people have access to this project</div>
            </div>
          </div>
          <div className="card-body tight">
            {members.length === 0 ? <Empty title="还没有成员" hint="从 Auth 里创建用户后再邀请" /> : (
              <table className="table">
                <thead>
                  <tr><th>Member</th><th>Role</th><th>Added</th><th style={{ width: 44 }} /></tr>
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
                            <div className="cell-main">{m.name}{m.email === 'alex@aurora.io' && <span className="tiny dim"> · you</span>}</div>
                            <div className="tiny dim">{m.email}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        {m.role === 'owner' ? (
                          <span className="role-pill" style={{ borderColor: 'rgba(253,54,110,.35)', color: '#ff8aa6' }}>
                            <Crown size={11} /> Owner
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
                              <option key={r.id} value={r.id}>{r.label}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="dim tiny">{timeAgo(m.addedAt)}</td>
                      <td>
                        <button className="icon-btn" disabled={!writable || m.role === 'owner'} onClick={() => remove(m)} title="Remove">
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
              <div className="card-title">Your access</div>
              <div className="card-sub">Resolved from your role in this project</div>
            </div>
            <Badge style={{ marginLeft: 'auto' }}>{me?.permissions?.length || 0} permissions</Badge>
          </div>
          <div className="card-body" style={{ maxHeight: 470, overflowY: 'auto' }}>
            {grouped.map((g) => (
              <div key={g.group} style={{ marginBottom: 10 }}>
                <div className="tiny dim" style={{ letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{g.group}</div>
                {g.items.map((p) => {
                  const allowed = !!me?.permissions?.includes(p.id);
                  return (
                    <div key={p.id} className="flex" style={{ justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
                      <span style={{ color: allowed ? 'var(--text)' : 'var(--dim)' }}>{p.label}</span>
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
            <div className="card-title">Permission matrix</div>
            <div className="card-sub">角色 × 权限点；API Key 的 scope 使用同一组权限点</div>
          </div>
        </div>
        <div className="card-body tight">
          <table className="matrix">
            <thead>
              <tr>
                <th>Permission</th>
                {ROLE_META.map((r) => (
                  <th key={r.id} className="c">
                    <span className="role-pill" style={{ borderColor: `${r.color}55`, color: r.color }}>{r.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => (
                <React.Fragment key={g.group}>
                  <tr className="group"><td colSpan={5}>{g.group}</td></tr>
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
        title="Add member"
        subtitle="被邀请人必须已经是该项目所在 Auth 中的用户"
        footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn primary" disabled={busy} onClick={invite}>{busy ? 'Adding…' : 'Add to project'}</button>
          </>
        }
      >
        <div className="field"><label>Email</label>
          <input className="input" placeholder="person@example.com" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} autoFocus /></div>
        <div className="field"><label>Role</label>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLE_META.filter((r) => r.id !== 'owner').map((r) => (
              <option key={r.id} value={r.id}>{r.label} — {r.description}</option>
            ))}
          </select>
        </div>
        <div className="tiny dim" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <Plus size={12} /> 需要新用户？先到 Auth 页面创建，再回来邀请。
        </div>
      </Modal>
    </div>
  );
}
