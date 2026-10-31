import { useEffect, useRef, useState } from 'react';
import {
  FolderOpen, Plus, UploadCloud, Trash2, RefreshCw, Image as ImageIcon,
  FileText, HardDrive, Lock, Wand2, Eye, ShieldCheck, X,
} from 'lucide-react';
import { api } from '../api';
import type { Bucket, FileItem } from '../types';
import { Badge, Empty, Loading, Modal, useToast } from '../components/ui';
import { fmtBytes, fmtDateTime, timeAgo } from '../lib/format';

export default function Storage() {
  const toast = useToast();
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [active, setActive] = useState<Bucket | null>(null);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newBucket, setNewBucket] = useState(false);
  const [form, setForm] = useState({ name: '', maxFileSize: 5, allowedExtensions: 'png,jpg,svg,webp', encryption: true, imageTransform: true });
  const [preview, setPreview] = useState<FileItem | null>(null);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const r = await api.buckets();
      setBuckets(r.buckets);
      setActive((prev) => r.buckets.find((b) => b.id === prev?.id) || r.buckets[0] || null);
    } catch (e: any) { toast.push(e.message, 'err'); }
    setLoading(false);
  };
  const loadFiles = async (b: Bucket | null) => {
    if (!b) { setFiles([]); return; }
    try { setFiles((await api.files(b.id)).files); } catch (e: any) { toast.push(e.message, 'err'); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => { loadFiles(active); }, [active?.id]);

  const uploadFiles = async (list: FileList | File[]) => {
    if (!active || !list.length) return;
    setBusy(true);
    for (const f of Array.from(list)) {
      try {
        await api.upload(active.id, f);
        toast.push(`${f.name} uploaded`);
      } catch (e: any) { toast.push(`${f.name}: ${e.message}`, 'err'); }
    }
    await loadFiles(active);
    await load();
    setBusy(false);
  };

  const createBucket = async () => {
    if (!form.name) return;
    try {
      await api.createBucket({
        name: form.name, maxFileSize: form.maxFileSize * 1024 * 1024,
        allowedExtensions: form.allowedExtensions.split(',').map((s) => s.trim()).filter(Boolean),
        encryption: form.encryption, imageTransform: form.imageTransform, compression: 'gzip',
      });
      toast.push('Bucket created');
      setNewBucket(false);
      setForm({ name: '', maxFileSize: 5, allowedExtensions: 'png,jpg,svg,webp', encryption: true, imageTransform: true });
      await load();
    } catch (e: any) { toast.push(e.message, 'err'); }
  };

  const isImage = (f: FileItem) => f.mimeType.startsWith('image/');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><FolderOpen size={11} /> Storage</div>
          <h1>Buckets & files</h1>
          <p>Encrypted object storage with compression, image transformations and granular access control.</p>
        </div>
        <div className="page-actions">
          <button className="btn ghost" onClick={() => { load(); loadFiles(active); }}><RefreshCw size={14} /> Refresh</button>
          <button className="btn ghost" onClick={() => setNewBucket(true)}><Plus size={14} /> New bucket</button>
          <button className="btn primary" disabled={!active || busy} onClick={() => inputRef.current?.click()}>
            <UploadCloud size={14} /> {busy ? 'Uploading…' : 'Upload file'}
          </button>
          <input ref={inputRef} type="file" multiple hidden onChange={(e) => e.target.files && uploadFiles(e.target.files)} />
        </div>
      </div>

      {loading ? <div className="card"><Loading /></div> : (
        <>
          <div className="bucket-tabs">
            {buckets.map((b) => (
              <div key={b.id} className={`bucket-chip pointer ${active?.id === b.id ? 'active' : ''}`} onClick={() => setActive(b)}>
                <FolderOpen size={13} /> {b.name}
                <small>{b.fileCount} files · {fmtBytes(b.totalSize)}</small>
              </div>
            ))}
          </div>

          {active && (
            <div className="grid-stats" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
              <div className="stat">
                <div className="stat-label"><HardDrive size={12} /> Bucket size</div>
                <div className="stat-value" style={{ fontSize: 21 }}>{fmtBytes(active.totalSize)}</div>
                <div className="stat-foot">of {fmtBytes(active.maxFileSize)} per-file limit</div>
              </div>
              <div className="stat">
                <div className="stat-label"><ImageIcon size={12} /> Files</div>
                <div className="stat-value" style={{ fontSize: 21 }}>{active.fileCount}</div>
                <div className="stat-foot">{active.allowedExtensions.map((e) => `.${e}`).join(' ') || 'any type'}</div>
              </div>
              <div className="stat">
                <div className="stat-label"><Lock size={12} /> Encryption</div>
                <div className="stat-value" style={{ fontSize: 21 }}>{active.encryption ? 'AES-256' : 'Off'}</div>
                <div className="stat-foot">at rest & in transit</div>
              </div>
              <div className="stat">
                <div className="stat-label"><Wand2 size={12} /> Compression</div>
                <div className="stat-value" style={{ fontSize: 21, textTransform: 'capitalize' }}>{active.compression}</div>
                <div className="stat-foot">{active.imageTransform ? 'image transforms enabled' : 'transforms disabled'}</div>
              </div>
            </div>
          )}

          <div
            className="card"
            style={{ borderColor: drag ? 'rgba(253,54,110,.5)' : undefined }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); uploadFiles(e.dataTransfer.files); }}
          >
            <div className="card-head">
              <div>
                <div className="card-title">{active?.name || 'Files'}</div>
                <div className="card-sub">{active ? `bucket_${active.id}` : 'Select a bucket'}</div>
              </div>
              <div className="flex" style={{ marginLeft: 'auto', gap: 6 }}>
                {active?.encryption && <Badge tone="green"><ShieldCheck size={10} /> encrypted</Badge>}
                {active && (
                  <button className="btn sm danger" onClick={async () => {
                    if (!confirm(`Delete bucket "${active.name}" and all its files?`)) return;
                    await api.deleteBucket(active.id); toast.push('Bucket deleted'); setActive(null); load();
                  }}><Trash2 size={12} /> Delete bucket</button>
                )}
              </div>
            </div>
            <div className="card-body">
              {files.length === 0 ? (
                <div className="dropzone" style={{ minHeight: 220 }} onClick={() => inputRef.current?.click()}>
                  <UploadCloud size={22} />
                  <b style={{ color: 'var(--muted)', fontWeight: 550 }}>Drop files to upload</b>
                  <span>or click to browse · max {active ? fmtBytes(active.maxFileSize) : '—'}</span>
                </div>
              ) : (
                <div className="file-grid">
                  {files.map((f) => (
                    <div className="file-card" key={f.id}>
                      <div className="file-thumb">
                        {isImage(f) ? <img src={f.url} alt={f.name} /> : <FileText size={26} style={{ color: 'var(--dim)' }} />}
                      </div>
                      <div className="file-meta">
                        <b>{f.name}</b>
                        <small>{fmtBytes(f.size)} · {timeAgo(f.createdAt)}</small>
                      </div>
                      <div className="file-actions">
                        <button className="mini-btn" onClick={() => setPreview(f)} title="Preview"><Eye size={12} /></button>
                        <button className="mini-btn danger" onClick={async () => {
                          await api.deleteFile(f.id); toast.push('File deleted'); loadFiles(active); load();
                        }} title="Delete"><Trash2 size={12} /></button>
                      </div>
                    </div>
                  ))}
                  <div className="file-card" style={{ background: 'transparent' }}>
                    <div className="dropzone" style={{ height: '100%' }} onClick={() => inputRef.current?.click()}>
                      <Plus size={18} />
                      <span>Add file</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <Modal open={newBucket} onClose={() => setNewBucket(false)} title="Create bucket"
        subtitle="Buckets isolate files and define their own permissions."
        footer={<>
          <button className="btn ghost" onClick={() => setNewBucket(false)}>Cancel</button>
          <button className="btn primary" disabled={!form.name} onClick={createBucket}>Create bucket</button>
        </>}
      >
        <div className="field">
          <label className="label">Name <span className="req">*</span></label>
          <input className="input" autoFocus placeholder="e.g. avatars" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="input-row">
          <div className="field">
            <label className="label">Max file size (MB)</label>
            <input className="input" type="number" value={form.maxFileSize} onChange={(e) => setForm({ ...form, maxFileSize: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label className="label">Allowed extensions</label>
            <input className="input" value={form.allowedExtensions} onChange={(e) => setForm({ ...form, allowedExtensions: e.target.value })} />
          </div>
        </div>
        <label className="flex pointer tiny" style={{ gap: 7, marginBottom: 8 }}>
          <input type="checkbox" checked={form.encryption} onChange={(e) => setForm({ ...form, encryption: e.target.checked })} /> Encrypt files at rest (AES-256)
        </label>
        <label className="flex pointer tiny" style={{ gap: 7 }}>
          <input type="checkbox" checked={form.imageTransform} onChange={(e) => setForm({ ...form, imageTransform: e.target.checked })} /> Enable image transformations
        </label>
      </Modal>

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name || ''} subtitle={preview ? `${preview.mimeType} · ${fmtBytes(preview.size)}` : ''} wide
        footer={<button className="btn ghost" onClick={() => setPreview(null)}><X size={14} /> Close</button>}
      >
        {preview && (
          <div>
            {isImage(preview) ? (
              <img src={preview.url} alt={preview.name} style={{ width: '100%', borderRadius: 10, background: '#08080c' }} />
            ) : (
              <div className="empty"><FileText size={26} /><h4>Preview unavailable</h4><p>Download the file to inspect it.</p></div>
            )}
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>File ID</dt><dd className="mono">{preview.id}</dd>
              <dt>Uploaded</dt><dd>{fmtDateTime(preview.createdAt)}</dd>
              <dt>URL</dt><dd><a href={preview.url} target="_blank" rel="noreferrer" style={{ color: '#ff8aa6' }}>{preview.url}</a></dd>
            </dl>
          </div>
        )}
      </Modal>
    </div>
  );
}
