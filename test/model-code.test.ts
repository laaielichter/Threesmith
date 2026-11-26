import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { buildModel } from "../src/model/index.js";
import { modelCode, urlFor } from "../src/model/code.js";
import { editGlbJson } from "./model-helpers.js";
import { reviewFiles } from "./helpers.js";
import { project, THREE_DIR } from "./helpers.js";

const have = !!findChromium();

function car(): { dir: string; file: string } {
  const dir = project({ "package.json": "{}" });
  mkdirSync(join(dir, "public", "models"), { recursive: true });
  const file = join(dir, "public", "models", "car.glb");
  writeFileSync(file, buildModel({ kind: "car", textures: false }).glb);
  return { dir, file };
}

describe("model code", () => {
  it("works out the URL from public/", () => {
    expect(urlFor("/p/public/models/a.glb", "/p", "public")).toBe("/models/a.glb");
    expect(urlFor("/p/assets/a.glb", "/p", "public")).toBe("/assets/a.glb");
  });

  it("writes a vanilla module with the parts and no review errors", () => {
    const { dir, file } = car();
    const r = modelCode(file, { root: dir, publicDir: "public" });
    expect(r.name).toBe("loadCar");
    expect(r.url).toBe("/models/car.glb");
    expect(r.parts.length).toBeGreaterThan(3);
    expect(r.code).toContain(`export const PARTS = ${JSON.stringify(r.parts)};`);
    expect(r.code).toContain("gltfLoader.loadAsync(URL, onProgress)");
    expect(r.code).toContain("o.userData.name ?? o.name");
    const rv = reviewFiles({ "car.js": r.code, "package.json": "{}" });
    expect(rv.findings.filter((f) => f.severity === "error")).toEqual([]);
    const ts = modelCode(file, { root: dir, publicDir: "public", typescript: true });
    expect(ts.file).toBe("car.ts");
    expect(ts.code).toMatch(/export type PartName = "[^"]+"( \| "[^"]+")+;/);
  });

  it("writes an R3F component with the node tree, or one primitive when the file needs it", () => {
    const { dir, file } = car();
    const r = modelCode(file, { root: dir, publicDir: "public", style: "r3f" });
    expect(r.name).toBe("Car");
    expect(r.tree).toBe(true);
    expect(r.code).toContain("export function Car(props)");
    expect(r.code).toMatch(/<mesh name="[^"]+" geometry=\{nodes\["[^"]+"\]\.geometry\} material=\{nodes\["[^"]+"\]\.material\}/);
    expect(r.code).toContain('useGLTF.preload(URL);');
    // two nodes with the same name: GLTFLoader renames one, so no tree
    const dup = editGlbJson(file, (j) => {
      j.nodes[1].name = j.nodes[0].name;
      j.animations = [{ name: "Drive", channels: [], samplers: [] }];
    });
    const p = modelCode(dup, { root: dir, publicDir: "public", style: "r3f", typescript: true });
    expect(p.tree).toBe(false);
    expect(p.why).toMatch(/two nodes are named/);
    expect(p.code).toContain("clone(scene)");
    expect(p.code).toContain("useAnimations(animations, group)");
    expect(p.file).toBe("Car.tsx");
  });

  it.skipIf(!have)("the vanilla module loads the model in a page and finds every part", async () => {
    const { dir, file } = car();
    const r = modelCode(file, { root: dir, publicDir: "public" });
    mkdirSync(join(dir, "three"), { recursive: true });
    cpSync(join(THREE_DIR, "examples", "jsm"), join(dir, "three", "addons"), { recursive: true });
    cpSync(join(THREE_DIR, "build", "three.module.js"), join(dir, "three", "three.module.js"));
    cpSync(join(THREE_DIR, "build", "three.core.js"), join(dir, "three", "three.core.js"));
    cpSync(file, join(dir, "models-car.glb"));
    writeFileSync(join(dir, "car.js"), r.code.replace('"/models/car.glb"', '"./models-car.glb"'));
    writeFileSync(join(dir, "index.html"), `<!doctype html><script type="importmap">{"imports":{"three":"./three/three.module.js","three/addons/":"./three/addons/"}}</script>
<script type="module">import { loadCar, PARTS } from './car.js';
const m = await loadCar();
document.title = 'parts ' + PARTS.filter((p) => m.parts[p]).length + '/' + PARTS.length;</script>`);
    const s = await import("../src/session/session.js");
    await s.startSession({ target: dir, wait: 1500 }, "model-code");
    try {
      const t = await s.pageOp({ op: "until", js: "document.title.startsWith('parts')", timeout: 10000 }, "model-code").then(() => s.pageOp({ op: "eval", js: "document.title" }, "model-code"));
      expect(t.value).toBe(`parts ${r.parts.length}/${r.parts.length}`);
    } finally {
      await s.stopSession("model-code");
    }
  }, 90_000);
});
