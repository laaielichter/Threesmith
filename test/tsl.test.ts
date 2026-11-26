import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { formatOutline, live, outline } from "../src/tsl/tsl.js";
import { project, THREE_DIR } from "./helpers.js";

const have = !!findChromium();

const TSL_FILE = `import * as THREE from 'three/webgpu';
import { Fn, uniform, uv, vec3, time, color, mix } from 'three/tsl';
const renderer = new THREE.WebGPURenderer();
export const tint = uniform(color(0xff8800));
export const stripes = Fn(() => {
  const s = uv().x * 8.0;
  return vec3(s.fract());
});
const glow = Fn(([c]) => c.mul(2)).setLayout({ name: 'glow', type: 'vec3', inputs: [{ name: 'c', type: 'vec3' }] });
const m = new THREE.MeshBasicNodeMaterial();
m.colorNode = mix(stripes(), glow(tint), time.sin());
`;

describe("tsl outline", () => {
  it("maps Fn, uniforms and node slots, with the TSL findings", () => {
    const dir = project({ "package.json": "{}", "src/fx.js": TSL_FILE, "src/plain.js": "import * as THREE from 'three';\nnew THREE.WebGLRenderer();\n" });
    const o = outline(dir);
    expect(o.files.map((f) => f.file)).toEqual(["src/fx.js"]);
    const f = o.files[0]!;
    expect(f.fns.map((x) => [x.name, x.layout])).toEqual([["stripes", undefined], ["glow", "glow"]]);
    expect(f.uniforms.map((u) => u.name)).toEqual(["tint"]);
    expect(f.slots.map((s) => `${s.target}.${s.slot}`)).toEqual(["m.colorNode"]);
    expect(o.renderer).toBe("both");
    expect(o.findings.map((x) => x.rule)).toContain("tsl-js-operator");
    const text = formatOutline(o);
    expect(text).toContain("Fn stripes (line 5), inline (no layout)");
    expect(text).toContain('Fn glow (line 9), layout "glow"');
    expect(text).toMatch(/src\/fx\.js:6 error \[tsl-js-operator\]/);
  });

  it("raises no TSL false alarms on three's own addons", async () => {
    const { review } = await import("../src/review/review.js");
    const r = review({ path: "node_modules/three/examples/jsm" });
    expect(r.findings.filter((f) => /^tsl-(?:js-|assign)/.test(f.rule))).toEqual([]);
  });

  it("says when there is no TSL", () => {
    expect(formatOutline(outline(project({ "a.js": "import * as THREE from 'three';\n" })))).toMatch(/^No TSL/);
  });
});

function gpuPage(script: string): string {
  const dir = project({
    "index.html": `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.webgpu.js","three/webgpu":"./three/three.webgpu.js","three/tsl":"./three/three.tsl.js"}}</script><script type="module" src="./main.js"></script></body></html>`,
    "main.js": script,
  });
  mkdirSync(join(dir, "three"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(THREE_DIR, join(dir, "node_modules", "three"), "dir");
  for (const f of ["three.webgpu.js", "three.tsl.js", "three.core.js"]) cpSync(join(THREE_DIR, "build", f), join(dir, "three", f));
  return dir;
}

const GPU_SCENE = `import * as THREE from 'three/webgpu';
import { uniform, uv, vec3, color, mix } from 'three/tsl';
const renderer = new THREE.WebGPURenderer();
renderer.setSize(200, 150);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
camera.position.z = 3;
const uTint = uniform(color(0xff8800)).setName('uTint');
const m = new THREE.MeshBasicNodeMaterial();
m.colorNode = mix(vec3(uv().x), uTint, 0.5);
const box = new THREE.Mesh(new THREE.BoxGeometry(), m);
box.name = 'crate';
scene.add(box);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
`;

describe.skipIf(!have)("tsl in the page (needs Chromium)", () => {
  it("reads the node graph of a material as a tree", async () => {
    const r = await live("graph", { target: gpuPage(GPU_SCENE), wait: 1500, object: "crate" });
    expect(r.text).toContain("renderer: WebGPURenderer");
    expect(r.text).toContain("crate: MeshBasicNodeMaterial, 1 node slot(s)");
    expect(r.text).toContain("crate.colorNode:");
    expect(r.text).toMatch(/MathNode mix/);
    expect(r.text).toMatch(/"uTint".*#ff8800.*\(uniform\)/);
  }, 90_000);

  it("shows the code WebGPURenderer generated, and finds a name in it", async () => {
    const r = await live("shader", { target: gpuPage(GPU_SCENE), wait: 1500, object: "crate", find: "uTint" });
    expect(r.text).toMatch(/crate \(MeshBasicNodeMaterial\): (GLSL|WGSL)/);
    expect(r.text).toContain("uTint");
    const none = await live("shader", { target: gpuPage(GPU_SCENE), wait: 1500, object: "nope" });
    expect(none.ok).toBe(false);
    expect(none.text).toContain('no drawable object named "nope"');
  }, 90_000);
});
