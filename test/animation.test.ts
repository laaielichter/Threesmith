import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { diagnoseMixers, fileAnimations, formatFileAnimations, formatMixers, formatSweep, mixers, playClip, sweep } from "../src/check/animation.js";
import { startSession, stopSession } from "../src/session/session.js";
import { box, editGlbJson, writeGlb } from "./model-helpers.js";
import { gamePage } from "./run-helpers.js";

const have = !!findChromium();

describe("animation in a file", () => {
  it("lists clips with length, paths, nodes and channels without a node", () => {
    const file = editGlbJson(writeGlb({ meshes: [box()], nodes: [{ name: "hero", mesh: 0 }] }), (j) => {
      const n = j.accessors.length;
      j.accessors.push({ componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1.5] });
      j.animations = [
        { name: "Bob", samplers: [{ input: n, output: n, interpolation: "LINEAR" }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }, { sampler: 0, target: { node: 7, path: "rotation" } }] },
      ];
    });
    const a = fileAnimations(file);
    expect(a.clips).toEqual([{ name: "Bob", duration: 1.5, channels: 2, paths: { translation: 1, rotation: 1 }, nodes: ["hero"], missing: 1 }]);
    expect(formatFileAnimations(a)).toContain('"Bob": 1.5s, 2 channel(s) (translation 1, rotation 1) on 1 node(s), 1 channel(s) without a node');
  });

  it("says what is wrong with mixers from their numbers", () => {
    const action = { clip: "Walk", duration: 1, running: true, enabled: true, paused: false, weight: 1, timeScale: 1, time: 0, loop: "repeat", repetitions: Infinity };
    expect(diagnoseMixers({ mixers: [], skinned: 2 })[0]).toMatch(/bind pose/);
    expect(diagnoseMixers({ mixers: [{ root: "hero", time: 0, moved: 0, timeScale: 1, actions: [action], unbound: [], unboundCount: 0 }], skinned: 0 })[0]).toMatch(/did not move/);
    expect(diagnoseMixers({ mixers: [{ root: "hero", time: 1, moved: 0.1, timeScale: 1, actions: [{ ...action, running: false }], unbound: [], unboundCount: 0 }], skinned: 0 })[0]).toMatch(/No clip runs/);
    expect(diagnoseMixers({ mixers: [{ root: "hero", time: 1, moved: 0.1, timeScale: 1, actions: [{ ...action, weight: 0 }], unbound: ["ghost.position"], unboundCount: 1 }], skinned: 0 }).join("\n")).toMatch(/weight 0[\s\S]*drive no node \(ghost\.position\)/);
  });
});

const SCENE = (update: string) => `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer(); renderer.setSize(200, 150); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100); camera.position.z = 5;
const hero = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); hero.name = 'hero'; scene.add(hero);
const hand = new THREE.Object3D(); hand.name = 'hand'; hand.position.x = 0.5; hero.add(hand);
const bob = new THREE.AnimationClip('Bob', 2, [new THREE.VectorKeyframeTrack('.position', [0, 1, 2], [0, 0, 0, 0, 1, 0, 0, 0, 0])]);
const spin = new THREE.AnimationClip('Spin', 1, [new THREE.NumberKeyframeTrack('.rotation[y]', [0, 1], [0, 6.28]), new THREE.VectorKeyframeTrack('ghost.position', [0, 1], [0, 0, 0, 1, 1, 1])]);
const mixer = new THREE.AnimationMixer(hero);
mixer.clipAction(bob).play();
mixer.clipAction(spin);
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => { ${update} renderer.render(scene, camera); });
`;

describe.skipIf(!have)("animation in the page (needs Chromium)", () => {
  it("finds every mixer, plays, poses and sweeps a clip", async () => {
    await startSession({ target: gamePage(SCENE("mixer.update(clock.getDelta());")), wait: 600 }, "anim-a");
    try {
      const m = await mixers("anim-a");
      expect(m.mixers).toHaveLength(1);
      expect(m.mixers[0]!.root).toBe("hero");
      expect(m.mixers[0]!.moved).toBeGreaterThan(0);
      expect(m.mixers[0]!.actions.map((a) => [a.clip, a.running])).toEqual([["Bob", true], ["Spin", false]]);
      // clipAction(spin) binds its tracks at once: 'ghost' is not under hero
      expect(m.problems).toEqual([expect.stringMatching(/1 track\(s\) on hero drive no node \(ghost\.position\)/)]);
      expect(formatMixers(m)).toContain('"Bob" 2s: running');

      expect(await playClip("anim-a", "Spin", { fade: 0.2 })).toBe('playing "Spin" on hero (fading 0.2s)');
      const after = await mixers("anim-a");
      expect(after.problems.join("\n")).toMatch(/drive no node \(ghost\.position\)/);
      await expect(playClip("anim-a", "Dance")).rejects.toThrow(/no action for clip "Dance"; the page has: Bob, Spin/);

      const pose = await sweep("anim-a", "Bob", { at: 1, nodes: ["hand"] });
      expect(pose.samples).toEqual([{ t: 1, lowest: 0.5, nodes: { hand: [0.5, 1, 0] } }]);

      const s = await sweep("anim-a", "Bob", { steps: 5 });
      expect(s.samples.map((x) => x.t)).toEqual([0, 0.5, 1, 1.5, 2]);
      expect(s.problems.join("\n")).toMatch(/below the ground \(y 0\) at 0s/);
      expect(formatSweep(s)).toContain("t 1s: lowest y 0.5");
      expect((await sweep("anim-a", "Bob", { steps: 3, ground: -0.5 })).problems.filter((p) => /ground/.test(p))).toEqual([]);
    } finally {
      await stopSession("anim-a");
    }
  }, 90_000);

  it("catches a mixer that is never updated", async () => {
    await startSession({ target: gamePage(SCENE("")), wait: 400 }, "anim-b");
    try {
      const m = await mixers("anim-b");
      expect(m.problems.join("\n")).toMatch(/did not move over 5 frames: mixer\.update\(delta\) is not called/);
    } finally {
      await stopSession("anim-b");
    }
  }, 60_000);
});
