import { useEffect, useMemo, useState } from 'react';
import {
  Fingerprint, Globe2, Building2, Server, Plus, Trash2, PlugZap, Pencil, ShieldCheck,
  Copy, CheckCircle2, Loader2,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Modal, useToast } from '../components/ui';
import { timeAgo } from '../lib/format';
import { useT } from '../lib/locale';
import type { IdentityProvider, SsoType } from '../types';

/**
 * Settings → Authentication：身份源管理。
 *
 * 密钥永远不回传明文，所以编辑时密码框留空 = 保持不变。
 * 「测试连接」走的是真实网络请求（OIDC 取 discovery、CAS 探登录页、LDAP 用服务账号 bind），
 * 配错了当场就能看见，不用等到有人点登录。
 */

const TYPES: { id: SsoType; label: string; icon: typeof Fingerprint; hint: string }[] = [
  { id: 'oidc', label: 'OpenID Connect', icon: Fingerprint, hint: 'Keycloak · Entra ID · Auth0 · Okta · Google' },
  { id: 'oauth2', label: 'OAuth 2.0', icon: Globe2, hint: 'Any authorization-code provider' },
  { id: 'cas', label: 'CAS', icon: Building2, hint: 'Apereo CAS 2.0 / 3.0' },
  { id: 'ldap', label: 'LDAP', icon: Server, hint: 'OpenLDAP · Active Directory' },
];

const typeMeta = (t: SsoType) => TYPES.find((x) => x.id === t)!;

const blankConfig = (type: SsoType): Record<string, any> => {
  switch (type) {
    case 'oidc':
      return { issuer: '', clientId: '', clientSecret: '', scopes: 'openid email profile', discovery: true };
    case 'oauth2':
      return {
        clientId: '', clientSecret: '', authorizeUrl: '', tokenUrl: '', userinfoUrl: '',
        scopes: 'email profile', usePkce: true,
      };
    case 'cas':
      return { serverUrl: '', version: '3', emailAttribute: 'mail', nameAttribute: 'displayName' };
    default:
      return {
        url: 'ldap://', baseDn: '', bindDn: '', bindPassword: '', userFilter: '(uid={{username}})',
        attrEmail: 'mail', attrName: 'cn', attrUsername: 'uid', startTls: false, tlsSkipVerify: false,
      };
  }
};

export default function SsoCard() {
  const toast = useToast();
  const t = useT();

  const [providers, setProviders] = useState<IdentityProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<IdentityProvider | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState('');

  const [form, setForm] = useState({
    type: 'oidc' as SsoType,
    name: '',
    defaultRole: 'viewer',
    allowedDomains: '',
    trustEmail: true,
    config: blankConfig('oidc'),
  });

  const load = async () => {
    try {
      const r = await api.ssoConfig();
      setProviders(r.providers);
      setDenied(false);
    } catch (e: any) {
      // 403 = 当前角色看不到身份源配置，静默隐藏整张卡片
      if (/permission|forbidden/i.test(e.message)) setDenied(true);
      else toast.push(e.message, 'err');
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const loginUrl = useMemo(() => `${window.location.origin}/login`, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ type: 'oidc', name: '', defaultRole: 'viewer', allowedDomains: '', trustEmail: true, config: blankConfig('oidc') });
    setOpen(true);
  };

  const openEdit = (p: IdentityProvider) => {
    setEditing(p);
    setForm({
      type: p.type,
      name: p.name,
      defaultRole: p.defaultRole || 'viewer',
      allowedDomains: p.allowedDomains.join(', '),
      trustEmail: p.trustEmail,
      config: { ...blankConfig(p.type), ...p.config, clientSecret: '', bindPassword: '' },
    });
    setOpen(true);
  };

  const switchType = (type: SsoType) => {
    setForm((f) => ({ ...f, type, config: { ...blankConfig(type), ...(f.type === type ? f.config : {}) } }));
  };

  const save = async () => {
    if (!form.name.trim()) return toast.push(t('Give the provider a name'), 'err');
    setSaving(true);
    const cfg: Record<string, any> = { ...form.config };
    if (typeof cfg.scopes === 'string') cfg.scopes = cfg.scopes.split(/[\s,]+/).filter(Boolean);
    try {
      const body = {
        type: form.type,
        name: form.name.trim(),
        defaultRole: form.defaultRole,
        allowedDomains: form.allowedDomains.split(/[\s,]+/).filter(Boolean),
        trustEmail: form.trustEmail,
        config: cfg,
      };
      if (editing) await api.updateSsoProvider(editing.id, body);
      else await api.createSsoProvider(body);
      setOpen(false);
      await load();
      toast.push(editing ? t('Identity provider updated') : t('Identity provider added'), 'ok');
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally { setSaving(false); }
  };

  const toggle = async (p: IdentityProvider) => {
    try {
      await api.updateSsoProvider(p.id, { enabled: !p.enabled });
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const remove = async (p: IdentityProvider) => {
    if (!window.confirm(t('Delete "{name}"? Accounts linked through it keep existing, but lose this sign-in route.', { name: p.name }))) return;
    try {
      await api.deleteSsoProvider(p.id);
      await load();
      toast.push(t('Identity provider deleted'), 'ok');
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const test = async (p: IdentityProvider) => {
    setTesting(p.id);
    try {
      const r = await api.testSsoProvider(p.id);
      toast.push(r.ok === false
        ? t('Connection failed ({status})', { status: r.status })
        : t('Connection OK'), r.ok === false ? 'err' : 'ok');
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally { setTesting(''); }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      toast.push(t('Login URL copied'), 'ok');
    } catch { toast.push(loginUrl, 'ok'); }
  };

  if (denied) return null;

  const setCfg = (key: string, value: any) => setForm((f) => ({ ...f, config: { ...f.config, [key]: value } }));

  return (
    <div className="card sso-card">
      <div className="card-head">
        <ShieldCheck size={15} />
        <div>
          <div className="card-title">{t('Authentication')}</div>
          <div className="card-sub">{t('Identity providers that can sign people in to this console')}</div>
        </div>
        <div className="page-actions">
          <button className="btn ghost sm" onClick={copy} title={loginUrl}>
            <Copy size={13} /> {t('Copy login URL')}
          </button>
          <button className="btn sm" onClick={openCreate}><Plus size={13} /> {t('Add provider')}</button>
        </div>
      </div>

      {loading ? (
        <div className="card-body"><Loader2 size={16} className="spin" /></div>
      ) : !providers.length ? (
        <div className="card-body">
          <div className="sso-empty">
            <ShieldCheck size={20} />
            <div>
              <b>{t('No identity provider yet')}</b>
              <p>{t('Add OIDC, OAuth2, CAS or LDAP so people sign in with the account they already have. Password login keeps working alongside it.')}</p>
            </div>
          </div>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Provider')}</th>
              <th>{t('Type')}</th>
              <th>{t('Default role')}</th>
              <th>{t('Accounts')}</th>
              <th>{t('Status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => {
              const Icon = typeMeta(p.type).icon;
              return (
                <tr key={p.id}>
                  <td>
                    <div className="cell-main">{p.name}</div>
                    <div className="cell-sub mono">{p.id}</div>
                  </td>
                  <td><Badge tone="violet"><Icon size={11} /> {typeMeta(p.type).label}</Badge></td>
                  <td className="tiny">{p.defaultRole || '—'}</td>
                  <td className="tiny">{p.identities}</td>
                  <td>
                    <button className="linklike" onClick={() => toggle(p)}>
                      {p.enabled
                        ? <Badge tone="green"><span className="dot" />{t('Enabled')}</Badge>
                        : <Badge>{t('Disabled')}</Badge>}
                    </button>
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="mini-btn" title={t('Test connection')} onClick={() => test(p)}>
                        {testing === p.id ? <Loader2 size={13} className="spin" /> : <PlugZap size={13} />}
                      </button>
                      <button className="mini-btn" title={t('Edit')} onClick={() => openEdit(p)}><Pencil size={13} /></button>
                      <button className="mini-btn danger" title={t('Delete')} onClick={() => remove(p)}><Trash2 size={13} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="sso-foot">
        <span>{t('Sign-in page')}: <code className="mono">{loginUrl}</code></span>
        {providers[0] && <span className="dim tiny">· {t('last updated {when}', { when: timeAgo(providers[0].updatedAt) })}</span>}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        wide
        title={editing ? t('Edit identity provider') : t('Add identity provider')}
        subtitle={t('Secrets are encrypted at rest and never sent back to the browser.')}
        footer={
          <>
            <button className="btn ghost" onClick={() => setOpen(false)}>{t('Cancel')}</button>
            <button className="btn primary" onClick={save} disabled={saving}>
              {saving && <Loader2 size={13} className="spin" />} {t('Save')}
            </button>
          </>
        }
      >
        <div className="sso-types">
          {TYPES.map((x) => {
            const Icon = x.icon;
            return (
              <button
                key={x.id}
                className={`sso-type ${form.type === x.id ? 'on' : ''}`}
                onClick={() => switchType(x.id)}
                disabled={!!editing && editing.type !== x.id}
              >
                <Icon size={16} />
                <b>{x.label}</b>
                <small>{x.hint}</small>
                {form.type === x.id && <CheckCircle2 size={13} className="sso-type-check" />}
              </button>
            );
          })}
        </div>

        <div className="input-row">
          <div className="field">
            <label className="label">{t('Display name')}<span className="req">*</span></label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={form.type === 'ldap' ? 'Corporate LDAP' : 'Company SSO'} />
          </div>
          <div className="field">
            <label className="label">{t('Default role for new accounts')}</label>
            <select className="input" value={form.defaultRole} onChange={(e) => setForm({ ...form, defaultRole: e.target.value })}>
              <option value="viewer">{t('Viewer')}</option>
              <option value="developer">{t('Developer')}</option>
              <option value="admin">{t('Admin')}</option>
              <option value="">{t('No project access')}</option>
            </select>
          </div>
        </div>

        {form.type === 'oidc' && (
          <>
            <div className="field">
              <label className="label">{t('Issuer URL')}<span className="req">*</span></label>
              <input className="input mono" value={form.config.issuer} onChange={(e) => setCfg('issuer', e.target.value)}
                placeholder="https://keycloak.example.com/realms/acme" />
              <div className="hint">{t('Endpoints are read from {issuer}/.well-known/openid-configuration', { issuer: form.config.issuer || '…' })}</div>
            </div>
            <div className="input-row">
              <div className="field">
                <label className="label">{t('Client ID')}<span className="req">*</span></label>
                <input className="input mono" value={form.config.clientId} onChange={(e) => setCfg('clientId', e.target.value)} />
              </div>
              <div className="field">
                <label className="label">{t('Client secret')}</label>
                <input className="input" type="password" value={form.config.clientSecret}
                  onChange={(e) => setCfg('clientSecret', e.target.value)}
                  placeholder={editing?.secrets.clientSecret?.set ? t('Leave blank to keep {preview}', { preview: editing.secrets.clientSecret.preview }) : ''} />
              </div>
            </div>
            <div className="field">
              <label className="label">{t('Scopes')}</label>
              <input className="input mono" value={form.config.scopes} onChange={(e) => setCfg('scopes', e.target.value)} />
              <div className="hint">{t('openid is required; email and profile give us a name and address to match on.')}</div>
            </div>
            <div className="field">
              <label className="label">{t('Trust email from provider')}</label>
              <label className="checkline">
                <input type="checkbox" checked={form.trustEmail} onChange={(e) => setForm({ ...form, trustEmail: e.target.checked })} />
                <span>{t('Merge into an existing account with the same email — only when the provider says the email is verified.')}</span>
              </label>
            </div>
          </>
        )}

        {form.type === 'oauth2' && (
          <>
            <div className="input-row">
              <div className="field">
                <label className="label">{t('Client ID')}<span className="req">*</span></label>
                <input className="input mono" value={form.config.clientId} onChange={(e) => setCfg('clientId', e.target.value)} />
              </div>
              <div className="field">
                <label className="label">{t('Client secret')}</label>
                <input className="input" type="password" value={form.config.clientSecret}
                  onChange={(e) => setCfg('clientSecret', e.target.value)}
                  placeholder={editing?.secrets.clientSecret?.set ? t('Leave blank to keep {preview}', { preview: editing.secrets.clientSecret.preview }) : ''} />
              </div>
            </div>
            <div className="field">
              <label className="label">{t('Authorize URL')}<span className="req">*</span></label>
              <input className="input mono" value={form.config.authorizeUrl} onChange={(e) => setCfg('authorizeUrl', e.target.value)} />
            </div>
            <div className="input-row">
              <div className="field">
                <label className="label">{t('Token URL')}<span className="req">*</span></label>
                <input className="input mono" value={form.config.tokenUrl} onChange={(e) => setCfg('tokenUrl', e.target.value)} />
              </div>
              <div className="field">
                <label className="label">{t('Userinfo URL')}<span className="req">*</span></label>
                <input className="input mono" value={form.config.userinfoUrl} onChange={(e) => setCfg('userinfoUrl', e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label className="label">{t('Scopes')}</label>
              <input className="input mono" value={form.config.scopes} onChange={(e) => setCfg('scopes', e.target.value)} />
            </div>
          </>
        )}

        {form.type === 'cas' && (
          <>
            <div className="field">
              <label className="label">{t('CAS server URL')}<span className="req">*</span></label>
              <input className="input mono" value={form.config.serverUrl} onChange={(e) => setCfg('serverUrl', e.target.value)}
                placeholder="https://cas.example.com/cas" />
              <div className="hint">{t('Login goes to {url}/login, tickets are checked against {url}/serviceValidate', { url: form.config.serverUrl || '…' })}</div>
            </div>
            <div className="input-row">
              <div className="field">
                <label className="label">{t('Protocol version')}</label>
                <select className="input" value={form.config.version} onChange={(e) => setCfg('version', e.target.value)}>
                  <option value="3">CAS 3.0 (returns attributes)</option>
                  <option value="2">CAS 2.0 (username only)</option>
                </select>
              </div>
              <div className="field">
                <label className="label">{t('Email attribute')}</label>
                <input className="input mono" value={form.config.emailAttribute} onChange={(e) => setCfg('emailAttribute', e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label className="label">{t('Name attribute')}</label>
              <input className="input mono" value={form.config.nameAttribute} onChange={(e) => setCfg('nameAttribute', e.target.value)} />
              <div className="hint">{t('Missing attributes fall back to the username — CAS 2.0 usually has no attributes at all.')}</div>
            </div>
          </>
        )}

        {form.type === 'ldap' && (
          <>
            <div className="input-row">
              <div className="field">
                <label className="label">{t('Server URL')}<span className="req">*</span></label>
                <input className="input mono" value={form.config.url} onChange={(e) => setCfg('url', e.target.value)}
                  placeholder="ldaps://dc01.corp.example:636" />
              </div>
              <div className="field">
                <label className="label">{t('Base DN')}<span className="req">*</span></label>
                <input className="input mono" value={form.config.baseDn} onChange={(e) => setCfg('baseDn', e.target.value)}
                  placeholder="ou=people,dc=corp,dc=example" />
              </div>
            </div>
            <div className="input-row">
              <div className="field">
                <label className="label">{t('Bind DN (service account)')}</label>
                <input className="input mono" value={form.config.bindDn} onChange={(e) => setCfg('bindDn', e.target.value)}
                  placeholder="cn=svc-studio,ou=services,dc=corp,dc=example" />
              </div>
              <div className="field">
                <label className="label">{t('Bind password')}</label>
                <input className="input" type="password" value={form.config.bindPassword}
                  onChange={(e) => setCfg('bindPassword', e.target.value)}
                  placeholder={editing?.secrets.bindPassword?.set ? t('Leave blank to keep {preview}', { preview: editing.secrets.bindPassword.preview }) : ''} />
              </div>
            </div>
            <div className="field">
              <label className="label">{t('User filter')}<span className="req">*</span></label>
              <input className="input mono" value={form.config.userFilter} onChange={(e) => setCfg('userFilter', e.target.value)} />
              <div className="hint">{t('{{username}} is replaced with the typed name and escaped, so it cannot be used to inject a filter.')}</div>
            </div>
            <div className="input-row">
              <div className="field">
                <label className="label">{t('Email attribute')}</label>
                <input className="input mono" value={form.config.attrEmail} onChange={(e) => setCfg('attrEmail', e.target.value)} />
              </div>
              <div className="field">
                <label className="label">{t('Name attribute')}</label>
                <input className="input mono" value={form.config.attrName} onChange={(e) => setCfg('attrName', e.target.value)} />
              </div>
            </div>
            <div className="input-row">
              <div className="field">
                <label className="label">{t('Username attribute')}</label>
                <input className="input mono" value={form.config.attrUsername} onChange={(e) => setCfg('attrUsername', e.target.value)} />
              </div>
              <div className="field">
                <label className="label">{t('Transport')}</label>
                <div className="checkstack">
                  <label className="checkline">
                    <input type="checkbox" checked={!!form.config.startTls} onChange={(e) => setCfg('startTls', e.target.checked)} />
                    <span>STARTTLS</span>
                  </label>
                  <label className="checkline">
                    <input type="checkbox" checked={!!form.config.tlsSkipVerify} onChange={(e) => setCfg('tlsSkipVerify', e.target.checked)} />
                    <span>{t('Skip certificate check (self-signed)')}</span>
                  </label>
                </div>
              </div>
            </div>
          </>
        )}

        <div className="field">
          <label className="label">{t('Allowed email domains')}</label>
          <input className="input mono" value={form.allowedDomains} onChange={(e) => setForm({ ...form, allowedDomains: e.target.value })}
            placeholder="corp.example, subsidiary.example" />
          <div className="hint">{t('Comma separated. Empty means any domain the provider vouches for.')}</div>
        </div>
      </Modal>
    </div>
  );
}
