import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { openRunPage } from "../src/check/play.js";
import { fetchRelease, localRelease, obtainRelease, onePerRelease, publishedVersions, releasesHome, resolveVersion, swapPath, versionsBetween } from "../src/compare/releases.js";
import { project, THREE_DIR } from "./helpers.js";
import { fakeRelease, gamePage } from "./run-helpers.js";

const have = !!findChromium();
const VERSIONS = ["0.150.0", "0.150.1", "0.183.0", "0.183.2", "0.184.0", "0.185.0", "0.185.1", "0.186.0-dev", "0.186.0", "0.187.0"];

describe("three releases", () => {
  it("resolves r186, exact versions, next, previous and latest from the published list", () => {
    expect(onePerRelease(VERSIONS)).toEqual(["0.150.1", "0.183.2", "0.184.0", "0.185.1", "0.186.0", "0.187.0"]);
    expect(resolveVersion("r183", VERSIONS)).toBe("0.183.2");
    expect(resolveVersion("185", VERSIONS)).toBe("0.185.1");
    expect(resolveVersion("0.183.0", VERSIONS)).toBe("0.183.0");
    expect(resolveVersion("next", VERSIONS, "0.184.0")).toBe("0.185.1");
    expect(resolveVersion("previous", VERSIONS, "0.184.0")).toBe("0.183.2");
    expect(resolveVersion("latest", VERSIONS)).toBe("0.187.0");
    expect(() => resolveVersion("next", VERSIONS, "0.187.0")).toThrow(/no three release after r187 is published yet/);
    expect(() => resolveVersion("r160", VERSIONS)).toThrow(/r160 is not published/);
    expect(() => resolveVersion("0.186.0-dev", VERSIONS)).toThrow(/not a three release/);
    expect(() => resolveVersion("main", VERSIONS)).toThrow(/not a three release/);
    expect(versionsBetween("r185", "r183", VERSIONS)).toEqual(["0.183.2", "0.184.0", "0.185.1"]);
  });

  it("maps node_modules, CDN and copied build requests into the package, and nothing else", () => {
    expect(swapPath("http://127.0.0.1:1/node_modules/three/build/three.module.js")).toBe("build/three.module.js");
    expect(swapPath("http://127.0.0.1:1/node_modules/three/examples/jsm/controls/OrbitControls.js")).toBe("examples/jsm/controls/OrbitControls.js");
    expect(swapPath("https://unpkg.com/three@0.160.0/build/three.module.js")).toBe("build/three.module.js");
    expect(swapPath("https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js")).toBe("examples/jsm/loaders/GLTFLoader.js");
    expect(swapPath("http://127.0.0.1:1/vendor/three.core.min.js")).toBe("build/three.core.min.js");
    expect(swapPath("http://127.0.0.1:1/main.js")).toBeUndefined();
    expect(swapPath("http://127.0.0.1:1/my-three.module.js.map")).toBeUndefined();
    expect(swapPath("http://127.0.0.1:1/node_modules/three//etc/passwd")).toBeUndefined();
  });

  it("takes a local package folder, or a project with three in node_modules", async () => {
    const fake = fakeRelease("901");
    expect(localRelease(fake)).toMatchObject({ version: "0.901.0", release: 901, source: "path" });
    const proj = project({});
    mkdirSync(join(proj, "node_modules"));
    cpSync(fake, join(proj, "node_modules", "three"), { recursive: true });
    expect((await obtainRelease(join(proj), proj))).toMatchObject({ release: 901, source: "path" });
    await expect(obtainRelease("./nothing/here", proj)).rejects.toThrow(/no three package in/);
    expect((await obtainRelease("installed", process.cwd())).source).toBe("installed");
  });
});

describe.skipIf(!have)("the swap (needs Chromium)", () => {
  const SCRIPT = `import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer();
renderer.setSize(200, 150);
document.body.appendChild(renderer.domElement);
renderer.render(new THREE.Scene(), new THREE.PerspectiveCamera());
window.rev = THREE.REVISION;
`;
  it("serves another release for the page's own three files; without it the page keeps its own", async () => {
    const page = gamePage(SCRIPT);
    const fake = fakeRelease("902");
    for (const [swap, want] of [[fake, "902"], [undefined, (JSON.parse(readFileSync(join(THREE_DIR, "package.json"), "utf8")) as { version: string }).version.split(".")[1]]] as const) {
      const o = await openRunPage({ target: page, ...(swap ? { swapThree: swap } : {}) });
      try {
        expect(await o.page.evaluate("window.rev")).toBe(want);
        expect(o.swapped.sort()).toEqual(swap ? ["build/three.core.js", "build/three.module.js"] : []);
      } finally {
        await o.close();
      }
    }
  });
});

// Needs the npm registry once; the release then stays in the cache (THREESMITH_THREE_CACHE, set in test/setup.ts).
let online = false;
try {
  online = !(await publishedVersions()).offline;
} catch {
  online = false;
}
describe.skipIf(!have || !online)("a release from npm (needs Chromium and the registry once)", () => {
  it("fetches r186 into the cache with only build/ and examples/jsm/, and the page runs it", async () => {
    const r = await fetchRelease("0.186.0");
    expect(r.dir.startsWith(releasesHome())).toBe(true);
    expect(readFileSync(join(r.dir, "build", "three.core.js"), "utf8")).toMatch(/^const REVISION = '186';/m);
    expect((await fetchRelease("0.186.0")).source).toBe("cache");
    const o = await openRunPage({ target: gamePage(SCRIPT_REV), swapThree: r.dir });
    try {
      expect(await o.page.evaluate("window.rev")).toBe("186");
    } finally {
      await o.close();
    }
  }, 180_000);
});
const SCRIPT_REV = `import * as THREE from 'three'; window.rev = THREE.REVISION;`;
