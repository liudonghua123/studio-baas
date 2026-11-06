import { Fragment, useEffect, useState } from 'react';
import { History, RotateCcw, FileCode2, ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import type { FunctionVersion } from '../types';
import { Badge, Empty, Loading, useToast } from '../components/ui';
import { useAuth } from '../lib/auth';
import { fmtDateTime, timeAgo } from '../lib/format';
import { useT } from '../lib/locale';

/**
 * 版本列表：每次保存代码都会留下一条不可变快照，可以展开看当时的代码、一键回滚。
 * 回滚不会删除历史——它会写入一条新的 "restored from vN" 版本。
 */
export default function VersionsTab({ functionId, functionName, currentCode, onRestored }: {
  functionId: string;
  functionName: string;
  currentCode: string;
  onRestored: () => void;
}) {
  const toast = useToast();
  const t = useT();
  const { can } = useAuth();
  const [versions, setVersions] = useState<FunctionVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.versions(functionId);
      setVersions(r.versions);
    } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  useEffect(() => { load(); }, [functionId]);

  const restore = async (v: FunctionVersion) => {
    if (!window.confirm(t('Restore {name} to v{version}? The current code is kept as a new version.', { name: functionName, version: v.version }))) return;
    setBusy(v.id);
    try {
      await api.restoreVersion(functionId, v.id);
      toast.push(t('Restored to v{version}', { version: v.version }));
      await load();
      onRestored();
    } catch (e: any) { toast.push(e.message, 'err'); }
    setBusy(null);
  };

  const same = (v: FunctionVersion) => v.code.trim() === currentCode.trim();

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="card-title"><History size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{t('Deploy history')}</div>
            <div className="card-sub">{t('Every save is an immutable snapshot. Rolling back keeps the history intact.')}</div>
          </div>
          <Badge tone="violet">{t('{n} versions', { n: versions.length })}</Badge>
        </div>
        <div className="card-body tight">
          {loading ? <Loading rows={4} /> : versions.length === 0 ? (
            <Empty title={t('No versions yet')} hint={t('Save the code once to create the first snapshot.')} icon={<FileCode2 size={24} />} />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 28 }} />
                  <th style={{ width: 90 }}>{t('Version')}</th>
                  <th style={{ width: 110 }}>{t('Label')}</th>
                  <th style={{ width: 130 }}>{t('Runtime')}</th>
                  <th>{t('Author')}</th>
                  <th style={{ width: 150 }}>{t('Saved')}</th>
                  <th style={{ width: 96 }} />
                </tr>
              </thead>
              <tbody>
                {versions.map((v, i) => (
                  <Fragment key={v.id}>
                    <tr className="pointer" onClick={() => setOpenId(openId === v.id ? null : v.id)}>
                      <td className="dim">{openId === v.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</td>
                      <td>
                        <span className="mono" style={{ color: 'var(--violet-text)' }}>v{v.version}</span>
                        {i === 0 && <Badge tone="green" dot>{t('latest')}</Badge>}
                      </td>
                      <td className="tiny dim">{v.label || '—'}</td>
                      <td>
                        <span className="runtime-chip" title={v.runtimeInfo?.protocol || ''}>
                          <i style={{ background: v.runtimeInfo?.color || '#8b5cf6' }} />
                          {v.runtimeInfo?.label || v.runtime || '—'}
                        </span>
                      </td>
                      <td className="cell-sub">{v.createdBy || t('system')}</td>
                      <td className="dim tiny" title={fmtDateTime(v.createdAt)}>{timeAgo(v.createdAt)}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                          {same(v) ? (
                            <Badge tone="green" dot>{t('deployed')}</Badge>
                          ) : (
                            <button
                              className="btn sm ghost"
                              disabled={!can('functions.write') || busy === v.id}
                              onClick={() => restore(v)}
                            >
                              <RotateCcw size={11} /> {busy === v.id ? '…' : t('Restore')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {openId === v.id && (
                      <tr>
                        <td />
                        <td colSpan={6}>
                          <pre className="mono" style={{
                            margin: 0, padding: 12, background: 'var(--code-bg)', border: '1px solid var(--line)',
                            borderRadius: 8, maxHeight: 280, overflow: 'auto', fontSize: 11.5, lineHeight: 1.6,
                          }}>{v.code}</pre>
                          <div className="hint" style={{ marginTop: 6 }}>
                            {t('{lines} lines · {bytes} bytes', { lines: v.code.split('\n').length, bytes: v.code.length })}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="card-title"><ShieldAlert size={14} style={{ verticalAlign: -2, marginRight: 6 }} />{t('How it works')}</div>
        </div>
        <div className="card-body">
          <ul className="tiny muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
            <li><b>{t('Save code')}</b> {t('writes a new version and updates the deployed code in one step — the same call the API exposes as')} <span className="mono">PATCH /v1/functions/:id</span>{t('.')}</li>
            <li><b>{t('Restore')}</b> {t('copies the old code back over the current one and records it as a new version (')}<span className="mono">restored from vN</span>{t('), so nothing is ever lost.')}</li>
            <li>{t('Version numbers are per function and monotonic; the newest {n} are kept.', { n: 30 })}</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
