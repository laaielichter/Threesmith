import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/mcp/server.js";
import { findChromium } from "../src/check/browser.js";
import { bisect, formatBisect, rangeReleases } from "../src/compare/bisect.js";
import { publishedVersions } from "../src/compare/releases.js";
import { project } from "./helpers.js";
import { fakeRelease, gamePage } from "./run-helpers.js";

const have = !!findChromium();

const BOX = `import * as THREE from 'three';
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
// r184 made FileLoader.load() return nothing, also for a cached file (three.js PR 33380)
const CACHED = `import * as THREE from 'three';
THREE.Cache.enabled = true;
const loader = new THREE.FileLoader();
loader.load('./data.txt', () => { window.second = loader.load('./data.txt'); window.done = true; });
`;
const wider = (rev: string) => fakeRelease(rev, [[/(class BoxGeometry extends BufferGeometry \{[\s\S]*?super\(\);)/, "$1 width *= 1.5;"]]);

describe("bisect ranges", () => {
  it("takes a list of folders, sorted by release, and needs two", async () => {
    const dir = project({});
    const list = await rangeReleases([fakeRelease("903"), fakeRelease("901")].join(","), dir);
    expect(list.map((r) => r.release)).toEqual([901, 903]);
    await expect(rangeReleases(fakeRelease("901"), dir)).rejects.toThrow(/at least two releases/);
    await expect(rangeReleases("r182..", dir)).rejects.toThrow(/needs a range such as r182..r185/);
  });
});

describe.skipIf(!have)("three_compare bisect (needs Chromium)", () => {
  it("halves to the first release where the page changes, with the unexplained change", async () => {
    const range = [fakeRelease("901"), fakeRelease("902"), wider("903"), wider("904"), wider("905")].join(",");
    const r = await bisect({ target: gamePage(BOX), range });
    expect([r.lastGood, r.firstBad]).toEqual(["0.902.0", "0.903.0"]);
    expect(r.probes.length).toBeLessThan(5);
    expect(r.changes.find((c) => c.kind === "object-bounds")).toMatchObject({ unexplained: true });
    expect(formatBisect(r)).toContain("first changed release: r903 (0.903.0)");
  });

  it("runs over MCP: three_compare with bisect, and a clear error without with or bisect", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({}).connect(b);
    const c = new Client({ name: "test", version: "0" });
    await c.connect(a);
    const target = gamePage(BOX);
    const text = (r: unknown) => (r as { content: { text?: string }[] }).content[0]?.text ?? "";
    const r = await c.callTool({ name: "three_compare", arguments: { target, bisect: [fakeRelease("901"), wider("902"), wider("903")].join(",") } });
    expect(text(r)).toContain("first changed release: r902 (0.902.0)");
    const none = await c.callTool({ name: "three_compare", arguments: { target } });
    expect([none.isError, text(none)]).toEqual([true, expect.stringContaining("three_compare needs `with`")]);
    await c.close();
  });

  it("says when nothing changes in the range", async () => {
    const r = await bisect({ target: gamePage(BOX), range: [fakeRelease("901"), fakeRelease("902")].join(",") });
    expect([r.ok, r.firstBad, r.message]).toEqual([true, undefined, "no change from 0.901.0 to 0.902.0."]);
  });
});

let online = false;
try {
  online = !(await publishedVersions()).offline;
} catch {
  online = false;
}
describe.skipIf(!have || !online)("bisect on real releases (needs Chromium and the registry once)", () => {
  it("names r184 as the first release where FileLoader.load() stops returning the cached file", async () => {
    const r = await bisect({ target: gamePage(CACHED, { "data.txt": "hello" }), range: "r182..r185", steps: [{ type: "until", js: "window.done === true", timeout: 5000 }], expect: ["window.second === 'hello' @ end"] });
    expect(r.mode).toBe("claims");
    expect([r.lastGood, r.firstBad].map((v) => v?.split(".")[1])).toEqual(["183", "184"]);
    expect(r.probes.find((p) => p.release === 184)?.bad).toBe(true);
  }, 300_000);

  it("names r183 as the first release that changes the Clock page (its deprecation warning)", async () => {
    const r = await bisect({ target: gamePage(BOX), range: "r182..r185" });
    expect(r.firstBad?.split(".")[1]).toBe("183");
    expect(r.changes.find((c) => c.kind === "warning-new")?.explainedBy[0]).toMatchObject({ release: 183, id: "clock-deprecated" });
  }, 300_000);
});
