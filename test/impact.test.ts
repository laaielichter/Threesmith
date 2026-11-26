import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { formatImpact, impact, ImpactError } from "../src/impact/impact.js";
import { createServer } from "../src/mcp/server.js";
import { project } from "./helpers.js";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
const put = (dir: string, file: string, text: string) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};

function repo(): string {
  const dir = project({
    "package.json": JSON.stringify({ dependencies: { three: "^0.187.0" } }),
    "index.html": '<!doctype html><script type="module" src="/src/main.js"></script>',
    "editor.html": '<!doctype html><script type="module" src="/src/editor.js"></script>',
    "src/main.js": "import { start } from './scene.js';\nstart();\n",
    "src/editor.js": "import * as THREE from 'three';\nconsole.log(THREE.REVISION);\n",
    "src/scene.js":
      "import * as THREE from 'three';\nimport frag from './shaders/glow.frag?raw';\nexport function start() {\n  const renderer = new THREE.WebGLRenderer();\n  renderer.toneMapping = THREE.NoToneMapping;\n  const m = new THREE.ShaderMaterial({ fragmentShader: frag });\n  new THREE.TextureLoader().load('/textures/wood.png');\n}\n",
    "src/shaders/glow.frag": "void main() { gl_FragColor = vec4(1.0); }\n",
    "public/textures/wood.png": "png",
    ".threesmith/scenarios/opens.json": JSON.stringify({ name: "opens", steps: [], watch: [], expect: ["scene.children.length >= 0"] }),
    ".threesmith/scenarios/editor.json": JSON.stringify({ name: "editor", entry: "editor.html", steps: [], watch: [], expect: ["scene.children.length >= 0"] }),
  });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("impact", () => {
  it("says nothing changed on a clean tree", () => {
    expect(formatImpact(impact(repo()))).toBe("No changes against HEAD.");
  });

  it("follows a changed file to the pages and scenarios that run it, and names what it touches", () => {
    const dir = repo();
    put(dir, "src/scene.js", "import * as THREE from 'three';\nimport frag from './shaders/glow.frag?raw';\nexport function start() {\n  const renderer = new THREE.WebGLRenderer();\n  renderer.toneMapping = THREE.ACESFilmicToneMapping;\n  const m = new THREE.ShaderMaterial({ fragmentShader: frag });\n  new THREE.TextureLoader().load('/textures/wood.png');\n}\n");
    const r = impact(dir);
    expect(r.changed.map((c) => [c.file, c.status, c.added, c.removed])).toEqual([["src/scene.js", "changed", 1, 1]]);
    expect(r.changed[0]!.areas).toContain("picture");
    expect(r.dependents).toEqual(["src/main.js"]);
    expect(r.pages).toEqual(["index.html"]);
    expect(r.scenarios).toEqual(["opens"]);
    const text = formatImpact(r);
    expect(text).toContain("the whole picture");
    expect(text).toMatch(/1\. three_review with files: \["src\/scene\.js"\]/);
    expect(text).toContain('three_scenario op run for: opens');
    expect(text).toContain('three_check target "."');
  });

  it("follows shaders imported with ?raw and assets loaded by path, and counts new files", () => {
    const dir = repo();
    put(dir, "src/shaders/glow.frag", "void main() { gl_FragColor = vec4(0.5); }\n");
    put(dir, "public/textures/wood.png", "png2");
    put(dir, "src/new.js", "export const camera = new THREE.PerspectiveCamera(50);\n");
    const r = impact(dir);
    const by = Object.fromEntries(r.changed.map((c) => [c.file, c]));
    expect(by["src/shaders/glow.frag"]!.areas).toContain("shaders");
    expect(by["public/textures/wood.png"]!.areas).toContain("assets");
    expect(by["src/new.js"]!.status).toBe("added");
    expect(by["src/new.js"]!.areas).toContain("camera");
    expect(r.pages).toEqual(["index.html"]);
    expect(r.next.join("\n")).toContain("three_assets");
  });

  it("treats a three version bump as touching every page", () => {
    const dir = repo();
    put(dir, "package.json", JSON.stringify({ dependencies: { three: "^0.188.0" } }));
    const r = impact(dir);
    expect(r.changed[0]!.areas).toEqual(expect.arrayContaining(["three-version", "build"]));
    expect(r.pages).toEqual(["editor.html", "index.html"]);
    expect(r.scenarios.sort()).toEqual(["editor", "opens"]);
    expect(r.next.join("\n")).toContain("three_compare");
  });

  it("compares with another ref and takes a list of files without git", () => {
    const dir = repo();
    put(dir, "src/editor.js", "import * as THREE from 'three';\nwindow.addEventListener('pointerdown', () => {});\n");
    git(dir, "commit", "-qam", "edit");
    expect(impact(dir).changed).toEqual([]);
    expect(impact(dir, { base: "HEAD~1" }).pages).toEqual(["editor.html"]);
    expect(() => impact(dir, { base: "nope" })).toThrow(ImpactError);
    rmSync(join(dir, ".git"), { recursive: true, force: true });
    expect(() => impact(dir)).toThrow(/not in a git repository/);
    const r = impact(dir, { files: ["src/editor.js"] });
    expect(r.changed[0]!.areas).toContain("input");
    expect(r.scenarios).toEqual(["editor"]);
  });

  it("runs as an MCP tool", async () => {
    const dir = repo();
    put(dir, "src/editor.js", "import * as THREE from 'three';\nconst g = new THREE.BoxBufferGeometry();\n");
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({ root: dir }).connect(b);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(a);
    const r = await c.callTool({ name: "three_impact", arguments: {} });
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toContain("editor.html");
  });
});
