import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight, Building2, Fingerprint, Globe2, KeyRound, Loader2, LogIn,
  Server, ShieldCheck, TriangleAlert,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';
import type { PublicProvider, SsoType } from '../types';

/**
 * 登录页。
 *
 * SSO 回调落在 /login#secret=…：会话票据走 URL fragment，
 * 不发给服务端、不进访问日志、不会被 Referer 带走。
 * 这里读出来存进 localStorage，然后立刻替换 history，避免刷新时重复写入。
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

function parseHash(): { secret?: string; error?: string; returnTo?: string; provider?: string; joined?: string } {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return {};
  const p = new URLSearchParams(raw);
  return {
    secret: p.get('secret') || undefined,
    error: p.get('error') || undefined,
    returnTo: p.get('returnTo') || undefined,
    provider: p.get('provider') || undefined,
    joined: p.get('joined') || undefined,
  };
}

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

  const returnTo = initial.returnTo && initial.returnTo.startsWith('/') ? initial.returnTo : '/';

  useEffect(() => {
    // 回调成功：立刻落盘并清掉地址栏里的票据
    if (initial.secret) {
      signIn(initial.secret);
      window.history.replaceState(null, '', '/login');
      nav(returnTo, { replace: true });
    }
  }, [initial.secret, returnTo, nav, signIn]);

  useEffect(() => {
    api.ssoProviders()
      .then((r) => {
        setProviders(r.providers);
        const ldaps = r.providers.filter((p) => p.type === 'ldap');
        if (ldaps.length === 1) setLdapId(ldaps[0].id);
        if (ldaps.length > 1) setLdapId(ldaps[0].id);
      })
      .catch(() => setProviders([]));
  }, []);

  const ldapProviders = providers.filter((p) => p.type === 'ldap');
  const redirectProviders = providers.filter((p) => p.type !== 'ldap');

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
      const r = await api.passwordLogin(email, password);
      signIn(r.secret);
      nav(returnTo, { replace: true });
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
      const r = await api.ldapLogin(ldapId, username, ldapPassword);
      signIn(r.secret);
      nav(returnTo, { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally { setBusy(''); }
  };

  const showLdapForm = ldapProviders.length > 0;
  const hasSso = redirectProviders.length > 0 || showLdapForm;

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
