import type { Page } from "playwright-core";

/**
 * A deterministic, paused clock for headless runs (`seed` / `fixed_dt` in check, play and scenarios). Before any page
 * script runs, it replaces:
 * - `requestAnimationFrame` / `cancelAnimationFrame`: callbacks wait in a queue and run only when Threesmith advances
 *   the clock, one frame at a time, with a timestamp that grows by exactly `fixedDt` ms per frame;
 * - `performance.now()`, `Date.now()` and `new Date()`: virtual time, which moves only with those frames (Date starts
 *   at 2026-01-01T00:00:00Z);
 * - `Math.random()`: a seeded generator (mulberry32), the same numbers every run.
 * Waits become frames (`wait 500` at 16.67 ms is 30 frames), so a run gives the same frames, values and pixels every
 * time. Not virtual: `setTimeout`/`setInterval`, network loads and workers still run in real time, so wait for a
 * loaded model with an `until` step rather than a fixed wait. The real functions stay on `window.__tsReal` for
 * Threesmith's own helpers.
 */

export interface ClockOptions {
  /** Seed for Math.random (an integer). */
  seed?: number;
  /** Milliseconds per frame. */
  fixedDt?: number;
}

export const DEFAULT_DT = 1000 / 60;
export const DEFAULT_SEED = 1;
/** 2026-01-01T00:00:00Z: where Date starts in a deterministic run. */
export const CLOCK_EPOCH = 1767225600000;

/** The clock settings a run uses, or undefined when neither seed nor fixedDt is set. Throws on bad values. */
export function clockSettings(o: ClockOptions): { seed: number; fixedDt: number } | undefined {
  if (o.seed === undefined && o.fixedDt === undefined) return undefined;
  const seed = o.seed ?? DEFAULT_SEED;
  const fixedDt = o.fixedDt ?? DEFAULT_DT;
  if (!Number.isSafeInteger(seed)) throw new Error(`seed must be a whole number, got ${seed}`);
  if (!Number.isFinite(fixedDt) || fixedDt <= 0 || fixedDt > 1000) throw new Error(`fixed_dt must be more than 0 and at most 1000 ms, got ${fixedDt}`);
  return { seed, fixedDt };
}

/** The init script for a clock: numbers only are put into it, checked by clockSettings. */
export function clockInit(s: { seed: number; fixedDt: number }): string {
  return `(() => {
  const w = window;
  const dt = ${Number(s.fixedDt)};
  let seed = ${Number(s.seed)} >>> 0;
  const real = w.__tsReal = { now: performance.now.bind(performance), dateNow: Date.now, Date, raf: w.requestAnimationFrame.bind(w), caf: w.cancelAnimationFrame.bind(w), setTimeout: w.setTimeout.bind(w), random: Math.random };
  let now = 0;
  let next = 1;
  let queue = new Map();
  const clock = w.__tsClock = { dt, seed: ${Number(s.seed)}, frames: 0, time: () => now };
  Math.random = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  performance.now = () => now;
  const RealDate = real.Date;
  const epoch = ${CLOCK_EPOCH};
  function VDate(...args) {
    if (!new.target) return new RealDate(epoch + now).toString();
    return args.length ? new RealDate(...args) : new RealDate(epoch + now);
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = () => Math.floor(epoch + now);
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  w.Date = VDate;
  w.requestAnimationFrame = (cb) => { const id = next++; queue.set(id, cb); return id; };
  w.cancelAnimationFrame = (id) => { queue.delete(id); };
  /** Runs n frames: time moves by dt, the queued callbacks run, then real tasks (promises, loads) get a turn. */
  clock.advance = async (n) => {
    for (let i = 0; i < n; i++) {
      now = Math.round((now + dt) * 1000) / 1000;
      clock.frames++;
      const due = queue;
      queue = new Map();
      for (const cb of due.values()) {
        try { cb(now); } catch (e) { real.setTimeout(() => { throw e; }, 0); }
      }
      await new Promise((ok) => real.setTimeout(ok, 0));
    }
    return now;
  };
})();`;
}

/** Pages whose clock Threesmith drives, with their frame length. */
const virtual = new WeakMap<Page, number>();

export function markVirtual(page: Page, fixedDt: number): void {
  virtual.set(page, fixedDt);
}

/** The frame length of a page with a deterministic clock, or undefined for a real-time page. */
export function virtualDt(page: Page): number | undefined {
  return virtual.get(page);
}

/** Frames that stand for ms of waiting (at least 1). */
export function framesFor(ms: number, dt: number): number {
  return Math.max(1, Math.round(ms / dt));
}

/** Advances a deterministic page by n frames. */
export async function advance(page: Page, n: number): Promise<void> {
  await page.evaluate(`window.__tsClock.advance(${Math.max(0, Math.min(Math.round(n), 100_000))})`);
}

/** Lets a page run for ms: real time on a normal page, the same span in frames on a deterministic one. */
export async function settle(page: Page, ms: number): Promise<void> {
  const dt = virtualDt(page);
  if (dt === undefined) await page.waitForTimeout(ms);
  else await advance(page, framesFor(ms, dt));
}
