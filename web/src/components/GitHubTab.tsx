import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Github, GitBranch, GitCommit as GitCommitIcon,
  Loader2, Plug, RefreshCw, Send, Trash2, Webhook,
} from 'lucide-react';
import { api } from '../api';
import type { GitCommit, GitDeploy, GitIntegration } from '../types';
import { Badge, CopyButton, Empty, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { fmtDuration, timeAgo } from '../lib/format';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'manual pull', webhook: 'webhook push', push: 'console push',
};

export default function GitHubTab({ functionId, functionName }: { functionId: string; functionName: string }) {
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
    if (!/^[\w.-]+\/[\w.-]+$/.test(form.repo.trim())) return toast.push('仓库格式应为 owner/repo', 'err');
    setBusy('connect');
    try {
      const r = await api.connectGit(functionId, form);
      setIt(r);
      toast.push(`已连接 ${r.repo}@${r.branch}`);
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
      toast.push('设置已保存');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const pull = async () => {
    setBusy('pull');
    try {
      const r = await api.gitPull(functionId);
      toast.push(`已部署 ${r.sha} · ${r.path}`);
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const push = async () => {
    setBusy('push');
    try {
      const r = await api.gitPush(functionId);
      toast.push(`已提交 ${r.sha} 到仓库`);
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const testDelivery = async () => {
    setBusy('delivery');
    try {
      const r = await api.gitTestDelivery(functionId);
      toast.push(r.action === 'deployed' ? `投递成功，已部署 ${r.deploy?.sha}` : `投递返回：${r.reason}`, r.ok ? 'ok' : 'err');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const disconnect = async () => {
    if (!window.confirm(`断开 ${it?.repo}？函数代码会保留，但不再自动部署。`)) return;
    setBusy('disconnect');
    try {
      await api.disconnectGit(functionId);
      setIt(null);
      setDeploys([]);
      setCommits([]);
      toast.push('已断开仓库');
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const writable = can('functions.write');
  if (loading) return <div className="card"><div className="card-body"><span className="tiny dim">Loading…</span></div></div>;

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        {/* ---------------------------------------------------- 连接 / 设置 */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title flex" style={{ gap: 8 }}>
                <Github size={14} /> Repository
                {it && <Badge tone={it.autoDeploy ? 'green' : 'amber'} dot>{it.autoDeploy ? 'auto deploy' : 'manual'}</Badge>}
              </div>
              <div className="card-sub">
                {it ? `${it.repo} → ${functionName}` : '把这个函数绑定到 GitHub 仓库，push 即部署'}
              </div>
            </div>
            {it && (
              <div className="flex" style={{ marginLeft: 'auto', gap: 6 }}>
                <button className="btn sm" disabled={!writable || busy === 'pull'} onClick={pull}>
                  {busy === 'pull' ? <Loader2 size={13} className="spin" /> : <ArrowDownToLine size={13} />} Pull
                </button>
                <button className="btn sm" disabled={!writable || busy === 'push'} onClick={push}>
                  {busy === 'push' ? <Loader2 size={13} className="spin" /> : <ArrowUpFromLine size={13} />} Push
                </button>
                <button className="icon-btn" title="Disconnect" disabled={!writable} onClick={disconnect}>
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
                    <label>Repository</label>
                    <input className="input mono" placeholder="owner/repo" value={form.repo}
                      onChange={(e) => setForm({ ...form, repo: e.target.value })} />
                    <div className="tiny dim">例如 studio-baas/demo-functions</div>
                  </div>
                  <div className="field">
                    <label>Branch</label>
                    <input className="input mono" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
                    <div className="tiny dim">只有这个分支的 push 会触发部署</div>
                  </div>
                </div>
                <div className="field-row">
                  <div className="field">
                    <label>Function path</label>
                    <input className="input mono" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
                    <div className="tiny dim">仓库内的入口文件，pull 时读它，push 时写它</div>
                  </div>
                  <div className="field">
                    <label>GitHub token <span className="dim">optional</span></label>
                    <input className="input mono" type="password" placeholder="ghp_… / github_pat_…" value={form.token}
                      onChange={(e) => setForm({ ...form, token: e.target.value })} />
                    <div className="tiny dim">私有仓库或需要 push 时必填，权限只需 contents:write</div>
                  </div>
                </div>
                <div className="flex" style={{ gap: 8 }}>
                  <button className="btn primary sm" disabled={!writable || busy === 'connect'} onClick={connect}>
                    {busy === 'connect' ? <Loader2 size={13} className="spin" /> : <Plug size={13} />} Connect repository
                  </button>
                  <span className="tiny dim">{mode === 'simulate' ? '演示模式：本地模拟 GitHub API' : 'Live 模式：调用 GitHub REST API'}</span>
                </div>
              </div>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                <div className="git-meta">
                  <div>
                    <div className="tiny dim">REPOSITORY</div>
                    <a className="mono tiny" href={`https://github.com/${it.repo}`} target="_blank" rel="noreferrer"
                      style={{ color: 'var(--text)' }}>{it.repo}</a>
                  </div>
                  <div>
                    <div className="tiny dim">LAST DEPLOY</div>
                    <div className="tiny flex" style={{ gap: 4 }}>
                      <GitBranch size={11} /> {it.lastSyncAt ? timeAgo(it.lastSyncAt) : 'never'}
                    </div>
                  </div>
                </div>

                <div className="flex" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {it.lastSha && (
                    <span className="git-sha"><GitCommitIcon size={11} /> {it.lastSha}</span>
                  )}
                  <span className="tiny dim" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.lastMessage || '尚未同步过代码'} {it.lastAuthor ? `· ${it.lastAuthor}` : ''}
                  </span>
                  {it.lastStatus && <Badge tone={it.lastStatus === 'deployed' ? 'green' : 'blue'}>{it.lastStatus}</Badge>}
                </div>

                <div className="field-row">
                  <div className="field">
                    <label>Branch</label>
                    <input className="input mono" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Function path</label>
                    <input className="input mono" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
                  </div>
                  <div className="field">
                    <label>Token</label>
                    <input className="input mono" type="password" placeholder={it.hasToken ? '已保存，留空则不修改' : 'optional'}
                      value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />
                  </div>
                </div>

                <div className="flex" style={{ gap: 10 }}>
                  <label className="switch">
                    <input type="checkbox" checked={form.autoDeploy} disabled={!writable}
                      onChange={(e) => setForm({ ...form, autoDeploy: e.target.checked })} />
                    <span>Auto deploy on push</span>
                  </label>
                  <button className="btn sm ghost" style={{ marginLeft: 'auto' }} disabled={!writable || busy === 'save'} onClick={saveSettings}>
                    {busy === 'save' ? <Loader2 size={13} className="spin" /> : <CheckCircle2 size={13} />} Save settings
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
              <div className="card-title">Deploy history</div>
              <div className="card-sub">每次拉取、推送、webhook 触发都会留下记录</div>
            </div>
            <button className="mini-btn" style={{ marginLeft: 'auto' }} title="Refresh" onClick={load}>
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="card-body tight">
            {deploys.length === 0 ? (
              <Empty title="还没有部署" hint="连接仓库后点 Pull，或让 GitHub push 触发一次部署" icon={<GitCommitIcon size={24} />} />
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Commit</th><th>Source</th><th>Status</th><th>Duration</th><th>When</th></tr>
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
                      <td className="tiny dim">{SOURCE_LABEL[d.source] || d.source}</td>
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
              <div className="card-sub">在 GitHub 仓库 Settings → Webhooks 里填这个地址</div>
            </div>
          </div>
          <div className="card-body">
            {!it ? (
              <div className="tiny dim">连接仓库后生成 webhook 地址与密钥。</div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                <div>
                  <div className="tiny dim" style={{ marginBottom: 4 }}>PAYLOAD URL</div>
                  <div className="dns-box">
                    <code className="mono tiny" style={{ wordBreak: 'break-all' }}>{webhookUrl}</code>
                    <CopyButton text={webhookUrl} />
                  </div>
                </div>
                <div>
                  <div className="tiny dim" style={{ marginBottom: 4 }}>SECRET</div>
                  <div className="dns-box">
                    <code className="mono tiny">{it.webhookSecret.slice(0, 12)}…</code>
                    <CopyButton text={it.webhookSecret} />
                  </div>
                </div>
                <div className="tiny dim" style={{ lineHeight: 1.7 }}>
                  事件选 <span className="mono">push</span>，Content type 用 <span className="mono">application/json</span>。
                  服务端用 HMAC-SHA256 校验 <span className="mono">X-Hub-Signature-256</span>，只接受分支
                  <span className="mono"> {it.branch}</span> 的推送。
                </div>
                <button className="btn sm ghost" disabled={!writable || busy === 'delivery'} onClick={testDelivery}>
                  {busy === 'delivery' ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Send test delivery
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Recent commits</div>
              <div className="card-sub">{it ? `${it.repo}@${it.branch}` : '未连接仓库'}</div>
            </div>
          </div>
          <div className="card-body tight">
            {commits.length === 0 ? (
              <div className="tiny dim" style={{ padding: 10 }}>连接仓库后可查看分支上的提交。</div>
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
              Push 时把控制台里的代码提交回仓库；Pull 时用远端文件覆盖函数代码并记录一次部署。
              默认 <span className="mono">GIT_MODE=simulate</span> 不访问外网，设为
              <span className="mono"> live </span> 即走真实 GitHub API（需要 token）。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
