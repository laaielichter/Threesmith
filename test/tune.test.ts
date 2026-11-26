import { cpSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { createServer } from "../src/mcp/server.js";
import { codeFor, formatSave, planSave, tuneSet, tweaksOf, type Tweak } from "../src/tune/tune.js";
import { startSession, stopSession } from "../src/session/session.js";
import { project, THREE_DIR } from "./helpers.js";

const have = !!findChromium();

const MAIN = `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 240);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#000000');
const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
camera.position.set(0, 0, 5);
const sun = new THREE.DirectionalLight(0xffffff, 1);
sun.name = 'sun';
scene.add(sun);
const lamp = new THREE.PointLight(0xffaa00, 2);
lamp.name = 'lamp';
lamp.intensity = 3;
scene.add(lamp);
const mat = new THREE.MeshStandardMaterial({ color: 0xff0000, roughness: 0.5 });
const crate = new THREE.Mesh(new THREE.BoxGeometry(), mat);
crate.name = 'crate';
crate.position.set(0, 1, 0);
scene.add(crate);
const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
ball.name = 'ball';
scene.add(ball);
renderer.setAnimationLoop(() => renderer.render(scene, camera));
`;

const tw = (object: string, prop: string, kind: Tweak["kind"], value: unknown): Tweak => ({ object, prop, kind, value, original: null });

describe("tune: back to the source", () => {
  it("writes values in the style of the code", () => {
    expect(codeFor({ kind: "color", value: "#ff8800" }, "0xffffff")).toBe("0xff8800");
    expect(codeFor({ kind: "color", value: "#ff8800" }, "'#000000'")).toBe("'#ff8800'");
    expect(codeFor({ kind: "vector", value: [1, 2.123456, 0] })).toBe("1, 2.1235, 0");
    expect(codeFor({ kind: "number", value: 0.30000000004 })).toBe("0.3");
  });

  it("finds each place a value is set: constructor, assignment, set(), material option, or a new line", () => {
    const dir = project({ "package.json": "{}", "main.js": MAIN });
    const plan = planSave(dir, [
      tw("sun", "intensity", "number", 2.5),
      tw("sun", "color", "color", "#ffeedd"),
      tw("lamp", "intensity", "number", 4),
      tw("camera", "fov", "number", 45),
      tw("crate", "position", "vector", [1, 2, 3]),
      tw("crate", "material.roughness", "number", 0.2),
      tw("crate", "material.metalness", "number", 0.8),
      tw("ball", "material.color", "color", "#0000ff"),
      tw("ball", "material.roughness", "number", 0.9),
      tw("scene", "background", "color", "#112233"),
      tw("renderer", "toneMappingExposure", "number", 1.4),
      tw("ghost", "visible", "boolean", false),
    ]);
    const hows = Object.fromEntries(plan.edits.map((e) => [`${e.tweak.object}.${e.tweak.prop}`, e.how]));
    expect(hows).toEqual({
      "sun.intensity": "constructor",
      "sun.color": "constructor",
      "lamp.intensity": "assignment",
      "camera.fov": "constructor",
      "crate.position": "setter",
      "crate.material.roughness": "option",
      "crate.material.metalness": "option",
      "ball.material.color": "option",
      "ball.material.roughness": "option",
      "scene.background": "assignment",
      "renderer.toneMappingExposure": "insert",
    });
    expect(plan.missing.map((m) => m.tweak.object)).toEqual(["ghost"]);
    const code = plan.files[0]!.data;
    expect(code).toContain("new THREE.DirectionalLight(0xffeedd, 2.5)");
    expect(code).toContain("lamp.intensity = 4;");
    expect(code).toContain("new THREE.PointLight(0xffaa00, 2)");
    expect(code).toContain("new THREE.PerspectiveCamera(45, 4 / 3, 0.1, 100)");
    expect(code).toContain("crate.position.set(1, 2, 3)");
    expect(code).toContain("{ metalness: 0.8, color: 0xff0000, roughness: 0.2 }");
    expect(code).toContain("new THREE.MeshStandardMaterial({ roughness: 0.9, color: 0x0000ff })");
    expect(code).toContain("new THREE.Color('#112233')");
    expect(code).toContain("const renderer = new THREE.WebGLRenderer();\nrenderer.toneMappingExposure = 1.4;\nrenderer.setSize");
    const text = formatSave(plan, undefined);
    expect(text).toContain("main.js:9 constructor: 1 → 2.5  (sun.intensity)");
    expect(text).toContain('not saved: ghost.visible: the code never names an object "ghost"');
    expect(text).toContain("Dry run");
  });
});

function page(): string {
  const dir = project({
    "package.json": "{}",
    "index.html": `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js"}}</script><script type="module" src="./main.js"></script></body></html>`,
    "main.js": MAIN,
  });
  mkdirSync(join(dir, "three"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  symlinkSync(THREE_DIR, join(dir, "node_modules", "three"), "dir");
  cpSync(join(THREE_DIR, "build", "three.module.js"), join(dir, "three", "three.module.js"));
  cpSync(join(THREE_DIR, "build", "three.core.js"), join(dir, "three", "three.core.js"));
  return dir;
}

describe.skipIf(!have)("tune in the page (needs Chromium)", () => {
  it("changes values live and refuses what it cannot set", async () => {
    await startSession({ target: page(), wait: 500 }, "tune-a");
    try {
      const r = await tuneSet("tune-a", "sun", "intensity", 3);
      expect([r.before, r.after]).toEqual([1, 3]);
      const c = await tuneSet("tune-a", "crate", "material.color", "#00ff00");
      expect(c.kind).toBe("color");
      expect([c.before, c.after]).toEqual(["#ff0000", "#00ff00"]);
      const p = await tuneSet("tune-a", "camera", "fov", 40);
      expect(p.after).toBe(40);
      await tuneSet("tune-a", "sun", "intensity", 4);
      expect(tweaksOf("tune-a").map((t) => [t.object, t.prop, t.original, t.value])).toEqual([
        ["sun", "intensity", 1, 4],
        ["crate", "material.color", "#ff0000", "#00ff00"],
        ["camera", "fov", 60, 40],
      ]);
      await expect(tuneSet("tune-a", "nobody", "visible", false)).rejects.toThrow(/no object named "nobody"/);
      await expect(tuneSet("tune-a", "crate", "position", 3)).rejects.toThrow(/is a vector/);
    } finally {
      await stopSession("tune-a");
    }
  }, 90_000);

  it("saves the tweaks into the code through MCP, undoably", async () => {
    const dir = page();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({ root: dir }).connect(b);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(a);
    const txt = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
    await c.callTool({ name: "three_session", arguments: { op: "start", target: ".", name: "tune-b", wait: 500 } });
    try {
      expect(txt(await c.callTool({ name: "three_tune", arguments: { op: "set", name: "tune-b", object: "sun", prop: "intensity", value: 2.5 } }))).toContain("sun.intensity: 1 → 2.5");
      expect(txt(await c.callTool({ name: "three_tune", arguments: { op: "save", name: "tune-b" } }))).toContain("Dry run");
      expect(readFileSync(join(dir, "main.js"), "utf8")).toContain("DirectionalLight(0xffffff, 1)");
      expect(txt(await c.callTool({ name: "three_tune", arguments: { op: "save", name: "tune-b", write: true } }))).toMatch(/journal entry #\d+/);
      expect(readFileSync(join(dir, "main.js"), "utf8")).toContain("DirectionalLight(0xffffff, 2.5)");
      expect(txt(await c.callTool({ name: "three_tune", arguments: { op: "list", name: "tune-b" } }))).toContain("No tweaks");
      await c.callTool({ name: "three_undo", arguments: {} });
      expect(readFileSync(join(dir, "main.js"), "utf8")).toContain("DirectionalLight(0xffffff, 1)");
    } finally {
      await stopSession("tune-b");
    }
  }, 90_000);
});
