import React from 'react';

const smooth = (pts: [number, number][]) => {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
};

export function AreaChart({ data, height = 240 }: { data: { date: string; requests: number; errors: number }[]; height?: number }) {
  const W = 900;
  const H = height;
  const padL = 42, padR = 14, padT = 18, padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const max = Math.max(...data.map((d) => d.requests), 10) * 1.12;
  const x = (i: number) => padL + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const pts: [number, number][] = data.map((d, i) => [x(i), y(d.requests)]);
  const ePts: [number, number][] = data.map((d, i) => [x(i), y(d.errors)]);
  const line = smooth(pts);
  const area = `${line} L ${x(data.length - 1)} ${padT + innerH} L ${padL} ${padT + innerH} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--pink)" stopOpacity="0.30" />
          <stop offset="60%" stopColor="var(--violet)" stopOpacity="0.10" />
          <stop offset="100%" stopColor="var(--violet)" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="lineStroke" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--violet)" />
          <stop offset="100%" stopColor="var(--pink)" />
        </linearGradient>
      </defs>
      {ticks.map((t) => {
        const yy = padT + innerH * t;
        return (
          <g key={t}>
            <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="var(--line)" strokeDasharray="3 5" />
            <text x={padL - 9} y={yy + 3.5} textAnchor="end" fontSize="9.5" fill="var(--dim)">
              {Math.round(max * (1 - t))}
            </text>
          </g>
        );
      })}
      <path d={area} fill="url(#areaFill)" />
      <path d={line} fill="none" stroke="url(#lineStroke)" strokeWidth="2.1" strokeLinecap="round" />
      <path d={smooth(ePts)} fill="none" stroke="var(--pink)" strokeOpacity="0.5" strokeWidth="1.3" strokeDasharray="4 4" />
      {pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r="1.9" fill="var(--bg)" stroke="var(--pink)" strokeWidth="1.3" opacity={i === pts.length - 1 ? 1 : 0} />
      ))}
      {data.map((d, i) =>
        i % Math.ceil(data.length / 7) === 0 || i === data.length - 1 ? (
          <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--dim)">
            {d.date.slice(5).replace('-', '/')}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export function Sparkline({ data, color = 'var(--pink)', width = 96, height = 34 }: { data: number[]; color?: string; width?: number; height?: number }) {
  if (!data.length) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data);
  const span = max - min || 1;
  const pts: [number, number][] = data.map((v, i) => [
    (i / Math.max(data.length - 1, 1)) * width,
    height - 3 - ((v - min) / span) * (height - 8),
  ]);
  const d = smooth(pts);
  const id = React.useId().replace(/:/g, '');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`sg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${d} L ${width} ${height} L 0 ${height} Z`} fill={`url(#sg-${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Ring({ value, size = 54, color = 'var(--pink)', label }: { value: number; size?: number; color?: string; label?: string }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--w4)" strokeWidth="4" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth="4"
        strokeDasharray={`${c * Math.min(value, 1)} ${c}`} strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" fontSize="10" fill="var(--text-soft)" fontWeight="600">
        {label ?? `${Math.round(value * 100)}%`}
      </text>
    </svg>
  );
}
