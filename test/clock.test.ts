import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { check } from "../src/check/check.js";
import { CLOCK_EPOCH, clockSettings, framesFor } from "../src/check/clock.js";
import { play } from "../src/check/play.js";
import { parseScenario, scenarioJson } from "../src/check/scenario.js";
import { decodePng } from "../src/check/png.js";
import { diff } from "../src/check/diff.js";
import { readFileSync } from "node:fs";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();

// Motion from the clock and colours from Math.random: a real-time run never draws the same frame twice.
const SCENE = `
import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 240);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
camera.position.z = 5;
scene.add(new THREE.AmbientLight(0xffffff, 1), new THREE.DirectionalLight(0xffffff, 2));
const boxes = [];
for (let i = 0; i < 12; i++) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial({ color: new THREE.Color(Math.random(), Math.random(), Math.random()) }));
  m.position.set(Math.random() * 6 - 3, Math.random() * 4 - 2, 0);
  m.name = 'box' + i;
  scene.add(m); boxes.push(m);
}
const timer = new THREE.Timer();
window.app = { started: Date.now(), frames: 0 };
renderer.setAnimationLoop((t) => {
  timer.update(t);
  window.app.frames++;
  for (const b of boxes) b.rotation.y = timer.getElapsed() * 2 + b.position.x;
  boxes[0].position.y = Math.sin(performance.now() / 300);
  renderer.render(scene, camera);
});
`;

describe("clock settings", () => {
  it("defaults, checks and converts waits to frames", () => {
    expect(clockSettings({})).toBeUndefined();
    expect(clockSettings({ seed: 7 })).toEqual({ seed: 7, fixedDt: 1000 / 60 });
    expect(clockSettings({ fixedDt: 10 })).toEqual({ seed: 1, fixedDt: 10 });
    expect(() => clockSettings({ seed: 1.5 })).toThrow(/seed must be a whole number/);
    expect(() => clockSettings({ seed: Number("abc") })).toThrow(/seed/);
    expect(() => clockSettings({ fixedDt: 0 })).toThrow(/fixed_dt/);
    expect(() => clockSettings({ fixedDt: Number.NaN })).toThrow(/fixed_dt/);
    expect(framesFor(500, 1000 / 60)).toBe(30);
    expect(framesFor(1, 16)).toBe(1);
  });
  it("keeps seed and fixedDt in a scenario", () => {
    const s = parseScenario({ name: "x", steps: [], expect: ["1 @ end"], seed: 3, fixedDt: 20 }, "x");
    expect(s.seed).toBe(3);
    expect(scenarioJson(s)).toMatchObject({ seed: 3, fixedDt: 20 });
  });
});

describe.skipIf(!have)("deterministic clock (needs Chromium)", () => {
  const run = (dir: string, seed?: number) =>
    play({
      target: dir,
      wait: 300,
      ...(seed !== undefined ? { seed } : {}),
      steps: [{ type: "frames", n: 20 }, { type: "wait", ms: 250 }, { type: "press", key: "a" }, { type: "until", js: "app.frames >= 60" }],
      watch: ["$('box0').position.y", "$('box3').rotation.y", "app.frames", "Math.random()"],
      expect: ["app.frames >= 60 @ end", `app.started === ${CLOCK_EPOCH} @ end`],
    });

  it("gives the same watched values, frames and pixels on every run with a seed", async () => {
    const dir = gamePage(SCENE);
    const a = await run(dir, 42);
    const shotA = readFileSync(a.screenshot!);
    const b = await run(dir, 42);
    const shotB = readFileSync(b.screenshot!);
    expect(a.ok, JSON.stringify(a.claims)).toBe(true);
    expect(b.watch).toEqual(a.watch);
    expect(b.steps.map((s) => [s.t, s.frame])).toEqual(a.steps.map((s) => [s.t, s.frame]));
    expect(b.stats.frames).toBe(a.stats.frames);
    // 300 ms + 20 frames + 250 ms at 60 fps: 18 + 20 + 15 frames before the key press, then until frame 60
    expect(a.steps.map((s) => s.frame)).toEqual([0, 21, 37, 38]);
    expect(diff(decodePng(shotA), decodePng(shotB), { threshold: 0 }).ratio).toBe(0);
    const other = await run(dir, 43);
    expect(other.watch.find((w) => w.js === "Math.random()")!.end).not.toEqual(a.watch.find((w) => w.js === "Math.random()")!.end);
  }, 120_000);

  it("makes check screenshots identical too, and real time does not", async () => {
    const dir = gamePage(SCENE);
    const shot = async (seed?: number) => decodePng(readFileSync((await check({ target: dir, wait: 400, ...(seed !== undefined ? { seed } : {}) })).screenshot!));
    const a = await shot(5);
    const b = await shot(5);
    expect(diff(a, b, { threshold: 0 }).ratio).toBe(0);
    const r1 = await shot();
    const r2 = await shot();
    expect(diff(r1, r2, { threshold: 0 }).ratio).toBeGreaterThan(0);
  }, 120_000);
});
