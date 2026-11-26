import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { learningOn, threesmithHome } from "../learn/feedback.js";
import { errorTemplate } from "../lessons/local.js";

/**
 * What a dream reads back: small counters kept on this machine while agents work. API names that were looked up and
 * did not exist (with the name the installed three suggested), browser and console messages that no explanation or
 * lesson covered (as scrubbed templates), Threesmith writes that were undone (tool and rule, never the code) and how
 * many sessions started. Nothing else: no code, no file names, no paths. $THREESMITH_HOME/signals.json, readable
 * only by this user; THREESMITH_LEARN=0 turns it off.
 */

export interface Counter {
  n: number;
  /** Day of the last time it was seen (YYYY-MM-DD). */
  last: string;
}

export interface Signals {
  version: 1;
  sessions: { n: number; first: string };
  /** Day of the last dream. */
  lastDream?: string;
  /** Sessions counted at the last dream. */
  sessionsAtDream?: number;
  /** API names that were not there: `BoxBufferGeometry` → what the installed three suggested. */
  apiMisses: Record<string, Counter & { suggest?: string }>;
  /** Scrubbed message templates that nothing explained. */
  unexplained: Record<string, Counter>;
  /** Undone writes per tool (`fix`, `migrate`). */
  undone: Record<string, Counter>;
  /** Proposal keys and the day they were applied or set aside. */
  handled: Record<string, { how: "applied" | "seen"; at: string }>;
}

export const MAX_ITEMS = 200;

const file = (): string => join(threesmithHome(), "signals.json");
const today = (now = new Date()): string => now.toISOString().slice(0, 10);

export function emptySignals(now = new Date()): Signals {
  return { version: 1, sessions: { n: 0, first: today(now) }, apiMisses: {}, unexplained: {}, undone: {}, handled: {} };
}

function counters<T extends Counter>(v: unknown, extra?: (o: Record<string, unknown>) => Partial<T>): Record<string, T> {
  const out: Record<string, T> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== "object" || typeof raw["n"] !== "number" || raw["n"] < 1) continue;
    out[k.slice(0, 240)] = { n: Math.floor(raw["n"]), last: typeof raw["last"] === "string" ? raw["last"].slice(0, 10) : "", ...(extra?.(raw) ?? {}) } as T;
  }
  return out;
}

/** The signals file in the shape it should have; a missing or broken file reads as empty. */
export function readSignals(): Signals {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    if (raw["version"] !== 1) return emptySignals();
    const s = raw["sessions"] as { n?: unknown; first?: unknown } | undefined;
    const handled: Signals["handled"] = {};
    for (const [k, h] of Object.entries((raw["handled"] ?? {}) as Record<string, { how?: unknown; at?: unknown }>)) {
      if (h && (h.how === "applied" || h.how === "seen") && typeof h.at === "string") handled[k] = { how: h.how, at: h.at.slice(0, 10) };
    }
    return {
      version: 1,
      sessions: { n: typeof s?.n === "number" && s.n >= 0 ? Math.floor(s.n) : 0, first: typeof s?.first === "string" ? s.first.slice(0, 10) : today() },
      ...(typeof raw["lastDream"] === "string" ? { lastDream: raw["lastDream"].slice(0, 10) } : {}),
      ...(typeof raw["sessionsAtDream"] === "number" ? { sessionsAtDream: Math.floor(raw["sessionsAtDream"]) } : {}),
      apiMisses: counters<Counter & { suggest?: string }>(raw["apiMisses"], (o) => (typeof o["suggest"] === "string" ? { suggest: o["suggest"].slice(0, 80) } : {})),
      unexplained: counters(raw["unexplained"]),
      undone: counters(raw["undone"]),
      handled,
    };
  } catch {
    return emptySignals();
  }
}

/** Keep the most recent and most frequent entries of a map once it grows past MAX_ITEMS. */
function cap<T extends Counter>(m: Record<string, T>): Record<string, T> {
  const keys = Object.keys(m);
  if (keys.length <= MAX_ITEMS) return m;
  const keep = keys.sort((a, b) => m[b]!.last.localeCompare(m[a]!.last) || m[b]!.n - m[a]!.n).slice(0, MAX_ITEMS);
  return Object.fromEntries(keep.map((k) => [k, m[k]!]));
}

/** Read, change and write the signals atomically. Never throws: signals are a bonus, never in the way of a tool. */
export function updateSignals(change: (s: Signals) => void): Signals | undefined {
  if (!learningOn()) return undefined;
  try {
    const s = readSignals();
    change(s);
    s.apiMisses = cap(s.apiMisses);
    s.unexplained = cap(s.unexplained);
    s.undone = cap(s.undone);
    const f = file();
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    try {
      renameSync(tmp, f);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return s;
  } catch {
    return undefined;
  }
}

function bump<T extends Counter>(m: Record<string, T>, key: string, extra: Partial<T> = {}, now = new Date()): void {
  const c = m[key];
  m[key] = { ...(c ?? {}), ...extra, n: (c?.n ?? 0) + 1, last: today(now) } as T;
}

/** A name shaped like a three.js API name: `Mesh`, `WebGLRenderer.setSize`, `sRGBEncoding`. */
const API_NAME = /^[A-Za-z_$][\w$]{1,60}(?:\.[A-Za-z_$][\w$]{0,60})?$/;

/**
 * An API lookup that found nothing. Kept only when the installed three had a suggestion, so the name is one an agent
 * guessed for a three.js API (and not a word of the project).
 */
export function recordApiMiss(query: string, suggestions: readonly string[]): void {
  const q = query.trim().replace(/^THREE\./, "");
  const suggest = suggestions[0];
  if (!API_NAME.test(q) || !suggest || suggest === q) return;
  updateSignals((s) => bump(s.apiMisses, q, { suggest }));
}

/** A message nothing explained, kept as its scrubbed template (no names, paths or numbers). */
export function recordUnexplained(message: string): void {
  const t = errorTemplate(message).trim();
  if (t.length < 12 || !/[a-z]{3}/i.test(t)) return;
  updateSignals((s) => bump(s.unexplained, t));
}

/** Writes that were undone, counted per tool (`fix`, `migrate`, `decoders`); never what they wrote. */
export function recordUndone(entries: readonly { tool: string }[]): void {
  const keys = entries.map((e) => e.tool.replace(/^three_/, "").split(/\s/)[0]!).filter(Boolean);
  if (keys.length) updateSignals((s) => keys.forEach((k) => bump(s.undone, k)));
}

/** A session started (the SessionStart hook). */
export function recordSession(): Signals | undefined {
  return updateSignals((s) => {
    s.sessions.n++;
  });
}
