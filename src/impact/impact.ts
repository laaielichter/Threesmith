import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, posix, relative, resolve, sep } from "node:path";
import { loadScenarios } from "../check/scenario.js";
import { collect, readLimited } from "../review/source.js";

/**
 * The whole change, before it is run: which files changed (against git, or a list), what each change touches in a
 * three.js scene (the picture as a whole, lights, camera, materials and shaders, assets, the loop, disposal, input,
 * the three version), which pages run the changed code (through the import graph, transitively), which kept
 * scenarios and baselines cover those pages, and the shortest list of checks that proves the change. Read-only.
 */

export type Area = "picture" | "lights" | "camera" | "materials" | "shaders" | "assets" | "loop" | "dispose" | "input" | "postfx" | "three-version" | "build";

const AREA_LABEL: Record<Area, string> = {
  picture: "the whole picture (colour space, tone mapping, pixel ratio, shadows, environment, fog)",
  lights: "lights and shadows",
  camera: "camera and controls",
  materials: "materials",
  shaders: "shaders (GLSL or TSL)",
  assets: "models, textures and loaders",
  loop: "the animation loop and timing",
  dispose: "disposal and memory",
  input: "input and picking",
  postfx: "post-processing",
  "three-version": "the three version",
  build: "the build",
};

/** Patterns on changed lines that say what a change touches. Order: most global first. */
const AREA_PATTERNS: [Area, RegExp][] = [
  ["three-version", /"three"\s*:|"@types\/three"\s*:|three@\d|\/three\/build\//],
  ["picture", /\b(?:toneMapping(?:Exposure)?|outputColorSpace|outputEncoding|colorSpace|setPixelRatio|shadowMap|useLegacyLights|physicallyCorrectLights|environment(?:Intensity|Rotation)?|backgroundIntensity|background\s*=|\.fog\b|Fog(?:Exp2)?\b|PMREMGenerator|RoomEnvironment|setClearColor)\b/],
  ["postfx", /\b(?:EffectComposer|RenderPass|UnrealBloomPass|OutputPass|ShaderPass|addPass|PostProcessing|pass\(|EffectComposer)\b/],
  ["shaders", /\b(?:ShaderMaterial|RawShaderMaterial|onBeforeCompile|ShaderChunk|uniforms|gl_FragColor|gl_Position|vertexShader|fragmentShader|Fn\(|NodeMaterial|colorNode|positionNode|wgslFn|glslFn)\b/],
  ["materials", /\b(?:Mesh(?:Basic|Standard|Physical|Lambert|Phong|Toon|Matcap|Normal|Depth)Material|LineBasicMaterial|PointsMaterial|SpriteMaterial|\.(?:transparent|opacity|side|depthWrite|depthTest|blending|metalness|roughness|emissive(?:Intensity)?|envMapIntensity|wireframe|flatShading|vertexColors|needsUpdate)\b)/],
  ["lights", /\b(?:(?:Ambient|Directional|Point|Spot|Hemisphere|RectArea)Light|LightProbe|\.intensity|castShadow|receiveShadow|\.shadow\.)\b/],
  ["camera", /\b(?:(?:Perspective|Orthographic|Cube|Array)Camera|\.fov\b|\.near\b|\.far\b|\.aspect\b|\.zoom\b|updateProjectionMatrix|lookAt|(?:Orbit|Map|Trackball|Fly|FirstPerson|PointerLock|Transform|Arcball|Drag)Controls)\b/],
  ["assets", /\b(?:GLTFLoader|DRACOLoader|KTX2Loader|MeshoptDecoder|TextureLoader|RGBELoader|HDRLoader|EXRLoader|FBXLoader|OBJLoader|useGLTF|useTexture|\.load(?:Async)?\(|setDecoderPath|setTranscoderPath)\b|\.(?:glb|gltf|ktx2|hdr|exr|png|jpe?g|webp|avif)\b/],
  ["loop", /\b(?:setAnimationLoop|requestAnimationFrame|useFrame|Clock\b|Timer\b|getDelta|getElapsedTime|AnimationMixer|mixer\.update|\.update\()/],
  ["dispose", /\b(?:dispose\(|removeFromParent|\.remove\(|forceContextLoss|renderLists)\b/],
  ["input", /\b(?:addEventListener|Raycaster|setFromCamera|intersectObjects?|pointer(?:down|move|up)|onPointer\w+|onClick)\b/],
];

const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const ASSET_EXT = /\.(?:glb|gltf|bin|ktx2|basis|hdr|exr|png|jpe?g|webp|avif|mp3|ogg|wav|mp4|webm|json)$/i;
const SHADER_EXT = /\.(?:glsl|vert|frag|vs|fs|wgsl)$/i;
const BUILD_FILE = /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|vite\.config\.\w+|next\.config\.\w+|webpack\.config\.\w+|tsconfig(?:\.\w+)?\.json|rollup\.config\.\w+)$/;

export interface ChangedFile {
  file: string;
  status: "changed" | "added" | "deleted";
  /** Lines added and removed (0 when the change came from a list, not git). */
  added: number;
  removed: number;
  areas: Area[];
}

export interface ImpactResult {
  root: string;
  /** What the change was measured against: a git ref, the working tree or a list. */
  base: string;
  changed: ChangedFile[];
  /** Every area touched, with the changed files that touch it. */
  areas: { area: Area; files: string[] }[];
  /** Code files that import a changed file (directly or through others), not changed themselves. */
  dependents: string[];
  /** Pages (HTML) that run changed code or load a changed asset. */
  pages: string[];
  /** Kept scenarios whose page is affected. */
  scenarios: string[];
  /** Kept baselines (.threesmith/baselines) that may now differ. */
  baselines: string[];
  /** The checks that prove the change, in order. */
  next: string[];
  notes: string[];
}

export class ImpactError extends Error {}

export interface ImpactOptions {
  /** git ref to compare with (default: HEAD, so the uncommitted work incl. new files). */
  base?: string;
  /** Changed files (relative to the project) instead of git. */
  files?: string[];
}

const posixRel = (root: string, full: string): string => relative(root, full).split(sep).join("/");

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
}

/** Changed files with their changed lines, from git. Paths relative to `root`. */
function fromGit(root: string, base: string): { file: string; status: ChangedFile["status"]; lines: string[]; added: number; removed: number }[] {
  let top: string;
  try {
    top = git(root, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new ImpactError(`${root} is not in a git repository; pass files: [...] with the changed files.`);
  }
  try {
    git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  } catch {
    throw new ImpactError(`no commit "${base}" in this repository; use a branch, tag or commit (default HEAD).`);
  }
  const out = new Map<string, { file: string; status: ChangedFile["status"]; lines: string[]; added: number; removed: number }>();
  const inRoot = (p: string) => {
    const full = resolve(top, p);
    const r = posixRel(root, full);
    return r.startsWith("..") ? undefined : r;
  };
  for (const line of git(root, ["diff", "--name-status", "--no-renames", base, "--", "."]).split("\n")) {
    const [st, p] = line.split("\t");
    if (!st || !p) continue;
    const file = inRoot(p);
    if (!file) continue;
    out.set(file, { file, status: st.startsWith("A") ? "added" : st.startsWith("D") ? "deleted" : "changed", lines: [], added: 0, removed: 0 });
  }
  // ls-files prints paths relative to the folder it runs in (the project), diff relative to the repository
  for (const p of git(root, ["ls-files", "--others", "--exclude-standard", "--", "."]).split("\n")) {
    if (!p.trim()) continue;
    const file = posixRel(root, resolve(root, p));
    if (!file.startsWith("..") && !out.has(file)) out.set(file, { file, status: "added", lines: [], added: 0, removed: 0 });
  }
  // changed lines per file (text files only; new files are read whole)
  let current: string | undefined;
  for (const line of git(root, ["diff", "-U0", "--no-color", "--no-renames", base, "--", "."]).split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      current = p === "/dev/null" ? undefined : inRoot(p);
      continue;
    }
    if (line.startsWith("--- ")) {
      if (!current) {
        const p = line.slice(4).replace(/^a\//, "");
        if (p !== "/dev/null") current = inRoot(p);
      }
      continue;
    }
    if (line.startsWith("diff --git")) {
      current = undefined;
      continue;
    }
    const e = current ? out.get(current) : undefined;
    if (!e) continue;
    if (line.startsWith("+")) {
      e.added++;
      e.lines.push(line.slice(1));
    } else if (line.startsWith("-")) {
      e.removed++;
      e.lines.push(line.slice(1));
    }
  }
  for (const e of out.values()) {
    if (e.status !== "added" || e.lines.length) continue;
    const text = readLimited(join(root, e.file));
    if (text !== undefined && !text.includes("\u0000")) {
      e.lines = text.split("\n");
      e.added = e.lines.length;
    }
  }
  return [...out.values()];
}

function areasOf(file: string, lines: string[]): Area[] {
  const found = new Set<Area>();
  if (ASSET_EXT.test(file) && !/package(?:-lock)?\.json$|tsconfig/.test(file)) found.add("assets");
  if (SHADER_EXT.test(file)) found.add("shaders");
  if (BUILD_FILE.test(file)) found.add("build");
  const text = lines.join("\n");
  for (const [area, re] of AREA_PATTERNS) if (re.test(text)) found.add(area);
  if (/package(?:-lock)?\.json$/.test(file) && !/"three"\s*:|"@types\/three"\s*:/.test(text)) found.delete("three-version");
  return [...found];
}

/** Relative imports of a file: `import x from './a'`, `import('./b')`, `require('./c')`, `new URL('./d', import.meta.url)`, `<script src>`. */
function importsOf(raw: string): string[] {
  const out: string[] = [];
  const re = /\b(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url|<script[^>]*\ssrc=["']([^"']+)["']/g;
  for (const m of raw.matchAll(re)) {
    const spec = m.slice(1).find(Boolean);
    if (spec && /^(?:\.{1,2}\/|\/)/.test(spec)) out.push(spec.replace(/[?#].*$/, ""));
  }
  return out;
}

/** The file a relative import means, or undefined (packages, URLs, files that are not there). */
function resolveImport(root: string, from: string, spec: string): string | undefined {
  const base = spec.startsWith("/") ? (existsSync(join(root, spec)) || !existsSync(join(root, "public", spec)) ? join(root, spec) : join(root, "public", spec)) : resolve(root, dirname(from), spec);
  const tries = [base, ...CODE_EXT.map((e) => base + e), ...CODE_EXT.map((e) => join(base, `index${e}`))];
  // TypeScript code imports './a.js' for './a.ts'
  if (/\.[cm]?js$/.test(base)) tries.push(base.replace(/\.([cm]?)js$/, ".$1ts"), base.replace(/\.js$/, ".tsx"));
  for (const t of tries) {
    try {
      if (statSync(t).isFile()) {
        const r = posixRel(root, t);
        return r.startsWith("..") ? undefined : r;
      }
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Files the project could import (code, shaders, html), walked with the review's skip list. */
function projectFiles(root: string): string[] {
  const files = new Set(collect(root).files.map((f) => f.path));
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || ["node_modules", "dist", "build", "coverage", "out", "vendor"].includes(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (SHADER_EXT.test(e.name)) files.add(posixRel(root, full));
    }
  };
  walk(root, 0);
  return [...files];
}

export function impact(rootDir: string, options: ImpactOptions = {}): ImpactResult {
  const root = resolve(rootDir);
  const base = options.files ? "the files given" : (options.base ?? "HEAD");
  const raw = options.files
    ? options.files.map((f) => {
        const file = posixRel(root, resolve(root, f));
        if (file.startsWith("..")) throw new ImpactError(`${f} is outside the project ${root}.`);
        const exists = existsSync(join(root, file));
        const text = exists ? readLimited(join(root, file)) : undefined;
        const lines = text !== undefined && !text.includes("\u0000") ? text.split("\n") : [];
        return { file, status: (exists ? "changed" : "deleted") as ChangedFile["status"], lines, added: 0, removed: 0 };
      })
    : fromGit(root, options.base ?? "HEAD");

  const changed: ChangedFile[] = raw
    .filter((c) => !c.file.startsWith(".threesmith/journal/"))
    .map((c) => ({ file: c.file, status: c.status, added: c.added, removed: c.removed, areas: areasOf(c.file, c.lines) }))
    .sort((a, b) => a.file.localeCompare(b.file));
  const changedSet = new Set(changed.map((c) => c.file));

  // import graph, reversed: file -> files that import it
  const files = projectFiles(root);
  const importers = new Map<string, Set<string>>();
  const assetUsers = new Map<string, Set<string>>();
  for (const f of files) {
    const text = readLimited(join(root, f));
    if (text === undefined) continue;
    for (const spec of importsOf(text)) {
      const target = resolveImport(root, f, spec);
      if (!target) continue;
      (importers.get(target) ?? importers.set(target, new Set()).get(target)!).add(f);
    }
    // asset paths written as strings: './models/car.glb', '/textures/a.png'
    for (const m of text.matchAll(/['"`]((?:\.{0,2}\/)?[\w./@-]+\.(?:glb|gltf|ktx2|hdr|exr|png|jpe?g|webp|avif|bin))['"`]/gi)) {
      const ref = m[1]!;
      for (const cand of [resolve(root, dirname(f), ref), join(root, ref), join(root, "public", ref)]) {
        if (!existsSync(cand)) continue;
        const r = posixRel(root, cand);
        if (r.startsWith("..")) continue;
        (assetUsers.get(r) ?? assetUsers.set(r, new Set()).get(r)!).add(f);
        break;
      }
    }
  }

  // everything that runs a changed file, transitively
  const reached = new Set<string>();
  const queue: string[] = [];
  for (const c of changed) {
    queue.push(c.file);
    for (const u of assetUsers.get(c.file) ?? []) queue.push(u);
  }
  while (queue.length) {
    const f = queue.shift()!;
    if (reached.has(f)) continue;
    reached.add(f);
    for (const imp of importers.get(f) ?? []) if (!reached.has(imp)) queue.push(imp);
  }
  const htmlFiles = files.filter((f) => /\.html?$/.test(f));
  const pages = htmlFiles.filter((p) => reached.has(p)).sort();
  const buildOrVersion = changed.some((c) => c.areas.includes("three-version") || c.areas.includes("build"));
  if (buildOrVersion) for (const p of htmlFiles) if (!pages.includes(p)) pages.push(p);
  pages.sort();
  const dependents = [...reached].filter((f) => !changedSet.has(f) && !/\.html?$/.test(f)).sort();

  // scenarios: their page folder (target + entry) is one of the affected pages
  const scenarios: string[] = [];
  let scenarioError: string | undefined;
  try {
    for (const { scenario: s } of loadScenarios(root)) {
      if (s.target && /^https?:/.test(s.target)) {
        if (pages.length || changed.length) scenarios.push(s.name); // a dev server serves the whole project
        continue;
      }
      const page = posix.normalize(posix.join(s.target ?? ".", s.entry ?? "index.html"));
      if (pages.includes(page) || (!htmlFiles.length && changed.some((c) => c.areas.length))) scenarios.push(s.name);
    }
  } catch (e) {
    scenarioError = (e as Error).message;
  }
  const baselineDir = join(root, ".threesmith", "baselines");
  const baselines = pages.length && existsSync(baselineDir) ? readdirSync(baselineDir).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, "")).sort() : [];

  const areaMap = new Map<Area, string[]>();
  for (const c of changed) for (const a of c.areas) (areaMap.get(a) ?? areaMap.set(a, []).get(a)!).push(c.file);
  const order = Object.keys(AREA_LABEL) as Area[];
  const areas = [...areaMap.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([area, f]) => ({ area, files: f }));
  const has = (a: Area) => areaMap.has(a);

  const notes: string[] = [];
  if (scenarioError) notes.push(`scenarios not read: ${scenarioError}`);
  if (has("picture")) notes.push("A renderer or scene-wide setting changed: every page and every baseline can look different, not only the files you touched.");
  if (has("three-version")) notes.push("The three version changed: run three_compare with the old release to see what changed in the page, explained per migration note.");
  if (changed.some((c) => c.status === "deleted" && ASSET_EXT.test(c.file))) notes.push("An asset was deleted: three_assets lists the code that still loads it.");

  const next: string[] = [];
  const code = changed.filter((c) => c.status !== "deleted" && (CODE_EXT.includes(extname(c.file)) || /\.html?$/.test(c.file)));
  if (code.length) next.push(`three_review with files: [${code.slice(0, 8).map((c) => `"${c.file}"`).join(", ")}${code.length > 8 ? ", ..." : ""}] and only_new: true`);
  if (has("three-version")) next.push("three_compare with: previous (or the release you came from) on each page below");
  if (has("assets") || changed.some((c) => ASSET_EXT.test(c.file))) next.push("three_assets (paths, capitals, decoders)");
  if (has("assets") && changed.some((c) => /\.(?:glb|gltf)$/.test(c.file))) next.push("three_model_inspect on each changed model (loaders and decoders it needs)");
  if (has("shaders") || has("postfx")) next.push("three_check on each page below: shader compile errors come back at your file and line");
  if (scenarios.length) next.push(`three_scenario op run for: ${scenarios.slice(0, 10).join(", ")}`);
  for (const p of pages.slice(0, 5)) next.push(`three_check target "${posix.dirname(p) === "." ? "." : posix.dirname(p)}"${posix.basename(p) !== "index.html" ? ` entry "${posix.basename(p)}"` : ""}${baselines.length ? ` with your baseline (${baselines.slice(0, 3).join(", ")})` : ""}`);
  if (has("lights") || has("camera") || has("materials")) next.push("three_inspect when something is not visible after the change");
  if (has("loop")) next.push("three_perf against the last run (frame times and draw calls)");
  if (has("dispose")) next.push("three_leaks with the steps of one cycle");
  if (has("build")) next.push("three_build (copies of three, missing assets, base path)");
  if (!next.length && changed.length) next.push("Nothing in the change touches three.js: the usual tests are enough.");

  return { root, base, changed, areas, dependents, pages, scenarios, baselines, next, notes };
}

export function formatImpact(r: ImpactResult, detail: "brief" | "full" = "brief"): string {
  if (!r.changed.length) return `No changes against ${r.base}.`;
  const cap = detail === "full" ? 500 : 15;
  const out = [`${r.changed.length} changed file(s) against ${r.base}:`];
  for (const c of r.changed.slice(0, cap)) out.push(`  ${c.status === "changed" ? "M" : c.status === "added" ? "A" : "D"} ${c.file}${c.added || c.removed ? ` (+${c.added} -${c.removed})` : ""}${c.areas.length ? `: ${c.areas.join(", ")}` : ""}`);
  if (r.changed.length > cap) out.push(`  +${r.changed.length - cap} more`);
  if (r.areas.length) {
    out.push("Touches:");
    for (const a of r.areas) out.push(`  ${AREA_LABEL[a.area]}: ${a.files.slice(0, 4).join(", ")}${a.files.length > 4 ? ", ..." : ""}`);
  }
  if (r.dependents.length) out.push(`Runs through: ${r.dependents.slice(0, detail === "full" ? 100 : 8).join(", ")}${r.dependents.length > 8 && detail !== "full" ? `, +${r.dependents.length - 8}` : ""}`);
  out.push(`Pages: ${r.pages.length ? r.pages.join(", ") : "none found (a page that loads the code from a dev server or another folder is not seen)"}`);
  if (r.scenarios.length) out.push(`Scenarios: ${r.scenarios.join(", ")}`);
  if (r.baselines.length) out.push(`Baselines that may differ: ${r.baselines.join(", ")}`);
  for (const n of r.notes) out.push(`Note: ${n}`);
  out.push("Next:");
  r.next.forEach((n, i) => out.push(`  ${i + 1}. ${n}`));
  return out.join("\n");
}
