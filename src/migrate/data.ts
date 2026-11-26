import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../model/data.js";

/**
 * The migration data: data/migrations/r{N}.json holds the changes made in release N (the "N-1 → N" section of the
 * three.js migration guide), written by hand from the guide and the pull requests it links. Each entry says how to
 * find the old code (a pattern, review rule ids, or both), what to do instead, and where it is documented.
 */

export type MigrationKind = "rename" | "removed" | "behaviour" | "appearance";
export const MIGRATION_KINDS: readonly MigrationKind[] = ["rename", "removed", "behaviour", "appearance"];

export interface Detect {
  /** JavaScript regular expression (source), matched against the code with comments blanked. */
  pattern?: string;
  /** Review rule ids whose findings are this change. */
  rules?: string[];
  /** The pattern counts only where this also matches (in the same file or anywhere in the project). */
  also?: string;
  /** The pattern does not count in a file where this matches. */
  unless?: string;
}

export interface MigrationEntry {
  id: string;
  kind: MigrationKind;
  title: string;
  detect: Detect;
  /** What to do instead. */
  todo: string;
  /** A name that must exist in the target release (checked against the installed API index). */
  replacement?: string;
  /** For a deprecation: the release that removed the old API (verified in the source or the review rules). */
  removedIn?: number;
  /** The pull request, issue or migration guide section. */
  source: string;
}

export interface MigrationRelease {
  release: number;
  /** The section of the migration guide. */
  guide: string;
  entries: MigrationEntry[];
}

let cached: MigrationRelease[] | undefined;

/** Checks one release file; throws naming the file and the entry. */
export function parseRelease(json: unknown, file: string): MigrationRelease {
  const o = json as Partial<MigrationRelease>;
  if (!o || typeof o.release !== "number" || !Number.isInteger(o.release) || typeof o.guide !== "string" || !Array.isArray(o.entries)) throw new Error(`${file}: needs release, guide and entries`);
  for (const e of o.entries as Partial<MigrationEntry>[]) {
    const where = `${file} ${e?.id ?? "?"}`;
    if (!e || typeof e.id !== "string" || !/^[a-z0-9-]+$/.test(e.id)) throw new Error(`${where}: id must be kebab-case`);
    if (!MIGRATION_KINDS.includes(e.kind as MigrationKind)) throw new Error(`${where}: kind must be one of ${MIGRATION_KINDS.join(", ")}`);
    if (typeof e.title !== "string" || typeof e.todo !== "string" || typeof e.source !== "string" || !/^https:\/\//.test(e.source)) throw new Error(`${where}: needs title, todo and an https source`);
    const d = e.detect;
    if (!d || (!d.pattern && !d.rules?.length)) throw new Error(`${where}: detect needs a pattern or rules`);
    for (const k of ["pattern", "also", "unless"] as const) {
      if (d[k] === undefined) continue;
      try {
        new RegExp(d[k]!, "g");
      } catch (err) {
        throw new Error(`${where}: detect.${k} is not a valid regular expression: ${(err as Error).message}`);
      }
    }
  }
  return o as MigrationRelease;
}

/** All releases with migration data, oldest first. */
export function migrations(dir: string = dataDir("migrations")): MigrationRelease[] {
  if (cached && dir === dataDir("migrations")) return cached;
  const out = readdirSync(dir)
    .filter((f) => /^r\d+\.json$/.test(f))
    .map((f) => parseRelease(JSON.parse(readFileSync(join(dir, f), "utf8")), f))
    .sort((a, b) => a.release - b.release);
  if (dir === dataDir("migrations")) cached = out;
  return out;
}

/** The newest and oldest release the data covers. */
export function dataRange(): { min: number; max: number } {
  const all = migrations();
  return { min: all[0]?.release ?? 0, max: all.at(-1)?.release ?? 0 };
}
