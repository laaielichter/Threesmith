import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { releaseOf } from "../api/install.js";
import type { SourceFile } from "../review/source.js";

/** A release number from "r150", "150", "0.150.0" or "^0.150.1"; undefined when it is none of those. */
export function releaseNumber(text: string): number | undefined {
  const t = text.trim();
  let m = /^r?(\d{2,3})$/i.exec(t);
  if (m) return Number(m[1]);
  m = /^[~^<>=v\s]*0\.(\d{2,3})(?:\.\d+)?/.exec(t);
  return m ? Number(m[1]) : undefined;
}

export interface FromEvidence {
  release: number;
  /** Where it was read: "CDN URL in index.html", "@types/three 0.150.1", ... */
  from: string;
}

const CDN = /(?:unpkg\.com|cdn\.jsdelivr\.net\/npm|cdn\.skypack\.dev|esm\.sh|ga\.jspm\.io\/npm:)\/?three@([\d.]+)|cdnjs\.cloudflare\.com\/ajax\/libs\/three\.js\/r?([\d.]+)/g;

/** Releases pinned in CDN URLs in the code. */
export function cdnReleases(files: SourceFile[]): FromEvidence[] {
  const out: FromEvidence[] = [];
  for (const f of files) {
    for (const m of f.text.matchAll(CDN)) {
      const v = m[1] ?? m[2] ?? "";
      const release = m[1] ? releaseOf(v) : releaseNumber(v);
      if (release) out.push({ release, from: `CDN URL in ${f.path} (three@${v})` });
    }
  }
  return out;
}

type Pkg = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** @types/three and three in package.json, and three in package-lock.json. */
export function packageReleases(root: string, pkg: Pkg | undefined): FromEvidence[] {
  const out: FromEvidence[] = [];
  const deps = { ...pkg?.devDependencies, ...pkg?.dependencies };
  for (const name of ["@types/three", "three"]) {
    const v = deps[name];
    const r = v ? releaseNumber(v) : undefined;
    if (r) out.push({ release: r, from: `${name} ${v} in package.json` });
  }
  const lock = join(root, "package-lock.json");
  if (existsSync(lock)) {
    try {
      const v = (JSON.parse(readFileSync(lock, "utf8")) as { packages?: Record<string, { version?: string }> }).packages?.["node_modules/three"]?.version;
      const r = v ? releaseOf(v) : 0;
      if (r) out.push({ release: r, from: `three ${v} in package-lock.json` });
    } catch {
      /* a broken lockfile tells nothing */
    }
  }
  return out;
}

/** Earlier three versions in the git history of package.json (newest first), when the project is a git repository. */
export function gitReleases(root: string): FromEvidence[] {
  let log: string;
  try {
    log = execFileSync("git", ["log", "-n", "200", "-p", "--format=commit %h", "--", "package.json"], { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return [];
  }
  const out: FromEvidence[] = [];
  let commit = "";
  for (const line of log.split("\n")) {
    const c = /^commit (\w+)/.exec(line);
    if (c) commit = c[1]!;
    const m = /^-\s*"three"\s*:\s*"([^"]+)"/.exec(line);
    const r = m ? releaseNumber(m[1]!) : undefined;
    if (r) out.push({ release: r, from: `three ${m![1]} in package.json before commit ${commit}` });
  }
  return out;
}

/**
 * The release the code was written for: the oldest one the code itself pins (CDN URLs) or package.json, the lockfile
 * and @types/three name, below the target; else the newest earlier version in the git history of package.json.
 */
export function detectFrom(root: string, files: SourceFile[], pkg: Pkg | undefined, target: number): { release: number; evidence: FromEvidence[] } | undefined {
  const direct = [...cdnReleases(files), ...packageReleases(root, pkg)].filter((e) => e.release < target);
  if (direct.length) {
    const release = Math.min(...direct.map((e) => e.release));
    const evidence = direct.filter((e) => e.release === release).filter((e, i, list) => list.findIndex((x) => x.from === e.from) === i);
    return { release, evidence };
  }
  const git = gitReleases(root).find((e) => e.release < target);
  return git ? { release: git.release, evidence: [git] } : undefined;
}
