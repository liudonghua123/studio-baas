import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Globe2, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { FunctionDomain } from '../types';
import { Badge, CopyButton, Empty, Modal, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';

const tone = (s: string) => (s === 'active' ? 'green' : s === 'failed' ? 'red' : s === 'verifying' ? 'blue' : 'amber');

export default function DomainsTab({ functionId, functionName }: { functionId: string; functionName: string }) {
  const toast = useToast();
  const { can } = useAuth();
  const [list, setList] = useState<FunctionDomain[]>([]);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try { setList((await api.domains(functionId)).domains); } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, [functionId]);

  const add = async () => {
    if (!host.trim()) return toast.push('请输入域名', 'err');
    try {
      await api.addDomain(functionId, host.trim());
      setOpen(false);
      setHost('');
      toast.push('域名已添加，请完成 DNS 校验');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const verify = async (d: FunctionDomain) => {
    setBusy(d.id);
    try {
      const r = await api.verifyDomain(functionId, d.id);
      toast.push(r.status === 'active' ? `${d.hostname} 已生效` : `校验失败：${r.note || 'no TXT record'}`, r.status === 'active' ? 'ok' : 'err');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); } finally { setBusy(null); }
  };

  const remove = async (d: FunctionDomain) => {
    if (!window.confirm(`解绑 ${d.hostname}？`)) return;
    try {
      await api.deleteDomain(functionId, d.id);
      toast.push('已解绑');
      load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const active = list.filter((d) => d.status === 'active');

  return (
    <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Custom domains</div>
              <div className="card-sub">把函数挂到自己的域名上，请求会按 Host 直接路由进函数</div>
            </div>
            <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!can('functions.write')}
              onClick={() => setOpen(true)}>
              <Plus size={13} /> Add domain
            </button>
          </div>
          <div className="card-body tight">
            {list.length === 0 ? (
              <Empty title="还没有绑定域名" hint="添加域名后会生成一条 TXT 校验记录" icon={<Globe2 size={26} />} />
            ) : (
              <table className="table">
                <thead>
                  <tr><th>Hostname</th><th>Status</th><th>SSL</th><th>Added</th><th style={{ width: 96 }} /></tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <div className="dom-row">
                          <Globe2 size={13} style={{ color: 'var(--dim)' }} />
                          <span className="dom-host">{d.hostname}</span>
                        </div>
                        {d.status !== 'active' && (
                          <div className="dns-box" style={{ marginTop: 6 }}>
                            <div className="tiny dim" style={{ marginBottom: 3, letterSpacing: '0.06em' }}>TXT · _studio-baas</div>
                            <div className="flex" style={{ justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ wordBreak: 'break-all' }}>{d.dnsRecord}</span>
                              <CopyButton text={d.dnsRecord} />
                            </div>
                          </div>
                        )}
                      </td>
                      <td>
                        <Badge tone={tone(d.status)} dot>{d.status}</Badge>
                        {d.note && d.status !== 'active' && <div className="tiny dim" style={{ marginTop: 4, maxWidth: 240 }}>{d.note}</div>}
                      </td>
                      <td><Badge tone={d.sslStatus === 'issued' ? 'green' : 'amber'}>{d.sslStatus}</Badge></td>
                      <td className="dim tiny" style={{ whiteSpace: 'nowrap' }}>{timeAgo(d.createdAt)}</td>
                      <td>
                        <div className="flex" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          <button className="mini-btn" title="Verify DNS" disabled={!can('functions.write') || busy === d.id}
                            onClick={() => verify(d)}>
                            {busy === d.id ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
                          </button>
                          <button className="mini-btn" title="Remove" disabled={!can('functions.write')} onClick={() => remove(d)}>
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">Request routing</div></div>
          <div className="card-body">
            {active.length === 0 ? (
              <div className="tiny dim">绑定并校验通过后，任意发往该域名的请求都会被路由到 <b>{functionName}</b>，路径、查询串、Header 与 body 会原样注入 <span className="mono">req</span>。</div>
            ) : (
              <>
                <div className="tiny dim" style={{ marginBottom: 8 }}>
                  已生效域名会拦截全部路径并发给 <b>{functionName}</b>。本地验证（无需真实 DNS）：
                </div>
                <pre className="dns-box" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{`curl -X POST http://localhost:5174/checkout \\
  -H "Host: ${active[0].hostname}" \\
  -H "content-type: application/json" \\
  -d '{"email":"demo@aurora.io"}'`}</pre>
                <div className="tiny dim" style={{ marginTop: 8 }}>
                  线上部署时把域名 CNAME 到入口即可，TLS 证书在验证通过后自动签发（演示环境为模拟签发）。
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><div className="card-title">How verification works</div></div>
        <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            ['Add the domain', '生成一次性校验 token，写入 functionDomains 表'],
            ['Create a TXT record', '在 DNS 服务商处添加 _studio-baas 的 TXT 记录，值形如 studio-baas-verify=…'],
            ['Click verify', '服务端读取 TXT 记录并比对；DOMAIN_VERIFY_MODE=strict 时强制真实校验'],
            ['TLS + routing', '校验通过后标记 active 并签发证书，Host 请求开始路由到函数'],
          ].map(([t, d], i) => (
            <div key={t} className="flex" style={{ gap: 9, alignItems: 'flex-start' }}>
              <span className="step-num">{i + 1}</span>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 550 }}>{t}</div>
                <div className="tiny dim" style={{ lineHeight: 1.6 }}>{d}</div>
              </div>
            </div>
          ))}
          <div className="divider" />
          <div className="tiny dim" style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <ShieldCheck size={13} style={{ marginTop: 2, color: '#00b894' }} />
            默认 simulate 模式便于本地演示；接入真实域名时设置 <span className="mono">DOMAIN_VERIFY_MODE=strict</span>。
          </div>
          {list.some((d) => d.status === 'failed') && (
            <div className="tiny" style={{ display: 'flex', gap: 6, color: '#ff8aa6' }}>
              <AlertCircle size={13} style={{ marginTop: 2 }} /> 有域名校验失败，请在 DNS 生效后重试。
            </div>
          )}
          {active.length > 0 && (
            <div className="tiny" style={{ display: 'flex', gap: 6, color: '#00b894' }}>
              <CheckCircle2 size={13} style={{ marginTop: 2 }} /> {active.length} 个域名正在接收流量。
            </div>
          )}
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Add custom domain"
        subtitle={`绑定到 ${functionName}`}
        footer={<>
          <button className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn primary" onClick={add}>Add domain</button>
        </>}>
        <div className="field"><label>Hostname</label>
          <input className="input" placeholder="api.example.com" value={host}
            onChange={(e) => setHost(e.target.value)} autoFocus />
          <div className="hint">不要带协议和路径，例如 api.aurora.io</div>
        </div>
      </Modal>
    </div>
  );
}
