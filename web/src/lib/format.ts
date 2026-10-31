export const fmtBytes = (n: number) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1);
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
};

export const fmtNum = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString('en-US');

export const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const fmtDateTime = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
};

/** Format an instant in a specific IANA timezone, e.g. "01 Nov, 09:00" */
export const fmtInZone = (iso: string | null | undefined, timeZone: string) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch {
    return fmtDateTime(iso);
  }
};

/** Short label for an IANA zone: "UTC" or "Berlin" */
export const zoneLabel = (timeZone: string) =>
  timeZone === 'UTC' ? 'UTC' : timeZone.split('/').pop()!.replace(/_/g, ' ');

export const timeAgo = (iso?: string | null) => {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
};

export const timeUntil = (iso?: string | null) => {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'due now';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'in <1m';
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
};

export const fmtDuration = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`);

export const initials = (name: string) =>
  name.split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();

export const statusTone = (status: string): 'green' | 'pink' | 'amber' | 'blue' | 'red' | '' => {
  const s = status.toLowerCase();
  if (['active', 'completed', 'ready', 'paid', 'sent', 'delivered', 'operational', 'published', 'healthy'].includes(s)) return 'green';
  if (['pending', 'unverified', 'draft', 'degraded', 'scheduled'].includes(s)) return 'amber';
  if (['failed', 'blocked', 'refunded', 'error'].includes(s)) return 'red';
  if (['shipped', 'deployed'].includes(s)) return 'blue';
  return '';
};

export const pretty = (v: any) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
