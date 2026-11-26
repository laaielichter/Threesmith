import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChromium } from "../src/check/browser.js";
import { check } from "../src/check/check.js";
import { decoderWrites, decodersBroken, formatDecoders, planDecoders, statementEnd } from "../src/decoders/decoders.js";
import { undoJournal, writeFiles } from "../src/project/journal.js";
import { boxGlb, importMapProject, MAIN } from "./gltf-helpers.js";
import { project, THREE_DIR } from "./helpers.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { triage } from "../src/doctor/triage.js";

async function client(readOnly = false): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ readOnly }).connect(b);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(a);
  return c;
}
const textOf = (r: unknown): string => (r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "";

const have = !!findChromium();
describe("three_decoders plan", () => {
  it("finds what each model needs and plans copies from the installed three plus the code patch", async () => {
    const dir = await importMapProject();
    const plan = planDecoders({ path: dir, three: THREE_DIR });
    expect(plan.serveDir).toBe(".");
    expect(plan.urlBase).toBe("./");
    expect(plan.states.map((s) => [s.id, s.status, s.required])).toEqual([
      ["draco", "not-set-up", true],
      ["ktx2", "not-set-up", true],
      ["meshopt", "not-set-up", true],
    ]);
    expect(decodersBroken(plan)).toBe(true);
    expect(plan.copies.map((c) => c.to).sort()).toEqual(["basis/basis_transcoder.js", "basis/basis_transcoder.wasm", "draco/draco_decoder.js", "draco/draco_decoder.wasm", "draco/draco_wasm_wrapper.js"]);
    // the glTF-only Draco build of the installed three
    expect(plan.copies.find((c) => c.to === "draco/draco_decoder.wasm")!.from).toBe(join(THREE_DIR, "examples/jsm/libs/draco/gltf/draco_decoder.wasm"));
    const main = plan.patches.find((p) => p.file === "main.js")!.data;
    expect(main).toContain("import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';");
    expect(main).toContain("import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';");
    expect(main).toContain("import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';");
    expect(main).toContain("gltfLoader.setDRACOLoader(new DRACOLoader().setDecoderPath('./draco/'));");
    expect(main).toContain("gltfLoader.setKTX2Loader(new KTX2Loader().setTranscoderPath('./basis/').detectSupport(renderer));");
    expect(main).toContain("gltfLoader.setMeshoptDecoder(MeshoptDecoder);");
    // right after the GLTFLoader statement, in the planned order, before the first load
    expect(main).toContain("const gltfLoader = new GLTFLoader();\ngltfLoader.setDRACOLoader(new DRACOLoader().setDecoderPath('./draco/'));\ngltfLoader.setKTX2Loader(");
    // the setup comes before the first load
    expect(main.indexOf("setDRACOLoader")).toBeLessThan(main.indexOf("loadAsync"));
    expect(formatDecoders(plan)).toMatch(/write: true would:\n {2}copy node_modules\/three\/examples\/jsm\/libs\/draco\/gltf\/draco_decoder\.js -> draco\/draco_decoder\.js \(\d+ KB\)/);
  });

  it("checks served decoder files by hash against the installed three", async () => {
    const dir = await importMapProject(MAIN.replace("const gltfLoader = new GLTFLoader();", "const gltfLoader = new GLTFLoader();\nconst ktx2 = new KTX2Loader().setTranscoderPath('./basis/').detectSupport(renderer);\ngltfLoader.setKTX2Loader(ktx2);\ngltfLoader.setDRACOLoader(new DRACOLoader().setDecoderPath('./draco/'));").replace("import { GLTFLoader }", "import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';\nimport { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';\nimport { GLTFLoader }"));
    mkdirSync(join(dir, "basis"), { recursive: true });
    mkdirSync(join(dir, "draco"), { recursive: true });
    const libs = join(THREE_DIR, "examples/jsm/libs");
    // the full Draco build counts as a match too; the transcoder is from "another release" (changed bytes)
    for (const f of ["draco_decoder.wasm", "draco_wasm_wrapper.js"]) cpSync(join(libs, "draco", f), join(dir, "draco", f));
    cpSync(join(libs, "basis/basis_transcoder.js"), join(dir, "basis/basis_transcoder.js"));
    const wasm = readFileSync(join(libs, "basis/basis_transcoder.wasm"));
    wasm.writeUInt8(wasm.readUInt8(wasm.length - 1) ^ 0xff, wasm.length - 1);
    writeFileSync(join(dir, "basis/basis_transcoder.wasm"), wasm);
    const plan = planDecoders({ path: dir, three: THREE_DIR });
    const draco = plan.states.find((s) => s.id === "draco")!;
    const ktx2 = plan.states.find((s) => s.id === "ktx2")!;
    expect([draco.source, draco.status, draco.folder]).toEqual(["local", "ok", "draco"]);
    expect([ktx2.source, ktx2.status]).toEqual(["local", "stale"]);
    expect(ktx2.files).toEqual([
      { file: "basis/basis_transcoder.js", status: "match" },
      { file: "basis/basis_transcoder.wasm", status: "differs" },
    ]);
    expect(ktx2.message).toMatch(/must match KTX2Loader's release/);
    expect(plan.copies.map((c) => c.to)).toEqual(["basis/basis_transcoder.js", "basis/basis_transcoder.wasm"]);
    // a missing folder
    const gone = planDecoders({ path: dir, three: THREE_DIR, model: "models/box.glb" });
    expect(gone.states.map((s) => s.id)).toEqual(["draco", "ktx2"]);
  });

  it("pins a CDN transcoder to the installed three, and rewrites an assigned setter into a call", () => {
    const dir = project({
      "package.json": `{"name":"cdn","private":true}`,
      "index.html": `<script type="module" src="./main.js"></script>`,
      "main.js": `import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
const renderer = new THREE.WebGLRenderer();
const ktx2 = new KTX2Loader().setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.150.0/examples/jsm/libs/basis/').detectSupport(renderer);
const loader = new GLTFLoader();
loader.setKTX2Loader = ktx2;
`,
    });
    const plan = planDecoders({ path: dir, three: THREE_DIR });
    const k = plan.states.find((s) => s.id === "ktx2")!;
    expect([k.source, k.status, k.version]).toEqual(["cdn", "mismatch", { found: "0.150.0", installed: "0.187.0" }]);
    const main = plan.patches[0]!.data;
    expect(main).toContain("three@0.187.0/examples/jsm/libs/basis/");
    expect(main).toContain("loader.setKTX2Loader(ktx2);");
    expect(main).not.toContain("setKTX2Loader =");
    expect(plan.copies).toEqual([]);
  });

  it("serves from public/ with a bundler and sets an explicit path on a loader that relies on three's folder", () => {
    const dir = project({
      "package.json": `{"name":"vite-app","private":true,"devDependencies":{"vite":"^7.0.0","three":"^0.187.0"}}`,
      "index.html": `<script type="module" src="/src/main.ts"></script>`,
      "src/main.ts": `import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
const draco = new DRACOLoader();
export const loader = new GLTFLoader().setDRACOLoader(draco);
`,
    });
    const plan = planDecoders({ path: dir, three: THREE_DIR });
    expect([plan.bundler, plan.serveDir, plan.urlBase]).toEqual(["vite", "public", "/"]);
    const d = plan.states[0]!;
    expect([d.id, d.source, d.status]).toEqual(["draco", "default", "check"]);
    expect(plan.copies.map((c) => c.to).sort()).toEqual(["public/draco/draco_decoder.js", "public/draco/draco_decoder.wasm", "public/draco/draco_wasm_wrapper.js"]);
    expect(plan.patches[0]!.data).toContain("const draco = new DRACOLoader().setDecoderPath('/draco/');");
    expect(plan.notes.join(" ")).toMatch(/public\/ is served at \//);
  });

  it("uses drei's useGLTF.setDecoderPath for React Three Fiber, and gives KTX2 as hand work", async () => {
    const dir = project({
      "package.json": `{"name":"r3f-app","private":true,"dependencies":{"@react-three/fiber":"^9.0.0","@react-three/drei":"^10.0.0","three":"^0.187.0"},"devDependencies":{"vite":"^7.0.0"}}`,
      "src/Model.jsx": `import { useGLTF } from '@react-three/drei';
import { Canvas } from '@react-three/fiber';
export function Model() {
  const { scene } = useGLTF('/box.glb');
  return <primitive object={scene} />;
}
`,
    });
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "box.glb"), await boxGlb({ draco: true, ktx2: true }));
    const plan = planDecoders({ path: dir, three: THREE_DIR });
    expect(plan.framework).toBe("r3f");
    expect(plan.states.map((s) => [s.id, s.source, s.status])).toEqual([
      ["draco", "drei", "check"],
      ["ktx2", "none", "not-set-up"],
    ]);
    expect(plan.patches[0]!.data).toContain("import { useGLTF } from '@react-three/drei';\n\nuseGLTF.setDecoderPath('/draco/');");
    expect(plan.todo.map((t) => t.code ?? "").join("\n")).toContain("useGLTF(url, true, true, (loader) => loader.setKTX2Loader(ktx2))");
    expect(plan.copies.map((c) => c.to)).toContain("public/basis/basis_transcoder.wasm");
  });

  it("sets KTX2 up after await renderer.init() with WebGPURenderer, and leaves it as hand work without it", async () => {
    const main = (init: boolean) => `import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const loader = new GLTFLoader();
const $renderer = new THREE.WebGPURenderer();
${init ? "await $renderer.init();\n" : ""}const gltf = await loader.loadAsync('./box.glb');
`;
    const glb = await boxGlb({ ktx2: true });
    for (const init of [true, false]) {
      const dir = project({ "package.json": "{}", "index.html": `<script type="module" src="./main.js"></script>`, "main.js": main(init) });
      writeFileSync(join(dir, "box.glb"), glb);
      const plan = planDecoders({ path: dir, three: THREE_DIR });
      if (init) expect(plan.patches[0]!.data).toContain("await $renderer.init();\nloader.setKTX2Loader(new KTX2Loader().setTranscoderPath('./basis/').detectSupport($renderer));\nconst gltf");
      else {
        expect(plan.patches).toEqual([]);
        expect(plan.todo[0]!.message).toContain("await $renderer.init() first");
      }
    }
  });

  it("finds the end of a chained statement", () => {
    const t = "const a = new X()\n  .b(1)\n  .c(');');\nnext();";
    expect(t.slice(0, statementEnd(t, 10))).toBe("const a = new X()\n  .b(1)\n  .c(');');");
  });
});

describe("three_decoders over MCP and in the doctor", () => {
  it("dry-runs, refuses write on a read-only server, and writes one undoable step", async () => {
    const dir = await importMapProject();
    const ro = await client(true);
    const refused = await ro.callTool({ name: "three_decoders", arguments: { path: dir, write: true, three: THREE_DIR } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("read-only session");
    const c = await client();
    const dry = await c.callTool({ name: "three_decoders", arguments: { path: dir, three: THREE_DIR } });
    expect(dry.isError).toBe(true);
    expect(textOf(dry)).toContain("write: true would:");
    expect(existsSync(join(dir, "draco"))).toBe(false);
    const w = await c.callTool({ name: "three_decoders", arguments: { path: dir, write: true, three: THREE_DIR } });
    expect(w.isError).toBeFalsy();
    expect(textOf(w)).toMatch(/Written \(journal \d+; three_undo takes it back\)/);
    expect(existsSync(join(dir, "draco", "draco_decoder.wasm"))).toBe(true);
    const undo = await c.callTool({ name: "three_undo", arguments: { path: dir } });
    expect(textOf(undo)).toContain("main.js");
    expect(existsSync(join(dir, "draco", "draco_decoder.wasm"))).toBe(false);
  });

  it("three_doctor points to three_decoders when a decoder is missing", async () => {
    const dir = await importMapProject();
    expect(triage(dir, { three: THREE_DIR }).next.join("\n")).toContain("three_decoders");
    const clean = project({ "package.json": "{}", "main.js": "import * as THREE from 'three';\nconst s = new THREE.Scene();\n" });
    expect(triage(clean, { three: THREE_DIR }).next.join("\n")).not.toContain("three_decoders");
  });
});

describe.skipIf(!have)("three_decoders end to end (needs Chromium)", () => {
  it("fails before, passes after write with the installed three's decoders, and undo restores the project", async () => {
    const dir = await importMapProject();
    const before = await check({ target: dir, wait: 1500 });
    expect(before.ok).toBe(false);
    expect(before.issues.map((i) => i.message).join("\n")).toMatch(/No DRACOLoader instance provided|setKTX2Loader must be called|setMeshoptDecoder must be called/);

    const plan = planDecoders({ path: dir, three: THREE_DIR });
    const original = readFileSync(join(dir, "main.js"), "utf8");
    const id = writeFiles(dir, "three_decoders", "decoders", decoderWrites(plan));
    expect(id).toBeGreaterThan(0);

    const after = await check({ target: dir, wait: 5000, inspect: true });
    expect(after.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(after.ok).toBe(true);
    expect(after.scene?.counts.meshes).toBe(2);
    expect(after.scene?.renderer?.textures).toBeGreaterThanOrEqual(1);

    // the served files now hash-match the installed three, and nothing is left to do
    const again = planDecoders({ path: dir, three: THREE_DIR });
    expect(again.states.map((s) => s.status)).toEqual(["ok", "ok", "ok"]);
    expect(again.copies).toEqual([]);
    expect(again.patches).toEqual([]);

    const undo = undoJournal(dir);
    expect(undo.undone[0]!.restored).toEqual(["main.js"]);
    expect(readFileSync(join(dir, "main.js"), "utf8")).toBe(original);
    expect(existsSync(join(dir, "draco", "draco_decoder.wasm"))).toBe(false);
    expect(existsSync(join(dir, "basis", "basis_transcoder.wasm"))).toBe(false);
  });
});
