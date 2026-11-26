import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { explain } from "../explain/explain.js";
import { readFeedback } from "../learn/feedback.js";
import { readLocal, removeLocalLesson } from "../lessons/local.js";
import { allLessons, lessonsForError } from "../lessons/search.js";
import type { LocalData } from "../lessons/types.js";
import { stateDir, writeFiles } from "../project/journal.js";
import { readSignals, updateSignals, type Signals } from "./signals.js";

/**
 * Dreaming: between sessions, Threesmith looks back at what agents ran into on this machine and turns it into
 * numbered proposals, each with its evidence. API names agents keep guessing become project hints, messages nothing
 * explained become draft lessons to finish, lessons that misled are retired, duplicates merged, rules that are
 * often wrong here get a note, and tools whose writes keep being undone are flagged.
 *
 * Deterministic: no model, no network, nothing leaves the machine. Nothing changes until a proposal is applied.
 * Project hints go through the journal (three_undo takes them back) into `.threesmith/hints.json`, which is local
 * state, and the session start shows them to the next agent.
 */

export type ProposalKind = "api-hint" | "draft-lesson" | "retire-lesson" | "merge-lessons" | "noisy-rule" | "undone-tool";

const KIND_ORDER: ProposalKind[] = ["api-hint", "draft-lesson", "retire-lesson", "merge-lessons", "noisy-rule", "undone-tool"];

const KIND_LABEL: Record<ProposalKind, string> = {
  "api-hint": "project hint",
  "draft-lesson": "draft lesson",
  "retire-lesson": "retire lesson",
  "merge-lessons": "merge lessons",
  "noisy-rule": "noisy rule",
  "undone-tool": "undone writes",
};

export interface Proposal {
  /** Number in this list, from 1. */
  n: number;
  /** Stable id: the same proposal has the same key in the next dream. */
  key: string;
  kind: ProposalKind;
  title: string;
  reason: string;
  evidence: Record<string, number>;
  /** What applying it does; absent for a suggestion, which applying only sets aside. */
  apply?: string;
  /** Safe details: API names, a lesson id, a rule id, a tool, a message template. */
  detail: { use?: string; not?: string; lessons?: string[]; rule?: string; tool?: string; template?: string };
}

export interface Due {
  due: boolean;
  /** Sessions since the last dream (or since counting began). */
  sessions: number;
  /** Hours since the last dream, or null before the first. */
  hours: number | null;
  lastDream?: string;
}

export interface DreamResult {
  proposals: Proposal[];
  /** Proposals left out because they were applied or set aside before (shown with all). */
  handled: number;
  due: Due;
  sources: { apiMisses: number; unexplained: number; undone: number; feedbackRules: number; localLessons: number };
}

export interface DreamOptions {
  /** Show proposals that were applied or set aside before, too. */
  all?: boolean;
  now?: Date;
  /** Data to use instead of the files on this machine (tests). */
  signals?: Signals;
  local?: LocalData;
  feedback?: ReturnType<typeof readFeedback>;
}

/** Evidence a proposal needs before it is made. */
export const MIN_REPEATS = 2;
export const DUE_SESSIONS = 5;
export const DUE_HOURS = 24;

const keyOf = (kind: ProposalKind, ...parts: string[]): string => `${kind}:${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 10)}`;

const words = (s: string): string =>
  s
    .toLowerCase()
    .replace(/<[a-z]+>/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function dueOf(s: Signals, now = new Date()): Due {
  const sessions = s.sessions.n - (s.sessionsAtDream ?? 0);
  const hours = s.lastDream ? Math.floor((now.getTime() - Date.parse(`${s.lastDream}T00:00:00Z`)) / 3_600_000) : null;
  return { due: sessions >= DUE_SESSIONS && (hours === null || hours >= DUE_HOURS), sessions, hours, ...(s.lastDream ? { lastDream: s.lastDream } : {}) };
}

export function dream(options: DreamOptions = {}): DreamResult {
  const now = options.now ?? new Date();
  const s = options.signals ?? readSignals();
  const local = options.local ?? readLocal();
  const fb = options.feedback ?? readFeedback();
  const found: Omit<Proposal, "n">[] = [];

  // API names agents keep guessing: a hint for the next agent in this project.
  for (const [name, c] of Object.entries(s.apiMisses)) {
    if (c.n < MIN_REPEATS || !c.suggest) continue;
    found.push({
      key: keyOf("api-hint", name, c.suggest),
      kind: "api-hint",
      title: `\`${name}\` is not in the installed three; agents here meant \`${c.suggest}\``,
      reason: `looked up ${c.n} times and not found; the installed three suggested ${c.suggest}`,
      evidence: { lookups: c.n },
      apply: "adds a project hint (.threesmith/hints.json) that the session start and three_api show",
      detail: { not: name, use: c.suggest },
    });
  }

  // Messages that nothing explained, more than once: a lesson waiting to be written.
  for (const [template, c] of Object.entries(s.unexplained)) {
    if (c.n < MIN_REPEATS) continue;
    if (explain(template).length || lessonsForError(template, { local }).length) continue;
    found.push({
      key: keyOf("draft-lesson", template),
      kind: "draft-lesson",
      title: `No lesson yet for: ${template.slice(0, 120)}`,
      reason: `seen ${c.n} times (last ${c.last}); no explanation and no lesson matched it`,
      evidence: { seen: c.n },
      detail: { template },
    });
  }

  // Local lessons that misled more often than they helped.
  for (const l of local.lessons) {
    const st = local.stats[l.id];
    if (!st || st.wrong < MIN_REPEATS || st.wrong <= st.helped) continue;
    found.push({
      key: keyOf("retire-lesson", l.id),
      kind: "retire-lesson",
      title: `Retire lesson ${l.id}: "${l.title.slice(0, 80)}"`,
      reason: `marked wrong ${st.wrong} times, helped ${st.helped} times`,
      evidence: { wrong: st.wrong, helped: st.helped },
      apply: "removes the lesson from this machine",
      detail: { lessons: [l.id] },
    });
  }

  // Bundled lessons that misled here: only a note (they are fixed in the repository, not here).
  for (const { lesson, local: isLocal } of allLessons(local)) {
    if (isLocal) continue;
    const st = local.stats[lesson.id];
    if (!st || st.wrong < MIN_REPEATS || st.wrong <= st.helped) continue;
    found.push({
      key: keyOf("retire-lesson", lesson.id),
      kind: "retire-lesson",
      title: `Bundled lesson ${lesson.id} misled here: "${lesson.title.slice(0, 80)}"`,
      reason: `marked wrong ${st.wrong} times, helped ${st.helped} times; it ships with Threesmith, so report it upstream with the symptom`,
      evidence: { wrong: st.wrong, helped: st.helped },
      detail: { lessons: [lesson.id] },
    });
  }

  // Local lessons that say the same thing: same title words, or the same message template.
  const groups = new Map<string, string[]>();
  for (const l of local.lessons) {
    for (const k of [`t:${words(l.title)}`, ...(l.errors ?? []).map((e) => `e:${words(e)}`)]) {
      if (k.length < 8) continue;
      const g = groups.get(k) ?? [];
      if (!g.includes(l.id)) g.push(l.id);
      groups.set(k, g);
    }
  }
  const merged = new Set<string>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    const id = [...ids].sort().join(",");
    if (merged.has(id)) continue;
    merged.add(id);
    const byDate = ids.map((i) => local.lessons.find((l) => l.id === i)!).sort((a, b) => a.added.localeCompare(b.added) || a.id.localeCompare(b.id));
    const keep = byDate[byDate.length - 1]!;
    found.push({
      key: keyOf("merge-lessons", id),
      kind: "merge-lessons",
      title: `${ids.length} local lessons say the same: keep ${keep.id}`,
      reason: `same ${ids.length > 1 ? "title or message" : "title"}: ${ids.join(", ")}`,
      evidence: { lessons: ids.length },
      apply: `removes the older ones (${byDate.slice(0, -1).map((l) => l.id).join(", ")}) and keeps the newest`,
      detail: { lessons: byDate.map((l) => l.id) },
    });
  }

  // Rules marked wrong here more often than right.
  for (const [rule, c] of Object.entries(fb.rules)) {
    if (c.wrong < 3 || c.wrong <= c.right) continue;
    found.push({
      key: keyOf("noisy-rule", rule),
      kind: "noisy-rule",
      title: `Rule ${rule} is often a false alarm here`,
      reason: `marked wrong ${c.wrong} times, right ${c.right} times on this machine; read its cases in test/rules.cases.ts and report the quiet case upstream`,
      evidence: { wrong: c.wrong, right: c.right },
      apply: "adds a project hint: verify a finding of this rule before acting on it",
      detail: { rule },
    });
  }

  // Tools whose writes keep being undone.
  for (const [tool, c] of Object.entries(s.undone)) {
    if (c.n < MIN_REPEATS) continue;
    found.push({
      key: keyOf("undone-tool", tool),
      kind: "undone-tool",
      title: `Writes of ${tool} were undone ${c.n} times`,
      reason: `an agent wrote with ${tool} and then took it back ${c.n} times (last ${c.last}); run it as a dry run first and read every change before write: true`,
      evidence: { undone: c.n },
      apply: `adds a project hint: dry-run ${tool} and read the changes before writing`,
      detail: { tool },
    });
  }

  const visible = found.filter((p) => options.all || !s.handled[p.key]);
  visible.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || Object.values(b.evidence)[0]! - Object.values(a.evidence)[0]! || a.key.localeCompare(b.key));
  return {
    proposals: visible.map((p, i) => ({ ...p, n: i + 1 })),
    handled: found.length - visible.length,
    due: dueOf(s, now),
    sources: {
      apiMisses: Object.keys(s.apiMisses).length,
      unexplained: Object.keys(s.unexplained).length,
      undone: Object.keys(s.undone).length,
      feedbackRules: Object.keys(fb.rules).length,
      localLessons: local.lessons.length,
    },
  };
}

// ---------------------------------------------------------------- project hints

export interface ProjectHints {
  version: 1;
  /** API names agents guessed: use `use`, not `not`. */
  api: { not: string; use: string }[];
  /** Rules to verify before acting on. */
  verify: string[];
  /** Tools to dry-run first. */
  dryRun: string[];
}

export const hintsFile = (root: string): string => join(stateDir(root), "hints.json");

export function readHints(root: string): ProjectHints {
  try {
    const raw = JSON.parse(readFileSync(hintsFile(root), "utf8")) as Partial<ProjectHints>;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 50) : []);
    return {
      version: 1,
      api: Array.isArray(raw.api) ? raw.api.filter((h) => typeof h?.not === "string" && typeof h?.use === "string").slice(0, 50) : [],
      verify: strs(raw.verify),
      dryRun: strs(raw.dryRun),
    };
  } catch {
    return { version: 1, api: [], verify: [], dryRun: [] };
  }
}

/** The hints as lines for an agent (session start), or nothing. */
export function formatHints(h: ProjectHints, limit = 8): string[] {
  const out = [
    ...h.api.map((a) => `\`${a.not}\` does not exist in the installed three; use \`${a.use}\`.`),
    ...h.verify.map((r) => `Review rule ${r} is often a false alarm in this project: verify its findings before you change code for them.`),
    ...h.dryRun.map((t) => `Run ${t} as a dry run first and read every change: its writes were undone here before.`),
  ];
  return out.slice(0, limit);
}

/** A hint for an API name that was not found, when the project has one. */
export function apiHintFor(root: string, query: string): string | undefined {
  const q = query.trim().replace(/^THREE\./, "");
  const h = readHints(root).api.find((a) => a.not === q);
  return h ? `Project hint: agents here asked for \`${h.not}\` before; the installed three has \`${h.use}\`.` : undefined;
}

// ---------------------------------------------------------------- apply

export interface ApplyResult {
  applied: { n: number; key: string; what: string }[];
  setAside: { n: number; key: string }[];
  unknown: string[];
  /** Journal entry of the hints write (three_undo), or 0. */
  journal: number;
}

/**
 * Apply proposals by number (of this dream) or key. Hints are written through the journal; lesson removals change
 * the local lessons file. A suggestion (no `apply`) is set aside, so the next dream leaves it out.
 */
export function applyDream(root: string, picks: readonly (number | string)[], options: DreamOptions = {}): ApplyResult {
  const all = dream({ ...options, all: true });
  const listed = dream(options).proposals;
  const res: ApplyResult = { applied: [], setAside: [], unknown: [], journal: 0 };
  const chosen: Proposal[] = [];
  for (const p of picks) {
    const hit = typeof p === "number" || /^\d+$/.test(p) ? listed.find((x) => x.n === Number(p)) : all.proposals.find((x) => x.key === p);
    if (!hit) res.unknown.push(String(p));
    else if (!chosen.includes(hit)) chosen.push(hit);
  }
  const hints = readHints(root);
  let hintsChanged = false;
  const handled: Record<string, "applied" | "seen"> = {};
  for (const p of chosen) {
    if (!p.apply) {
      res.setAside.push({ n: p.n, key: p.key });
      handled[p.key] = "seen";
      continue;
    }
    if (p.kind === "api-hint" && p.detail.not && p.detail.use) {
      if (!hints.api.some((a) => a.not === p.detail.not)) hints.api.push({ not: p.detail.not, use: p.detail.use });
      hintsChanged = true;
    } else if (p.kind === "noisy-rule" && p.detail.rule) {
      if (!hints.verify.includes(p.detail.rule)) hints.verify.push(p.detail.rule);
      hintsChanged = true;
    } else if (p.kind === "undone-tool" && p.detail.tool) {
      if (!hints.dryRun.includes(p.detail.tool)) hints.dryRun.push(p.detail.tool);
      hintsChanged = true;
    } else if (p.kind === "retire-lesson") {
      for (const id of p.detail.lessons ?? []) removeLocalLesson(id);
    } else if (p.kind === "merge-lessons") {
      for (const id of (p.detail.lessons ?? []).slice(0, -1)) removeLocalLesson(id);
    }
    res.applied.push({ n: p.n, key: p.key, what: p.apply });
    handled[p.key] = "applied";
  }
  if (hintsChanged) {
    const n = res.applied.filter((a) => /hint/.test(a.what)).length;
    res.journal = writeFiles(root, "three_dream", `dream: ${n} project hint(s)`, [{ file: ".threesmith/hints.json", data: `${JSON.stringify(hints, null, 2)}\n` }]);
  }
  markDreamed(handled, options.now);
  return res;
}

/** Remember that a dream ran (and what was handled), so the session start stops saying one is due. */
export function markDreamed(handled: Record<string, "applied" | "seen"> = {}, now = new Date()): void {
  const day = now.toISOString().slice(0, 10);
  updateSignals((s) => {
    s.lastDream = day;
    s.sessionsAtDream = s.sessions.n;
    for (const [k, how] of Object.entries(handled)) s.handled[k] = { how, at: day };
  });
}

// ---------------------------------------------------------------- output

export function formatDream(r: DreamResult, detail: "brief" | "full" = "brief"): string {
  if (!r.proposals.length) {
    const seen = r.sources.apiMisses + r.sources.unexplained + r.sources.undone + r.sources.feedbackRules + r.sources.localLessons;
    return `Nothing to propose${r.handled ? ` (${r.handled} handled before; all: true shows them)` : ""}. ${seen ? "Too little repeats yet: a proposal needs the same thing at least twice." : "Nothing recorded on this machine yet: Threesmith counts API names that were not there, messages nothing explained, undone writes and feedback while agents work."}`;
  }
  const out = [`Dream: ${r.proposals.length} proposal(s)${r.handled ? `, ${r.handled} handled before` : ""}. Nothing changes until you apply one.`];
  const cap = detail === "full" ? r.proposals.length : 12;
  for (const p of r.proposals.slice(0, cap)) {
    out.push(`${p.n}. [${KIND_LABEL[p.kind]}] ${p.title}`);
    out.push(`   why: ${p.reason}`);
    out.push(`   ${p.apply ? `apply: ${p.apply}` : p.kind === "draft-lesson" ? "finish it: find the cause (three_api, three_check), then three_lesson_add with this message as error; apply sets it aside" : "suggestion: apply sets it aside"}`);
    if (detail === "full") out.push(`   key: ${p.key}`);
  }
  if (r.proposals.length > cap) out.push(`+${r.proposals.length - cap} more (detail full)`);
  out.push("Next: show the list to the user, then three_dream with apply: [numbers] for the ones they approve.");
  return out.join("\n");
}

export function formatApply(r: ApplyResult): string {
  const out: string[] = [];
  for (const a of r.applied) out.push(`applied ${a.n}: ${a.what}`);
  for (const s of r.setAside) out.push(`set aside ${s.n}`);
  for (const u of r.unknown) out.push(`no proposal ${u} (run three_dream again: the numbers belong to the last list)`);
  if (r.journal) out.push(`hints written as journal entry #${r.journal}; three_undo takes them back. Lesson removals are not in the journal.`);
  return out.length ? out.join("\n") : "Nothing applied.";
}
