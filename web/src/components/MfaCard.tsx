import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, Copy, Fingerprint, KeyRound, Loader2, Plus, RefreshCw,
  ShieldCheck, Smartphone, Trash2, Users, X,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Modal, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { useT } from '../lib/locale';
import { createPasskey, explainWebauthnError, passkeysSupported } from '../lib/webauthn';
import type { MfaGap, MfaPolicy, MfaStatus, User } from '../types';

/**
 * Settings → Two-factor authentication。
 *
 * 上半部分是「我自己的因素」：所有人可见，因为每个人都要能管自己的账号。
 * 下半部分是「谁必须开」：只有 admin 及以上能看到，改一行规则就等于
 * 把一个角色整体推到强制登录流程里，所以复用 sso.* 那种边界（mfa.read/write）。
 */

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', developer: 'Developer', viewer: 'Viewer',
};

type EnrollView =
  | { step: 'totp'; methodId: string; secret: string; uri: string }
  | { step: 'codes'; codes: string[] }
  | null;

export default function MfaCard() {
  const t = useT();
  const toast = useToast();
  const { can, reload: reloadMe } = useAuth();

  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [enroll, setEnroll] = useState<EnrollView>(null);
  const [code, setCode] = useState('');
  const [passkeyOpen, setPasskeyOpen] = useState(false);
  const [passkeyName, setPasskeyName] = useState('');

  // 管理员区
  const [policies, setPolicies] = useState<MfaPolicy[]>([]);
  const [gaps, setGaps] = useState<MfaGap[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [draft, setDraft] = useState<{ scope: string; target: string; mode: string }[]>([]);
  const [addScope, setAddScope] = useState<'role' | 'user'>('role');
  const [addTarget, setAddTarget] = useState('admin');
  const [addMode, setAddMode] = useState<'required' | 'exempt'>('required');

  const canManage = can('mfa.read');

  const load = async () => {
    try {
      const s = await api.mfaStatus();
      setStatus(s);
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally { setLoading(false); }
  };

  const loadPolicies = async () => {
    if (!canManage) return;
    try {
      const r = await api.mfaPolicies();
      setPolicies(r.policies);
      setGaps(r.gaps);
    } catch { /* 权限在渲染时已判过，这里失败多半是刚被降权 */ }
  };

  useEffect(() => { void load(); }, []);
  useEffect(() => { void loadPolicies(); }, [canManage]);

  // 强制注册的用户会被路由送到 /settings?focus=mfa —— 滚到卡片上，别让人找
  useEffect(() => {
    if (loading) return;
    if (new URLSearchParams(window.location.search).get('focus') === 'mfa') {
      document.getElementById('mfa')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [loading]);

  const verified = useMemo(
    () => (status?.methods || []).filter((m) => m.verified),
    [status],
  );

  /* --------------------------------------------------------------- 注册 TOTP */
  const startTotp = async () => {
    setBusy('totp-begin');
    try {
      const r = await api.mfaTotpBegin();
      setCode('');
      setEnroll({ step: 'totp', methodId: r.methodId, secret: r.secret, uri: r.uri });
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally { setBusy(''); }
  };

  const confirmTotp = async () => {
    if (enroll?.step !== 'totp') return;
    setBusy('totp-confirm');
    try {
      const r = await api.mfaTotpConfirm(enroll.methodId, code);
      setEnroll({ step: 'codes', codes: r.recoveryCodes });
      await load();
      reloadMe();
      toast.push(t('Authenticator added'), 'ok');
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally { setBusy(''); }
  };

  /* ------------------------------------------------------------ 注册 Passkey */
  const startPasskey = async () => {
    setBusy('passkey');
    try {
      const { ticket, options } = await api.mfaPasskeyBegin(passkeyName.trim() || undefined);
      const response = await createPasskey(options);
      await api.mfaPasskeyFinish(ticket, response);
      setPasskeyOpen(false);
      setPasskeyName('');
      await load();
      reloadMe();
      toast.push(t('Passkey added'), 'ok');
    } catch (e: any) {
      toast.push(explainWebauthnError(e), 'err');
    } finally { setBusy(''); }
  };

  /* -------------------------------------------------------------- 管理与策略 */
  const removeMethod = async (id: string, name: string) => {
    if (!window.confirm(t('Remove "{name}"? You will not be able to use it to sign in any more.', { name }))) return;
    try {
      const r = await api.mfaDelete(id);
      await load();
      if (r.warning) toast.push(t(r.warning), 'err');
      else toast.push(t('Second factor removed'), 'ok');
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const regenerate = async () => {
    if (!window.confirm(t('Generate a new set of recovery codes? The old ones stop working immediately.'))) return;
    try {
      const r = await api.mfaRegenerateRecovery();
      setEnroll({ step: 'codes', codes: r.codes });
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const openPolicy = async () => {
    setDraft(policies.map((p) => ({ scope: p.scope, target: p.target, mode: p.mode })));
    setPolicyOpen(true);
    if (!users.length) {
      try { const r = await api.users(); setUsers(r.users); } catch { /* 忽略 */ }
    }
  };

  const addRule = () => {
    if (!addTarget) return;
    if (draft.some((r) => r.scope === addScope && r.target === addTarget)) {
      return toast.push(t('That rule already exists'), 'err');
    }
    setDraft((d) => [...d, { scope: addScope, target: addTarget, mode: addMode }]);
  };

  const savePolicy = async () => {
    setBusy('policy');
    try {
      const r = await api.mfaSavePolicies(draft);
      setPolicies(r.policies);
      setGaps(r.gaps);
      setPolicyOpen(false);
      await load();
      toast.push(t('Two-factor policy saved'), 'ok');
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally { setBusy(''); }
  };

  const copyText = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.push(t('Copied'), 'ok'); }
    catch { toast.push(text, 'ok'); }
  };

  if (loading) {
    return <div className="card"><div className="card-body"><Loader2 size={16} className="spin" /></div></div>;
  }

  const mustEnroll = status?.required && verified.length === 0;
  const policyForMe = policies.find((p) => p.scope === 'role' && p.target === (status?.role || ''));

  return (
    <>
      <div className={`card mfa-card${mustEnroll ? ' needs-action' : ''}`} id="mfa">
        <div className="card-head">
          <ShieldCheck size={15} />
          <div>
            <div className="card-title">{t('Two-factor authentication')}</div>
            <div className="card-sub">{t('A second proof of identity on top of your password')}</div>
          </div>
          <div className="page-actions">
            <button className="btn ghost sm" onClick={startTotp} disabled={!!busy}>
              {busy === 'totp-begin' ? <Loader2 size={13} className="spin" /> : <Smartphone size={13} />}
              {t('Authenticator app')}
            </button>
            {passkeysSupported() && (
              <button className="btn ghost sm" onClick={() => setPasskeyOpen(true)} disabled={!!busy}>
                <Fingerprint size={13} /> {t('Passkey')}
              </button>
            )}
          </div>
        </div>

        {mustEnroll ? (
          <div className="mfa-banner danger">
            <AlertTriangle size={15} />
            <div>
              <b>{t('Your role requires two-factor authentication')}</b>
              <p>{t('Add an authenticator app or a passkey to unlock the rest of the console. Until then only this page is available.')}</p>
            </div>
          </div>
        ) : status?.required ? (
          <div className="mfa-banner ok">
            <CheckCircle2 size={15} />
            <div>
              <b>{t('Two-factor is required for your role and it is set up')}</b>
              <p>{t('You will be asked for it every time you sign in.')}</p>
            </div>
          </div>
        ) : (
          <div className="mfa-banner">
            <ShieldCheck size={15} />
            <div>
              <b>{verified.length ? t('Two-factor is on for your account') : t('Two-factor is not required for you')}</b>
              <p>{verified.length
                ? t('Your project does not force it, but you can keep it on — it costs 20 seconds per sign-in.')
                : t('You can add it anyway; an admin can also require it for a role or a person.')}</p>
            </div>
          </div>
        )}

        {verified.length === 0 ? (
          <div className="card-body">
            <div className="sso-empty">
              <KeyRound size={20} />
              <div>
                <b>{t('No second factor yet')}</b>
                <p>{t('Use an authenticator app (TOTP) or a passkey. Recovery codes are issued once the first factor is confirmed.')}</p>
              </div>
            </div>
          </div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('Method')}</th>
                <th>{t('Added')}</th>
                <th>{t('Last used')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {verified.map((m) => (
                <tr key={m.id}>
                  <td>
                    <div className="flex" style={{ gap: 8, alignItems: 'center' }}>
                      {m.type === 'totp'
                        ? <Smartphone size={14} style={{ color: 'var(--violet-text)' }} />
                        : <Fingerprint size={14} style={{ color: 'var(--pink-text)' }} />}
                      <div>
                        <b style={{ fontWeight: 550 }}>{m.name}</b>
                        <div className="hint" style={{ margin: 0 }}>
                          {m.type === 'totp' ? t('Authenticator app') : t('Passkey')}
                          {m.transports.length ? ` · ${m.transports.join(', ')}` : ''}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="dim">{timeAgo(m.createdAt)}</td>
                  <td className="dim">{m.lastUsedAt ? timeAgo(m.lastUsedAt) : t('never')}</td>
                  <td>
                    <div className="row-actions" style={{ opacity: 1 }}>
                      <button className="icon-btn" title={t('Remove')} onClick={() => removeMethod(m.id, m.name)}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {verified.length > 0 && (
          <div className="sso-foot">
            <KeyRound size={12} />
            <span>{t('Recovery codes left: {n}', { n: status?.recoveryCodesLeft ?? 0 })}</span>
            <button className="linklike" style={{ marginLeft: 'auto' }} onClick={regenerate}>
              <RefreshCw size={11} style={{ verticalAlign: -1, marginRight: 4 }} />
              {t('Generate new codes')}
            </button>
          </div>
        )}

        {/* -------------------------------------------------- 管理员：策略 */}
        {canManage && (
          <>
            <div className="mfa-section-head">
              <Users size={14} />
              <div>
                <b>{t('Who must use it')}</b>
                <div className="hint" style={{ margin: 0 }}>
                  {t('Rules apply per project. A person-level exemption beats every role rule.')}
                </div>
              </div>
              <button className="btn ghost sm" onClick={openPolicy} style={{ marginLeft: 'auto' }}>
                <Plus size={13} /> {t('Edit policy')}
              </button>
            </div>

            <div className="card-body" style={{ paddingTop: 0 }}>
              {policies.length === 0 ? (
                <p className="hint" style={{ margin: 0 }}>{t('No rule yet — two-factor is optional for everyone in this project.')}</p>
              ) : (
                <div className="mfa-rules">
                  {policies.map((p) => (
                    <span key={p.id} className={`mfa-rule ${p.mode}`}>
                      {p.scope === 'user'
                        ? <>{t('User')} <b>{users.find((u) => u.id === p.target)?.email || p.target}</b></>
                        : <b>{t(ROLE_LABEL[p.target] || p.target)}</b>}
                      <em>{p.mode === 'required' ? t('required') : t('exempt')}</em>
                    </span>
                  ))}
                </div>
              )}

              {gaps.length > 0 && (
                <div className="mfa-gaps">
                  <b>{t('Required but not set up ({n})', { n: gaps.length })}</b>
                  <div className="mfa-gap-list">
                    {gaps.map((g) => (
                      <span key={g.userId} className="mfa-gap" title={`${g.email} · ${g.role}`}>
                        {g.name || g.email}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {policyForMe && (
                <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
                  {t('Your role ({role}) is on the list, so you will be challenged at sign-in.', { role: t(ROLE_LABEL[status?.role || ''] || status?.role || '') })}
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {/* ------------------------------------------------------- 绑定 TOTP */}
      <Modal
        open={!!enroll}
        onClose={() => { setEnroll(null); setCode(''); }}
        title={enroll?.step === 'codes' ? t('Save these recovery codes') : t('Add an authenticator app')}
        subtitle={enroll?.step === 'codes'
          ? t('Each code works once. They are shown only now.')
          : t('Any TOTP app works: 1Password, Authy, Google Authenticator, Microsoft Authenticator.')}
        footer={enroll?.step === 'codes' ? (
          <button className="btn primary" onClick={() => setEnroll(null)}>{t('Done')}</button>
        ) : (
          <>
            <button className="btn ghost" onClick={() => setEnroll(null)}>{t('Cancel')}</button>
            <button className="btn primary" onClick={confirmTotp} disabled={code.replace(/\D/g, '').length !== 6 || busy === 'totp-confirm'}>
              {busy === 'totp-confirm' ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
              {t('Verify and enable')}
            </button>
          </>
        )}
      >
        {enroll?.step === 'totp' ? (
          <div className="stack">
            <div className="field">
              <label className="label">{t('Secret key')}</label>
              <div className="flex" style={{ gap: 8 }}>
                <code className="mfa-secret">{enroll.secret}</code>
                <button className="icon-btn" onClick={() => copyText(enroll.secret)} title={t('Copy')}>
                  <Copy size={13} />
                </button>
              </div>
              <p className="hint">{t('Choose “Enter a setup key manually” in the app, then paste this key.')}</p>
            </div>
            <div className="field">
              <label className="label">{t('Code from the app')}</label>
              <input
                className="input otp-input" value={code} autoFocus
                onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                inputMode="numeric" autoComplete="one-time-code" placeholder="000000"
              />
            </div>
            <button className="linklike" onClick={() => copyText(enroll.uri)}>{t('Copy setup link (otpauth://)')}</button>
          </div>
        ) : enroll?.step === 'codes' ? (
          <div className="stack">
            <div className="mfa-codes">
              {enroll.codes.map((c) => <code key={c}>{c}</code>)}
            </div>
            <div className="flex" style={{ gap: 8 }}>
              <button className="btn ghost sm" onClick={() => copyText(enroll.codes.join('\n'))}>
                <Copy size={12} /> {t('Copy all')}
              </button>
              <button
                className="btn ghost sm"
                onClick={() => {
                  const blob = new Blob([`Studio BaaS recovery codes\n\n${enroll.codes.join('\n')}\n`], { type: 'text/plain' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = 'studio-baas-recovery-codes.txt';
                  a.click();
                  URL.revokeObjectURL(a.href);
                }}
              >
                {t('Download')}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* -------------------------------------------------------- 绑定 Passkey */}
      <Modal
        open={passkeyOpen}
        onClose={() => setPasskeyOpen(false)}
        title={t('Add a passkey')}
        subtitle={t('Your browser will ask for your fingerprint, face or device PIN.')}
        footer={
          <>
            <button className="btn ghost" onClick={() => setPasskeyOpen(false)}>{t('Cancel')}</button>
            <button className="btn primary" onClick={startPasskey} disabled={busy === 'passkey'}>
              {busy === 'passkey' ? <Loader2 size={13} className="spin" /> : <Fingerprint size={13} />}
              {t('Continue')}
            </button>
          </>
        }
      >
        <div className="field">
          <label className="label">{t('Name')}</label>
          <input
            className="input" value={passkeyName} autoFocus
            onChange={(e) => setPasskeyName(e.target.value)}
            placeholder={t('e.g. MacBook Touch ID')}
          />
          <p className="hint">{t('The private key never leaves your device. The server only stores the public half.')}</p>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- 编辑策略 */}
      <Modal
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        title={t('Two-factor policy')}
        subtitle={t('Require a second factor for a role or a specific person. Exemptions always win.')}
        wide
        footer={
          <>
            <button className="btn ghost" onClick={() => setPolicyOpen(false)}>{t('Cancel')}</button>
            <button className="btn primary" onClick={savePolicy} disabled={busy === 'policy'}>
              {busy === 'policy' ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />}
              {t('Save policy')}
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="mfa-rule-editor">
            <select className="input" value={addScope} onChange={(e) => {
              const scope = e.target.value as 'role' | 'user';
              setAddScope(scope);
              setAddTarget(scope === 'role' ? 'admin' : (users[0]?.id || ''));
            }}>
              <option value="role">{t('By role')}</option>
              <option value="user">{t('By person')}</option>
            </select>
            <select className="input" value={addTarget} onChange={(e) => setAddTarget(e.target.value)}>
              {addScope === 'role'
                ? ['owner', 'admin', 'developer', 'viewer'].map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r])}</option>)
                : users.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
            </select>
            <select className="input" value={addMode} onChange={(e) => setAddMode(e.target.value as 'required' | 'exempt')}>
              <option value="required">{t('required')}</option>
              <option value="exempt">{t('exempt')}</option>
            </select>
            <button className="btn ghost" onClick={addRule}><Plus size={13} /></button>
          </div>

          {draft.length === 0 ? (
            <p className="hint">{t('No rule — two-factor stays optional.')}</p>
          ) : (
            <div className="mfa-rules">
              {draft.map((r, i) => (
                <span key={`${r.scope}:${r.target}`} className={`mfa-rule ${r.mode}`}>
                  {r.scope === 'user'
                    ? <>{t('User')} <b>{users.find((u) => u.id === r.target)?.email || r.target}</b></>
                    : <b>{t(ROLE_LABEL[r.target] || r.target)}</b>}
                  <em>{r.mode === 'required' ? t('required') : t('exempt')}</em>
                  <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <p className="hint">
            {t('People who must use it but have not set it up can still sign in — they land on this page and can go nowhere else until they do.')}
          </p>

          {gaps.length > 0 && (
            <div className="mfa-gaps">
              <b>{t('Required but not set up ({n})', { n: gaps.length })}</b>
              <div className="mfa-gap-list">
                {gaps.map((g) => <span key={g.userId} className="mfa-gap">{g.name || g.email}</span>)}
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
