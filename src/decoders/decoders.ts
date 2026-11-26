import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { findThree } from "../api/install.js";
import { collect, lineOf, type SourceFile } from "../review/source.js";
import { gltfExtensionInfo, publicDirOf } from "../scan/assets.js";
import { projectRootOf } from "../scan/scan.js";

/**
 * three_decoders: what a project needs to load Draco, KTX2 (Basis) and meshopt glTF files, and how to wire it up with
 * the decoder files of the INSTALLED three (examples/jsm/libs), so the decoders match the loaders that use them. It
 * reads which models need which decoder (extensionsUsed / extensionsRequired), how the code points each loader at its
 * files (three's default folder, a local folder, a CDN), checks the files that are served against the installed copy
 * by hash, and plans the copies and code changes. Pure: the caller writes `writes` through the journal.
 */

export type DecoderId = "draco" | "ktx2" | "meshopt";
export type Framework = "vanilla" | "r3f";

export interface DecoderFile {
  /** Relative to the project. */
  file: string;
  status: "match" | "differs" | "missing";
}

export interface DecoderState {
  id: DecoderId;
  /** Models that need it (relative paths), and whether one requires it (no fallback). */
  models: string[];
  required: boolean;
  /** How the code gives the loader its files: none (no loader set up), default (three's folder next to the loader), local folder, cdn, inline (meshopt: inside the module), drei (useGLTF's default CDN). */
  source: "none" | "default" | "local" | "cdn" | "inline" | "drei";
  /** The path as written in the code. */
  path?: string;
  where?: string;
  /** The served folder a local path resolves to, relative to the project. */
  folder?: string;
  files: DecoderFile[];
  /** three version named in a CDN path, against the installed one. */
  version?: { found: string; installed: string };
  status: "ok" | "check" | "missing" | "stale" | "mismatch" | "not-set-up";
  message: string;
}

export interface DecoderCopy {
  /** Absolute source in node_modules/three. */
  from: string;
  /** Relative to the project. */
  to: string;
  bytes: number;
}

export interface DecoderPatch {
  /** Relative to the project. */
  file: string;
  data: string;
  changes: string[];
}

export interface DecoderTodo {
  where?: string;
  message: string;
  code?: string;
}

export interface DecoderPlan {
  root: string;
  three?: { version: string; release: number; libs: string };
  framework: Framework;
  bundler: string;
  /** The folder the dev server and the build serve at the URL base, relative to the project ("." for the root). */
  serveDir: string;
  /** How the code refers to that folder: "/" (public/ of a bundler) or "./" (next to the page). */
  urlBase: string;
  states: DecoderState[];
  copies: DecoderCopy[];
  patches: DecoderPatch[];
  todo: DecoderTodo[];
  notes: string[];
}

export interface DecoderOptions {
  path: string;
  /** Only this model (relative to the project or absolute). */
  model?: string;
  /** The folder the server serves at "/" (default: public/ when there is one or a bundler, else the page's folder). */
  publicDir?: string;
  framework?: Framework | "auto";
  three?: string;
}

/** The files each decoder needs, as three ships them in examples/jsm/libs. */
const FILES: Record<"draco" | "ktx2", { dir: string; alt?: string; files: string[]; needed: string[] }> = {
  // draco/gltf/ holds the glTF-only builds (smaller); draco/ the full ones. Either works with DRACOLoader.
  draco: { dir: "draco/gltf", alt: "draco", files: ["draco_decoder.js", "draco_decoder.wasm", "draco_wasm_wrapper.js"], needed: ["draco_decoder.wasm", "draco_wasm_wrapper.js"] },
  ktx2: { dir: "basis", files: ["basis_transcoder.js", "basis_transcoder.wasm"], needed: ["basis_transcoder.js", "basis_transcoder.wasm"] },
};
const FOLDER: Record<"draco" | "ktx2", string> = { draco: "draco", ktx2: "basis" };
const EXT_NEEDS: Record<string, DecoderId> = {
  KHR_draco_mesh_compression: "draco",
  EXT_meshopt_compression: "meshopt",
  KHR_meshopt_compression: "meshopt",
  KHR_texture_basisu: "ktx2",
};
const BUNDLERS = ["vite", "next", "webpack", "parcel", "react-scripts", "astro", "@sveltejs/kit", "nuxt", "esbuild", "rollup"];
const SKIP = new Set(["node_modules", ".git", ".threesmith", "dist", "build", "out", ".next", "coverage"]);
const CDN_THREE = /^(?:https?:)?\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh)\/three@([^/]+)\//;

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const posix = (p: string): string => p.split(sep).join("/");
const read = (p: string): Buffer | undefined => {
  try {
    return readFileSync(p);
  } catch {
    return undefined;
  }
};

function modelsOnDisk(root: string, max = 2000): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max || e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(p);
      } else if (/\.(?:glb|gltf)$/i.test(e.name)) out.push(posix(relative(root, p)));
    }
  };
  walk(root);
  return out.sort();
}

/** The end of the statement that starts before `from`: the `;` or line end at bracket depth 0 (chained `.x()` lines included). */
export function statementEnd(text: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const c = text[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && c === ";") return i + 1;
    else if (depth === 0 && c === "\n" && !/^\s*[.?]/.test(text.slice(i + 1, i + 200))) return i;
  }
  return text.length;
}

const indentAt = (text: string, at: number): string => /^[ \t]*/.exec(text.slice(text.lastIndexOf("\n", at - 1) + 1))?.[0] ?? "";

interface Loc {
  f: SourceFile;
  at: number;
}
const whereOf = (l: Loc): string => `${l.f.path}:${lineOf(l.f.text, l.at)}`;

/** The first string literal passed to `.method(` anywhere in the code. */
function pathCall(files: SourceFile[], method: RegExp): (Loc & { path: string; dynamic: boolean }) | undefined {
  for (const f of files) {
    const m = new RegExp(String.raw`\.${method.source}\s*\(\s*(['"\`])([^'"\`]*)\1`).exec(f.text);
    if (m) return { f, at: m.index, path: m[2] ?? "", dynamic: m[1] === "`" && (m[2] ?? "").includes("${") };
    const any = new RegExp(String.raw`\.${method.source}\s*\(`).exec(f.text);
    if (any) return { f, at: any.index, path: "", dynamic: true };
  }
  return undefined;
}

function firstMatch(files: SourceFile[], re: RegExp): Loc | undefined {
  for (const f of files) {
    const m = re.exec(f.text);
    if (m) return { f, at: m.index };
  }
  return undefined;
}

export function planDecoders(opts: DecoderOptions): DecoderPlan {
  const root = projectRootOf(opts.path);
  const collected = collect(root);
  const files = collected.files;
  const install = findThree(root, opts.three);
  const libs = install ? join(install.root, "examples", "jsm", "libs") : undefined;
  const deps = { ...(collected.packageJson?.dependencies ?? {}), ...(collected.packageJson?.devDependencies ?? {}) };
  const bundler = BUNDLERS.find((b) => b in deps) ?? (["vite.config.js", "vite.config.ts", "vite.config.mjs"].some((c) => existsSync(join(root, c))) ? "vite" : "none");
  const usesDrei = files.some((f) => /\buseGLTF\b/.test(f.text));
  const framework: Framework = opts.framework && opts.framework !== "auto" ? opts.framework : files.some((f) => f.r3f) && usesDrei ? "r3f" : "vanilla";
  const pages = files.filter((f) => /\.html?$/.test(f.path) && /<script[^>]*type=["']module["']/.test(f.raw));
  const pub = opts.publicDir ? posix(relative(root, resolve(root, opts.publicDir))) || "." : publicDirOf(root) ?? (bundler !== "none" ? "public" : undefined);
  const serveDir = pub ?? (pages[0] ? posix(dirname(pages[0].path)) : ".");
  const urlBase = pub ? "/" : "./";
  const notes: string[] = [];
  const todo: DecoderTodo[] = [];

  // which models need which decoder
  const modelList = opts.model ? [posix(relative(root, resolve(root, opts.model)))] : modelsOnDisk(root);
  const need = new Map<DecoderId, { models: string[]; required: boolean }>();
  for (const m of modelList) {
    const info = gltfExtensionInfo(join(root, m));
    if (!info) {
      if (opts.model) throw new Error(`${opts.model} is not a readable .glb or .gltf file`);
      continue;
    }
    for (const e of new Set([...info.used, ...info.required])) {
      const id = Object.hasOwn(EXT_NEEDS, e) ? EXT_NEEDS[e] : undefined;
      if (!id) continue;
      const n = need.get(id) ?? { models: [], required: false };
      if (!n.models.includes(m)) n.models.push(m);
      n.required ||= info.required.includes(e);
      need.set(id, n);
    }
  }
  // the code sets one up without a model on disk (models from a CDN or a user upload)
  const codeHas: Record<DecoderId, RegExp> = { draco: /\bDRACOLoader\b|\.setDRACOLoader\s*\(/, ktx2: /\bKTX2Loader\b|\.setKTX2Loader\s*\(/, meshopt: /\bMeshoptDecoder\b|\.setMeshoptDecoder\s*\(/ };
  if (!opts.model) for (const id of ["draco", "ktx2", "meshopt"] as const) if (!need.has(id) && files.some((f) => codeHas[id].test(f.text))) need.set(id, { models: [], required: false });

  const cdnThree = (() => {
    for (const p of files.filter((f) => /\.html?$/.test(f.path))) {
      const m = /(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh)\/three@([\d.]+)\//.exec(p.raw);
      if (m) return m[1];
    }
    return undefined;
  })();
  const libUrl = (id: "draco" | "ktx2"): string | undefined => (cdnThree ? `https://cdn.jsdelivr.net/npm/three@${cdnThree}/examples/jsm/libs/${FILES[id].dir}/` : undefined);
  const dracoDir = (): "draco/gltf" | "draco" => (files.some((f) => /['"`][^'"`\n]+\.drc['"`]/.test(f.text)) ? "draco" : "draco/gltf");

  const states: DecoderState[] = [];
  const copies: DecoderCopy[] = [];
  // per file: edits as [offset, deleteCount, insert, change]
  const edits = new Map<SourceFile, { at: number; del: number; insert: string; change: string }[]>();
  const edit = (f: SourceFile, at: number, del: number, insert: string, change: string) => edits.set(f, [...(edits.get(f) ?? []), { at, del, insert, change }]);

  const target = (id: "draco" | "ktx2"): { folder: string; url: string } => ({ folder: serveDir === "." ? FOLDER[id] : `${serveDir}/${FOLDER[id]}`, url: `${urlBase}${FOLDER[id]}/` });
  const planCopy = (id: "draco" | "ktx2", folder: string): void => {
    if (!libs) return;
    const dir = id === "draco" ? dracoDir() : FILES[id].dir;
    for (const name of FILES[id].files) {
      const from = join(libs, ...dir.split("/"), name);
      if (!existsSync(from)) continue;
      const to = `${folder.replace(/\/$/, "")}/${name}`.replace(/^\.\//, "");
      if (!copies.some((c) => c.to === to)) copies.push({ from, to, bytes: statSync(from).size });
    }
  };
  /** Compare the files in a served folder with the installed three's copies. */
  const checkFolder = (id: "draco" | "ktx2", folder: string): DecoderFile[] => {
    const spec = FILES[id];
    return spec.files
      .filter((name) => spec.needed.includes(name) || existsSync(join(root, folder, name)))
      .map((name) => {
        const have = read(join(root, folder, name));
        const file = posix(join(folder, name));
        if (!have) return { file, status: "missing" as const };
        if (!libs) return { file, status: "match" as const };
        const mine = sha(have);
        const theirs = [spec.dir, spec.alt].filter((d): d is string => !!d).map((d) => read(join(libs, ...d.split("/"), name)));
        return { file, status: theirs.some((t) => t && sha(t) === mine) ? ("match" as const) : ("differs" as const) };
      });
  };
  /** Where a local decoder path is served from: public/ for "/x/", the page folder for relative paths. */
  const resolveLocal = (path: string, from: SourceFile): string => {
    const rel = path.replace(/^\.?\//, "").replace(/\/?$/, "");
    const cands = path.startsWith("/") ? [pub ? `${pub}/${rel}` : rel, ...pages.map((p) => posix(join(dirname(p.path), rel)))] : [...pages.map((p) => posix(join(dirname(p.path), rel))), posix(join(dirname(from.path), rel)), pub ? `${pub}/${rel}` : rel];
    const norm = cands.map((c) => posix(join(c)).replace(/^\.\//, ""));
    return norm.find((c) => existsSync(join(root, c))) ?? norm[0] ?? rel;
  };

  const gltfDecls = (): { f: SourceFile; name: string; end: number; at: number }[] => {
    const out: { f: SourceFile; name: string; end: number; at: number }[] = [];
    for (const f of files) {
      for (const m of f.text.matchAll(/(?:\b(?:const|let|var)\s+([\w$]+)|((?:this\.)?[\w$]+(?:\.[\w$]+)*))\s*=\s*new\s+(?:[\w$]+\.)?GLTFLoader\s*\(/g)) {
        out.push({ f, name: m[1] ?? m[2] ?? "", at: m.index ?? 0, end: statementEnd(f.text, (m.index ?? 0) + m[0].length - 1) });
      }
    }
    return out;
  };
  const decls = gltfDecls();
  if (framework === "vanilla" && need.size && !decls.length) {
    const inline = firstMatch(files, /new\s+(?:[\w$]+\.)?GLTFLoader\s*\(/);
    todo.push(inline ? { where: whereOf(inline), message: "The GLTFLoader is not kept in a variable, so the decoders cannot be set on it: write const gltfLoader = new GLTFLoader(); and load with gltfLoader." } : { message: "No code makes a GLTFLoader yet: set the decoders up on it when you add one (three_model_inspect gives the loader code for a model)." });
  }

  /** An import line for an addon, in the style of the GLTFLoader import in that file. */
  const importFor = (f: SourceFile, what: "DRACOLoader" | "KTX2Loader" | "MeshoptDecoder"): { at: number; line: string } | undefined => {
    if (new RegExp(String.raw`import\s*\{[^}]*\b${what}\b[^}]*\}\s*from`).test(f.text)) return { at: -1, line: "" };
    const m = /import\s*\{[^}]*\bGLTFLoader\b[^}]*\}\s*from\s*(['"])([^'"]+)\1\s*;?/.exec(f.text);
    if (!m) return undefined;
    const spec = m[2] ?? "";
    const next = what === "MeshoptDecoder" ? spec.replace(/loaders\/GLTFLoader(\.js)?$/, "libs/meshopt_decoder.module$1") : spec.replace(/GLTFLoader(\.js)?$/, `${what}$1`);
    if (next === spec) return undefined;
    return { at: m.index + m[0].length, line: `\n${indentAt(f.text, m.index)}import { ${what} } from ${m[1]}${next}${m[1]};` };
  };
  const addImport = (f: SourceFile, what: "DRACOLoader" | "KTX2Loader" | "MeshoptDecoder"): boolean => {
    const imp = importFor(f, what);
    if (!imp) return false;
    if (imp.at >= 0 && !(edits.get(f) ?? []).some((e) => e.insert === imp.line)) edit(f, imp.at, 0, imp.line, `import ${what}`);
    return true;
  };
  const rendererIn = (f: SourceFile, after: number): { name: string; end: number; webgpu: boolean } | undefined => {
    const m = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+(?:[\w$]+\.)?(WebGLRenderer|WebGPURenderer)\s*\(/.exec(f.text);
    if (!m) return undefined;
    const name = m[1] ?? "renderer";
    const webgpu = m[2] === "WebGPURenderer";
    let end = statementEnd(f.text, m.index + m[0].length - 1);
    if (webgpu) {
      const init = new RegExp(String.raw`await\s+${name.replace(/\$/g, "\\$")}\.init\s*\(\s*\)`).exec(f.text);
      if (!init) return { name, end: -1, webgpu };
      end = statementEnd(f.text, init.index + init[0].length);
    }
    return { name, end: Math.max(end, after), webgpu };
  };

  for (const id of ["draco", "ktx2", "meshopt"] as const) {
    const n = need.get(id);
    if (!n) continue;
    const base = { id, models: n.models, required: n.required, files: [] as DecoderFile[] };
    const whom = n.models.length ? `${n.models.length === 1 ? n.models[0] : `${n.models.length} models`}` : "the code";

    if (id === "meshopt") {
      const set = firstMatch(files, /\.setMeshoptDecoder\s*\(/);
      if (set || (framework === "r3f" && usesDrei)) {
        states.push({ ...base, source: set ? "inline" : "drei", ...(set ? { where: whereOf(set) } : {}), status: "ok", message: set ? "setMeshoptDecoder is called; the decoder's WebAssembly is inside the module, no files to serve." : "drei's useGLTF sets the meshopt decoder by default." });
        continue;
      }
      states.push({ ...base, source: "none", status: "not-set-up", message: `${whom} use${n.models.length === 1 ? "s" : ""} meshopt compression, but no code calls setMeshoptDecoder: GLTFLoader throws "setMeshoptDecoder must be called before loading compressed files"${n.required ? "" : " (or reads the fallback buffers)"}.` });
      for (const d of decls) {
        if (addImport(d.f, "MeshoptDecoder")) edit(d.f, d.end, 0, `\n${indentAt(d.f.text, d.at)}${d.name}.setMeshoptDecoder(MeshoptDecoder);`, `${d.name}.setMeshoptDecoder(MeshoptDecoder)`);
        else todo.push({ where: whereOf(d), message: "Import MeshoptDecoder and call setMeshoptDecoder on this GLTFLoader.", code: `import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';\n${d.name}.setMeshoptDecoder(MeshoptDecoder);` });
      }
      continue;
    }

    const cls = id === "draco" ? "DRACOLoader" : "KTX2Loader";
    const setter = id === "draco" ? "setDRACOLoader" : "setKTX2Loader";
    const pathMethod = id === "draco" ? /setDecoderPath/ : /setTranscoderPath/;
    const loaderMade = firstMatch(files, new RegExp(String.raw`new\s+(?:[\w$]+\.)?${cls}\s*\(`));
    const pathSet = pathCall(files, id === "draco" ? /(?:setDecoderPath)/ : pathMethod);
    const t = target(id);
    const installed = install?.version ?? "";

    // drei: useGLTF makes its own DRACOLoader with a CDN decoder unless useGLTF.setDecoderPath / a path argument is given
    if (id === "draco" && framework === "r3f" && !loaderMade) {
      const dreiPath = pathCall(files, /setDecoderPath/);
      if (dreiPath && !dreiPath.dynamic && !/^(?:https?:)?\/\//.test(dreiPath.path)) {
        const folder = resolveLocal(dreiPath.path, dreiPath.f);
        const fileStates = checkFolder(id, folder);
        const missing = fileStates.some((x) => x.status === "missing");
        if (missing) planCopy(id, folder);
        states.push({ ...base, files: fileStates, source: "local", path: dreiPath.path, where: whereOf(dreiPath), folder, status: missing ? "missing" : fileStates.some((x) => x.status === "differs") ? "stale" : "ok", message: missing ? `useGLTF loads the Draco decoder from "${dreiPath.path}", but ${folder}/ does not have ${fileStates.filter((x) => x.status === "missing").map((x) => x.file.split("/").pop()).join(", ")}: the server answers with an HTML page and decoding fails.` : `useGLTF decodes Draco with the files in ${folder}/${fileStates.some((x) => x.status === "differs") ? " (they differ from the installed three's copy: another build; Draco decoders stay compatible, write replaces them)" : ", the same as the installed three's"}.` });
        if (fileStates.some((x) => x.status === "differs")) planCopy(id, folder);
        continue;
      }
      states.push({ ...base, source: dreiPath ? "cdn" : "drei", ...(dreiPath ? { path: dreiPath.path, where: whereOf(dreiPath) } : {}), status: libs ? "check" : "ok", message: `drei's useGLTF decodes Draco with ${dreiPath ? `the decoder at ${dreiPath.path || "a path built at runtime"}` : "a decoder from the gstatic CDN by default"}: it works online. To serve the installed three's decoder yourself (offline, strict CSP), write copies it to ${t.folder}/ and calls useGLTF.setDecoderPath('${t.url}').` });
      if (libs && !dreiPath) {
        planCopy(id, t.folder);
        const user = files.find((f) => /\buseGLTF\s*\(/.test(f.text));
        const imp = user && /import\s*\{[^}]*\buseGLTF\b[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/.exec(user.text);
        if (user && imp) edit(user, imp.index + imp[0].length, 0, `\n\nuseGLTF.setDecoderPath('${t.url}');`, `useGLTF.setDecoderPath('${t.url}')`);
      }
      continue;
    }
    if (id === "ktx2" && framework === "r3f" && !loaderMade) {
      states.push({ ...base, source: "none", status: "not-set-up", message: `${whom} use${n.models.length === 1 ? "s" : ""} KTX2 textures; drei's useGLTF does not set up a KTX2Loader by itself.` });
      planCopy(id, t.folder);
      todo.push({ message: "Give useGLTF a KTX2Loader through its extendLoader argument (it needs the WebGL renderer, so make it inside a component under <Canvas>).", code: `import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';\nconst gl = useThree((s) => s.gl);\nconst ktx2 = useMemo(() => new KTX2Loader().setTranscoderPath('${t.url}').detectSupport(gl), [gl]);\nconst gltf = useGLTF(url, true, true, (loader) => loader.setKTX2Loader(ktx2));` });
      continue;
    }

    // a setter assigned instead of called: loader.setKTX2Loader = ktx2
    for (const f of files) {
      for (const m of f.text.matchAll(new RegExp(String.raw`([\w$.]+)\.${setter}\s*=\s*([^;\n=][^;\n]*?)\s*;?(?=\n|$)`, "g"))) {
        edit(f, m.index ?? 0, m[0].length, `${m[1]}.${setter}(${m[2]});`, `${m[1]}.${setter} = ... becomes a call`);
      }
    }
    const attached = files.some((f) => new RegExp(String.raw`\.${setter}\s*[(=]`).test(f.text));

    if (!loaderMade) {
      states.push({ ...base, source: "none", status: "not-set-up", message: `${whom} use${n.models.length === 1 ? "s" : ""} ${id === "draco" ? "Draco-compressed meshes" : "KTX2 (Basis) textures"}, but no code makes a ${cls}: GLTFLoader throws ${id === "draco" ? '"No DRACOLoader instance provided"' : '"setKTX2Loader must be called before loading KTX2 textures"'}${n.required || id === "draco" ? "" : " (or uses the fallback image)"}.` });
      const url = libs ? t.url : libUrl(id);
      if (libs) planCopy(id, t.folder);
      if (!url) {
        todo.push({ message: `Install three (npm install three) so the ${id === "draco" ? "decoder" : "transcoder"} can come from the same release, or set a CDN path of the three version you load.` });
        continue;
      }
      for (const d of decls) {
        const pathPart = id === "draco" ? `.setDecoderPath('${url}')` : `.setTranscoderPath('${url}')`;
        if (id === "draco") {
          if (addImport(d.f, cls)) edit(d.f, d.end, 0, `\n${indentAt(d.f.text, d.at)}${d.name}.${setter}(new ${cls}()${pathPart});`, `${d.name}.${setter}(new ${cls}()${pathPart})`);
          else todo.push({ where: whereOf(d), message: `Import ${cls} and set it on this GLTFLoader.`, code: `${d.name}.${setter}(new ${cls}()${pathPart});` });
          continue;
        }
        const r = rendererIn(d.f, d.end);
        if (!r || r.end < 0) {
          todo.push({ where: whereOf(d), message: r ? `KTX2Loader.detectSupport needs the WebGPURenderer to be ready: await ${r.name}.init() first, then set it up.` : "KTX2Loader.detectSupport(renderer) needs the renderer, which is made in another file: set it up where both are known.", code: `${d.name}.${setter}(new ${cls}()${pathPart}.detectSupport(${r?.name ?? "renderer"}));` });
          continue;
        }
        if (addImport(d.f, cls)) edit(d.f, r.end, 0, `\n${indentAt(d.f.text, d.at)}${d.name}.${setter}(new ${cls}()${pathPart}.detectSupport(${r.name}));`, `${d.name}.${setter}(new ${cls}()${pathPart}.detectSupport(${r.name}))`);
        else todo.push({ where: whereOf(d), message: `Import ${cls} and set it on this GLTFLoader.`, code: `${d.name}.${setter}(new ${cls}()${pathPart}.detectSupport(${r.name}));` });
      }
      continue;
    }

    if (!attached) todo.push({ where: whereOf(loaderMade), message: `The ${cls} is never passed to the GLTFLoader (${setter}), so compressed models fail. Add gltfLoader.${setter}(${id === "draco" ? "dracoLoader" : "ktx2Loader"}) where both are made.` });
    if (id === "ktx2" && !files.some((f) => /\.detectSupport\s*\(/.test(f.text))) todo.push({ where: whereOf(loaderMade), message: "This KTX2Loader never calls detectSupport(renderer): the first texture throws \"Missing initialization with `.detectSupport( renderer )`\". Call it once the renderer exists (after await renderer.init() for WebGPURenderer)." });

    if (!pathSet) {
      // three's default: the folder next to DRACOLoader.js / KTX2Loader.js (new URL(..., import.meta.url))
      const moved = bundler !== "none";
      states.push({ ...base, source: "default", where: whereOf(loaderMade), status: moved && libs ? "check" : "ok", message: `The ${cls} has no ${id === "draco" ? "setDecoderPath" : "setTranscoderPath"}, so it loads its files from three's libs/${FILES[id].dir.split("/")[0]}/ next to ${cls}.js: that works when ${cls}.js is served from three's own folder (an import map onto node_modules or a CDN)${moved ? `; with ${bundler} the bundled ${cls}.js may sit elsewhere, so write serves the installed three's files from ${t.folder}/ and sets the path` : ""}.` });
      if (moved && libs) {
        planCopy(id, t.folder);
        const m = new RegExp(String.raw`new\s+(?:[\w$]+\.)?${cls}\s*\([^)]*\)`).exec(loaderMade.f.text.slice(loaderMade.at));
        if (m) edit(loaderMade.f, loaderMade.at + m.index + m[0].length, 0, `.${id === "draco" ? "setDecoderPath" : "setTranscoderPath"}('${t.url}')`, `${cls} path '${t.url}'`);
      }
      continue;
    }
    if (pathSet.dynamic) {
      states.push({ ...base, source: "local", where: whereOf(pathSet), status: "check", message: `The ${id === "draco" ? "decoder" : "transcoder"} path is built at runtime, so it cannot be checked from the files: make sure it serves ${FILES[id].needed.join(" and ")} from the installed three (node_modules/three/examples/jsm/libs/${FILES[id].dir}/).` });
      continue;
    }
    const cdn = CDN_THREE.exec(pathSet.path);
    if (cdn || /^(?:https?:)?\/\//.test(pathSet.path)) {
      const found = cdn?.[1];
      const pinned = found && /^\d+\.\d+\.\d+$/.test(found);
      const same = !!pinned && (!installed || found === installed || (!!cdnThree && found === cdnThree));
      const against = installed || cdnThree || "";
      if (found && against && !same) {
        // the transcoder (and its worker code in KTX2Loader) must come from the same release; Draco builds are compatible, but keep them pinned too
        const wrong = id === "ktx2";
        states.push({ ...base, source: "cdn", path: pathSet.path, where: whereOf(pathSet), version: { found, installed: against }, status: wrong ? "mismatch" : "check", message: `The ${id === "draco" ? "decoder" : "transcoder"} comes from three@${found} on a CDN, but the code runs three ${against}.${wrong ? " KTX2Loader's worker calls into basis_transcoder.js, which changes between releases: use the transcoder of the same release." : " Draco decoders are compatible across releases, but pin the same version so they update together."}` });
        const s = pathSet.f.raw.indexOf(pathSet.path, pathSet.at);
        if (s >= 0) {
          const next = pathSet.path.replace(/three@[^/]+\//, `three@${against}/`);
          edit(pathSet.f, s, pathSet.path.length, next, `CDN three@${found} -> three@${against}`);
        }
      } else {
        states.push({ ...base, source: "cdn", path: pathSet.path, where: whereOf(pathSet), ...(found ? { version: { found, installed: against } } : {}), status: found && !pinned ? "check" : "ok", message: found ? (pinned ? `The ${id === "draco" ? "decoder" : "transcoder"} comes from three@${found} on a CDN, the same release the code runs.` : `The ${id === "draco" ? "decoder" : "transcoder"} comes from three@${found} on a CDN: an unpinned version moves on its own and can stop matching ${cls}; pin it to ${against || "the three version you load"}.`) : id === "draco" ? `Draco decoder from ${pathSet.path}: Draco decoders do not depend on the three release.` : `Transcoder from ${pathSet.path}: it must be the basis_transcoder of the same three release as KTX2Loader; Threesmith cannot tell which release that URL serves.` });
        if (found && !pinned && against) {
          const s = pathSet.f.raw.indexOf(pathSet.path, pathSet.at);
          if (s >= 0) edit(pathSet.f, s, pathSet.path.length, pathSet.path.replace(/three@[^/]+\//, `three@${against}/`), `CDN three@${found} -> three@${against}`);
        }
      }
      continue;
    }
    const folder = resolveLocal(pathSet.path, pathSet.f);
    const fileStates = checkFolder(id, folder);
    const missing = fileStates.filter((x) => x.status === "missing");
    const differs = fileStates.filter((x) => x.status === "differs");
    if (missing.length || differs.length) planCopy(id, folder);
    if (!pathSet.path.endsWith("/")) todo.push({ where: whereOf(pathSet), message: `"${pathSet.path}" has no trailing slash: three joins the file name to it${id === "draco" ? " (LoaderUtils.resolveURL)" : " (FileLoader.setPath)"}, so add the slash.` });
    states.push({
      ...base,
      source: "local",
      path: pathSet.path,
      where: whereOf(pathSet),
      folder,
      files: fileStates,
      status: missing.length ? "missing" : differs.length ? "stale" : "ok",
      message: missing.length
        ? `The ${cls} loads its files from "${pathSet.path}", served from ${folder}/, which does not have ${missing.map((x) => x.file.split("/").pop()).join(", ")}: the server answers with an HTML page, and the ${id === "draco" ? "decoder" : "transcoder"} fails ("expected magic word 00 61 73 6d" or a MIME type error).`
        : differs.length
          ? `${differs.map((x) => x.file).join(", ")} differ${differs.length === 1 ? "s" : ""} from the installed three ${installed}'s copy: copied from another release.${id === "ktx2" ? " The transcoder must match KTX2Loader's release." : " Draco decoders stay compatible, but write keeps them in step with three."}`
          : `${folder}/ serves the ${id === "draco" ? "decoder" : "transcoder"} files of the installed three${installed ? ` ${installed}` : ""} (same hash).`,
    });
  }

  if (bundler === "vite" && ["vite.config.js", "vite.config.ts", "vite.config.mjs"].some((c) => /\bbase\s*:/.test(read(join(root, c))?.toString("utf8") ?? "")))
    notes.push(`vite.config sets a base: a decoder path of "${urlBase}..." is then outside it; use import.meta.env.BASE_URL + 'draco/' instead.`);
  if (copies.length && pub) notes.push(`${pub}/ is served at / by the dev server and copied into the build, so the files work in both.`);
  if (copies.length && !pub) notes.push(`The files go next to the page (${serveDir === "." ? "the project root" : `${serveDir}/`}), so "${urlBase}draco/" resolves from the page in development and on a static host.`);
  if (need.size && !libs && !cdnThree) notes.push("three is not installed (node_modules/three): the decoder files and their version cannot be checked. Run npm install.");

  const patches: DecoderPatch[] = [];
  for (const [f, list] of edits) {
    let data = f.raw;
    // from the end, and at the same offset the later edit first, so inserts keep the order they were planned in
    for (const e of list.map((x, i) => ({ ...x, i })).sort((a, b) => b.at - a.at || b.i - a.i)) data = data.slice(0, e.at) + e.insert + data.slice(e.at + e.del);
    patches.push({ file: f.path, data, changes: list.map((e) => e.change) });
  }
  return {
    root,
    ...(install && libs ? { three: { version: install.version, release: install.release, libs } } : {}),
    framework,
    bundler,
    serveDir,
    urlBase,
    states,
    copies,
    patches,
    todo,
    notes,
  };
}

/** The files a write makes: the decoder copies and the patched sources, relative to the project. */
export function decoderWrites(plan: DecoderPlan): { file: string; data: string | Uint8Array }[] {
  return [...plan.copies.map((c) => ({ file: c.to, data: readFileSync(c.from) })), ...plan.patches.map((p) => ({ file: p.file, data: p.data }))];
}

const MARK: Record<DecoderState["status"], string> = { ok: "ok", check: "check", missing: "error", stale: "warn", mismatch: "error", "not-set-up": "error" };

export function formatDecoders(plan: DecoderPlan, opts: { written?: boolean; journal?: number } = {}): string {
  const out: string[] = [];
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  out.push(`Decoders: three ${plan.three ? plan.three.version : "not installed"}, ${plan.framework === "r3f" ? "React Three Fiber (drei useGLTF)" : "vanilla GLTFLoader"}, bundler ${plan.bundler}; served folder ${plan.serveDir === "." ? "the project root" : `${plan.serveDir}/`} at ${plan.urlBase}.`);
  if (!plan.states.length) out.push("No model or code needs Draco, KTX2 or meshopt decoders.");
  for (const s of plan.states) {
    out.push(`${MARK[s.status]} [${s.id}] ${s.models.length ? `${s.models.slice(0, 3).join(", ")}${s.models.length > 3 ? ` +${s.models.length - 3}` : ""}${s.required ? " (required)" : ""}: ` : ""}${s.message}${s.where ? ` (${s.where})` : ""}`);
    for (const f of s.files.filter((x) => x.status !== "match")) out.push(`    ${f.file}: ${f.status === "missing" ? "missing" : "differs from the installed three"}`);
  }
  if (plan.copies.length || plan.patches.length) {
    out.push("", opts.written ? `Written${opts.journal ? ` (journal ${opts.journal}; three_undo takes it back)` : ""}:` : "write: true would:");
    for (const c of plan.copies) out.push(`  copy ${posix(relative(plan.root, c.from)).replace(/^.*node_modules\//, "node_modules/")} -> ${c.to} (${kb(c.bytes)})`);
    for (const p of plan.patches) out.push(`  edit ${p.file}: ${p.changes.join("; ")}`);
  }
  if (plan.todo.length) {
    out.push("", "By hand:");
    for (const t of plan.todo) {
      out.push(`  - ${t.where ? `${t.where}: ` : ""}${t.message}`);
      if (t.code) out.push(...t.code.split("\n").map((l) => `      ${l}`));
    }
  }
  for (const n of plan.notes) out.push(`note: ${n}`);
  if (!opts.written && (plan.copies.length || plan.patches.length)) out.push("Then run three_check on the page: the model must load without decoder errors.");
  return out.join("\n");
}

/** True when a decoder is not usable as the files stand. */
export function decodersBroken(plan: DecoderPlan): boolean {
  return plan.states.some((s) => s.status === "missing" || s.status === "mismatch" || s.status === "not-set-up");
}
