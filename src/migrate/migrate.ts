import { statSync } from "node:fs";
import { dirname } from "node:path";
import { findThree } from "../api/install.js";
import { hasSymbol } from "../api/lookup.js";
import { indexFor } from "../core.js";
import { FIXES, REWRITE_RULES } from "../review/fix.js";
import { review } from "../review/review.js";
import { collect, lineOf, lineText, type SourceFile } from "../review/source.js";
import { projectRootOf } from "../scan/scan.js";
import { migrations, type MigrationEntry, type MigrationKind } from "./data.js";
import { detectFrom, releaseNumber, type FromEvidence } from "./from.js";

/**
 * three_migrate: the plan to move code from one three release to another. It crosses the releases between them,
 * finds in the code the changes each one made (migration data in data/migrations, plus the review rules), and returns
 * them per release, a TO DO list with file and line for the hand work, and what will look different.
 */

export interface MigrateOptions {
  /** Project folder, or a file or folder in it. */
  path: string;
  /** The release the code was written for: "r150", "150", "0.150.0", or "auto" (default). */
  from?: string;
  /** The release to move to: "installed" (default) or a release. */
  to?: string;
  three?: string;
  /** Only these files (relative to the project). */
  files?: string[];
}

export interface Place {
  file: string;
  line: number;
  snippet: string;
  /** three_fix makes this change here (a rename with the same meaning). */
  fix?: boolean;
}

export interface AppliedEntry extends MigrationEntry {
  release: number;
  where: Place[];
  /** Every place is a rename three_fix makes. */
  fix: boolean;
  /** For a replacement name: does it exist in the installed three? */
  replacementExists?: boolean;
}

export interface TodoItem extends Place {
  id: string;
  release: number;
  kind: MigrationKind;
  title: string;
  todo: string;
  replacement?: string;
  replacementExists?: boolean;
  source: string;
}

export interface MigratePlan {
  from: number;
  to: number;
  installed: number | null;
  /** Why `from` is what it is when it was found by itself. */
  fromEvidence: FromEvidence[];
  /** Releases crossed that have changes in this code, oldest first. */
  releases: { release: number; guide: string; entries: AppliedEntry[] }[];
  counts: Record<MigrationKind, number>;
  /** Hand work: every place of a change three_fix does not make, oldest release first. */
  todo: TodoItem[];
  /** Changes that make the scene look different, with where they apply. */
  appearance: AppliedEntry[];
  /** Places three_fix makes (rename with the same meaning). */
  fixable: number;
  /** Changes between the two releases that this code does not show. */
  notFound: { release: number; id: string; title: string }[];
  /** The releases the data covers. */
  data: { min: number; max: number };
  filesScanned: number;
}

const MAX_PLACES = 50;

/** Does three_fix (without rewrites) change this line for one of these rules, on this release? */
function fixedBy(rules: string[] | undefined, line: string, release: number): boolean {
  if (!rules?.length) return false;
  return FIXES.some((fx) => rules.includes(fx.rule) && !REWRITE_RULES.has(fx.rule) && (fx.introducedIn ?? 0) <= release && new RegExp(fx.re.source, fx.re.flags.replace("g", "")).test(line));
}
const isShaderish = (f: SourceFile) => /#include\s*<|\bgl_(?:Position|FragColor)\b/.test(f.text);

/** Parses a release option: undefined for "auto" / "installed" / empty. Throws on anything else that is no release. */
export function releaseOption(name: string, value: string | undefined, fallbackWord: string): number | undefined {
  if (value === undefined || value.trim() === "" || value.trim().toLowerCase() === fallbackWord) return undefined;
  const r = releaseNumber(value);
  if (r === undefined) throw new Error(`${name} must be a release such as r150 (or ${fallbackWord}), got "${value}"`);
  return r;
}

/**
 * Does moving from `from` to `to` cross this change? A change made in `from` itself counts (code written for that
 * release may still use the name it deprecated), except a change in the look, which that code already had; a
 * deprecation also counts while its removal is still ahead.
 */
export function crosses(entry: MigrationEntry, release: number, from: number, to: number): boolean {
  if (release > to) return false;
  if (release > from || (release === from && entry.kind !== "appearance")) return true;
  return entry.removedIn !== undefined && entry.removedIn > from && entry.removedIn <= to;
}

/** Where a regular expression matches in a file, with the also/unless conditions of the entry. */
function matches(entry: MigrationEntry, f: SourceFile, all: string): Place[] {
  const d = entry.detect;
  if (!d.pattern) return [];
  if (d.unless && new RegExp(d.unless).test(f.text)) return [];
  if (d.also && !new RegExp(d.also).test(f.text) && !new RegExp(d.also).test(all)) return [];
  const out: Place[] = [];
  const seen = new Set<number>();
  for (const m of f.text.matchAll(new RegExp(d.pattern, "g"))) {
    const line = lineOf(f.text, m.index ?? 0);
    if (seen.has(line)) continue;
    seen.add(line);
    out.push({ file: f.path, line, snippet: lineText(f.raw, line).trim().slice(0, 120) });
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}

export function migratePlan(opts: MigrateOptions): MigratePlan {
  const isDir = statSync(opts.path).isDirectory();
  const folder = isDir ? opts.path : dirname(opts.path);
  const root = projectRootOf(folder);
  const install = findThree(folder, opts.three);
  const all = migrations();
  const data = { min: all[0]!.release, max: all.at(-1)!.release };
  const to = releaseOption("to", opts.to, "installed") ?? install?.release;
  if (to === undefined) throw new Error("three is not installed here, so the target release is unknown: pass to (e.g. r187) or install three.");
  const collected = collect(opts.path);
  const wanted = opts.files?.length ? new Set(opts.files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""))) : undefined;
  const files = collected.files.filter((f) => (!wanted || wanted.has(f.path)) && (f.usesThree || /\.html?$/.test(f.path) || isShaderish(f)));
  let from = releaseOption("from", opts.from, "auto");
  let fromEvidence: FromEvidence[] = [];
  if (from === undefined) {
    const found = detectFrom(root, collected.files, collected.packageJson, to);
    if (!found) throw new Error(`could not tell which three release this code was written for (no CDN version, @types/three, lockfile or git history below r${to}): pass from, e.g. r150.`);
    from = found.release;
    fromEvidence = found.evidence;
  }
  if (from >= to) throw new Error(`nothing to migrate: from r${from} is not older than to r${to}.`);

  const allText = files.map((f) => f.text).join("\n");
  const needsReview = all.some((r) => r.entries.some((e) => e.detect.rules?.length && crosses(e, r.release, from!, to)));
  const findings = needsReview ? review({ path: opts.path, ...(opts.three ? { three: opts.three } : {}) }).findings : [];
  let index: ReturnType<typeof indexFor> | undefined;
  try {
    index = install ? indexFor(folder, opts.three) : undefined;
  } catch {
    index = undefined;
  }

  const plan: MigratePlan = { from, to, installed: install?.release ?? null, fromEvidence, releases: [], counts: { rename: 0, removed: 0, behaviour: 0, appearance: 0 }, todo: [], appearance: [], fixable: 0, notFound: [], data, filesScanned: files.length };
  for (const rel of all) {
    const applied: AppliedEntry[] = [];
    for (const entry of rel.entries) {
      if (!crosses(entry, rel.release, from, to)) continue;
      const places = new Map<string, Place>();
      for (const f of files) for (const p of matches(entry, f, allText)) places.set(`${p.file}:${p.line}`, p);
      const onLine = entry.detect.pattern ? new RegExp(entry.detect.pattern) : undefined;
      for (const fd of findings) {
        if (!entry.detect.rules?.includes(fd.rule) || (wanted && !wanted.has(fd.file))) continue;
        // a rule can stand for several changes (tsl-renamed): with a pattern, only its own lines count
        if (onLine && !onLine.test(fd.snippet)) continue;
        places.set(`${fd.file}:${fd.line}`, { file: fd.file, line: fd.line, snippet: fd.snippet.trim().slice(0, 120) });
      }
      if (!places.size) {
        plan.notFound.push({ release: rel.release, id: entry.id, title: entry.title });
        continue;
      }
      const where = [...places.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line).slice(0, MAX_PLACES);
      if (entry.kind === "rename") for (const p of where) if (fixedBy(entry.detect.rules, p.snippet, install?.release ?? to)) p.fix = true;
      const fix = where.every((p) => p.fix);
      const a: AppliedEntry = { ...entry, release: rel.release, where, fix, ...(entry.replacement && index ? { replacementExists: hasSymbol(index, entry.replacement) } : {}) };
      applied.push(a);
      plan.counts[entry.kind]++;
      if (entry.kind === "appearance") plan.appearance.push(a);
      else
        for (const p of where) {
          if (p.fix) {
            plan.fixable++;
            continue;
          }
          plan.todo.push({ ...p, id: a.id, release: a.release, kind: a.kind, title: a.title, todo: a.todo, ...(a.replacement ? { replacement: a.replacement } : {}), ...(a.replacementExists !== undefined ? { replacementExists: a.replacementExists } : {}), source: a.source });
        }
    }
    if (applied.length) plan.releases.push({ release: rel.release, guide: rel.guide, entries: applied });
  }
  return plan;
}
