import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { annotator, apiNames, compare, compareCaptures, formatCompare, type Annotator, type Capture } from "../src/compare/compare.js";
import { publishedVersions } from "../src/compare/releases.js";
import { project, THREE_DIR } from "./helpers.js";
import { fakeRelease, gamePage } from "./run-helpers.js";

const have = !!findChromium();

const PBR = `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 240);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 320 / 240, 0.1, 100);
camera.position.set(0, 2, 5); camera.lookAt(0, 0, 0);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 1 }));
floor.name = 'Floor'; floor.rotation.x = -Math.PI / 2; scene.add(floor);
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.6, 32, 16), new THREE.MeshStandardMaterial({ color: 0xcc4422, metalness: 0.5, roughness: 0.4 }));
ball.name = 'Ball'; ball.position.y = 0.6; scene.add(ball);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(2, 4, 3); scene.add(sun);
renderer.setAnimationLoop((t) => { ball.rotation.y = t / 1000; renderer.render(scene, camera); });
`;
const CLOCK = `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 240);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 320 / 240, 0.1, 100);
camera.position.z = 4;
const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial());
box.name = 'Box'; scene.add(box);
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => { box.rotation.y += clock.getDelta(); renderer.render(scene, camera); });
`;
/** A stand-in for r188 whose AmbientLight is twice as bright: a change in the look that r188's notes explain. */
const brighterAmbient = () => fakeRelease("188", [[/(class AmbientLight extends Light \{[\s\S]*?super\( color, intensity \);)/, "$1 this.intensity *= 2;"]]);

const cap = (o: Partial<Capture>): Capture => ({ version: "0.187.0", release: 187, source: "path", revision: "187", swapped: ["build/three.module.js"], loaded: true, info: { calls: 2, triangles: 10, programs: 1, geometries: 2, textures: 0 }, objects: [], objectCount: 0, warnings: [], errors: [], ...o });
const none: Annotator = { forMessage: () => [], inCode: () => [] };

describe("compare by meaning", () => {
  it("reads API names from migration titles", () => {
    expect(apiNames("Clock is deprecated")).toContain("Clock");
    expect(apiNames("FileLoader.load() and ImageBitmapLoader.load() return nothing")).toEqual(expect.arrayContaining(["FileLoader", "ImageBitmapLoader", "load"]));
    expect(apiNames("Use Timer: timer.update( timestamp ) in the loop")).not.toContain("Use");
  });

  it("names lost objects, new errors and info deltas; without an entry they are unexplained", () => {
    const a = cap({ objects: [{ path: "Scene", type: "Scene", visible: true }, { path: "Scene > car", type: "Mesh", visible: true, size: [1, 1, 1], center: [0, 0, 0] }] });
    const b = cap({ release: 188, version: "0.188.0", objects: [{ path: "Scene", type: "Scene", visible: true }], errors: ["page-error: x is not a function"], info: { calls: 1, triangles: 0, programs: 1, geometries: 1, textures: 0 } });
    const r = compareCaptures(a, b, none, {});
    expect(r.changes.map((c) => [c.kind, c.unexplained])).toEqual([["error-new", true], ["object-lost", true], ["info", false]]);
    expect(r.changes[2]!.message).toBe("renderer.info r187 → r188: calls 2 → 1 (-1), triangles 10 → 0 (-10), geometries 2 → 1 (-1)");
    expect(compareCaptures(a, a, none, {}).changes).toEqual([]);
  });

  it("marks the entries this code uses, and ignores a copy of three inside the project", () => {
    const dir = gamePage(PBR);
    const ann = annotator(dir, 187, 188);
    expect(ann.inCode(["appearance"]).map((e) => e.id)).toEqual(["ambient-hemisphere-specular"]);
    expect(ann.forMessage("THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.")).toEqual([]);
    const clock = annotator(project({ "main.js": "import * as THREE from 'three';\nconst c = new THREE.Clock();\n" }), 182, 183);
    expect(clock.forMessage("THREE.THREE.Clock: This module has been deprecated. Please use THREE.Timer instead.").map((e) => [e.release, e.id])).toEqual([[183, "clock-deprecated"]]);
  });
});

describe.skipIf(!have)("three_compare (needs Chromium)", () => {
  it("gives the same capture twice on one release: the clock is deterministic", async () => {
    const r = await compare({ target: gamePage(PBR), base: THREE_DIR, with: THREE_DIR });
    expect([r.verdict, r.ok, r.pixels.ratio, r.problems]).toEqual(["same", true, 0, []]);
  });

  it("measures a brighter look per object and explains it with r188's ambient specular note", async () => {
    const r = await compare({ target: gamePage(PBR), base: THREE_DIR, with: brighterAmbient() });
    expect([r.base.revision, r.target.revision]).toEqual(["187", "188"]);
    expect(r.verdict).toBe("explained");
    expect(r.changes.some((c) => c.kind === "object-lost" || c.kind.startsWith("error"))).toBe(false);
    const floor = r.changes.find((c) => c.kind === "region" && c.message.startsWith("Scene > Floor"));
    expect(floor?.message).toMatch(/^Scene > Floor: \+\d+(\.\d)?% luminance/);
    expect(floor?.explainedBy.map((e) => [e.release, e.id, e.inCode])).toEqual([[188, "ambient-hemisphere-specular", true]]);
    expect(formatCompare(r)).toContain("expected: r188 AmbientLight and HemisphereLight add specular reflections to PBR materials (in this code)");
  });

  it("flags a change no migration note explains as a probable regression", async () => {
    const wider = fakeRelease("999", [[/(class BoxGeometry extends BufferGeometry \{[\s\S]*?super\(\);)/, "$1 width *= 1.5;"]]);
    const r = await compare({ target: gamePage(CLOCK), base: THREE_DIR, with: wider });
    expect([r.verdict, r.ok]).toEqual(["changed", false]);
    expect(r.changes.find((c) => c.kind === "object-bounds")).toMatchObject({ unexplained: true });
    expect(formatCompare(r)).toContain("no migration entry explains this: probable regression");
  });

  it("puts the comparison and the impact in the ci receipt", async () => {
    const { ci } = await import("../src/ci.js");
    const dir = gamePage(PBR);
    const r = await ci({ path: dir, three: THREE_DIR, failOn: "none", scenarios: false, check: { target: dir, wait: 300 }, compare: brighterAmbient(), impact: "HEAD" });
    expect(r.compare?.verdict).toBe("explained");
    expect(r.markdown).toContain("### Three release compare");
    expect(r.markdown).toContain("every change is explained by a migration note");
    expect(r.markdown).toMatch(/✔ Scene > Floor: .*r188: AmbientLight and HemisphereLight add specular/);
    expect(r.markdown).toContain("### What the change touches (against `HEAD`)");
    expect(r.markdown).toMatch(/Not worked out: .*not in a git repository|No changes against HEAD/);
    const none = await ci({ path: dir, three: THREE_DIR, failOn: "none", scenarios: false, compare: "previous" });
    expect(none.reasons).toContain("compare needs check (the page to run on both releases)");
  });

  it("says when the page loads no three it can swap", async () => {
    const r = await compare({ target: project({ "index.html": "<!doctype html><canvas></canvas>" }), base: THREE_DIR, with: THREE_DIR });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/loaded no three build file Threesmith could swap/);
  });
});

let online = false;
try {
  online = !(await publishedVersions()).offline;
} catch {
  online = false;
}
describe.skipIf(!have || !online)("three_compare on real releases (needs Chromium and the registry once)", () => {
  it("r182 → r183: the new Clock deprecation warning, explained by r183's clock-deprecated entry", async () => {
    const r = await compare({ target: gamePage(CLOCK), base: "r182", with: "r183" });
    expect([r.base.revision, r.target.revision]).toEqual(["182", "183"]);
    const w = r.changes.find((c) => c.kind === "warning-new");
    expect(w?.message).toMatch(/Clock: This module has been deprecated/);
    expect(w?.explainedBy[0]).toMatchObject({ release: 183, id: "clock-deprecated", inCode: true });
    expect(r.verdict).toBe("explained");
  }, 240_000);
});
