import { compare, type CompareResult } from "./compare/compare.js";
import { formatImpact, impact, type ImpactResult } from "./impact/impact.js";
import { check, formatBackend, type CheckOptions, type CheckResult } from "./check/check.js";
import { formatMarkdown } from "./review/format.js";
import { review, type ReviewResult } from "./review/review.js";
import type { Severity } from "./review/types.js";
import { loadScenarios, runScenarios, type ScenarioResult } from "./check/scenario.js";
import { projectRootOf } from "./scan/scan.js";

export interface CiOptions {
  path: string;
  three?: string;
  minScore?: number;
  /** Fail when a finding of this severity or worse exists. Default: error. */
  failOn?: Severity | "none";
  /** Optional browser check. */
  check?: Omit<CheckOptions, "target"> & { target: string };
  disable?: string[];
  /** Run the scenarios in .threesmith/scenarios (default true when there are any). */
  scenarios?: boolean;
  /**
   * Also run the check page on another three release (three_compare): `previous`, `r186`, a folder. On a pull request
   * that bumps three, the receipt then says what changed in the page and which migration note explains it; a page
   * that breaks on one of the two fails the receipt.
   */
  compare?: string;
  /** Also say what the change touches against this git ref (three_impact), e.g. origin/main. */
  impact?: string;
}

export interface CiResult {
  ok: boolean;
  reasons: string[];
  review: ReviewResult;
  check?: CheckResult;
  scenarios?: ScenarioResult[];
  compare?: CompareResult;
  impact?: ImpactResult;
  markdown: string;
}

const RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export async function ci(opts: CiOptions): Promise<CiResult> {
  const r = review({ path: opts.path, ...(opts.three ? { three: opts.three } : {}), ...(opts.disable ? { disable: opts.disable } : {}) });
  const reasons: string[] = [];
  const failOn = opts.failOn ?? "error";
  if (failOn !== "none" && r.findings.some((f) => RANK[f.severity] <= RANK[failOn])) {
    reasons.push(`review has ${failOn === "error" ? "errors" : `findings at ${failOn} or worse`}`);
  }
  if (opts.minScore !== undefined && r.score !== null && r.score < opts.minScore) {
    reasons.push(`score ${r.score} is below the minimum ${opts.minScore}`);
  }
  let c: CheckResult | undefined;
  if (opts.check) {
    try {
      c = await check(opts.check);
      if (!c.ok) reasons.push("browser check failed");
    } catch (e) {
      reasons.push(`browser check could not run: ${(e as Error).message}`);
    }
  }
  let scenarios: ScenarioResult[] | undefined;
  if (opts.scenarios !== false) {
    try {
      const project = projectRootOf(opts.path);
      if (loadScenarios(project).length) {
        scenarios = await runScenarios(project);
        const failed = scenarios.filter((s) => !s.ok).length;
        if (failed) reasons.push(`${failed} of ${scenarios.length} scenario(s) failed`);
      }
    } catch (e) {
      reasons.push(`scenarios could not run: ${(e as Error).message}`);
    }
  }
  let cmp: CompareResult | undefined;
  if (opts.compare) {
    if (!opts.check) reasons.push("compare needs check (the page to run on both releases)");
    else {
      try {
        cmp = await compare({ ...opts.check, with: opts.compare, ...(opts.three ? { base: opts.three } : {}) });
        if (cmp.verdict === "broken") reasons.push(`the page breaks on r${cmp.target.release ?? "?"} compared with r${cmp.base.release ?? "?"} (three_compare)`);
      } catch (e) {
        reasons.push(`compare could not run: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  let imp: ImpactResult | undefined;
  let impError: string | undefined;
  if (opts.impact) {
    try {
      imp = impact(projectRootOf(opts.path), { base: opts.impact });
    } catch (e) {
      impError = (e as Error).message;
    }
  }
  const ok = reasons.length === 0;
  const lines = [`## Threesmith receipt: ${ok ? "✅ pass" : "❌ fail"}`, ""];
  if (reasons.length) lines.push(...reasons.map((x) => `- ${x}`), "");
  lines.push(formatMarkdown(r));
  if (opts.check) {
    lines.push("", "### Headless check");
    if (!c) lines.push("The browser check could not run.");
    else {
      lines.push(
        `${c.ok ? "Passed" : "Failed"}: ${c.stats.canvases} canvas, contexts ${c.stats.contexts.join(", ") || "none"} (backend ${formatBackend(c.stats.backend)}), ${c.stats.frames} frames, three ${c.stats.threeRevision ? "r" + c.stats.threeRevision : "?"}.`,
      );
      for (const i of c.issues) lines.push(`- ${i.severity === "error" ? "✖" : "▲"} \`${i.kind}\` ${i.message}`);
      if (c.baseline) lines.push(`- baseline \`${c.baseline.name}\`: ${c.baseline.status}${c.baseline.ratio !== undefined ? ` (${(c.baseline.ratio * 100).toFixed(2)}% changed)` : ""}`);
    }
  }
  if (scenarios?.length) {
    lines.push("", `### Scenarios: ${scenarios.filter((s) => s.ok).length} of ${scenarios.length} passed`);
    for (const s of scenarios) {
      lines.push(`- ${s.ok ? "✔" : "✖"} \`${s.name}\` (${s.seconds.toFixed(1)} s)`);
      for (const cl of s.claims.filter((x) => !x.ok)) lines.push(`  - ${cl.text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")}: ${cl.message}`);
    }
  }
  if (opts.compare) {
    lines.push("", `### Three release compare (${opts.compare})`);
    if (!cmp) lines.push("The comparison could not run.");
    else {
      const VERDICT = { same: "nothing changed", explained: "every change is explained by a migration note", changed: "something changed that no migration note explains: a probable regression", broken: "the page breaks" } as const;
      lines.push(`r${cmp.base.release} → r${cmp.target.release}: **${VERDICT[cmp.verdict]}**.`);
      for (const ch of cmp.changes.slice(0, 15)) lines.push(`- ${ch.unexplained ? "▲" : "✔"} ${ch.message.replace(/\|/g, "\\|")}${ch.explainedBy.length ? ` — r${ch.explainedBy[0]!.release}: ${ch.explainedBy[0]!.title}` : ""}`);
      if (cmp.changes.length > 15) lines.push(`- … ${cmp.changes.length - 15} more`);
      for (const p of cmp.problems) lines.push(`- ✖ ${p}`);
    }
  }
  if (opts.impact) {
    lines.push("", `### What the change touches (against \`${opts.impact}\`)`);
    if (!imp) lines.push(`Not worked out: ${impError}`);
    else lines.push("```text", formatImpact(imp), "```");
  }
  lines.push("", "<sub>Made by [Threesmith](https://github.com/laaielichter/Threesmith)</sub>");
  return { ok, reasons, review: r, ...(c ? { check: c } : {}), ...(scenarios ? { scenarios } : {}), ...(cmp ? { compare: cmp } : {}), ...(imp ? { impact: imp } : {}), markdown: lines.join("\n") };
}
