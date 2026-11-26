import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { check } from "../src/check/check.js";
import { expression, translate, type Scope } from "../src/migrate/glsl.js";
import { formatMigrate } from "../src/migrate/format.js";
import { migratePlan } from "../src/migrate/migrate.js";
import { property, stringValue, webgpuReadiness } from "../src/migrate/webgpu.js";
import { review } from "../src/review/review.js";
import { makeSourceFile } from "../src/review/source.js";
import { project, THREE_DIR } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "migrate");
const plan = (name: string) => migratePlan({ path: join(FIXTURES, name), three: THREE_DIR, webgpu: true });
const scope = (names: Record<string, string> = {}): Scope => ({ names: new Map(Object.entries(names)), needs: new Map(), locals: new Set(), used: new Set() });

describe("GLSL to TSL", () => {
  it("translates expressions with precedence, calls, swizzles and numbers", () => {
    const s = scope({ uTime: "uTime", vUv: "uv()", uMap: "uMap" });
    expect(expression("0.5 + 0.5 * sin(uTime * 2.0)", s)).toBe("float( 0.5 ).add( float( 0.5 ).mul( sin( uTime.mul( 2 ) ) ) )");
    expect(expression("vec4(texture2D(uMap, vUv).rgb, 1.0)", s)).toBe("vec4( uMap.sample( uv() ).rgb, 1 )");
    expect(expression("-uTime", s)).toBe("uTime.negate()");
    expect(() => expression("myFunc(uTime)", s)).toThrow(/unknown function myFunc/);
    expect(() => expression("uTime > 1.0 ? 1.0 : 0.0", s)).toThrow();
  });
  it("turns declarations and assignments into toVar() and assign calls, and control flow into TODO", () => {
    const s = scope({ position: "positionLocal", uTime: "uTime" });
    const r = translate(["vec3 p = position", "p.y += sin(uTime)", "if (p.x > 0.0) { p.x = 0.0; }", "gl_Position = vec4(p, 1.0)"], s, new Set(["gl_Position"]), { capture: new Set(["gl_Position"]) });
    expect(r.lines).toEqual(["const p = positionLocal.toVar();", "p.y.addAssign( sin( uTime ) );", "// TODO (control flow): if (p.x > 0.0) { p.x = 0.0; };"]);
    expect(r.outputs.get("gl_Position")).toBe("vec4( p, 1 )");
    expect(r.todo).toHaveLength(1);
  });
  it("reads object properties and string expressions from the code", () => {
    expect(property("a: 1, b: { c: 2 }, d", "b")).toBe("{ c: 2 }");
    expect(property("a: 1, d", "d")).toBe("d");
    const text = "const vs = 'uniform float a;\\n' + `void main() {}`;\n";
    expect(stringValue("vs", text)).toBe("uniform float a;\nvoid main() {}");
    expect(stringValue("document.getElementById('x').textContent", text)).toBeUndefined();
  });
});

describe("WebGPU readiness", () => {
  it("r160-shadermaterial: the GLSL material and the composer block, with the passes mapped and a full draft", () => {
    const w = plan("r160-shadermaterial").webgpu!;
    expect(w.items.filter((i) => i.kind === "blocker").map((i) => `${i.id} ${i.file}:${i.line}`)).toEqual(["glsl-material main.js:26", "effect-composer main.js:2"]);
    expect(w.items.find((i) => i.id === "effect-composer")!.message).toContain("UnrealBloomPass -> bloom(");
    expect(w.items.map((i) => i.id)).toContain("renderer");
    expect(w.score).toBe(70);
    const d = w.drafts[0]!;
    expect(d.todo).toEqual([]);
    expect(d.code).toContain("import * as THREE from 'three/webgpu';");
    expect(d.code).toContain("import { Fn, float, mix, positionLocal, sin, texture, uniform, uv, vec4 } from 'three/tsl';");
    expect(d.code).toContain("p.z.addAssign( sin( p.x.mul( 4 ).add( uTime ) ).mul( 0.1 ) );");
    expect(d.code).toContain("return vec4( mix( uColor, tex.rgb, 0.5 ).mul( pulse ), 1 );");
    expect(d.code).toContain("material.side = THREE.DoubleSide;");
  });
  it("r160-onbeforecompile: the chunk hooks become positionNode and colorNode of a MeshStandardNodeMaterial", () => {
    const d = plan("r160-onbeforecompile").webgpu!.drafts[0]!;
    expect(d.source).toBe("onBeforeCompile");
    expect(d.material).toBe("MeshStandardNodeMaterial");
    expect(d.todo).toEqual([]);
    expect(d.code).toContain("new THREE.MeshStandardNodeMaterial( { color: 0x3366ff, roughness: 0.7 } )");
    expect(d.code).toContain("transformed.y.addAssign( sin( positionLocal.x.mul( 4 ).add( uTime ) ).mul( 0.1 ) );");
    expect(d.code).toContain("diffuseColor.rgb.mulAssign(");
  });
  it("marks what it cannot map and still writes a draft that runs", () => {
    const f = makeSourceFile("a.js", "import * as THREE from 'three';\nconst m = new THREE.ShaderMaterial({ vertexShader: document.getElementById('vs').textContent, fragmentShader: 'void main() { if (true) { discard; } gl_FragColor = vec4(1.0); }' });\n");
    const w = webgpuReadiness([f], 187);
    const d = w.drafts[0]!;
    expect(d.todo.join("\n")).toContain("vertexShader document.getElementById");
    expect(d.code).toContain("// TODO (control flow)");
    expect(d.code).toContain("return vec4( 1 );");
  });
  it("prints the readiness and the drafts in the plan; nothing for code without WebGPU blockers", () => {
    const text = formatMigrate(plan("r160-shadermaterial"));
    expect(text).toContain("WebGPU readiness: 70/100");
    expect(text).toContain("TSL draft 1: ShaderMaterial at main.js:26 -> MeshBasicNodeMaterial");
    const clean = webgpuReadiness([makeSourceFile("a.js", "import * as THREE from 'three/webgpu';\nconst m = new THREE.MeshStandardNodeMaterial();\n")], 187);
    expect(clean).toMatchObject({ score: 100, blockers: 0, drafts: [] });
  });
  it("the drafts pass the review: no GLSL material, nothing an error", () => {
    for (const name of ["r160-shadermaterial", "r160-onbeforecompile"]) {
      const code = plan(name).webgpu!.drafts[0]!.code;
      const dir = project({ "package.json": "{}", "draft.js": code });
      const r = review({ path: dir, three: THREE_DIR });
      expect(r.findings.map((x) => x.rule)).not.toContain("webgpu-glsl-material");
      expect(r.findings.filter((x) => x.severity === "error"), name).toEqual([]);
    }
  });
});

describe.skipIf(!findChromium())("TSL drafts render (needs Chromium)", () => {
  for (const name of ["r160-shadermaterial", "r160-onbeforecompile"]) {
    it(`${name}: the draft draws under WebGPURenderer with its WebGL 2 backend`, async () => {
      const dir = project({});
      mkdirSync(join(dir, "three"), { recursive: true });
      for (const f of ["three.core.js", "three.webgpu.js", "three.tsl.js"]) cpSync(join(THREE_DIR, "build", f), join(dir, "three", f));
      writeFileSync(join(dir, "draft.js"), plan(name).webgpu!.drafts[0]!.code);
      writeFileSync(
        join(dir, "index.html"),
        `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three/webgpu":"./three/three.webgpu.js","three/tsl":"./three/three.tsl.js"}}</script><script type="module">
import * as THREE from 'three/webgpu';
import { createMaterial } from './draft.js';
const renderer = new THREE.WebGPURenderer({ forceWebGL: true });
renderer.setSize(400, 300);
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101010);
scene.add(new THREE.AmbientLight(0xffffff, 1), new THREE.DirectionalLight(0xffffff, 2));
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
camera.position.z = 2.5;
const map = new THREE.DataTexture(new Uint8Array([255, 200, 0, 255]), 1, 1);
map.needsUpdate = true;
const { material, uniforms } = createMaterial({ uMap: map });
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 16, 16), material));
// uTime stays 0: the shader pulses to black at some times, which would read as a blank frame
uniforms.uTime.value = 0;
renderer.setAnimationLoop(() => renderer.render(scene, camera));
</script></body></html>`,
      );
      const r = await check({ target: dir, wait: 1500 });
      expect(r.issues.filter((i) => i.severity === "error"), JSON.stringify(r.issues)).toEqual([]);
      expect(r.stats.backend).toBe("webgl2");
      expect(r.stats.frames).toBeGreaterThan(0);
    }, 60_000);
  }
});
