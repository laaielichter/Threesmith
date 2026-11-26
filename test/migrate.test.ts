import { execFileSync } from "node:child_process";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasSymbol } from "../src/api/lookup.js";
import { indexFor } from "../src/core.js";
import { RULES } from "../src/review/rules.js";
import { MIGRATION_KINDS, migrations, parseRelease } from "../src/migrate/data.js";
import { cdnReleases, detectFrom, gitReleases, releaseNumber } from "../src/migrate/from.js";
import { crosses, migratePlan, releaseOption, type MigratePlan } from "../src/migrate/migrate.js";
import { formatMigrate } from "../src/migrate/format.js";
import { makeSourceFile } from "../src/review/source.js";
import { project, THREE_DIR } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "migrate");
const fixture = (name: string) => {
  const dir = project({});
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
};
/** The plan as "r152 output-color-space x1 fix" lines: what the snapshots compare. */
const lines = (p: MigratePlan) => p.releases.flatMap((r) => r.entries.map((e) => `r${r.release} ${e.id} x${e.where.length}${e.fix ? " fix" : ""}`));

describe("migration data", () => {
  const all = migrations();
  it("covers r120 to r188, oldest first, with unique ids and a source per change", () => {
    expect(all[0]!.release).toBe(120);
    expect(all.at(-1)!.release).toBe(188);
    const ids = all.flatMap((r) => r.entries.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(150);
    for (const r of all) {
      expect(r.guide).toMatch(/^https:\/\/github\.com\/mrdoob\/three\.js\/wiki\/Migration-Guide#r?\d+--r?\d+$/);
      for (const e of r.entries) {
        expect(MIGRATION_KINDS).toContain(e.kind);
        expect(e.source).toMatch(/^https:\/\/github\.com\/mrdoob\/three\.js\/(?:pull|issues)\/\d+$|^https:\/\/github\.com\/mrdoob\/three\.js\/wiki\/Migration-Guide#/);
        if (e.removedIn !== undefined) expect(e.removedIn).toBeGreaterThan(r.release);
      }
    }
  });
  it("names only review rules that exist", () => {
    const known = new Set(RULES.map((r) => r.id));
    for (const r of all) for (const e of r.entries) for (const id of e.detect.rules ?? []) expect(known, `${e.id} names ${id}`).toContain(id);
  });
  it("names replacements that exist in the installed three (r187) for changes up to it", () => {
    const index = indexFor(THREE_DIR, THREE_DIR);
    for (const r of all) for (const e of r.entries) if (e.replacement && r.release <= 187) expect(hasSymbol(index, e.replacement), `${e.id}: ${e.replacement}`).toBe(true);
  });
  it("rejects broken entries with the file and the entry named", () => {
    const base = { release: 150, guide: "https://x", entries: [{ id: "x", kind: "rename", title: "t", todo: "d", source: "https://x", detect: { pattern: "a" } }] };
    expect(parseRelease(base, "r150.json").entries).toHaveLength(1);
    expect(() => parseRelease({ ...base, entries: [{ ...base.entries[0], kind: "nope" }] }, "r150.json")).toThrow(/r150\.json x: kind/);
    expect(() => parseRelease({ ...base, entries: [{ ...base.entries[0], detect: {} }] }, "r150.json")).toThrow(/detect needs/);
    expect(() => parseRelease({ ...base, entries: [{ ...base.entries[0], detect: { pattern: "(" } }] }, "r150.json")).toThrow(/not a valid regular expression/);
    expect(() => parseRelease({ ...base, entries: [{ ...base.entries[0], source: "x" }] }, "r150.json")).toThrow(/https source/);
  });
});

describe("migrate plan", () => {
  it("r125-geometry: Geometry, the aliases, colour and light changes from @types/three", () => {
    const p = migratePlan({ path: fixture("r125-geometry"), three: THREE_DIR });
    expect([p.from, p.to, p.installed]).toEqual([124, 187, 187]);
    expect(p.fromEvidence[0]!.from).toContain("@types/three ^0.124.0");
    expect(lines(p)).toEqual([
      "r125 geometry-out-of-core x4",
      "r129 skinning-flag-removed x1",
      "r132 buffer-geometry-utils-import x1 fix",
      "r132 rough-less-shiny x1",
      "r145 buffer-geometry-aliases x2 fix",
      "r147 light-decay-2 x1",
      "r151 merge-geometries x1 fix",
      "r152 output-color-space x1 fix",
      "r152 color-management-on x1",
      "r155 legacy-lights-off x2",
      "r181 pbr-indirect-specular x1",
      "r181 rough-pbr-brighter x1",
    ]);
    expect(p.fixable).toBe(5);
    expect(p.todo.map((t) => `${t.file}:${t.line} ${t.id}`)).toContain("main.js:14 geometry-out-of-core");
    expect(p.appearance.map((a) => a.id)).toContain("legacy-lights-off");
  });

  it("r150-colour: from the CDN URL; renames write: true makes, Clock to do, the look after r152 and r181", () => {
    const p = migratePlan({ path: fixture("r150-colour"), three: THREE_DIR });
    expect(p.from).toBe(150);
    expect(p.fromEvidence).toEqual([{ release: 150, from: "CDN URL in index.html (three@0.150.1)" }]);
    expect(lines(p)).toEqual([
      "r150 physically-correct-lights x1 fix",
      "r152 output-color-space x1 fix",
      "r152 texture-color-space x1 fix",
      "r152 color-management-on x2",
      "r180 rgbe-loader-renamed x1 fix",
      "r181 pbr-indirect-specular x2",
      "r181 rough-pbr-brighter x2",
      "r181 pmrem-reflections x1",
      "r183 clock-deprecated x1",
    ]);
    const clock = p.todo.find((t) => t.id === "clock-deprecated")!;
    expect(clock).toMatchObject({ file: "scene.js", line: 33, replacement: "Timer", replacementExists: true });
    const text = formatMigrate(p);
    expect(text).toMatch(/^Threesmith migrate: r150 -> r187 \(installed r187\) \(from: CDN URL in index\.html/);
    expect(text).toContain("scene.js:33 r183 [clock-deprecated] Use Timer");
    expect(text).toContain("Will look different:");
    // to r188: the r188 light and AO changes join
    const next = migratePlan({ path: fixture("r150-colour"), three: THREE_DIR, to: "r188" });
    expect(lines(next)).toContain("r188 ambient-hemisphere-specular x1");
    expect(formatMigrate(next)).not.toContain("migration data goes up to");
  });

  it("r160-onbeforecompile: deprecations whose removal is still ahead count", () => {
    const p = migratePlan({ path: fixture("r160-onbeforecompile"), three: THREE_DIR });
    expect(p.from).toBe(160);
    expect(lines(p)).toEqual(["r155 use-legacy-lights-removed x1 fix", "r159 update-ranges x1", "r181 pbr-indirect-specular x1", "r181 rough-pbr-brighter x1", "r183 clock-deprecated x1"]);
  });

  it("r170-tsl: the TSL and WebGPURenderer renames, only where the code has them", () => {
    const p = migratePlan({ path: fixture("r170-tsl"), three: THREE_DIR });
    expect(p.fromEvidence[0]!.from).toBe("three ^0.170.0 in package.json");
    expect(lines(p)).toEqual([
      "r172 texture-node-sample x1 fix",
      "r173 tsl-to-varying x1 fix",
      "r179 tsl-label x1 fix",
      "r181 webgpu-async-deprecated x1",
      "r181 tsl-pi2 x2 fix",
      "r182 pcf-soft-shadow x1 fix",
      "r182 output-buffer-type x1 fix",
      "r183 post-processing-renamed x1 fix",
      "r186 pcf-soft-shadow-webgpu x1",
    ]);
    expect(p.notFound.map((n) => n.id)).toContain("tsl-pack-normal");
  });

  it("limits to files, takes from and to as given, and says when there is nothing to do", () => {
    const dir = fixture("r150-colour");
    const only = migratePlan({ path: dir, three: THREE_DIR, files: ["index.html"] });
    expect(only.releases).toEqual([]);
    expect(formatMigrate(only)).toMatch(/No change between r150 and r187 shows in this code/);
    const narrow = migratePlan({ path: dir, three: THREE_DIR, from: "r181", to: "0.183.0" });
    expect(lines(narrow)).toEqual(["r183 clock-deprecated x1"]); // r181 looks are what that code already had
    expect(() => migratePlan({ path: dir, three: THREE_DIR, from: "r187" })).toThrow(/nothing to migrate: from r187 is not older than to r187/);
    expect(() => migratePlan({ path: dir, three: THREE_DIR, to: "next" })).toThrow(/to must be a release/);
  });

  it("counts a pattern only with its `also` and without its `unless`", () => {
    const code = (extra: string) => project({ "package.json": "{}", "a.js": `import * as THREE from 'three';\nconst l = new THREE.PointLight(0xffffff, 1);\nrenderer.shadowMap.type = THREE.PCFSoftShadowMap;\n${extra}` });
    const ids = (dir: string) => lines(migratePlan({ path: dir, three: THREE_DIR, from: "r146" })).map((l) => l.split(" ")[1]);
    const plain = ids(code(""));
    expect(plain).toContain("light-decay-2");
    expect(plain).toContain("pcf-soft-shadow");
    expect(plain).not.toContain("pcf-soft-shadow-webgpu");
    const other = ids(code("l.decay = 1;\nconst r = new THREE.WebGPURenderer();\n"));
    expect(other).not.toContain("light-decay-2");
    expect(other).toContain("pcf-soft-shadow-webgpu");
  });

  it("asks for from when nothing tells the release", () => {
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nnew THREE.Mesh();\n" });
    expect(() => migratePlan({ path: dir, three: THREE_DIR })).toThrow(/could not tell which three release.*pass from/);
  });
});

describe("release crossing and from detection", () => {
  const e = (kind: "rename" | "appearance", removedIn?: number) => ({ id: "x", kind, title: "", detect: { pattern: "x" }, todo: "", source: "https://x", ...(removedIn ? { removedIn } : {}) });
  it("counts a change in `from` itself except a look change, and a deprecation until its removal", () => {
    expect(crosses(e("rename"), 150, 150, 187)).toBe(true);
    expect(crosses(e("appearance"), 150, 150, 187)).toBe(false);
    expect(crosses(e("rename"), 149, 150, 187)).toBe(false);
    expect(crosses(e("rename", 165), 155, 160, 187)).toBe(true);
    expect(crosses(e("rename", 165), 155, 166, 187)).toBe(false);
    expect(crosses(e("rename"), 188, 150, 187)).toBe(false);
  });
  it("reads releases from options, CDN URLs, package files and git history", () => {
    expect([releaseNumber("r150"), releaseNumber("150"), releaseNumber("0.150.1"), releaseNumber("^0.160.0"), releaseNumber("next")]).toEqual([150, 150, 150, 160, undefined]);
    expect(releaseOption("from", "auto", "auto")).toBeUndefined();
    expect(releaseOption("to", "installed", "installed")).toBeUndefined();
    expect(() => releaseOption("to", "latest", "installed")).toThrow(/to must be a release/);
    const html = makeSourceFile("index.html", '<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.module.js"}}</script><script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r126/three.min.js"></script>');
    expect(cdnReleases([html]).map((x) => x.release)).toEqual([128, 126]);
    const dir = project({ "package.json": JSON.stringify({ dependencies: { three: "^0.187.0" } }), "package-lock.json": JSON.stringify({ packages: { "node_modules/three": { version: "0.165.0" } } }) });
    expect(detectFrom(dir, [], { dependencies: { three: "^0.187.0" } }, 187)).toEqual({ release: 165, evidence: [{ release: 165, from: "three 0.165.0 in package-lock.json" }] });
  });
  it("falls back to the three version before the last bump in git", () => {
    const dir = project({ "package.json": JSON.stringify({ dependencies: { three: "^0.155.0" } }, null, 2) });
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("add", "package.json");
    git("commit", "-q", "-m", "one");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { three: "^0.187.0" } }, null, 2));
    git("commit", "-q", "-am", "bump");
    expect(gitReleases(dir).map((x) => x.release)).toEqual([155]);
    const found = detectFrom(dir, [], undefined, 187);
    expect(found?.release).toBe(155);
    expect(found?.evidence[0]!.from).toMatch(/^three \^0\.155\.0 in package\.json before commit \w+$/);
  });
});

describe("three_migrate over MCP", () => {
  it("returns the plan as text and refuses a bad release", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { createServer } = await import("../src/mcp/server.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer().connect(b);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(a);
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
    const r = await c.callTool({ name: "three_migrate", arguments: { path: fixture("r150-colour"), three: THREE_DIR } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("[clock-deprecated]");
    const bad = await c.callTool({ name: "three_migrate", arguments: { path: fixture("r150-colour"), three: THREE_DIR, from: "abc" } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("from must be a release");
  });
});
