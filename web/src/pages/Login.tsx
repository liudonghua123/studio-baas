import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Building2, Fingerprint, Globe2, KeyRound, Loader2, LogIn,
  Server, ShieldCheck, TriangleAlert,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';
import { explainWebauthnError, getAssertion, passkeysSupported } from '../lib/webauthn';
import type { LoginChallenge, LoginResult, LoginSession, MfaAvailable, PublicProvider, SsoType } from '../types';

/**
 * 登录页。
 *
 * 两个阶段：
 *   1. 第一因素（密码 / SSO / LDAP）
 *   2. 第二因素（TOTP / Passkey / 恢复码）—— 只有策略要求时才出现
 *
 * 第二阶段的凭据是一张一次性 challenge，不是会话：在通过验证之前，
 * 服务端没有发任何可以访问控制台的票据。刷新页面挑战还在（5 分钟），
 * 但前端只能读到「有哪些验证方式」，读不到账号信息。
 *
 * SSO 回调落在 /login#secret=… 或 #challenge=…：票据走 fragment，
 * 不发给服务端、不进访问日志、不会被 Referer 带走。
 */

const ICONS: Record<SsoType, typeof Fingerprint> = {
  oidc: Fingerprint,
  oauth2: Globe2,
  cas: Building2,
  ldap: Server,
};

const TYPE_LABEL: Record<SsoType, string> = {
  oidc: 'OpenID Connect',
  oauth2: 'OAuth 2.0',
  cas: 'CAS',
  ldap: 'LDAP',
};

function parseHash(): {
  secret?: string; challenge?: string; error?: string; returnTo?: string; provider?: string; joined?: string;
} {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return {};
  const p = new URLSearchParams(raw);
  return {
    secret: p.get('secret') || undefined,
    challenge: p.get('challenge') || undefined,
    error: p.get('error') || undefined,
    returnTo: p.get('returnTo') || undefined,
    provider: p.get('provider') || undefined,
    joined: p.get('joined') || undefined,
  };
}

interface MfaState {
  challenge: string;
  methods: MfaAvailable;
  reason?: string;
  provider?: string | null;
}

const EMPTY_METHODS: MfaAvailable = { totp: false, passkeys: [], recoveryCodesLeft: 0, enrolled: false };

export default function Login() {
  const t = useT();
  const nav = useNavigate();
  const { signIn, signOut, session, me } = useAuth();

  const initial = useMemo(parseHash, []);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [error, setError] = useState(initial.error || '');
  const [notice, setNotice] = useState(initial.joined === '1' ? t('Signed in and added to this project.') : '');
  const [busy, setBusy] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [ldapPassword, setLdapPassword] = useState('');
  const [ldapId, setLdapId] = useState('');

  const [mfa, setMfa] = useState<MfaState | null>(
    initial.challenge ? { challenge: initial.challenge, methods: EMPTY_METHODS, provider: initial.provider } : null,
  );
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  const returnTo = initial.returnTo && initial.returnTo.startsWith('/') ? initial.returnTo : '/';

  useEffect(() => {
    // 回调成功：立刻落盘并清掉地址栏里的票据
    if (initial.secret) {
      signIn(initial.secret);
      window.history.replaceState(null, '', '/login');
      nav(returnTo, { replace: true });
    } else if (initial.challenge) {
      window.history.replaceState(null, '', '/login');
    }
  }, [initial.secret, initial.challenge, returnTo, nav, signIn]);

  // 刷新后挑战还在，但方式列表要从服务端补：挑战 id 本身是凭据
  const challengeId = mfa?.challenge;
  useEffect(() => {
    if (!challengeId) return;
    api.mfaChallenge(challengeId)
      .then((r) => setMfa((prev) => (prev ? { ...prev, methods: r.methods, provider: prev.provider || r.provider } : prev)))
      .catch((e: any) => { setError(e.message); setMfa(null); });
  }, [challengeId]);

  useEffect(() => {
    if (mfa) codeRef.current?.focus();
  }, [mfa, recovery]);

  useEffect(() => {
    api.ssoProviders()
      .then((r) => {
        setProviders(r.providers);
        const ldaps = r.providers.filter((p) => p.type === 'ldap');
        if (ldaps.length >= 1) setLdapId(ldaps[0].id);
      })
      .catch(() => setProviders([]));
  }, []);

  const ldapProviders = providers.filter((p) => p.type === 'ldap');
  const redirectProviders = providers.filter((p) => p.type !== 'ldap');

  /** 登录接口的两种结局都从这里收口，避免「加了新登录方式却忘了处理第二因素」 */
  const finish = useCallback((r: LoginResult) => {
    if ((r as LoginChallenge).mfaRequired) {
      const c = r as LoginChallenge;
      setMfa({ challenge: c.challenge, methods: c.methods, reason: c.reason, provider: c.provider });
      setCode('');
      setRecovery(false);
      setError('');
      return;
    }
    const s = r as LoginSession;
    signIn(s.secret);
    if (s.mfaEnrollmentRequired) nav('/settings?focus=mfa', { replace: true });
    else nav(returnTo, { replace: true });
  }, [nav, returnTo, signIn]);

  const startSso = async (id: string) => {
    setError('');
    setBusy(id);
    try {
      const { url } = await api.startSso(id, returnTo);
      window.location.href = url;
    } catch (e: any) {
      setError(e.message);
      setBusy('');
    }
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy('password');
    try {
      finish(await api.passwordLogin(email, password));
    } catch (err: any) {
      setError(err.message);
    } finally { setBusy(''); }
  };

  const submitLdap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ldapId) return;
    setError('');
    setBusy('ldap');
    try {
      finish(await api.ldapLogin(ldapId, username, ldapPassword));
    } catch (err: any) {
      setError(err.message);
    } finally { setBusy(''); }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mfa) return;
    setError('');
    setBusy('code');
    try {
      const r = await api.mfaVerify(mfa.challenge, code, recovery ? 'recovery' : undefined);
      finish(r);
    } catch (err: any) {
      setError(err.message);
      setCode('');
      codeRef.current?.focus();
    } finally { setBusy(''); }
  };

  const usePasskey = async () => {
    if (!mfa) return;
    setError('');
    setBusy('passkey');
    try {
      const { ticket, options } = await api.mfaAssertBegin(mfa.challenge);
      const assertion = await getAssertion(options);
      finish(await api.mfaAssertFinish(ticket, assertion));
    } catch (err: any) {
      setError(explainWebauthnError(err));
    } finally { setBusy(''); }
  };

  const backToPrimary = () => {
    setMfa(null);
    setCode('');
    setRecovery(false);
    setError('');
  };

  const showLdapForm = ldapProviders.length > 0;
  const hasSso = redirectProviders.length > 0 || showLdapForm;

  /* ------------------------------------------------------------- 第二因素 */
  if (mfa) {
    const onlyPasskey = !mfa.methods.totp && mfa.methods.passkeys.length > 0;
    return (
      <div className="login-page">
        <div className="login-glow" aria-hidden />
        <div className="login-shell">
          <section className="login-brand">
            <div className="login-logo">
              <span className="login-mark">S</span>
              <div>
                <b>Studio BaaS</b>
                <small>{t('Backend console')}</small>
              </div>
            </div>
            <h1>{t('One more step')}</h1>
            <p className="login-lede">
              {t('This account is protected by two-factor authentication. Confirm it is you to finish signing in.')}
            </p>
            <ul className="login-points">
              <li><KeyRound size={14} /><span>{t('A 6-digit code from your authenticator app')}</span></li>
              <li><Fingerprint size={14} /><span>{t('Or a passkey — your fingerprint, face or device PIN')}</span></li>
              <li><ShieldCheck size={14} /><span>{t('No session is issued until this step succeeds')}</span></li>
            </ul>
          </section>

          <section className="login-panel">
            <div className="login-card">
              <div className="login-card-head">
                <h2>{t('Two-factor authentication')}</h2>
                <button className="linklike" onClick={backToPrimary}>
                  <ArrowLeft size={12} style={{ verticalAlign: -1, marginRight: 4 }} />
                  {t('Back to sign-in')}
                </button>
              </div>

              {error && (
                <div className="login-alert" role="alert">
                  <TriangleAlert size={14} />
                  <span>{error}</span>
                </div>
              )}

              <div className="login-note">
                {mfa.provider && mfa.provider !== 'password'
                  ? t('Signed in with {provider} — now confirm your second factor.', { provider: mfa.provider })
                  : t('Password accepted — now confirm your second factor.')}
              </div>

              {!onlyPasskey && (
                <form className="login-form" onSubmit={submitCode}>
                  <div className="field">
                    <label className="label">{recovery ? t('Recovery code') : t('Verification code')}</label>
                    <input
                      ref={codeRef}
                      className={recovery ? 'input mono' : 'input otp-input'}
                      value={code}
                      onChange={(e) => setCode(recovery
                        ? e.target.value.toUpperCase()
                        : e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
                      inputMode={recovery ? 'text' : 'numeric'}
                      autoComplete="one-time-code"
                      placeholder={recovery ? 'XXXX-XXXX' : ''}
                      aria-label={recovery ? t('Recovery code') : t('Verification code')}
                      required
                    />
                    <p className="hint">
                      {recovery
                        ? t('Paste one of the recovery codes you saved when you set this up. Each code works once.')
                        : t('Open your authenticator app and type the current code.')}
                    </p>
                  </div>
                  <button className="btn primary login-submit" disabled={busy === 'code'}>
                    {busy === 'code' ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}
                    {t('Verify and sign in')}
                  </button>
                </form>
              )}

              {mfa.methods.passkeys.length > 0 && passkeysSupported() && (
                <button className="btn login-submit" onClick={usePasskey} disabled={!!busy} style={{ marginTop: onlyPasskey ? 0 : 10 }}>
                  {busy === 'passkey' ? <Loader2 size={14} className="spin" /> : <Fingerprint size={14} />}
                  {t('Use a passkey instead')}
                </button>
              )}

              <div className="login-mfa-alt">
                {mfa.methods.totp && (
                  <button className="btn ghost login-submit" onClick={() => { setRecovery((v) => !v); setCode(''); }}>
                    <KeyRound size={13} />
                    {recovery ? t('Use an authenticator code') : t('Use a recovery code')}
                  </button>
                )}
                {recovery && mfa.methods.recoveryCodesLeft === 0 && (
                  <div className="login-note" style={{ marginTop: 10 }}>
                    {t('You have no recovery codes left for this account.')}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------------- 第一因素 */
  return (
    <div className="login-page">
      <div className="login-glow" aria-hidden />
      <div className="login-shell">
        <section className="login-brand">
          <div className="login-logo">
            <span className="login-mark">S</span>
            <div>
              <b>Studio BaaS</b>
              <small>{t('Backend console')}</small>
            </div>
          </div>

          <h1>{t('Sign in to your workspace')}</h1>
          <p className="login-lede">
            {t('One console for databases, functions, sites and storage — with your company directory in front of the door.')}
          </p>

          <ul className="login-points">
            <li><Fingerprint size={14} /><span>{t('OpenID Connect with PKCE, discovery and signed id_tokens')}</span></li>
            <li><KeyRound size={14} /><span>{t('OAuth 2.0 authorization code, CAS 2.0/3.0 service tickets')}</span></li>
            <li><Server size={14} /><span>{t('LDAP / Active Directory bind, no password ever stored')}</span></li>
            <li><ShieldCheck size={14} /><span>{t('Roles stay per project — signing in does not grant access by itself')}</span></li>
          </ul>
        </section>

        <section className="login-panel">
          <div className="login-card">
            <div className="login-card-head">
              <h2>{hasSso ? t('Continue with') : t('Sign in')}</h2>
              {session && (
                <button className="btn ghost sm" onClick={() => { signOut(); setNotice(''); }}>
                  {t('Sign out')}
                </button>
              )}
            </div>

            {error && (
              <div className="login-alert" role="alert">
                <TriangleAlert size={14} />
                <span>{error}</span>
              </div>
            )}
            {!error && notice && <div className="login-note">{notice}</div>}
            {session && me?.principal && (
              <div className="login-note">
                {t('Signed in as {name}', { name: me.principal.name })}
                {' · '}
                <button className="linklike" onClick={() => nav(returnTo, { replace: true })}>{t('Back to console')}</button>
              </div>
            )}

            {redirectProviders.length > 0 && (
              <div className="login-providers">
                {redirectProviders.map((p) => {
                  const Icon = ICONS[p.type] || LogIn;
                  return (
                    <button
                      key={p.id}
                      className="login-provider"
                      onClick={() => startSso(p.id)}
                      disabled={!!busy}
                    >
                      <Icon size={16} />
                      <span className="login-provider-text">
                        <b>{p.name}</b>
                        <small>{TYPE_LABEL[p.type]}</small>
                      </span>
                      {busy === p.id ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}
                    </button>
                  );
                })}
              </div>
            )}

            {showLdapForm && (
              <form className="login-form" onSubmit={submitLdap}>
                <div className="login-sep"><span>{t('Directory account')}</span></div>
                {ldapProviders.length > 1 && (
                  <div className="field">
                    <label className="label">{t('Directory')}</label>
                    <select className="input" value={ldapId} onChange={(e) => setLdapId(e.target.value)}>
                      {ldapProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label className="label">{t('Username')}</label>
                  <input className="input" value={username} onChange={(e) => setUsername(e.target.value)}
                    autoComplete="username" placeholder="alice" required />
                </div>
                <div className="field">
                  <label className="label">{t('Password')}</label>
                  <input className="input" type="password" value={ldapPassword}
                    onChange={(e) => setLdapPassword(e.target.value)} autoComplete="current-password" required />
                </div>
                <button className="btn login-submit" disabled={busy === 'ldap'}>
                  {busy === 'ldap' ? <Loader2 size={14} className="spin" /> : <LogIn size={14} />}
                  {t('Sign in')}
                </button>
              </form>
            )}

            <form className="login-form" onSubmit={submitPassword}>
              {hasSso && <div className="login-sep"><span>{t('or use a local account')}</span></div>}
              <div className="field">
                <label className="label">{t('Email')}</label>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email" placeholder="you@company.com" required />
              </div>
              <div className="field">
                <label className="label">{t('Password')}</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password" required />
              </div>
              <button className="btn login-submit" disabled={busy === 'password'}>
                {busy === 'password' ? <Loader2 size={14} className="spin" /> : <ArrowRight size={14} />}
                {t('Sign in with password')}
              </button>
            </form>

            {!providers.length && (
              <p className="login-foot">
                {t('No identity provider is configured yet. An admin can add OIDC, OAuth2, CAS or LDAP in Settings → Authentication.')}
              </p>
            )}

            <div className="login-foot">
              <button className="linklike" onClick={() => nav('/', { replace: true })}>
                {t('Continue to the demo console without signing in')}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
