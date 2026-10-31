import type express from 'express';

/**
 * 极简内存限流：滑动窗口计数，按 key 维度（IP / IP+email）。
 * 目的不是替代网关，而是让「登录爆破」和「函数刷执行」在单机演示里
 * 也有基本刹车；多实例部署时应换成 Redis 之类的共享存储。
 */
interface Bucket { count: number; resetAt: number }
const buckets = new Map<string, Bucket>();

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** 额外参与计数的维度，例如登录时的 email */
  keyOf?: (req: express.Request) => string;
  message?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').replace('::ffff:', '');
    const extra = opts.keyOf ? ':' + opts.keyOf(req) : '';
    const key = `${req.path}|${ip}${extra}`;
    const t = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + opts.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    const remaining = Math.max(0, opts.max - b.count);
    res.setHeader('X-RateLimit-Limit', String(opts.max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(b.resetAt / 1000)));
    if (b.count > opts.max) {
      const retry = Math.ceil((b.resetAt - t) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({
        ok: false, code: 'rate_limited',
        error: opts.message || `Too many requests, retry in ${retry}s`,
        retryAfter: retry,
      });
    }
    next();
  };
}

/** 定期清理过期桶，避免长时间运行后 Map 无限增长 */
export function startRateLimitSweeper(intervalMs = 60_000) {
  const timer = setInterval(() => {
    const t = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
