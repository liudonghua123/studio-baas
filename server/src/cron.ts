/**
 * 极简 cron 解析器（5 段：分 时 日 月 周）
 * 支持 `*`、`a`、`a-b`、`a-b/n`、`* /n`、逗号列表。
 * 时区通过 Intl 计算偏移，按小时缓存，够日常调度用（不考虑 DST 边界那一分钟）。
 */

const FIELDS: { name: string; min: number; max: number }[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
];

export interface ParsedCron {
  minutes: Set<number>; hours: Set<number>; days: Set<number>;
  months: Set<number>; weekdays: Set<number>;
  domRestricted: boolean; dowRestricted: boolean;
  expr: string;
}

export function parseCron(expr: string): ParsedCron {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron must have 5 fields: minute hour day month weekday');

  const sets = parts.map((raw, i) => {
    const f = FIELDS[i];
    const out = new Set<number>();
    for (const chunk of raw.split(',')) {
      const [range, stepRaw] = chunk.split('/');
      const step = stepRaw ? Number(stepRaw) : 1;
      if (!Number.isFinite(step) || step <= 0) throw new Error(`Invalid step in "${chunk}"`);
      let lo: number; let hi: number;
      if (range === '*') { lo = f.min; hi = f.max; }
      else if (range.includes('-')) {
        const [a, b] = range.split('-').map(Number);
        lo = a; hi = b;
      } else {
        lo = Number(range); hi = lo;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < f.min || hi > f.max || lo > hi) {
        throw new Error(`Value out of range in "${chunk}" (${f.name} ${f.min}-${f.max})`);
      }
      for (let v = lo; v <= hi; v += step) out.add(v);
    }
    return out;
  });

  const weekdays = sets[4];
  if (weekdays.has(7)) { weekdays.delete(7); weekdays.add(0); }

  return {
    minutes: sets[0], hours: sets[1], days: sets[2], months: sets[3], weekdays,
    domRestricted: parts[2] !== '*', dowRestricted: parts[4] !== '*',
    expr: parts.join(' '),
  };
}

function tzOffsetMinutes(date: Date, timeZone: string): number {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(date)) if (part.type !== 'literal') p[part.type] = part.value;
    const asUTC = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      Number(p.hour) % 24, Number(p.minute), Number(p.second),
    );
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch {
    return 0;
  }
}

/** 从 from 之后开始，找下一次匹配的时间（UTC 返回） */
export function nextRun(expr: string, from: Date = new Date(), timeZone = 'UTC'): Date {
  const c = parseCron(expr);
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  let cursor = start.getTime();
  const limit = cursor + 1000 * 60 * 60 * 24 * 366;
  let cacheKey = -1;
  let offset = 0;

  while (cursor <= limit) {
    const d = new Date(cursor);
    const hourKey = Math.floor(cursor / 3_600_000);
    if (hourKey !== cacheKey) { cacheKey = hourKey; offset = tzOffsetMinutes(d, timeZone); }
    const local = new Date(cursor + offset * 60_000);
    const month = local.getUTCMonth() + 1;
    const day = local.getUTCDate();
    const weekday = local.getUTCDay();
    const hour = local.getUTCHours();
    const minute = local.getUTCMinutes();

    if (!c.months.has(month)) {
      const next = new Date(cursor + offset * 60_000);
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      next.setUTCHours(0, 0, 0, 0);
      cursor = next.getTime() - offset * 60_000;
      cacheKey = -1;
      continue;
    }
    const dayOk = c.domRestricted && c.dowRestricted
      ? (c.days.has(day) || c.weekdays.has(weekday))
      : c.days.has(day) && c.weekdays.has(weekday);
    if (!dayOk) {
      const next = new Date(cursor + offset * 60_000);
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(0, 0, 0, 0);
      cursor = next.getTime() - offset * 60_000;
      cacheKey = -1;
      continue;
    }
    if (!c.hours.has(hour)) {
      const next = new Date(cursor + offset * 60_000);
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
      cursor = next.getTime() - offset * 60_000;
      cacheKey = -1;
      continue;
    }
    if (!c.minutes.has(minute)) { cursor += 60_000; continue; }
    return new Date(cursor);
  }
  throw new Error('No matching time within a year — check the cron expression');
}

export function nextRuns(expr: string, count = 3, from: Date = new Date(), timeZone = 'UTC'): string[] {
  const out: string[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const n = nextRun(expr, cursor, timeZone);
    out.push(n.toISOString());
    cursor = n;
  }
  return out;
}

export function describeCron(expr: string): string {
  const p = String(expr || '').trim();
  const presets: Record<string, string> = {
    '* * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '*/15 * * * *': 'Every 15 minutes',
    '0 * * * *': 'Hourly, on the hour',
    '0 0 * * *': 'Daily at 00:00',
    '0 2 * * *': 'Daily at 02:00',
    '0 9 * * 1': 'Mondays at 09:00',
  };
  return presets[p] || 'Custom schedule';
}
