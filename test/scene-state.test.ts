import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { diffSnapshots, formatSceneDiff } from "../src/check/scene-state.js";
import { pageOp, startSession, stopSession } from "../src/session/session.js";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();

describe("scene diff", () => {
  it("lists what was added, removed and changed", () => {
    const e = { type: "Mesh", visible: true, position: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], material: "MeshBasicMaterial #ffffff" };
    const d = diffSnapshots({ "Scene > a": e, "Scene > b": e }, { "Scene > a": { ...e, visible: false, position: [0, 1, 0] }, "Scene > c": e });
    expect(d).toMatchObject({ added: ["Scene > c"], removed: ["Scene > b"], changed: [{ path: "Scene > a", what: ["hidden", "moved [0, 0, 0] → [0, 1, 0]"] }] });
    expect(formatSceneDiff(diffSnapshots({}, {}))).toMatch(/^Nothing changed/);
  });
});

describe.skipIf(!have)("textures and diff in the live page (needs Chromium)", () => {
  it("finds colour-space mistakes, sizes and memory, and what an action changed", async () => {
    await startSession({ target: gamePage(`import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer(); renderer.setSize(160, 120); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100); camera.position.z = 4;
const data = (w, h) => { const t = new THREE.DataTexture(new Uint8Array(w * h * 4).fill(200), w, h); t.needsUpdate = true; return t; };
const albedo = data(64, 64); albedo.name = 'albedo';
const normal = data(32, 32); normal.name = 'normal'; normal.colorSpace = THREE.SRGBColorSpace;
const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: albedo, normalMap: normal })); m.name = 'crate'; scene.add(m);
scene.add(new THREE.AmbientLight());
window.app = { m };
renderer.setAnimationLoop(() => renderer.render(scene, camera));`), wait: 500 }, "ss");
    try {
      const t = await pageOp({ op: "textures" }, "ss");
      expect(t.ok).toBe(false);
      expect(t.text).toContain("albedo [map] 64x64");
      expect(t.text).toMatch(/albedo[\s\S]*colour map read as linear/);
      expect(t.text).toMatch(/normal \[normalMap\][\s\S]*data map \(normalMap\) read as sRGB/);
      expect((await pageOp({ op: "diff" }, "ss")).text).toMatch(/kept a snapshot of \d+ object/);
      await pageOp({ op: "eval", js: "app.m.position.x = 2; app.m.material.color.set(0xff0000); return 1" }, "ss");
      const d = await pageOp({ op: "diff" }, "ss");
      expect(d.text).toContain("~ Scene > crate: moved [0, 0, 0] → [2, 0, 0]; material MeshStandardMaterial #ffffff → MeshStandardMaterial #ff0000");
    } finally {
      await stopSession("ss");
    }
  }, 60_000);
});
