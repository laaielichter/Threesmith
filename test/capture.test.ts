import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { capture, contactSheet, formatCapture } from "../src/check/capture.js";
import { decodePng } from "../src/check/png.js";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();
const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const SCENE = (body: string) => `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer(); renderer.setSize(160, 120); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202020);
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100); camera.position.z = 4;
const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()); scene.add(box);
let frame = 0;
renderer.setAnimationLoop((t) => { frame++; ${body} renderer.render(scene, camera); });
`;

describe("capture", () => {
  it("puts pictures side by side on a contact sheet", () => {
    const img = { width: 10, height: 5, data: new Uint8Array(200).fill(9) };
    const s = contactSheet([img, img, img, img, img], 10);
    expect([s.width, s.height]).toEqual([4 * 10 + 3 * 2, 2 * 5 + 2]);
  });

  it.skipIf(!have)("records frames 1/fps apart, with motion, pops and a still scene", async () => {
    const r = await capture({ target: gamePage(SCENE("box.rotation.y = t / 500; if (frame === 25) { const p = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), new THREE.MeshBasicMaterial({ color: 0xffffff })); p.position.z = 1; scene.add(p); }")), fps: 20, seconds: 2, wait: 100, sheet: 8 });
    expect(r.frames).toBe(40);
    expect(r.still).toBe(false);
    expect(r.motion.slice(0, 5).every((m) => m > 0)).toBe(true);
    expect(r.pops.length).toBeGreaterThan(0);
    expect(decodePng(r.sheet!).width).toBe(4 * 160 + 3 * 2);
    expect(existsSync(`${r.dir}/frame-0040.png`)).toBe(true);
    expect(formatCapture(r)).toMatch(/frame \d+: \d+% of the picture changes at once/);
    const again = await capture({ target: gamePage(SCENE("box.rotation.y = t / 500;")), fps: 20, seconds: 0.5, wait: 100 });
    const third = await capture({ target: gamePage(SCENE("box.rotation.y = t / 500;")), fps: 20, seconds: 0.5, wait: 100 });
    expect(again.motion).toEqual(third.motion);
    const still = await capture({ target: gamePage(SCENE("")), fps: 10, seconds: 0.5, wait: 100 });
    expect(still.still).toBe(true);
    expect(formatCapture(still)).toContain("Nothing moves");
  }, 120_000);

  it.skipIf(!have || !ffmpeg)("encodes an .mp4 with ffmpeg", async () => {
    const r = await capture({ target: gamePage(SCENE("box.rotation.y = t / 500;")), fps: 10, seconds: 0.6, wait: 50, video: true });
    expect(r.video && existsSync(r.video)).toBe(true);
  }, 60_000);
});
