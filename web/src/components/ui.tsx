import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, Copy, Inbox, X } from 'lucide-react';

/* ------------------------------------------------------------------- toast */

type Toast = { id: number; text: string; tone: 'ok' | 'err' };
const ToastCtx = createContext<{ push: (text: string, tone?: 'ok' | 'err') => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, text, tone }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone === 'err' ? 'error' : 'success'}`}>
            {t.tone === 'err' ? <AlertCircle size={14} /> : <Check size={14} />} {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------------- modal */

export function Modal({
  open, onClose, title, subtitle, children, footer, wide,
}: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: React.ReactNode; footer?: React.ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ drawer */

export function Drawer({
  open, onClose, title, subtitle, children, footer,
}: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: React.ReactNode; footer?: React.ReactNode;
}) {
  if (!open) return null;
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <div>
            <div className="card-title">{title}</div>
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={14} /></button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

/* ------------------------------------------------------------------- badge */

export function Badge({ children, tone = '', dot = false, style }: {
  children: React.ReactNode; tone?: string; dot?: boolean; style?: React.CSSProperties;
}) {
  return (
    <span className={`badge ${tone}`} style={style}>
      {dot && <i className="dot" />}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ states */

export function Empty({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon || <Inbox size={26} />}
      <h4>{title}</h4>
      {hint && <p>{hint}</p>}
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 34, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- copy button */

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={label ? 'btn sm ghost' : 'mini-btn'}
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); } catch {}
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
      {label && <span>{done ? '已复制' : label}</span>}
    </button>
  );
}
