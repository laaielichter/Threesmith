import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * three_gltf: validate a .glb/.gltf with the Khronos glTF-Validator and optimise it with gltf-transform. Both are
 * OPTIONAL dependencies, loaded on use (like playwright-core): when one is missing, the answer says what to install
 * instead of failing. Pure: optimise returns the new bytes; the caller writes them through the journal.
 */

export class OptionalMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptionalMissing";
  }
}

export async function loadOptional<T>(name: string, why: string): Promise<T> {
  try {
    return (await import(name)) as T;
  } catch {
    throw new OptionalMissing(`${why} needs the optional package ${name}, which is not installed. Install it next to threesmith: npm install -D ${name}`);
  }
}

export interface ValidationMessage {
  severity: "error" | "warning" | "info" | "hint";
  code: string;
  message: string;
  pointer?: string;
}

export interface ValidationReport {
  file: string;
  validator: string;
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  /** Capped list, errors first. */
  messages: ValidationMessage[];
  truncated: boolean;
  generator?: string;
  version?: string;
}

interface ValidatorModule {
  version(): string;
  validateBytes(data: Uint8Array, options?: { uri?: string; maxIssues?: number; externalResourceFunction?: (uri: string) => Promise<Uint8Array> }): Promise<{
    issues: { numErrors: number; numWarnings: number; numInfos: number; numHints: number; truncated: boolean; messages: { code: string; message: string; severity: number; pointer?: string }[] };
    info?: { version?: string; generator?: string };
  }>;
}

const SEVERITY: ValidationMessage["severity"][] = ["error", "warning", "info", "hint"];

/** Validate glTF bytes. `dir` is where external buffers and images of a .gltf are read from (never outside it). */
export async function validateBytes(data: Uint8Array, file: string, dir: string, opts: { maxIssues?: number } = {}): Promise<ValidationReport> {
  const mod = await loadOptional<{ default?: ValidatorModule } & ValidatorModule>("gltf-validator", "glTF validation");
  const v = (mod.default ?? mod) as ValidatorModule;
  const base = resolve(dir);
  const r = await v.validateBytes(data, {
    uri: basename(file),
    maxIssues: opts.maxIssues ?? 200,
    externalResourceFunction: async (uri: string) => {
      const path = decodeURIComponent(uri.split(/[?#]/)[0] ?? "");
      if (/^[a-z]+:/i.test(path) || isAbsolute(path)) throw new Error(`not read: ${uri} (only files next to the model)`);
      const full = resolve(base, path);
      const rel = relative(base, full);
      if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`not read: ${uri} is outside the model's folder`);
      return new Uint8Array(readFileSync(full));
    },
  });
  const messages = r.issues.messages
    .map((m) => ({ severity: SEVERITY[m.severity] ?? "info", code: m.code, message: m.message, ...(m.pointer ? { pointer: m.pointer } : {}) }))
    .sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity));
  return {
    file,
    validator: `glTF-Validator ${v.version()}`,
    errors: r.issues.numErrors,
    warnings: r.issues.numWarnings,
    infos: r.issues.numInfos,
    hints: r.issues.numHints,
    messages,
    truncated: r.issues.truncated,
    ...(r.info?.generator ? { generator: r.info.generator } : {}),
    ...(r.info?.version ? { version: r.info.version } : {}),
  };
}

function readModel(file: string): Uint8Array {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`model not found: ${file}`);
  if (!/\.(?:glb|gltf)$/i.test(file)) throw new Error(`${file} is not a .glb or .gltf file`);
  return new Uint8Array(readFileSync(file));
}

export async function validateGltf(file: string, opts: { maxIssues?: number } = {}): Promise<ValidationReport> {
  return validateBytes(readModel(file), file, dirname(file), opts);
}

export function formatValidation(r: ValidationReport, opts: { limit?: number; label?: string } = {}): string {
  const limit = opts.limit ?? 20;
  const out = [`${opts.label ?? r.file}: ${r.errors} error(s), ${r.warnings} warning(s), ${r.infos} info, ${r.hints} hint(s) (${r.validator}${r.generator ? `; made by ${r.generator}` : ""}).`];
  const shown = r.messages.filter((m) => m.severity === "error" || m.severity === "warning" || limit > 40);
  for (const m of shown.slice(0, limit)) out.push(`${m.severity} [${m.code}] ${m.message}${m.pointer ? ` at ${m.pointer}` : ""}`);
  if (shown.length > limit || r.truncated) out.push(`+${Math.max(0, shown.length - limit)} more${r.truncated ? " (the validator stopped early)" : ""}`);
  if (!r.errors) out.push(r.warnings ? "Valid glTF; the warnings may still show in three.js (check the ones about missing data)." : "Valid glTF.");
  return out.join("\n");
}

// ---- optimise ----

export type Compression = "draco" | "meshopt" | "none";

export interface ModelStats {
  bytes: number;
  meshes: number;
  primitives: number;
  vertices: number;
  triangles: number;
  materials: number;
  textures: number;
  extensions: string[];
}

export interface OptimizeOptions {
  compress?: Compression;
  /** Keep this share of the triangles (0 < ratio < 1) with meshoptimizer's simplifier. */
  simplify?: number;
  /** Output path; default <name>.optimized.glb next to the input. */
  out?: string;
}

export interface OptimizeResult {
  file: string;
  out: string;
  steps: string[];
  before: ModelStats;
  after: ModelStats;
  data: Uint8Array;
  /** The output validated, when gltf-validator is installed. */
  validation?: ValidationReport;
  notes: string[];
}

type Core = typeof import("@gltf-transform/core");
type Extensions = typeof import("@gltf-transform/extensions");
type Functions = typeof import("@gltf-transform/functions");
type Doc = import("@gltf-transform/core").Document;

function stats(doc: Doc, bytes: number): ModelStats {
  const root = doc.getRoot();
  let primitives = 0;
  let vertices = 0;
  let triangles = 0;
  for (const mesh of root.listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      primitives++;
      const count = p.getAttribute("POSITION")?.getCount() ?? 0;
      vertices += count;
      // 4 = TRIANGLES (the default); strips and fans are rare after export
      if (p.getMode() === 4) triangles += Math.floor((p.getIndices()?.getCount() ?? count) / 3);
    }
  }
  return {
    bytes,
    meshes: root.listMeshes().length,
    primitives,
    vertices,
    triangles,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    extensions: root.listExtensionsUsed().map((e) => e.extensionName).sort(),
  };
}

export async function optimizeGltf(file: string, opts: OptimizeOptions = {}): Promise<OptimizeResult> {
  const input = readModel(file);
  const why = "glTF optimisation";
  const core = await loadOptional<Core>("@gltf-transform/core", why);
  const ext = await loadOptional<Extensions>("@gltf-transform/extensions", why);
  const fn = await loadOptional<Functions>("@gltf-transform/functions", why);
  const compress = opts.compress ?? "none";
  const notes: string[] = [];

  // decoders and encoders, only when the file or the options need them
  // gltf-transform logs to the console by default; the MCP server must never write to stdout
  const logger = new core.Logger(core.Logger.Verbosity.SILENT);
  const io = new core.NodeIO().setLogger(logger).registerExtensions(ext.ALL_EXTENSIONS);
  const used = (() => {
    try {
      return extensionsOf(input).join(" ");
    } catch {
      return "";
    }
  })();
  const needDraco = compress === "draco" || used.includes("KHR_draco_mesh_compression");
  const needMeshopt = compress === "meshopt" || (opts.simplify !== undefined && opts.simplify < 1) || /(?:EXT|KHR)_meshopt_compression/.test(used);
  const deps: Record<string, unknown> = {};
  if (needDraco) {
    const draco = await loadOptional<{ default: { createDecoderModule(): Promise<unknown>; createEncoderModule(): Promise<unknown> } }>("draco3dgltf", "Draco (de)compression");
    deps["draco3d.decoder"] = await draco.default.createDecoderModule();
    deps["draco3d.encoder"] = await draco.default.createEncoderModule();
  }
  let meshopt: typeof import("meshoptimizer") | undefined;
  if (needMeshopt) {
    meshopt = await loadOptional<typeof import("meshoptimizer")>("meshoptimizer", "meshopt compression and simplification");
    await Promise.all([meshopt.MeshoptDecoder.ready, meshopt.MeshoptEncoder.ready, meshopt.MeshoptSimplifier.ready]);
    deps["meshopt.decoder"] = meshopt.MeshoptDecoder;
    deps["meshopt.encoder"] = meshopt.MeshoptEncoder;
  }
  io.registerDependencies(deps);

  const doc = /\.gltf$/i.test(file) ? await io.read(file) : await io.readBinary(input);
  doc.setLogger(logger);
  const before = stats(doc, input.byteLength);
  const steps: string[] = [];
  const transforms = [fn.dedup(), fn.prune(), fn.weld()];
  steps.push("dedup (identical accessors, meshes, materials, textures)", "prune (unused nodes, materials, textures, accessors)", "weld (merge identical vertices)");
  if (opts.simplify !== undefined && opts.simplify > 0 && opts.simplify < 1 && meshopt) {
    transforms.push(fn.simplify({ simplifier: meshopt.MeshoptSimplifier, ratio: opts.simplify, error: 0.001 }));
    steps.push(`simplify to about ${Math.round(opts.simplify * 100)}% of the triangles (meshoptimizer, error 0.1%)`);
  }
  // an already compressed file is written uncompressed unless asked for, so remove the old compression first
  for (const e of doc.getRoot().listExtensionsUsed()) {
    if (["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_meshopt_compression"].includes(e.extensionName)) e.dispose();
  }
  if (compress === "draco") {
    transforms.push(fn.draco({ method: "edgebreaker" }));
    steps.push("Draco geometry compression (KHR_draco_mesh_compression): the page needs a DRACOLoader");
  } else if (compress === "meshopt" && meshopt) {
    transforms.push(fn.meshopt({ encoder: meshopt.MeshoptEncoder, level: "medium" }));
    steps.push("meshopt compression (EXT_meshopt_compression, quantized): the page needs setMeshoptDecoder");
  }
  await doc.transform(...transforms);
  const data = await io.writeBinary(doc);
  const after = stats(doc, data.byteLength);
  const out = opts.out ? resolve(opts.out) : join(dirname(file), `${basename(file, extname(file))}.optimized.glb`);
  if (compress !== "none") notes.push(`The page must set up the ${compress === "draco" ? "Draco" : "meshopt"} decoder for the new file: three_decoders (write: true) does it with the installed three's files.`);
  notes.push("Textures are kept as they are: KTX2 needs KTX-Software (toktx) and WebP or resizing need sharp, e.g. npx @gltf-transform/cli etc1s in.glb out.glb.");
  let validation: ValidationReport | undefined;
  try {
    validation = await validateBytes(data, basename(out), dirname(file));
  } catch (e) {
    if (!(e instanceof OptionalMissing)) throw e;
    notes.push("Install gltf-validator to validate the output as well.");
  }
  return { file, out, steps, before, after, data, ...(validation ? { validation } : {}), notes };
}

/** extensionsUsed of glb or gltf bytes, without loading buffers. */
function extensionsOf(data: Uint8Array): string[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let json: string;
  if (buf.length >= 20 && buf.readUInt32LE(0) === 0x46546c67) json = buf.subarray(20, 20 + buf.readUInt32LE(12)).toString("utf8");
  else json = buf.toString("utf8");
  const parsed = JSON.parse(json) as { extensionsUsed?: string[] };
  return parsed.extensionsUsed ?? [];
}

const kb = (n: number): string => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

export function formatOptimize(r: OptimizeResult, opts: { root?: string; written?: boolean; journal?: number } = {}): string {
  const rel = (p: string) => (opts.root ? relative(opts.root, p) || p : p);
  const pct = r.before.bytes ? Math.round((1 - r.after.bytes / r.before.bytes) * 100) : 0;
  const row = (s: ModelStats) => `${kb(s.bytes)}, ${s.triangles} triangles, ${s.vertices} vertices, ${s.primitives} primitive(s), ${s.materials} material(s), ${s.textures} texture(s)${s.extensions.length ? `; ${s.extensions.join(", ")}` : ""}`;
  const out = [
    `${rel(r.file)} -> ${rel(r.out)}: ${pct >= 0 ? `${pct}% smaller` : `${-pct}% larger`} (measured on the written bytes).`,
    `  before: ${row(r.before)}`,
    `  after:  ${row(r.after)}`,
    `steps: ${r.steps.join("; ")}.`,
  ];
  if (r.validation) out.push(formatValidation(r.validation, { label: "output", limit: 10 }));
  for (const n of r.notes) out.push(`note: ${n}`);
  out.push(opts.written ? `Written${opts.journal ? ` (journal ${opts.journal}; three_undo takes it back)` : ""}. Load the new file and run three_check against a baseline of the old one.` : "write: true (--write) saves it; the input stays as it is.");
  return out.join("\n");
}
