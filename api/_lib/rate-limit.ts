// IP-based request rate limiting (Express middleware).
//
// Dependency-free, in-memory fixed-window limiter. We deliberately avoid an
// external package here so there's no new supply-chain surface and the limiter
// is trivially auditable. Two limiters are exported:
//
//   • globalRateLimit — a generous per-IP cap on every endpoint, to blunt
//     scraping / brute-force / accidental request storms.
//   • authRateLimit   — a strict 5-attempts / 15-minutes per-IP cap on the
//     OAuth (authentication) routes, per the security requirement.
//
// NOTE ON SCOPE: the store is per-process. On Cloud Run with multiple instances
// each instance keeps its own counters, so the effective limit is
// (max × instanceCount). This is intentional defense-in-depth — it is not a
// billing/quota control (that lives in api/_lib/runs.ts, which is per-user and
// Mongo-backed and therefore global). For a hard cross-instance auth cap, back
// this with a shared store (Redis/Memorystore); the interface below is
// store-agnostic so that swap is localized.

import type { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  resetAt: number; // epoch ms when the window rolls over
}

export interface RateLimitOptions {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Max requests permitted per key per window. */
  max: number;
  /** Namespace so independent limiters never collide in the shared store. */
  name: string;
  /** Human-readable 429 detail. */
  message?: string;
  /** Override the per-request key (defaults to the client IP). */
  keyGenerator?: (req: Request) => string;
}

// Single shared store keyed by `${name}:${clientKey}`. Entries self-expire and
// a periodic sweep evicts stale ones so the map can't grow unbounded.
const store = new Map<string, Bucket>();

let sweeper: ReturnType<typeof setInterval> | null = null;
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of store) {
      if (b.resetAt <= now) store.delete(k);
    }
  }, 60_000);
  // Don't keep the event loop alive just for the sweeper.
  sweeper.unref?.();
}

/** Best-effort client identity. Honors X-Forwarded-For only when the app has
 *  `trust proxy` set (see server/index.ts), otherwise falls back to the socket
 *  address. Never throws. */
export function clientKey(req: Request): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Core limiter. Pure function over the module store so it's unit-testable: call
 * `consume` directly, or use `rateLimit()` for the Express middleware.
 *
 * Returns the post-increment limiter state for the given key.
 */
export function consume(
  name: string,
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): { allowed: boolean; remaining: number; resetMs: number } {
  const storeKey = `${name}:${key}`;
  let b = store.get(storeKey);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    store.set(storeKey, b);
  }
  b.count += 1;
  const resetMs = b.resetAt - now;
  const allowed = b.count <= max;
  const remaining = Math.max(0, max - b.count);
  return { allowed, remaining, resetMs };
}

export function rateLimit(opts: RateLimitOptions) {
  ensureSweeper();
  const keyOf = opts.keyGenerator ?? clientKey;
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const { allowed, remaining, resetMs } = consume(opts.name, keyOf(req), opts.max, opts.windowMs);
    const resetSec = Math.ceil(resetMs / 1000);
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSec));
    if (!allowed) {
      res.setHeader('Retry-After', String(resetSec));
      res.status(429).json({
        error: 'rate_limit_exceeded',
        detail: opts.message ?? 'Too many requests. Please retry later.',
      });
      return;
    }
    next();
  };
}

// ---- Configured limiters ---------------------------------------------------

// Every endpoint: generous cap to absorb a single client's burst without
// throttling the app's own pipeline (which fans out a dozen agent calls/min).
export const globalRateLimit = rateLimit({
  name: 'global',
  windowMs: 60_000,
  max: 120,
  message: 'Too many requests — slow down and retry in a minute.',
});

// Authentication / OAuth routes: 5 attempts per 15 minutes, per the brief.
export const authRateLimit = rateLimit({
  name: 'auth',
  windowMs: 15 * 60_000,
  max: 5,
  message: 'Too many authentication attempts. Try again in 15 minutes.',
});

/** Test seam — clears all counters between unit tests. */
export function __resetRateLimitStore(): void {
  store.clear();
}
