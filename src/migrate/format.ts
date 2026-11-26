import type { MigratePlan } from "./migrate.js";

/** The plan as compact text: one line per change, the TO DO list with file:line, what will look different. */
export function formatMigrate(p: MigratePlan, opts: { detail?: "brief" | "full" } = {}): string {
  const full = opts.detail === "full";
  const cap = (n: number) => (full ? Number.POSITIVE_INFINITY : n);
  const changes = p.releases.reduce((a, r) => a + r.entries.length, 0);
  const why = p.fromEvidence.length ? ` (from: ${p.fromEvidence.map((e) => e.from).join("; ")})` : "";
  const out = [`Threesmith migrate: r${p.from} -> r${p.to}${p.installed !== null ? ` (installed r${p.installed})` : ""}${why}`];
  if (p.to > p.data.max) out.push(`note: the migration data goes up to r${p.data.max}; changes after it are not listed.`);
  if (p.from < p.data.min) out.push(`note: the migration data starts at r${p.data.min}; changes before it are not listed. Move in steps of about 10 releases.`);
  if (!changes) {
    out.push(`No change between r${p.from} and r${p.to} shows in this code (${p.filesScanned} file(s) scanned, ${p.notFound.length} change(s) checked).`);
    return out.join("\n");
  }
  const kinds = Object.entries(p.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ");
  out.push(`${changes} change(s) in ${p.releases.length} release(s) apply to this code (${kinds}). ${p.todo.length} place(s) need hand work${p.fixable ? `, ${p.fixable} write: true rewrites (three_fix renames included)` : ""}.`);
  out.push("", "Plan:");
  for (const r of p.releases) {
    for (const e of r.entries) {
      const first = e.where[0]!;
      out.push(`  r${r.release} ${e.kind.padEnd(10)} [${e.id}] ${e.title}: ${e.where.length} place(s), first ${first.file}:${first.line}${e.fix ? " (write)" : ""}`);
    }
  }
  if (p.todo.length) {
    out.push("", `TO DO (${p.todo.length}):`);
    for (const t of p.todo.slice(0, cap(30))) {
      const rep = t.replacement ? ` [${t.replacement}${t.replacementExists === false ? ` is not in the installed r${p.installed}` : ""}]` : "";
      out.push(`  ${t.file}:${t.line} r${t.release} [${t.id}] ${t.todo}${rep}`);
    }
    if (p.todo.length > cap(30)) out.push(`  ... ${p.todo.length - 30} more (detail full)`);
  }
  if (p.appearance.length) {
    out.push("", "Will look different:");
    for (const a of p.appearance.slice(0, cap(12))) out.push(`  r${a.release} [${a.id}] ${a.title}: ${a.where.length} place(s), e.g. ${a.where[0]!.file}:${a.where[0]!.line}. ${a.todo}`);
  }
  if (p.fixable) out.push("", "Next: three_migrate with write: true for the exact rewrites (undoable); then the TO DO list, with three_api for every replacement; then three_review.");
  else out.push("", "Next: the TO DO list, with three_api for every replacement; then three_review.");
  if (full && p.notFound.length) {
    out.push("", `Not found in this code (${p.notFound.length}):`);
    for (const n of p.notFound) out.push(`  r${n.release} [${n.id}] ${n.title}`);
  } else if (p.notFound.length) out.push(`${p.notFound.length} other change(s) between r${p.from} and r${p.to} do not show in this code (detail full lists them).`);
  if (full) {
    out.push("", "Sources:");
    for (const r of p.releases) for (const e of r.entries) out.push(`  [${e.id}] ${e.source}`);
  }
  return out.join("\n");
}
