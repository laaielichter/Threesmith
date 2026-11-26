import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { findThree, releaseOf } from "../api/install.js";
import { threesmithHome } from "../learn/feedback.js";

/**
 * Other three.js releases for `three_compare`: which version a spec means ("r186", "0.186.1", "next", "previous",
 * "latest", or a folder holding a three package), and the package itself. A release from npm is fetched once with
 * `npm pack` (so the user's registry, proxy and npm cache apply) into `$THREESMITH_HOME/three/<version>/` (or
 * `$THREESMITH_THREE_CACHE/<version>/`), keeping only package.json, build/ and examples/jsm/. Nothing in the project's
 * node_modules changes: the page gets the other release through a request swap (see `swapPath`).
 */

export interface Release {
  /** "0.186.0". */
  version: string;
  /** 186. */
  release: number;
  /** The package folder: package.json, build/, examples/jsm/. */
  dir: string;
  source: "installed" | "path" | "cache" | "npm";
}

const run = promisify(execFile);
const isWin = process.platform === "win32";

/** Where fetched releases live. */
export function releasesHome(env: NodeJS.ProcessEnv = process.env): string {
  return env["THREESMITH_THREE_CACHE"] ? resolve(env["THREESMITH_THREE_CACHE"]) : join(threesmithHome(), "three");
}

/** A stable three version ("0.186.1"; no "-dev" builds). */
const STABLE = /^0\.(\d+)\.(\d+)$/;

/** Stable versions, oldest first. */
export function sortVersions(versions: string[]): string[] {
  const key = (v: string) => {
    const m = STABLE.exec(v)!;
    return Number(m[1]) * 10000 + Number(m[2]);
  };
  return [...new Set(versions.filter((v) => STABLE.test(v)))].sort((a, b) => key(a) - key(b));
}

/** The newest patch of each release, oldest first: one version per release number. */
export function onePerRelease(versions: string[]): string[] {
  const best = new Map<number, string>();
  for (const v of sortVersions(versions)) best.set(releaseOf(v), v);
  return [...best.values()];
}

/**
 * The version a spec means, from the published versions. Pure. `installed` is the project's version (for next and
 * previous). Throws a clear message for a release that does not exist.
 */
export function resolveVersion(spec: string, versions: string[], installed?: string): string {
  const all = onePerRelease(versions);
  const exact = sortVersions(versions);
  const s = spec.trim().toLowerCase();
  if (!all.length) throw new Error("no three versions known (npm view three versions gave nothing)");
  if (s === "latest") return all.at(-1)!;
  if (s === "next" || s === "previous") {
    if (!installed) throw new Error(`"${spec}" needs the installed three (none found next to the page)`);
    const r = releaseOf(installed);
    const v = s === "next" ? all.find((x) => releaseOf(x) > r) : [...all].reverse().find((x) => releaseOf(x) < r);
    if (!v) throw new Error(s === "next" ? `no three release after r${r} is published yet (newest: ${all.at(-1)})` : `no three release before r${r}`);
    return v;
  }
  if (STABLE.test(s)) {
    if (!exact.includes(s)) throw new Error(`three ${s} is not published (newest: ${all.at(-1)})`);
    return s;
  }
  const m = /^r?(\d{2,3})$/.exec(s) ?? /^0\.(\d{2,3})$/.exec(s);
  if (!m) throw new Error(`"${spec}" is not a three release: use r186, 0.186.1, next, previous, latest or a folder with a three package`);
  const v = all.find((x) => releaseOf(x) === Number(m[1]));
  if (!v) throw new Error(`three r${m[1]} is not published (newest: ${all.at(-1)})`);
  return v;
}

/** The versions between two specs, both ends included, one per release, oldest first. Pure. */
export function versionsBetween(from: string, to: string, versions: string[], installed?: string): string[] {
  const a = releaseOf(resolveVersion(from, versions, installed));
  const b = releaseOf(resolveVersion(to, versions, installed));
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return onePerRelease(versions).filter((v) => releaseOf(v) >= lo && releaseOf(v) <= hi);
}

async function npm(args: string[], cwd?: string): Promise<string> {
  // npm is a .cmd on Windows, which execFile only runs through a shell; the arguments are ours (versions are checked)
  const { stdout } = await run(isWin ? "npm.cmd" : "npm", args, { ...(cwd ? { cwd } : {}), shell: isWin, maxBuffer: 16 * 1024 * 1024, timeout: 120_000, windowsHide: true });
  return stdout;
}

/**
 * The published versions of three: asked from npm, and kept in the cache folder so a later run works offline.
 * Falls back to the cached list (and then to the versions already fetched) when npm cannot be reached.
 */
export async function publishedVersions(home: string = releasesHome()): Promise<{ versions: string[]; offline: boolean }> {
  const file = join(home, "versions.json");
  try {
    const list = JSON.parse(await npm(["view", "three", "versions", "--json"])) as string[] | string;
    const versions = sortVersions(Array.isArray(list) ? list : [list]);
    if (versions.length) {
      mkdirSync(home, { recursive: true });
      writeFileSync(file, JSON.stringify(versions));
      return { versions, offline: false };
    }
  } catch {
    /* offline: use what is cached */
  }
  let versions: string[] = [];
  try {
    versions = sortVersions(JSON.parse(readFileSync(file, "utf8")) as string[]);
  } catch {
    versions = existsSync(home) ? sortVersions(readdirSync(home).filter((d) => existsSync(join(home, d, "package.json")))) : [];
  }
  if (!versions.length) throw new Error("cannot list three releases: npm cannot reach the registry and nothing is cached yet. Run once with network, or pass a folder with a three package.");
  return { versions, offline: true };
}

/** A folder holding a three package: the package itself, or a project/node_modules with three in it. */
export function localRelease(path: string): Release | undefined {
  const dir = resolve(path);
  for (const root of [dir, join(dir, "three"), join(dir, "node_modules", "three")]) {
    const found = findThree(root, root);
    if (found) return { version: found.version, release: found.release, dir: found.root, source: "path" };
  }
  return undefined;
}

/** A release from the cache, or fetched from npm into it. */
export async function fetchRelease(version: string, home: string = releasesHome()): Promise<Release> {
  if (!STABLE.test(version)) throw new Error(`not a three version: ${version}`);
  const dir = join(home, version);
  if (existsSync(join(dir, "package.json"))) return { version, release: releaseOf(version), dir, source: "cache" };
  mkdirSync(home, { recursive: true });
  const work = mkdtempSync(join(home, `.fetch-${version}-`));
  try {
    try {
      await npm(["pack", `three@${version}`, "--silent"], work);
    } catch (e) {
      throw new Error(`cannot fetch three ${version} from npm (offline, or the registry is blocked): ${(e as Error).message.split("\n")[0]}`);
    }
    const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error(`npm pack three@${version} gave no tarball`);
    const out = join(work, "out");
    mkdirSync(out);
    // only what a page loads: the builds and the addons (examples/js is gone since r148; older packages still work)
    const members = ["package/package.json", "package/build", "package/examples/jsm"];
    try {
      await run("tar", ["-xzf", join(work, tgz), "-C", out, ...members], { timeout: 120_000, windowsHide: true });
    } catch {
      await run("tar", ["-xzf", join(work, tgz), "-C", out], { timeout: 120_000, windowsHide: true });
    }
    const pkg = join(out, "package");
    const json = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { name?: string; version?: string };
    if (json.name !== "three" || json.version !== version) throw new Error(`the tarball for three@${version} holds ${json.name}@${json.version}`);
    try {
      renameSync(pkg, dir);
    } catch (e) {
      // another run fetched it at the same time
      if (!existsSync(join(dir, "package.json"))) throw e;
    }
    return { version, release: releaseOf(version), dir, source: "npm" };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * The release a spec means, ready to serve. `project` is the page's folder (for "installed", next and previous).
 * A spec with a path separator, or one that names an existing folder, is a local package.
 */
export async function obtainRelease(spec: string, project: string, home: string = releasesHome()): Promise<Release> {
  const installed = findThree(project);
  const s = spec.trim();
  if (s === "installed") {
    if (!installed) throw new Error("three is not installed next to the page, so there is no installed release to compare");
    return { version: installed.version, release: installed.release, dir: installed.root, source: "installed" };
  }
  if (/[\\/]/.test(s) || (existsSync(resolve(project, s)) && !/^(?:r?\d+|0\.\d+(?:\.\d+)?|next|previous|latest)$/i.test(s))) {
    const local = localRelease(resolve(project, s));
    if (!local) throw new Error(`no three package in ${s} (looked for package.json with "name": "three", also in three/ and node_modules/three/)`);
    return local;
  }
  // an exact version that is already cached needs no network
  if (STABLE.test(s) && existsSync(join(home, s, "package.json"))) return { version: s, release: releaseOf(s), dir: join(home, s), source: "cache" };
  const { versions } = await publishedVersions(home);
  const version = resolveVersion(s, versions, installed?.version);
  if (installed && version === installed.version) return { version, release: installed.release, dir: installed.root, source: "installed" };
  return fetchRelease(version, home);
}

/**
 * The path inside the three package a request stands for, or undefined when the request is not a three file:
 * `.../node_modules/three/<path>`, a CDN URL `.../three@<version>/<path>` (unpkg, jsDelivr), or a copied build file
 * (`three.module.js`, `three.core.js`, `three.webgpu.js`, `three.tsl.js`, with `.min`) anywhere, which maps to build/.
 */
export function swapPath(url: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return undefined;
  }
  const clean = (p: string) => (p.split("/").some((x) => x === ".." || x === "") ? undefined : p);
  let m = /\/node_modules\/three\/(.+)$/.exec(path);
  if (m) return clean(m[1]!);
  m = /\/three@[^/]+\/(.+)$/.exec(path);
  if (m) return clean(m[1]!);
  m = /\/(three\.(?:module|core|webgpu|tsl|webgpu\.nodes)(?:\.min)?\.js)$/.exec(path);
  if (m) return `build/${m[1]}`;
  return undefined;
}
