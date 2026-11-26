import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { check } from "../src/check/check.js";
import { migratePlan } from "../src/migrate/migrate.js";
import { applyRewrites, formatMigrateWrite, migrateWrite } from "../src/migrate/write.js";
import { undoJournal, writeFiles } from "../src/project/journal.js";
import { review } from "../src/review/review.js";
import { readOnlyRefusal } from "../src/mcp/toolsets.js";
import { project, THREE_DIR } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "migrate");
const fixture = (name: string) => {
  const dir = project({});
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
};
const write = (dir: string, opts: { to?: string; three?: string } = {}) => {
  const w = migrateWrite({ path: dir, three: opts.three ?? THREE_DIR, ...(opts.to ? { to: opts.to } : {}) });
  const id = writeFiles(w.plan.root, "three_migrate", "test", w.files.map((f) => ({ file: f.rootFile, data: f.data })));
  return { w, id };
};
const apiErrors = (dir: string) => review({ path: dir, three: THREE_DIR }).findings.filter((f) => f.category === "api" && f.severity === "error").map((f) => `${f.rule} ${f.file}:${f.line}`);

describe("migrate rewrites", () => {
  it("r150-colour: renames, the loader, the dropped switch; only the hand work is left, and undo restores the bytes", () => {
    const dir = fixture("r150-colour");
    const before = readFileSync(join(dir, "scene.js"), "utf8");
    const { w } = write(dir);
    expect(w.files.map((f) => `${f.file} ${f.count} ${f.changes.join(",")}`)).toEqual(["scene.js 6 output-encoding,physically-correct-lights,rgbe-loader-deprecated,texture-encoding"]);
    const after = readFileSync(join(dir, "scene.js"), "utf8");
    expect(after).toContain("import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';");
    expect(after).toContain("renderer.outputColorSpace = THREE.SRGBColorSpace;");
    expect(after).toContain("texture.colorSpace = THREE.SRGBColorSpace;");
    expect(after).not.toContain("physicallyCorrectLights");
    expect(apiErrors(dir)).toEqual([]);
    const again = migratePlan({ path: dir, three: THREE_DIR, from: "r150" });
    expect(again.fixable).toBe(0);
    expect(again.todo.map((t) => t.id)).toEqual(["clock-deprecated"]);
    const u = undoJournal(dir);
    expect(u.undone[0]!.restored).toEqual(["scene.js"]);
    expect(readFileSync(join(dir, "scene.js"), "utf8")).toBe(before);
  });

  it("r170-tsl: the TSL and WebGPURenderer renames, imports included, strings left alone", async () => {
    const dir = fixture("r170-tsl");
    write(dir);
    const after = readFileSync(join(dir, "main.js"), "utf8");
    expect(after).toContain("import { color, uniform, positionLocal, sin, TWO_PI, texture, uv } from 'three/tsl';");
    expect(after).toContain("const wave = sin(positionLocal.x.mul(TWO_PI).add(time)).toVarying();");
    expect(after).toContain("new THREE.WebGPURenderer({ outputBufferType: THREE.HalfFloatType })");
    expect(after).toContain("texture(map).sample(uv().mul(2))");
    expect(after).toContain("new THREE.RenderPipeline(renderer)");
    expect(after).toContain(".setName('red')");
    expect(after).toContain("THREE.PCFShadowMap;");
    expect(apiErrors(dir)).toEqual([]);
    // every name the rewritten file imports exists in the installed three
    const tsl = await import(pathToFileURL(join(THREE_DIR, "build", "three.tsl.js")).href);
    const names = /import \{([^}]*)\} from 'three\/tsl'/.exec(after)![1]!.split(",").map((s) => s.trim());
    expect(names.filter((n) => !(n in tsl))).toEqual([]);
    const left = migratePlan({ path: dir, three: THREE_DIR });
    expect(left.todo.map((t) => t.id).sort()).toEqual(["webgpu-async-deprecated"]);
  });

  it("leaves Geometry to the hand work (r125-geometry) and the dry run changes nothing", () => {
    const dir = fixture("r125-geometry");
    const before = readFileSync(join(dir, "main.js"), "utf8");
    const dry = migrateWrite({ path: dir, three: THREE_DIR });
    expect(readFileSync(join(dir, "main.js"), "utf8")).toBe(before);
    expect(formatMigrateWrite(dry, false)).toMatch(/^Would rewrite 7 place\(s\) in 1 file\(s\)/);
    write(dir);
    const after = readFileSync(join(dir, "main.js"), "utf8");
    expect(after).toContain("import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';");
    expect(after).toContain("BufferGeometryUtils.mergeGeometries([box, new THREE.SphereGeometry(0.5)])");
    expect(apiErrors(dir).map((e) => e.split(" ")[0])).toEqual(["geometry-class", "geometry-vertices", "face3", "geometry-vertices", "compute-face-normals"]);
  });

  it("skips rewrites whose new name the installed three does not have yet", () => {
    const old = project({ "package.json": JSON.stringify({ name: "three", version: "0.176.0" }) });
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three/webgpu';\nimport { color } from 'three/tsl';\nconst n = color(1, 0, 0).label('x');\n" });
    const w = migrateWrite({ path: dir, three: old, from: "r170", to: "r180" });
    expect(w.files).toEqual([]);
    expect(w.skipped).toEqual([{ id: "tsl-label", release: 179 }]);
    expect(formatMigrateWrite(w, false)).toContain("tsl-label (r179)");
  });
});

describe("read-only", () => {
  it("refuses write but keeps the plan", () => {
    expect(readOnlyRefusal("three_migrate", { write: true })).toContain("read-only");
    expect(readOnlyRefusal("three_migrate", {})).toBeUndefined();
  });
});

describe("applyRewrites", () => {
  it("renames code only, keeps comments, groups and lookaheads, and deletes whole lines", () => {
    const code = "const a = x.varying(); // x.varying()\nconst s = 'x.varying()';\nconst gl = `varying vec2 vUv;`;\n";
    expect(applyRewrites(code, [{ find: String.raw`\.varying(?=\s*\()`, replace: ".toVarying", code: true }])).toEqual({ text: code.replace("= x.varying()", "= x.toVarying()"), count: 1 });
    expect(applyRewrites("a.label( 'n' ); a.label(n);", [{ find: String.raw`\.label(?=\s*\(\s*['"])`, replace: ".setName", code: true }]).text).toBe("a.setName( 'n' ); a.label(n);");
    expect(applyRewrites("myScene.autoUpdate = false;", [{ find: String.raw`\b([\w$]*[sS]cene\w*)\.autoUpdate\b`, replace: "$1.matrixWorldAutoUpdate", code: true }]).text).toBe("myScene.matrixWorldAutoUpdate = false;");
    expect(applyRewrites("a();\n  renderer.useLegacyLights = false;\nb();\n", [{ find: String.raw`^[ \t]*[\w$.]+\.useLegacyLights\s*=\s*false\s*;?[ \t]*\r?\n`, replace: "", code: true }]).text).toBe("a();\nb();\n");
  });
});

describe.skipIf(!findChromium())("a migrated page runs (needs Chromium)", () => {
  it("r150-colour after write: true renders headless on the installed three", async () => {
    const dir = fixture("r150-colour");
    write(dir);
    mkdirSync(join(dir, "three", "addons", "loaders"), { recursive: true });
    for (const f of ["three.module.js", "three.core.js"]) cpSync(join(THREE_DIR, "build", f), join(dir, "three", f));
    cpSync(join(THREE_DIR, "examples", "jsm", "loaders", "HDRLoader.js"), join(dir, "three", "addons", "loaders", "HDRLoader.js"));
    // the same page, with the import map pointing at the local copy instead of the CDN
    writeFileSync(join(dir, "index.html"), readFileSync(join(dir, "index.html"), "utf8").replace(/https:\/\/unpkg\.com\/three@0\.150\.1\/build\//, "./three/").replace(/https:\/\/unpkg\.com\/three@0\.150\.1\/examples\/jsm\//, "./three/addons/"));
    const r = await check({ target: dir, wait: 800, ignore: ["wood.jpg", "studio.hdr"] });
    expect(r.issues.filter((i) => i.severity === "error"), JSON.stringify(r.issues)).toEqual([]);
    expect(r.stats.threeRevision).toBe("187");
    expect(r.stats.backend).toBe("webgl2");
  }, 60_000);
});
