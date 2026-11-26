import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { check } from "../src/check/check.js";
import { formatOptimize, formatValidation, loadOptional, optimizeGltf, OptionalMissing, validateGltf } from "../src/gltf/gltf.js";
import { createServer } from "../src/mcp/server.js";
import { patchGlbJson, sphereGlb } from "./gltf-helpers.js";
import { project, THREE_DIR } from "./helpers.js";

const have = !!findChromium();
const textOf = (r: unknown): string => (r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "";

async function client(readOnly = false): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ readOnly }).connect(b);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(a);
  return c;
}

async function models(): Promise<string> {
  const dir = project({ "package.json": "{}" });
  mkdirSync(join(dir, "models"), { recursive: true });
  const glb = await sphereGlb(64);
  writeFileSync(join(dir, "models", "sphere.glb"), glb);
  writeFileSync(join(dir, "models", "broken.glb"), patchGlbJson(glb, (j) => ((j["meshes"] as { primitives: { material: number }[] }[])[0]!.primitives[0]!.material = 99)));
  return dir;
}

describe("three_gltf validate", () => {
  it("passes a valid model and names the errors of a broken one", async () => {
    const dir = await models();
    const ok = await validateGltf(join(dir, "models", "sphere.glb"));
    expect([ok.errors, ok.validator]).toEqual([0, expect.stringMatching(/^glTF-Validator \d/)]);
    expect(formatValidation(ok)).toContain("Valid glTF.");
    const bad = await validateGltf(join(dir, "models", "broken.glb"));
    expect(bad.errors).toBeGreaterThan(0);
    expect(bad.messages[0]).toMatchObject({ severity: "error", code: "UNRESOLVED_REFERENCE", pointer: "/meshes/0/primitives/0/material" });
    expect(formatValidation(bad)).toMatch(/^error \[UNRESOLVED_REFERENCE\] .* at \/meshes\/0\/primitives\/0\/material$/m);
  });

  it("says what to install when an optional package is missing", async () => {
    await expect(loadOptional("threesmith-no-such-package", "glTF validation")).rejects.toThrow(OptionalMissing);
    await expect(loadOptional("threesmith-no-such-package", "glTF validation")).rejects.toThrow("glTF validation needs the optional package threesmith-no-such-package, which is not installed. Install it next to threesmith: npm install -D threesmith-no-such-package");
  });

  it("refuses files that are not glTF", async () => {
    const dir = project({ "a.txt": "x" });
    await expect(validateGltf(join(dir, "a.txt"))).rejects.toThrow(/not a \.glb or \.gltf/);
    await expect(validateGltf(join(dir, "none.glb"))).rejects.toThrow(/model not found/);
  });
});

describe("three_gltf optimize", () => {
  it("prunes, welds and Draco-compresses: smaller, the same triangles, valid", async () => {
    const dir = await models();
    const r = await optimizeGltf(join(dir, "models", "sphere.glb"), { compress: "draco" });
    expect(r.out).toBe(join(dir, "models", "sphere.optimized.glb"));
    expect(r.after.bytes).toBeLessThan(r.before.bytes * 0.75);
    expect(r.after.triangles).toBe(r.before.triangles);
    expect([r.before.materials, r.after.materials]).toEqual([2, 1]);
    expect(r.after.extensions).toEqual(["KHR_draco_mesh_compression"]);
    expect(r.validation?.errors).toBe(0);
    expect(existsSync(r.out)).toBe(false); // pure: nothing written
    const text = formatOptimize(r, { root: dir });
    expect(text).toMatch(/^models\/sphere\.glb -> models\/sphere\.optimized\.glb: \d+% smaller/);
    expect(text).toContain("three_decoders");
  });

  it("writes nothing to stdout (the MCP server owns it)", async () => {
    const dir = await models();
    const spies = (["log", "info", "warn", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const write = vi.spyOn(process.stdout, "write");
    try {
      await optimizeGltf(join(dir, "models", "sphere.glb"), { compress: "draco" });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
      write.mockRestore();
    }
  });

  it("meshopt-compresses and simplifies", async () => {
    const dir = await models();
    const m = await optimizeGltf(join(dir, "models", "sphere.glb"), { compress: "meshopt" });
    expect(m.after.extensions).toContain("EXT_meshopt_compression");
    expect(m.after.bytes).toBeLessThan(m.before.bytes);
    expect(m.validation?.errors).toBe(0);
    const s = await optimizeGltf(join(dir, "models", "sphere.glb"), { simplify: 0.25 });
    expect(s.after.triangles).toBeLessThan(s.before.triangles * 0.5);
    expect(s.after.triangles).toBeGreaterThan(0);
  });
});

describe("three_gltf over MCP", () => {
  it("validates, optimizes as a dry run, writes one undoable file, and refuses write when read-only", async () => {
    const dir = await models();
    const c = await client();
    const v = await c.callTool({ name: "three_gltf", arguments: { op: "validate", file: "models/broken.glb", path: dir } });
    expect(v.isError).toBe(true);
    expect(textOf(v)).toContain("UNRESOLVED_REFERENCE");
    const dry = await c.callTool({ name: "three_gltf", arguments: { op: "optimize", file: "models/sphere.glb", compress: "draco", path: dir } });
    expect(textOf(dry)).toContain("write: true (--write) saves it");
    expect(existsSync(join(dir, "models", "sphere.optimized.glb"))).toBe(false);
    const ro = await client(true);
    expect((await ro.callTool({ name: "three_gltf", arguments: { op: "optimize", file: "models/sphere.glb", write: true, path: dir } })).isError).toBe(true);
    const w = await c.callTool({ name: "three_gltf", arguments: { op: "optimize", file: "models/sphere.glb", compress: "draco", out: "models/small.glb", write: true, path: dir } });
    expect(textOf(w)).toMatch(/Written \(journal \d+/);
    expect(existsSync(join(dir, "models", "small.glb"))).toBe(true);
    await c.callTool({ name: "three_undo", arguments: { path: dir } });
    expect(existsSync(join(dir, "models", "small.glb"))).toBe(false);
    const outside = await c.callTool({ name: "three_gltf", arguments: { op: "optimize", file: "models/sphere.glb", out: "../x.glb", write: true, path: dir } });
    expect(outside.isError).toBe(true);
  });
});

describe.skipIf(!have)("three_gltf optimize renders the same (needs Chromium)", () => {
  it("the Draco output matches a baseline of the original within the default tolerance", async () => {
    const dir = await models();
    const jsm = ["loaders/GLTFLoader.js", "loaders/DRACOLoader.js", "utils/BufferGeometryUtils.js", "utils/SkeletonUtils.js"];
    for (const f of ["three.module.js", "three.core.js"]) cpSync(join(THREE_DIR, "build", f), join(dir, "three", f), { recursive: true });
    for (const f of jsm) cpSync(join(THREE_DIR, "examples", "jsm", f), join(dir, "three", "jsm", f));
    for (const f of ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"]) cpSync(join(THREE_DIR, "examples/jsm/libs/draco/gltf", f), join(dir, "draco", f));
    writeFileSync(join(dir, "index.html"), `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js","three/addons/":"./three/jsm/"}}</script><script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 240);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x203040);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(2, 3, 4);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
camera.position.set(0, 0, 3);
const loader = new GLTFLoader().setDRACOLoader(new DRACOLoader().setDecoderPath('./draco/'));
scene.add((await loader.loadAsync('./models/model.glb')).scene);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
</script></body></html>`);
    cpSync(join(dir, "models", "sphere.glb"), join(dir, "models", "model.glb"));
    const first = await check({ target: dir, wait: 2500, baseline: "model" });
    expect(first.baseline?.status).toBe("created");
    const r = await optimizeGltf(join(dir, "models", "sphere.glb"), { compress: "draco" });
    writeFileSync(join(dir, "models", "model.glb"), r.data);
    expect(readFileSync(join(dir, "models", "model.glb")).byteLength).toBe(r.after.bytes);
    const second = await check({ target: dir, wait: 2500, baseline: "model" });
    expect(second.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(second.baseline?.status).toBe("match");
  });
});
