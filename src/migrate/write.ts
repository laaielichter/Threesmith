import { statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { findThree } from "../api/install.js";
import { codeOnly, fix } from "../review/fix.js";
import { collect, stripComments } from "../review/source.js";
import { migrations } from "./data.js";
import { crosses, migratePlan, type MigrateOptions, type MigratePlan } from "./migrate.js";

/**
 * The writes of three_migrate: the renames of three_fix (same meaning, checked per release) and the migration data's
 * own exact rewrites, for every release crossed whose new names exist in the installed three. Pure: it returns the new
 * file contents; the caller writes them through the journal, so three_undo takes them back in one step.
 */

export interface MigrateFileWrite {
  /** Relative to the folder that was migrated. */
  file: string;
  /** Path relative to the project root, for the journal. */
  rootFile: string;
  data: string;
  count: number;
  /** Change ids and three_fix rule ids applied here. */
  changes: string[];
}

export interface MigrateWrite {
  plan: MigratePlan;
  files: MigrateFileWrite[];
  total: number;
  /** Rewrites left out because the installed three does not have the new name yet. */
  skipped: { id: string; release: number }[];
}

const SKIP_FILE = /\.min\.|\.d\.ts$/;

/** Applies one entry's rewrites to a file's text; returns the new text and how many places changed. */
export function applyRewrites(text: string, rewrites: { find: string; replace: string; code?: boolean }[]): { text: string; count: number } {
  let out = text;
  let count = 0;
  for (const r of rewrites) {
    const blanked = stripComments(out);
    const source = r.code ? codeOnly(blanked) : blanked;
    const edits: { start: number; end: number; text: string }[] = [];
    for (const m of source.matchAll(new RegExp(r.find, "gmd"))) {
      const start = m.index ?? 0;
      // groups are read from the real text at the same offsets (blanking keeps lengths)
      const group = (n: number) => {
        const at = m.indices?.[n];
        return at ? out.slice(at[0], at[1]) : "";
      };
      edits.push({ start, end: start + m[0].length, text: r.replace.replace(/\$(\d)/g, (_, n: string) => group(Number(n))) });
    }
    for (const e of edits.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    count += edits.length;
  }
  return { text: out, count };
}

export function migrateWrite(opts: MigrateOptions): MigrateWrite {
  const plan = migratePlan(opts);
  const isDir = statSync(opts.path).isDirectory();
  const folder = isDir ? opts.path : dirname(opts.path);
  const install = findThree(folder, opts.three);
  const installed = install?.release ?? 0;
  const wanted = opts.files?.length ? new Set(opts.files.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, ""))) : undefined;
  const fixed = fix({ path: opts.path, ...(opts.three ? { three: opts.three } : {}) });
  const texts = new Map<string, { text: string; count: number; changes: Set<string> }>();
  for (const f of fixed.files) if (!wanted || wanted.has(f.file)) texts.set(f.file, { text: f.fixed, count: f.count, changes: new Set(f.rules) });

  const skipped: MigrateWrite["skipped"] = [];
  const entries = migrations().flatMap((r) => r.entries.filter((e) => e.rewrite?.length && crosses(e, r.release, plan.from, plan.to)).map((e) => ({ e, release: r.release })));

  for (const f of collect(opts.path).files) {
    if (SKIP_FILE.test(f.path) || (wanted && !wanted.has(f.path)) || !(f.usesThree || /\.html?$/.test(f.path))) continue;
    const cur = texts.get(f.path) ?? { text: f.raw, count: 0, changes: new Set<string>() };
    for (const { e, release } of entries) {
      const blanked = stripComments(cur.text);
      if (e.detect.unless && new RegExp(e.detect.unless).test(blanked)) continue;
      if (e.detect.also && !new RegExp(e.detect.also).test(blanked)) continue;
      const r = applyRewrites(cur.text, e.rewrite!);
      if (!r.count) continue;
      // the new name must exist in the installed three, or the rewrite would break the code
      if (release > installed) {
        if (!skipped.some((x) => x.id === e.id)) skipped.push({ id: e.id, release });
        continue;
      }
      cur.text = r.text;
      cur.count += r.count;
      cur.changes.add(e.id);
    }
    if (cur.count) texts.set(f.path, cur);
  }
  const root = plan.root;
  const files = [...texts.entries()]
    .filter(([, v]) => v.count)
    .map(([file, v]) => ({ file, rootFile: relative(root, join(folder, file)).split("\\").join("/"), data: v.text, count: v.count, changes: [...v.changes].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { plan, files, total: files.reduce((a, f) => a + f.count, 0), skipped };
}

export function formatMigrateWrite(w: MigrateWrite, written: boolean, journal?: number): string {
  const out: string[] = [];
  if (!w.total) out.push("Nothing to rewrite mechanically: the TO DO list is hand work.");
  else {
    out.push(written ? `Rewrote ${w.total} place(s) in ${w.files.length} file(s):` : `Would rewrite ${w.total} place(s) in ${w.files.length} file(s) (write: true / --write applies them):`);
    for (const f of w.files) out.push(`  ${f.file}: ${f.count} (${f.changes.join(", ")})`);
  }
  if (w.skipped.length) out.push(`Not rewritten, the installed three does not have the new name yet: ${w.skipped.map((s) => `${s.id} (r${s.release})`).join(", ")}. Install the target release first.`);
  if (journal) out.push(`Undo with three_undo / threesmith undo (journal #${journal}).`);
  if (written) out.push("Run three_migrate again for what is left, then three_review.");
  return out.join("\n");
}
