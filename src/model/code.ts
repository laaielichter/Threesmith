import { relative, resolve, sep } from "node:path";
import { loadGltf, type Gltf, type GltfNode } from "./gltf.js";
import { inspectModel as inspectModelInfo } from "./inspect.js";
import { modelNeeds } from "./needs.js";

/**
 * Code for a model: a vanilla ES module (or TypeScript) that loads the .glb with the decoders it needs and hands back
 * its named parts, materials and animation actions, or a React Three Fiber component (like gltfjsx) with the node
 * tree as JSX when the file allows it. Names come from the file as GLTFLoader keeps them (`userData.name`), so the
 * code finds the parts whatever names three makes unique. Pure: it returns the code, the caller writes it.
 */

export type CodeStyle = "vanilla" | "r3f";

export interface CodeOptions {
  style?: CodeStyle;
  typescript?: boolean;
  /** URL the page loads the model from (default: from its place under public/ or the project). */
  url?: string;
  /** Name of the function or component (default: from the file name). */
  name?: string;
  /** Project folder, to work out the URL. */
  root?: string;
  publicDir?: string | null;
}

export interface CodeResult {
  code: string;
  /** Suggested file name for the code. */
  file: string;
  name: string;
  url: string;
  style: CodeStyle;
  /** R3F: the node tree is written out as JSX; false: one <primitive> with the parts looked up by name. */
  tree: boolean;
  /** Why the tree could not be written out, when it was not. */
  why?: string;
  parts: string[];
  clips: string[];
  decoders: string[];
}

const ident = (s: string, upper: boolean): string => {
  const words = s.replace(/\.[^.]+$/, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = words.map((w, i) => (i === 0 && !upper ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join("") || "model";
  return /^\d/.test(out) ? `${upper ? "Model" : "model"}${out}` : out;
};

/** PropertyBinding.sanitizeNodeName, as GLTFLoader names nodes. */
const sanitize = (name: string): string => name.replace(/\s/g, "_").replace(/[[\].:/]/g, "");

const r = (n: number) => Math.round(n * 1e5) / 1e5;
const arr = (v: number[]) => `[${v.map(r).join(", ")}]`;

/** The URL a page loads `file` from: under public/ it is served from the root; elsewhere relative to the project. */
export function urlFor(file: string, root: string, publicDir: string | null | undefined): string {
  const full = resolve(file);
  if (publicDir) {
    const p = relative(resolve(root, publicDir), full);
    if (!p.startsWith("..")) return `/${p.split(sep).join("/")}`;
  }
  const p = relative(resolve(root), full);
  return p.startsWith("..") ? `./${full.split(sep).pop()}` : `/${p.split(sep).join("/")}`;
}

/** Can the node tree be written as JSX that matches what GLTFLoader builds? The reason when not. */
function treeBlocker(j: Gltf): string | undefined {
  if (j.skins?.length) return "the model is skinned (a skinned mesh needs its skeleton cloned with SkeletonUtils)";
  if (j.cameras?.length) return "the model has cameras";
  if (j.extensionsUsed?.includes("KHR_lights_punctual")) return "the model has lights";
  if (j.extensionsUsed?.includes("EXT_mesh_gpu_instancing")) return "the model uses GPU instancing";
  const seen = new Set<string>();
  for (const n of j.nodes ?? []) {
    if (n.matrix) return "a node has a matrix instead of position, rotation and scale";
    if (n.mesh !== undefined && !n.name) return "a mesh node has no name";
    if (n.mesh !== undefined && (j.meshes?.[n.mesh]?.primitives.length ?? 0) > 1) return "a mesh has more than one primitive (GLTFLoader makes a group of meshes)";
    if (n.mesh !== undefined && j.meshes?.[n.mesh]?.primitives.some((p) => p.targets?.length)) return "a mesh has morph targets";
    if (n.name) {
      const s = sanitize(n.name);
      if (seen.has(s)) return `two nodes are named "${n.name}" (GLTFLoader renames one)`;
      seen.add(s);
    }
  }
  return undefined;
}

function jsxNode(j: Gltf, i: number, depth: number, lines: string[]): void {
  const n = j.nodes![i] as GltfNode;
  const pad = "  ".repeat(depth);
  const attrs: string[] = [];
  const name = n.name ? sanitize(n.name) : "";
  if (name) attrs.push(`name=${JSON.stringify(name)}`);
  if (n.mesh !== undefined) {
    const key = JSON.stringify(name);
    attrs.push(`geometry={nodes[${key}].geometry}`, `material={nodes[${key}].material}`);
  }
  if (n.translation && n.translation.some((v) => v !== 0)) attrs.push(`position={${arr(n.translation)}}`);
  if (n.rotation && (n.rotation[0] || n.rotation[1] || n.rotation[2] || n.rotation[3] !== 1)) attrs.push(`quaternion={${arr(n.rotation)}}`);
  if (n.scale && n.scale.some((v) => v !== 1)) attrs.push(`scale={${n.scale.every((v) => v === n.scale![0]) ? r(n.scale[0]!) : arr(n.scale)}}`);
  const tag = n.mesh !== undefined ? "mesh" : "group";
  const kids = n.children ?? [];
  if (!kids.length) {
    lines.push(`${pad}<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""} />`);
    return;
  }
  lines.push(`${pad}<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
  for (const c of kids) jsxNode(j, c, depth + 1, lines);
  lines.push(`${pad}</${tag}>`);
}

export function modelCode(file: string, options: CodeOptions = {}): CodeResult {
  const g = loadGltf(file);
  const j = g.json;
  const info = inspectModelInfo(file);
  const needs = modelNeeds(info);
  const style = options.style ?? "vanilla";
  const ts = options.typescript === true;
  const base = file.split(/[\\/]/).pop() ?? "model.glb";
  const name = options.name ?? ident(base, style === "r3f");
  const url = options.url ?? urlFor(file, options.root ?? process.cwd(), options.publicDir);
  const parts = [...new Set((j.nodes ?? []).map((n) => n.name).filter((x): x is string => !!x))];
  const clips = (j.animations ?? []).map((a, i) => a.name || `animation_${i}`);
  const decoders = needs.setups.map((s) => s.id);
  const q = JSON.stringify;
  const out: string[] = [];
  let tree = false;
  let why: string | undefined;

  if (style === "vanilla") {
    const fn = `load${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    const partType = parts.length ? parts.map((p) => q(p)).join(" | ") : "string";
    const clipType = clips.length ? clips.map((c) => q(c)).join(" | ") : "string";
    out.push(`// ${base}: ${info.triangles} triangles, ${info.materials.length} material(s), ${clips.length} animation(s). Made by threesmith model code.`);
    out.push("import { AnimationMixer } from 'three';");
    out.push("import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';");
    for (const s of needs.setups) out.push(...s.imports);
    if (ts) {
      out.push("import type { AnimationAction, Material, Object3D, WebGLRenderer } from 'three';");
      out.push("import type { WebGPURenderer } from 'three/webgpu';");
    }
    out.push("", `export const URL = ${q(url)};`);
    if (ts) out.push(`export type PartName = ${partType};`, `export type ClipName = ${clipType};`);
    out.push(`export const PARTS = ${q(parts)}${ts ? " as const" : ""};`, `export const CLIPS = ${q(clips)}${ts ? " as const" : ""};`, "");
    const rendererArg = decoders.includes("ktx2");
    out.push(
      "/**",
      ` * Loads ${base} and returns its root, its parts by their name in the file, its materials by name, and one`,
      " * action per animation (call mixer.update(delta) every frame). dispose() frees its GPU memory.",
      ...(rendererArg ? [" * @param renderer the renderer that draws it (KTX2 textures are transcoded for its GPU)"] : []),
      " */",
    );
    out.push(`export async function ${fn}(${rendererArg ? `renderer${ts ? ": WebGLRenderer | WebGPURenderer" : ""}, ` : ""}onProgress${ts ? "?: (event: ProgressEvent) => void" : ""}) {`);
    out.push("  const gltfLoader = new GLTFLoader();");
    for (const s of needs.setups) for (const l of s.code.split("\n")) out.push(`  ${l}`);
    out.push("  const gltf = await gltfLoader.loadAsync(URL, onProgress);");
    out.push("  const root = gltf.scene;");
    out.push(`  const parts${ts ? ": Partial<Record<PartName, Object3D>>" : ""} = {};`);
    out.push(`  const materials${ts ? ": Record<string, Material>" : ""} = {};`);
    out.push("  root.traverse((o) => {");
    out.push("    // GLTFLoader keeps the name from the file in userData.name (o.name may have a suffix such as _1)");
    out.push(`    const key = (o.userData.name ?? o.name)${ts ? " as PartName" : ""};`);
    out.push("    if (key && !(key in parts)) parts[key] = o;");
    out.push(`    const list = (Array.isArray((o${ts ? " as any" : ""}).material) ? (o${ts ? " as any" : ""}).material : [(o${ts ? " as any" : ""}).material]).filter(Boolean);`);
    out.push("    for (const m of list) if (m.name && !(m.name in materials)) materials[m.name] = m;");
    out.push("  });");
    if (clips.length) {
      out.push("  const mixer = new AnimationMixer(root);");
      out.push(`  const actions${ts ? ": Partial<Record<ClipName, AnimationAction>>" : ""} = {};`);
      out.push(`  for (const clip of gltf.animations) actions[clip.name${ts ? " as ClipName" : ""}] = mixer.clipAction(clip);`);
    } else out.push("  const mixer = null;", `  const actions${ts ? ": Partial<Record<ClipName, AnimationAction>>" : ""} = {};`);
    out.push("  const dispose = () => {");
    out.push("    root.removeFromParent();");
    out.push(`    root.traverse((o${ts ? ": any" : ""}) => {`);
    out.push("      o.geometry?.dispose();");
    out.push("      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {");
    out.push("        for (const v of Object.values(m)) if ((v as { isTexture?: boolean } | null)?.isTexture) (v as { dispose(): void }).dispose();".replace(/ as \{[^}]+\}( \| null)?/g, ts ? "$&" : ""));
    out.push("        m.dispose();");
    out.push("      }");
    out.push("    });");
    if (clips.length) out.push("    mixer.stopAllAction();", "    mixer.uncacheRoot(root);");
    out.push("  };");
    out.push("  return { root, parts, materials, mixer, actions, animations: gltf.animations, dispose };");
    out.push("}");
    return { code: `${out.join("\n")}\n`, file: `${name}.${ts ? "ts" : "js"}`, name: fn, url, style, tree, parts, clips, decoders };
  }

  // React Three Fiber
  why = treeBlocker(j);
  tree = !why;
  const draco = decoders.includes("draco");
  const meshopt = decoders.includes("meshopt");
  const ktx2 = decoders.includes("ktx2");
  out.push(`// ${base}: ${info.triangles} triangles, ${info.materials.length} material(s), ${clips.length} animation(s). Made by threesmith model code.`);
  out.push(`import { useMemo${clips.length || tree ? ", useRef" : ""} } from 'react';`);
  out.push(`import { useGLTF${clips.length ? ", useAnimations" : ""} } from '@react-three/drei';`);
  if (ktx2) out.push("import { useThree } from '@react-three/fiber';", "import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';");
  if (!tree) out.push("import { clone } from 'three/addons/utils/SkeletonUtils.js';");
  if (ts) out.push("import type { ThreeElements } from '@react-three/fiber';", "import type { Object3D } from 'three';");
  out.push("", `const URL = ${q(url)};`);
  // useGLTF(path, useDraco, useMeshopt, extendLoader): true uses drei's CDN decoder; a path serves it yourself
  const dracoArg = draco ? "true" : "false";
  const loaderArgs = ktx2 ? `, ${dracoArg}, ${meshopt ? "true" : "false"}, extend` : meshopt ? `, ${dracoArg}, true` : draco ? ", true" : "";
  if (ktx2) {
    out.push("", "/** KTX2 textures: a transcoder set up for this renderer (copy node_modules/three/examples/jsm/libs/basis/ to public/basis/ to serve it yourself). */");
    out.push("let ktx2Loader" + (ts ? ": KTX2Loader | undefined" : "") + ";");
  }
  out.push("", `export function ${name}(props${ts ? ": ThreeElements['group']" : ""}) {`);
  if (ktx2) {
    out.push("  const gl = useThree((s) => s.gl);");
    out.push(`  const extend = (loader${ts ? ": any" : ""}) => {`, "    ktx2Loader ??= new KTX2Loader().setTranscoderPath('/basis/').detectSupport(gl);", "    loader.setKTX2Loader(ktx2Loader);", "  };");
  }
  out.push(`  const { ${tree ? "nodes" : "scene"}${clips.length ? ", animations" : ""} } = useGLTF(URL${loaderArgs})${ts ? " as any" : ""};`);
  if (clips.length || tree) out.push(`  const group = useRef${ts ? "<any>" : ""}(null);`);
  if (clips.length) {
    out.push("  // actions by clip name: " + clips.map((c) => q(c)).join(", "));
    out.push("  const { actions } = useAnimations(animations, group);");
  }
  if (tree) {
    out.push("  return (", "    <group ref={group} {...props} dispose={null}>");
    const lines: string[] = [];
    const roots = j.scenes?.[j.scene ?? 0]?.nodes ?? [];
    for (const i of roots) jsxNode(j, i, 3, lines);
    out.push(...lines, "    </group>", "  );", "}");
  } else {
    out.push(`  // one copy per use (${why})`);
    if (parts.length) out.push(`  // a part by its name in the file: copy.getObjectsByProperty('name', ...) can miss renamed ones; match o.userData.name === ${q(parts[0])}`);
    out.push("  const copy = useMemo(() => clone(scene), [scene]);");
    out.push(`  return <primitive ${clips.length ? "ref={group} " : ""}object={copy} {...props} />;`, "}");
  }
  out.push("", `useGLTF.preload(URL${draco && !ktx2 ? ", true" : ""});`);
  if (ktx2) out.push("// useGLTF.preload needs the KTX2 loader too: preload inside a component that has the renderer.");
  return { code: `${out.join("\n")}\n`, file: `${name}.${ts ? "tsx" : "jsx"}`, name, url, style, tree, ...(why ? { why } : {}), parts, clips, decoders };
}

export function formatModelCode(r: CodeResult, written?: string): string {
  const out = [
    `${r.style === "r3f" ? `React Three Fiber component ${r.name}` : `module with ${r.name}()`} for ${r.url}: ${r.parts.length} named part(s), ${r.clips.length} animation(s)${r.decoders.length ? `, decoders: ${r.decoders.join(", ")}` : ""}.`,
  ];
  if (r.style === "r3f") out.push(r.tree ? "The node tree is written out as JSX: edit positions, materials and props per part." : `One <primitive> (${r.why}); parts are looked up by their name in the file.`);
  out.push(written ? `Written to ${written} (three_undo takes it back).` : "", "```" + (r.file.endsWith("x") ? "jsx" : "js"), r.code.trimEnd(), "```");
  return out.filter(Boolean).join("\n");
}
