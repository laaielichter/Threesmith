import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { device, formatDevice, loadProfile, PROFILES } from "../src/check/device.js";
import { ids, project, reviewFiles } from "./helpers.js";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();
const META = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js"}}</script><script type="module" src="./main.js"></script></body></html>`;

const scene = (opts: { ratio: string; big?: boolean; busyMs?: number }) => `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setPixelRatio(${opts.ratio});
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 3;
const small = new THREE.DataTexture(new Uint8Array(16 * 16 * 4).fill(200), 16, 16);
small.needsUpdate = true;
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: small })));
${opts.big ? `const wide = new THREE.DataTexture(new Uint8Array(5000 * 4 * 4).fill(90), 5000, 4);
wide.needsUpdate = true;
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: wide })));
const c = document.createElement('canvas'); c.width = 6000; c.height = 8;
const resized = new THREE.CanvasTexture(c);
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: resized })));` : ""}
renderer.setAnimationLoop(() => {
  ${opts.busyMs ? `const until = performance.now() + ${opts.busyMs}; let x = 0; while (performance.now() < until) x += Math.sqrt(x + 1);` : ""}
  renderer.render(scene, camera);
});
`;

describe("device profiles", () => {
  it("has the presets and reads a custom JSON profile on top of one", () => {
    expect(Object.keys(PROFILES)).toEqual(["phone", "tablet", "low-end-laptop"]);
    const dir = project({ "slow.json": JSON.stringify({ extends: "tablet", cpuThrottle: 6, maxTextureSize: 2048 }), "bad.json": JSON.stringify({ width: -1 }) });
    const p = loadProfile(join(dir, "slow.json"));
    expect([p.name, p.width, p.cpuThrottle, p.maxTextureSize]).toEqual(["slow", 820, 6, 2048]);
    expect(() => loadProfile(join(dir, "bad.json"))).toThrow(/"width" must be a positive number/);
    expect(() => loadProfile("watch")).toThrow(/unknown device profile "watch"; use phone, tablet, low-end-laptop/);
  });
});

describe("no-context-loss-handler", () => {
  it("stays quiet with an animation loop and in R3F, fires for an on-demand page", () => {
    const T = "import * as THREE from 'three';\nconst renderer = new THREE.WebGLRenderer();\n";
    expect(ids(reviewFiles({ "a.js": `${T}function render() { renderer.render(scene, camera); }\nwindow.addEventListener('resize', render);\n` }))).toContain("no-context-loss-handler");
    expect(ids(reviewFiles({ "a.js": `${T}renderer.setAnimationLoop(() => renderer.render(scene, camera));\n` }))).not.toContain("no-context-loss-handler");
    expect(ids(reviewFiles({ "a.js": `${T}function tick() { renderer.render(scene, camera); requestAnimationFrame(tick); }\ntick();\n` }))).not.toContain("no-context-loss-handler");
  });
});

describe.skipIf(!have)("three_device (needs Chromium)", () => {
  it("names a texture over the phone's limit, the one three resized, and an uncapped pixel ratio", async () => {
    const dir = gamePage(scene({ ratio: "window.devicePixelRatio", big: true }));
    const r = await device({ target: dir, profile: "phone", seconds: 1, wait: 800 });
    // no <meta name="viewport">: the phone lays the page out 980 wide
    expect(r.canvas).toMatchObject({ cssWidth: 980, pixelRatio: 3, width: 2940 });
    expect(r.findings.map((f) => f.kind).sort()).toEqual(["pixel-ratio", "texture-over-limit", "texture-resized", "viewport-meta"]);
    expect(r.textures.over).toEqual([expect.objectContaining({ width: 5000, height: 4 })]);
    expect(r.ok).toBe(false);
    const text = formatDevice(r);
    expect(text).toMatch(/^Threesmith device: FAIL on phone/);
    expect(text).toContain("[device-texture-over-limit] A 5000x4 texture was uploaded");
    expect(text).toContain("renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))");
  });

  it("passes a page that fits, and the same page on a tablet has no 5000-wide problem at 8192", async () => {
    const ok = await device({ target: gamePage(scene({ ratio: "Math.min(window.devicePixelRatio, 2)" }), { "index.html": META }), profile: "phone", seconds: 1, wait: 800 });
    expect(ok.canvas).toMatchObject({ cssWidth: 390, pixelRatio: 2, width: 780 });
    expect(ok.findings).toEqual([]);
    expect(ok.ok).toBe(true);
    expect(ok.frames).toBeGreaterThan(0);
    const tablet = await device({ target: gamePage(scene({ ratio: "Math.min(window.devicePixelRatio, 2)", big: true }), { "index.html": META }), profile: "tablet", seconds: 1, wait: 800 });
    expect(tablet.findings.filter((f) => f.kind.startsWith("texture"))).toEqual([]);
  });

  it("the CPU slow-down makes the script time per frame longer", async () => {
    const dir = gamePage(scene({ ratio: "1", busyMs: 0 }).replace("renderer.setAnimationLoop(() => {", "renderer.setAnimationLoop(() => {\n  let x = 0; for (let i = 0; i < 200000; i++) x += Math.sqrt(i + x % 7);"));
    writeFileSync(join(dir, "fast.json"), JSON.stringify({ extends: "low-end-laptop", cpuThrottle: 1 }));
    const fast = await device({ target: dir, profile: join(dir, "fast.json"), seconds: 1.5, wait: 500 });
    const slow = await device({ target: dir, profile: "low-end-laptop", seconds: 1.5, wait: 500 });
    // compare the ratio, not absolute times (SwiftShader, shared CI machines)
    expect(slow.script.p50).toBeGreaterThan(fast.script.p50 * 1.5);
  });
});

const still = (mode: "loop" | "demand" | "demand-handled") => `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x335577);
const c = document.createElement('canvas'); c.width = c.height = 64;
const g = c.getContext('2d'); g.fillStyle = '#e04020'; g.fillRect(0, 0, 64, 64);
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) })));
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 10);
camera.position.z = 2.5;
const render = () => renderer.render(scene, camera);
${mode === "loop" ? "renderer.setAnimationLoop(render);" : "render();\nwindow.addEventListener('pointermove', render);"}
${mode === "demand-handled" ? "renderer.domElement.addEventListener('webglcontextrestored', render);" : ""}
`;

describe.skipIf(!have)("three_device lose_context (needs Chromium)", () => {
  const run = async (mode: "loop" | "demand" | "demand-handled") => {
    const dir = gamePage(still(mode), { "index.html": META, "quick.json": JSON.stringify({ extends: "low-end-laptop", cpuThrottle: 1, width: 400, height: 300 }) });
    return device({ target: dir, profile: join(dir, "quick.json"), seconds: 0.5, wait: 600, loseContext: true });
  };

  it("three brings an animated scene back by itself", async () => {
    const r = await run("loop");
    expect(r.contextLoss).toMatchObject({ lost: true, restored: true, blankAfter: false, still: true, recovered: true });
    expect(r.contextLoss!.drawsAfter).toBeGreaterThan(0);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(formatDevice(r)).toContain("context loss: lost and restored");
  });

  it("an on-demand page without a handler stays blank; with a webglcontextrestored handler it comes back", async () => {
    const bad = await run("demand");
    expect(bad.contextLoss).toMatchObject({ lost: true, restored: true, drawsAfter: 0, blankAfter: true, recovered: false });
    expect(bad.ok).toBe(false);
    expect(bad.findings.find((f) => f.kind === "context-loss")?.message).toMatch(/nothing was drawn and the canvas is blank/);
    const good = await run("demand-handled");
    expect(good.contextLoss).toMatchObject({ lost: true, restored: true, blankAfter: false, recovered: true });
    expect(good.contextLoss!.changed).toBeLessThanOrEqual(0.01);
    expect(good.ok).toBe(true);
  });
});
