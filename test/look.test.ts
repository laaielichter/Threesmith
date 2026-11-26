import { cpSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { formatLook, judge, look, placeOf, verdicts, type LookReport } from "../src/check/look.js";
import { pageOp, startSession, stopSession } from "../src/session/session.js";
import { project, THREE_DIR } from "./helpers.js";

const have = !!findChromium();

function page(script: string): string {
  const dir = project({
    "index.html": `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js"}}</script><script type="module" src="./main.js"></script></body></html>`,
    "main.js": script,
  });
  mkdirSync(join(dir, "three"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(THREE_DIR, join(dir, "node_modules", "three"), "dir");
  cpSync(join(THREE_DIR, "build", "three.module.js"), join(dir, "three", "three.module.js"));
  cpSync(join(THREE_DIR, "build", "three.core.js"), join(dir, "three", "three.core.js"));
  return dir;
}

const scene = (body: string, bg = "0x203040") => `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(400, 300);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(${bg});
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
camera.position.set(0, 0, 5);
scene.add(new THREE.AmbientLight(0xffffff, 1.5));
const box = (name, color, x, y, z, s = 1) => { const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), new THREE.MeshBasicMaterial({ color })); m.name = name; m.position.set(x, y, z); scene.add(m); return m; };
${body}
renderer.setAnimationLoop(() => renderer.render(scene, camera));
`;

const report = (objects: Partial<LookReport["objects"][number]>[], frame: Partial<NonNullable<LookReport["frame"]>> = {}): LookReport => ({
  found: true,
  skipped: 0,
  frame: { width: 400, height: 300, luma: 90, dark: 0.1, bright: 0, background: 0.7, transparent: 0, content: null, ...frame },
  objects: objects.map((o) => ({ name: "x", visible: 0.1, silhouette: 0.1, box: [0.4, 0.4, 0.6, 0.6], center: [0.5, 0.5], cut: [], luma: 100, meshes: 1, ...o })),
});

describe("look: verdicts and claims", () => {
  it("names places in the frame", () => {
    expect(placeOf([0.5, 0.5])).toBe("centre");
    expect(placeOf([0.1, 0.1])).toBe("top left");
    expect(placeOf([0.9, 0.5])).toBe("right");
  });

  it("judges claims on the numbers and explains unknown ones", () => {
    const r = report([{ name: "car", visible: 0.12, silhouette: 0.2, cut: ["right"], hiddenBy: { name: "wall", share: 0.4 } }], { background: 0.6 });
    const c = judge(r, ["car visible >= 10%", "Car in view", "car centered", "car not cut", "car not hidden", "frame not dark", "background <= 50%", "boat in view", "make it pretty"]);
    expect(c.map((x) => x.ok)).toEqual([true, true, true, false, true, true, false, false, false]);
    expect(c[7]!.value).toContain('no object "boat"');
    expect(c[8]!.value).toContain("unknown claim");
  });

  it("calls out a dark, empty or hidden frame", () => {
    expect(verdicts(report([], { luma: 3, dark: 0.99 })).map((v) => v.kind)).toEqual(["empty", "too-dark"]);
    expect(verdicts(report([{ visible: 0, silhouette: 0, center: null, box: null }])).map((v) => v.kind)).toEqual(["nothing-visible"]);
    expect(verdicts(report([{ name: "car", visible: 0.01, silhouette: 0.2, hiddenBy: { name: "wall", share: 0.9 } }])).map((v) => v.kind)).toContain("hidden");
    expect(verdicts({ found: false, objects: [], skipped: 0, why: "no scene" })[0]!.kind).toBe("no-scene");
  });
});

describe.skipIf(!have)("look (needs Chromium)", () => {
  it("measures each object's share, place and edges, and judges claims", async () => {
    const r = await look({ target: page(scene("box('crate', 0xff3030, 0, 0, 0, 1.5);\nbox('lamp', 0x30ff30, 3.3, 1.6, 0, 1);")), wait: 600, expect: ["crate visible >= 5%", "crate centered", "crate not cut", "lamp cut", "frame not dark"] });
    const crate = r.report.objects.find((o) => o.name === "crate")!;
    expect(crate.visible).toBeGreaterThan(0.05);
    expect(placeOf(crate.center!)).toBe("centre");
    expect(crate.cut).toEqual([]);
    const lamp = r.report.objects.find((o) => o.name === "lamp")!;
    expect(lamp.cut.length).toBeGreaterThan(0);
    expect(r.claims.map((c) => [c.text, c.ok])).toEqual([
      ["crate visible >= 5%", true],
      ["crate centered", true],
      ["crate not cut", true],
      ["lamp cut", true],
      ["frame not dark", true],
    ]);
    expect(r.ok).toBe(true);
    const text = formatLook(r);
    expect(text).toMatch(/crate: [\d.]+% at the centre/);
  }, 60_000);

  it("draws numbered boxes and names on the frame", async () => {
    const r = await look({ target: page(scene("box('crate', 0xff3030, 0, 0, 0, 1.5);")), wait: 600, annotate: true });
    expect(r.image?.subarray(1, 4).toString()).toBe("PNG");
    const { decodePng } = await import("../src/check/png.js");
    const img = decodePng(r.image!);
    expect([img.width, img.height]).toEqual([400, 300]);
    expect(formatLook(r)).toMatch(/1\. crate: /);
  }, 60_000);

  it("says what hides an object", async () => {
    const r = await look({ target: page(scene("box('car', 0xff3030, 0, 0, -2, 1);\nbox('wall', 0x8080ff, 0, 0, 1, 2.5);")), wait: 600, expect: ["car hidden"] });
    const car = r.report.objects.find((o) => o.name === "car")!;
    expect(car.silhouette).toBeGreaterThan(0);
    expect(car.visible).toBe(0);
    expect(car.hiddenBy?.name).toBe("wall");
    expect(r.claims[0]!.ok).toBe(true);
    expect(formatLook(r)).toContain("car: not visible: all of it is behind wall");
  }, 60_000);

  it("finds a black frame: a lit material without light on a black background", async () => {
    const r = await look({ target: page(`import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer(); renderer.setSize(320, 240); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100); camera.position.z = 4;
const m = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial({ color: 0xffffff })); m.name = 'ball'; scene.add(m);
renderer.setAnimationLoop(() => renderer.render(scene, camera));`), wait: 600 });
    const kinds = r.verdicts.map((v) => v.kind);
    expect(kinds).toContain("too-dark");
    expect(kinds).toContain("nothing-visible");
    expect(r.ok).toBe(false);
  }, 60_000);

  it("measures a live page with three_page op look", async () => {
    await startSession({ target: page(scene("box('crate', 0xff3030, 0, 0, 0, 1.5);")), wait: 600 }, "look-test");
    try {
      const a = await pageOp({ op: "look", expect: ["crate in view"] }, "look-test");
      expect(a.ok).toBe(true);
      expect(a.text).toContain("crate:");
    } finally {
      await stopSession("look-test");
    }
  }, 60_000);
});
