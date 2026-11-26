import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { play } from "../check/play.js";
import { annotator, capture, compareCaptures, type Capture, type Change, type CompareOptions } from "./compare.js";
import { obtainRelease, publishedVersions, versionsBetween, type Release } from "./releases.js";
import { findThree } from "../api/install.js";

/**
 * `three_compare --bisect`: the first three release between two where the page changes (any change against the
 * first release: console, scene, renderer.info, pixels), breaks (a new error or a lost object), or fails claims
 * (`expect`, judged as three_play judges them). It halves over the releases, one per release number, so r160..r188
 * takes about five runs. It assumes the change stays once it is there; the releases it ran are listed.
 */

export interface BisectOptions extends Omit<CompareOptions, "with"> {
  /** "r182..r185", or a comma-separated list of releases or folders with a three package. */
  range: string;
  /** What counts as bad: any change against the first release (default), a break, or failed claims (with expect). */
  until?: "change" | "break";
  /** Claims as in three_play ("window.second === 'hello' @ end"): a release is bad when one fails. */
  expect?: string[];
}

export interface Probe {
  version: string;
  release: number;
  bad: boolean;
  /** One line: why it is bad, or what it looked like. */
  why: string;
}

export interface BisectResult {
  ok: boolean;
  url: string;
  mode: "change" | "break" | "claims";
  /** The releases in the range, oldest first. */
  releases: string[];
  probes: Probe[];
  /** The last release that is still good and the first that is bad, when found. */
  lastGood?: string;
  firstBad?: string;
  /** What changed between them, annotated with that release's migration entries. */
  changes: Change[];
  message: string;
}

/** The releases of a range spec, oldest first. */
export async function rangeReleases(range: string, folder: string): Promise<Release[]> {
  const items = range.includes("..") ? undefined : range.split(",").map((s) => s.trim()).filter(Boolean);
  let specs: string[];
  if (items) specs = items;
  else {
    const [from, to] = range.split("..").map((s) => s.trim());
    if (!from || !to) throw new Error(`bisect needs a range such as r182..r185, got "${range}"`);
    specs = versionsBetween(from, to, (await publishedVersions()).versions, findThree(folder)?.version);
  }
  const out: Release[] = [];
  for (const s of specs) out.push(await obtainRelease(s, folder));
  out.sort((a, b) => a.release - b.release || a.version.localeCompare(b.version, undefined, { numeric: true }));
  if (out.length < 2) throw new Error(`bisect needs at least two releases, got ${out.map((r) => r.version).join(", ") || "none"}`);
  return out;
}

export async function bisect(opts: BisectOptions): Promise<BisectResult> {
  const folder = /^https?:\/\//.test(opts.target) ? process.cwd() : opts.target;
  const releases = await rangeReleases(opts.range, folder);
  const mode: BisectResult["mode"] = opts.expect?.length ? "claims" : (opts.until ?? "change");
  const dir = join(opts.stateDir ?? join(folder, ".threesmith"), "compare");
  mkdirSync(dir, { recursive: true });
  const caps = new Map<number, Capture>();
  const probes: Probe[] = [];
  let url = "";
  let reference: { cap: Capture; image?: Parameters<typeof compareCaptures>[3]["base"] } | undefined;

  const snap = async (i: number) => {
    const r = releases[i]!;
    const got = await capture(opts, r, join(dir, `bisect-r${r.release}-${r.version}.png`));
    url = got.url;
    caps.set(i, got.capture);
    return got;
  };
  const judge = async (i: number): Promise<boolean> => {
    const r = releases[i]!;
    let probe: Probe;
    if (mode === "claims") {
      const seeded = opts.seed === undefined && opts.fixedDt === undefined ? { seed: 1 } : {};
      const p = await play({ ...opts, ...seeded, swapThree: r.dir, expect: opts.expect!, ...(opts.steps ? { steps: opts.steps } : {}), screenshot: false });
      url = p.url;
      const failed = p.claims.filter((c) => !c.ok);
      const errors = p.issues.filter((x) => x.severity === "error");
      probe = { version: r.version, release: r.release, bad: !p.ok, why: failed.length ? failed.map((c) => c.message).join("; ") : errors.length ? errors.map((e) => `${e.kind}: ${e.message}`).join("; ").slice(0, 300) : "claims hold" };
      await snap(i); // for the diff between the last good and the first bad release
    } else {
      const got = await snap(i);
      if (!reference) {
        reference = { cap: got.capture, ...(got.image ? { image: got.image } : {}) };
        probe = { version: r.version, release: r.release, bad: false, why: "reference" };
      } else {
        const d = compareCaptures(reference.cap, got.capture, annotator(folder, reference.cap.release, r.release), { ...(reference.image ? { base: reference.image } : {}), ...(got.image ? { target: got.image } : {}) }, opts);
        const counted = d.changes.filter((c) => (mode === "break" ? c.kind === "error-new" || c.kind === "object-lost" : !c.kind.endsWith("-gone")));
        probe = { version: r.version, release: r.release, bad: counted.length > 0, why: counted.length ? counted.map((c) => c.message).join("; ").slice(0, 300) : "same as the first release" };
      }
    }
    probes.push(probe);
    return probe.bad;
  };

  const done = (o: Partial<BisectResult> & { message: string; ok: boolean }): BisectResult => ({ url, mode, releases: releases.map((r) => r.version), probes, changes: [], ...o });
  const first = await judge(0);
  if (first) return done({ ok: false, message: `already ${mode === "claims" ? "fails" : "bad"} on the first release, ${releases[0]!.version}: ${probes[0]!.why}. Start the range earlier.` });
  if (!(await judge(releases.length - 1))) return done({ ok: true, message: `no ${mode === "claims" ? "failing claim" : mode === "break" ? "break" : "change"} from ${releases[0]!.version} to ${releases.at(-1)!.version}.` });
  let lo = 0;
  let hi = releases.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (await judge(mid)) hi = mid;
    else lo = mid;
  }
  const good = releases[lo]!;
  const bad = releases[hi]!;
  const a = caps.get(lo);
  const b = caps.get(hi);
  let changes: Change[] = [];
  if (a && b) {
    // the difference made by that one release, explained by its own migration entries
    const ann = annotator(folder, good.release, bad.release);
    changes = compareCaptures(a, b, ann, {}, opts).changes;
  }
  const why = probes.find((p) => p.version === bad.version)?.why ?? "";
  return done({ ok: true, lastGood: good.version, firstBad: bad.version, changes, message: `first ${mode === "claims" ? "failing" : mode === "break" ? "breaking" : "changed"} release: r${bad.release} (${bad.version}); r${good.release} (${good.version}) is the last good one. ${why}` });
}

export function formatBisect(r: BisectResult): string {
  const out = [`Threesmith bisect (${r.mode}): ${r.message}`, `releases ${r.releases[0]} … ${r.releases.at(-1)} (${r.releases.length}); ran ${r.probes.length}: ${r.probes.map((p) => `r${p.release} ${p.bad ? "bad" : "good"}`).join(", ")}`];
  for (const c of r.changes) {
    out.push(`${c.unexplained ? "✖" : "▲"} [${c.kind}] ${c.message}`);
    for (const e of c.explainedBy.slice(0, 2)) out.push(`    expected: r${e.release} ${e.title}${e.inCode ? " (in this code)" : ""} – ${e.todo} ${e.source}`);
    if (c.unexplained) out.push("    no migration entry explains this: probable regression (or a change the data does not cover yet)");
  }
  if (r.firstBad) out.push(`next: threesmith compare <target> --base ${r.lastGood} --with ${r.firstBad} for the full diff with pixels; the release notes of r${r.firstBad.split(".")[1]} name the pull requests.`);
  out.push("note: bisect assumes a change stays once it is there; the releases it ran are listed above.");
  return out.join("\n");
}
