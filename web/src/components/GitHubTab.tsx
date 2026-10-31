import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Github, GitBranch, GitCommit as GitCommitIcon,
  Loader2, Plug, RefreshCw, Send, Trash2, Webhook,
} from 'lucide-react';
import { api } from '../api';
import type { GitCommit, GitDeploy, GitIntegration } from '../types';
import { Badge, CopyButton, Empty, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/locale';
import { fmtDuration, timeAgo } from '../lib/format';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'manual pull', webhook: 'webhook push', push: 'console push',
};

export default function GitHubTab({ functionId, functionName }: { functionId: string; functionName: string }) {
  const t = useT();
  const toast = useToast();
  const { can } = useAuth();
  const [it, setIt] = useState<GitIntegration | null>(null);
  const [deploys, setDeploys] = useState<GitDeploy[]>([]);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [mode, setMode] = useState<'simulate' | 'live'>('simulate');
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ repo: '', branch: 'main', path: 'src/main.js', token: '', autoDeploy: true });

  const load = async () => {
    try {
      const r = await api.git(functionId);
      setIt(r.integration);
      setMode(r.mode);
      setDeploys(r.deploys || []);
      if (r.integration) {
        setForm({
          repo: r.integration.repo, branch: r.integration.branch, path: r.integration.path,
          token: '', autoDeploy: r.integration.autoDeploy,
        });
        api.gitCommits(functionId).then((c) => setCommits(c.commits)).catch(() => setCommits([]));
      } else {
        setCommits([]);
      }
    } catch (e: any) {
      toast.push(e.message, 'err');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { setLoading(true); load(); }, [functionId]);

  const webhookUrl = useMemo(
    () => (it ? `${window.location.origin}/v1/git/webhook/${it.id}` : ''),
    [it],
  );

  const connect = async () => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(form.repo.trim())) return toast.push(t('Repository must be in owner/repo format'), 'err');
    setBusy('connect');
    try {
      const r = await api.connectGit(functionId, form);
      setIt(r);
      toast.push(t('Connected to {repo}@{branch}', { repo: r.repo, branch: r.branch }));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const saveSettings = async () => {
    setBusy('save');
    try {
      await api.updateGit(functionId, {
        repo: form.repo, branch: form.branch, path: form.path,
        autoDeploy: form.autoDeploy, ...(form.token ? { token: form.token } : {}),
      });
      toast.push(t('Settings saved'));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const pull = async () => {
    setBusy('pull');
    try {
      const r = await api.gitPull(functionId);
      toast.push(t('Deployed {sha} · {path}', { sha: r.sha, path: r.path }));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const push = async () => {
    setBusy('push');
    try {
      const r = await api.gitPush(functionId);
      toast.push(t('Pushed {sha} to the repository', { sha: r.sha }));
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const testDelivery = async () => {
    setBusy('delivery');
    try {
      const r = await api.gitTestDelivery(functionId);
      toast.push(r.action === 'deployed' ? t('Delivery succeeded — deployed {sha}', { sha: r.deploy?.sha || '' }) : t('Delivery returned: {reason}', { reason: r.reason || '' }), r.ok ? 'ok' : 'err');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const disconnect = async () => {
    if (!window.confirm(t('Disconnect {repo}? Function code is kept, but it will no longer auto-deploy.', { repo: it?.repo || '' }))) return;
    setBusy('disconnect');
    try {
      await api.disconnectGit(functionId);
      setIt(null);
      setDeploys([]);
      setCommits([]);
      toast.push(t('Repository disconnected'));
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const writable = can('functions.write');
  if (loading) return <div className="card"><div className="card-body"><span className="tiny dim">{t('Loading…')}</span></div></div>;

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        {/* ---------------------------------------------------- 连接 / 设置 */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title flex" style={{ gap: 8 }}>
                <Github size={14} /> {t('Repository')}
                {it && <Badge tone={it.autoDeploy ? 'green' : 'amber'} dot>{it.autoDeploy ? t('auto deploy') : t('manual')}</Badge>}
              </div>
              <div className="card-sub">
                {it ? `${it.repo} → ${functionName}` : t('Bind this function to a GitHub repository — push to deploy')}
              </div>
            </div>
            {it && (
              <div className="flex" style={{ marginLeft: 'auto', gap: 6 }}>
                <button className="btn sm" disabled={!writable || busy === 'pull'} onClick={pull}>
                  {busy === 'pull' ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />} {t('Pull')}
                </button>
                <button className="btn sm" disabled={!writable || busy === 'push'} onClick={push}>
                  {busy === 'push' ? <Loader2 size={13} className="spin" /> : <ArrowUpFromLine size={13} />} {t('Push')}
                </button>
                <button className="icon-btn" title={t('Disconnect')} disabled={!writable} onClick={disconnect}>
                  <Trash2 size={13} />
                </button>
              </div>
            )}
          </div>
          <div className="card-body">
            {!it ? (
              <div className="stack" style={{ gap: 10 }}>
                <div className="field-row">
                  <div className="field">
                    <label>{t('Repository')}</label>
                    <input className="input mono" placeholder="owner/repo" value={form.repo}
                      onChange={(e) => setForm({ ...form, repo: e.target.value })} />
                    <div className="tiny dim">{t('e.g. studio-baas/demo-functions')}</div>
                  </div>
                  <div className="field">
                    <label>{t('Branch')}</label>
                    <input className="input mono" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
                    <div className="tiny dim">{t('Only pushes to this branch trigger a deploy')}</div>
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>{t('Function path')}</label>
                    <input className="input mono" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
                    <div className="tiny dim">{t('Entry file inside the repo — read on pull, written on push')}</div>
                  </div>
                  <div className="field">
                    <label>{t('GitHub token')} <span className="dim">{t('optional')}</span></label>
                    <input className="input mono" type="password" placeholder="ghp_… / github_pat_…" value={form.token}
                      onChange={(e) => setForm({ ...form, token: e.target.value })} />
                    <div className="tiny dim">{t('Required for private repos or when pushing. Scope: contents:write')}</div>
                  </div>
                </div>
                <div className="flex" style={{ gap: 8 }}>
                  <button className="btn primary sm" disabled={!writable || busy === 'connect'} onClick={connect}>
                    {busy === 'connect' ? <Loader2 size={13} className="spin" /> : <Plug size={13} />} {t('Connect repository')}
                  </button>
                  <span className="tiny dim">{mode === 'simulate' ? t('Demo mode: the GitHub API is simulated locally') : t('Live mode: calls the GitHub REST API')}</span>
                </div>
              </div>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                <div className="git-meta">
                  <div>
                    <div className="tiny dim">{t('REPOSITORY')}</div>
                    <a className="mono tiny" href={`https://github.com/${it.repo}`} target="_blank" rel="noreferrer"
                      style={{ color: 'var(--text)' }}>{it.repo}</a>
                  </div>
                  <div>
                    <div className="tiny dim">{t('LAST DEPLOY')}</div>
                    <div className="tiny flex" style={{ gap: 4 }}>
                      <GitBranch size={11} /> {it.lastSyncAt ? timeAgo(it.lastSyncAt) : t('never')}
                    </div>
                  </div>
                </div>

                <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {it.lastSha && (
                    <span className="git-sha"><GitCommitIcon size={11} /> {it.lastSha}</span>
                  )}
                  <span className="tiny dim" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.lastMessage || t('No code synced yet')} {it.lastAuthor ? `· ${it.lastAuthor}` : ''}
                  </span>
                  {it.lastStatus && <Badge tone={it.lastStatus === 'deployed' ? 'green' : 'blue'}>{it.lastStatus}</Badge>}
                </div>

                <div className="field-row">
                  <div className="field">
                    <label>{t('Branch')}</label>
                    <input className="input mono" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>{t('Function path')}</label>
                    <input className="input mono" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>{t('Token')}</label>
                    <input className="input mono" type="password" placeholder={it.hasToken ? t('Saved — leave blank to keep it') : t('optional')}
                      value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
                  </div>
                </div>

                <div className="flex" style={{ gap: 10 }}>
                  <label className="switch">
                    <input type="checkbox" checked={form.autoDeploy} disabled={!writable}
                      onChange={(e) => setForm({ ...form, autoDeploy: e.target.checked })} />
                    <span>{t('Auto deploy on push')}</span>
                  </label>
                  <button className="btn sm ghost" style={{ marginLeft: 'auto' }} disabled={!writable || busy === 'save'} onClick={saveSettings}>
                    {busy === 'save' ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />} {t('Save settings')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ---------------------------------------------------- 部署历史 */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('Deploy history')}</div>
              <div className="card-sub">{t('Every pull, push and webhook delivery leaves a record')}</div>
            </div>
            <button className="mini-btn" style={{ marginLeft: 'auto' }} title={t('Refresh')} onClick={load}>
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="card-body tight">
            {deploys.length === 0 ? (
              <Empty title={t('No deployments yet')} hint={t('Connect a repository and hit Pull, or let a GitHub push trigger one')} icon={<GitCommitIcon size={24} />} />
            ) : (
              <table className="table">
                <thead>
                  <tr><th>{t('Commit')}</th><th>{t('Source')}</th><th>{t('Status')}</th><th>{t('Duration')}</th><th>{t('When')}</th></tr>
                </thead>
                <tbody>
                  {deploys.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="flex" style={{ gap: 8 }}>
                          <span className="git-sha">{d.sha}</span>
                          <span className="tiny" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {d.message}
                          </span>
                        </div>
                        <div className="tiny dim">{d.author}</div>
                      </td>
                      <td className="tiny dim">{t(SOURCE_LABEL[d.source] || d.source)}</td>
                      <td><Badge tone={d.status === 'deployed' || d.status === 'pushed' ? 'green' : 'amber'}>{d.status}</Badge></td>
                      <td className="tiny dim mono">{fmtDuration(d.duration)}</td>
                      <td className="tiny dim" style={{ whiteSpace: 'nowrap' }}>{timeAgo(d.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------- 右栏 */}
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title flex" style={{ gap: 6 }}><Webhook size={13} /> Webhook</div>
              <div className="card-sub">{t('Add this URL under Settings → Webhooks in the GitHub repository')}</div>
            </div>
          </div>
          <div className="card-body">
            {!it ? (
              <div className="tiny dim">{t('A webhook URL and secret are generated once a repository is connected.')}</div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                <div>
                  <div className="tiny dim" style={{ marginBottom: 4 }}>{t('PAYLOAD URL')}</div>
                  <div className="dns-box">
                    <code className="mono tiny" style={{ wordBreak: 'break-all' }}>{webhookUrl}</code>
                    <CopyButton text={webhookUrl} />
                  </div>
                </div>
                <div>
                  <div className="tiny dim" style={{ marginBottom: 4 }}>{t('SECRET')}</div>
                  <div className="dns-box">
                    <code className="mono tiny">{it.webhookSecret.slice(0, 12)}…</code>
                    <CopyButton text={it.webhookSecret} />
                  </div>
                </div>
                <div className="tiny dim" style={{ lineHeight: 1.7 }}>
                  {t('Choose event')} <span className="mono">push</span>{t(', content type')} <span className="mono">application/json</span>
                  {t('. The server verifies')} <span className="mono">X-Hub-Signature-256</span>
                  {t(' with HMAC-SHA256; only pushes to branch')}
                  <span className="mono"> {it.branch}</span>{t(' are accepted.')}
                </div>
                <button className="btn sm ghost" disabled={!writable || busy === 'delivery'} onClick={testDelivery}>
                  {busy === 'delivery' ? <Loader2 size={13} className="spin" /> : <Send size={13} />} {t('Send test delivery')}
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">{t('Recent commits')}</div>
              <div className="card-sub">{it ? `${it.repo}@${it.branch}` : t('No repository connected')}</div>
            </div>
          </div>
          <div className="card-body tight">
            {commits.length === 0 ? (
              <div className="tiny dim" style={{ padding: 10 }}>{t('Connect a repository to browse commits on the branch.')}</div>
            ) : (
              commits.map((c) => (
                <div key={c.sha} className="git-commit">
                  <span className="git-sha">{c.sha}</span>
                  <div style={{ minWidth: 0 }}>
                    <div className="tiny" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.message}</div>
                    <div className="tiny dim">{c.author} · {c.date ? timeAgo(c.date) : '—'}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-body" style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Github size={14} style={{ color: 'var(--dim)', marginTop: 2 }} />
            <div className="tiny dim" style={{ lineHeight: 1.7 }}>
              {t('Push commits console code back to the repository; Pull overwrites the function code with the remote file and records a deployment. By default ')}
              <span className="mono">GIT_MODE=simulate</span>{t(' never touches the network — set it to')}
              <span className="mono"> live </span>{t('to hit the real GitHub API (a token is required).')}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
