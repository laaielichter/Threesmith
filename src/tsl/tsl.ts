import { settle } from "../check/clock.js";
import type { Issue } from "../check/check.js";
import type { PageOptions } from "../check/page.js";
import { openRunPage } from "../check/play.js";
import { review } from "../review/review.js";
import { lineOf, collect } from "../review/source.js";
import { tslImports } from "../review/scene-rules.js";
import { blankStrings } from "../review/tsl-rules.js";
import { closeOf } from "../review/parse.js";
import type { Finding } from "../review/types.js";

/**
 * TSL, seen from the files and from the running page. `outline` maps the TSL in the project (Fn definitions with
 * their layout, uniforms, the node slots each material sets, compute kernels) next to the review's TSL findings.
 * `graph` reads the node graph a material really has in the page, slot by slot, as an indented tree. `shader` asks
 * WebGPURenderer for the code it generated for one object (WGSL on WebGPU, GLSL on the WebGL 2 fallback) and shows
 * the lines that matter. The page parts need WebGPURenderer (three/webgpu).
 */

const TSL_RULE = /^(?:tsl-|node-material-webgl$|webgpu-glsl-material$|unknown-symbol$)/;

export interface TslFileOutline {
  file: string;
  imports: number;
  fns: { name: string; line: number; layout?: string }[];
  uniforms: { name: string; line: number }[];
  slots: { target: string; slot: string; line: number; expr: string }[];
  computes: number[];
}

export interface TslOutline {
  root: string;
  files: TslFileOutline[];
  renderer: "WebGPURenderer" | "WebGLRenderer" | "both" | "none";
  findings: Finding[];
}

export function outline(rootDir: string): TslOutline {
  const files: TslFileOutline[] = [];
  const all = collect(rootDir).files;
  let gpu = false;
  let gl = false;
  for (const f of all) {
    if (/\bWebGPURenderer\b/.test(f.text)) gpu = true;
    if (/\bnew\s+(?:[\w$]+\.)?WebGLRenderer\b/.test(f.text)) gl = true;
    const imported = tslImports(f);
    const ns = /import\s*\*\s*as\s+[\w$]+\s+from\s*['"]three\/tsl['"]/.test(f.text);
    if (!imported.size && !ns && !/\w+Node\s*=/.test(f.text)) continue;
    const text = blankStrings(f.text);
    const o: TslFileOutline = { file: f.path, imports: imported.size, fns: [], uniforms: [], slots: [], computes: [] };
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\.)?Fn\s*\(/g)) {
      // the layout: .setLayout({ name }) right after the Fn( ... ) call, or Fn(fn, { name }) as its second argument
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(f.text, open);
      const after = close > 0 ? f.text.slice(close + 1, close + 400) : "";
      const inner = close > 0 ? f.text.slice(open, close) : "";
      const layout = /^\s*\.setLayout\s*\(\s*\{[^}]*?name\s*:\s*['"]([\w$]+)['"]/.exec(after)?.[1] ?? /,\s*\{[^{}]*?name\s*:\s*['"]([\w$]+)['"][^{}]*\}\s*$/.exec(inner)?.[1];
      o.fns.push({ name: m[1]!, line: lineOf(f.text, m.index ?? 0), ...(layout ? { layout } : {}) });
    }
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:[\w$]+\.)?uniform\s*\(/g)) o.uniforms.push({ name: m[1]!, line: lineOf(f.text, m.index ?? 0) });
    for (const m of text.matchAll(/([\w$.]+)\.((?:color|position|normal|emissive|opacity|roughness|metalness|alphaTest|output|fragment|vertex|mask|depth|shadow\w*|clearcoat\w*|sheen\w*|iridescence\w*|transmission|thickness|aoNode|light\w*|backdrop\w*|mrt)\w*Node)\s*=(?!=)\s*([^;\n]{0,80})/g)) {
      o.slots.push({ target: m[1]!, slot: m[2]!, line: lineOf(f.text, m.index ?? 0), expr: f.text.slice((m.index ?? 0) + m[0].length - m[3]!.length, (m.index ?? 0) + m[0].length).trim() });
    }
    for (const m of text.matchAll(/\.compute\s*\(/g)) o.computes.push(lineOf(f.text, m.index ?? 0));
    if (o.fns.length || o.uniforms.length || o.slots.length || o.computes.length || o.imports) files.push(o);
  }
  const r = review({ path: rootDir });
  const tslFiles = new Set(files.map((f) => f.file));
  const findings = r.findings.filter((x) => TSL_RULE.test(x.rule) && (x.rule !== "unknown-symbol" || tslFiles.has(x.file)));
  return { root: rootDir, files, renderer: gpu && gl ? "both" : gpu ? "WebGPURenderer" : gl ? "WebGLRenderer" : "none", findings };
}

export function formatOutline(o: TslOutline, detail: "brief" | "full" = "brief"): string {
  if (!o.files.length) return "No TSL in this project (nothing imports from 'three/tsl' or sets a *Node slot).";
  const cap = detail === "full" ? 500 : 12;
  const out = [`TSL in ${o.files.length} file(s); renderer: ${o.renderer}.`];
  if (o.renderer === "WebGLRenderer") out.push("Note: only WebGPURenderer (three/webgpu) builds node materials; WebGLRenderer ignores the *Node slots unless a nodes handler is set.");
  for (const f of o.files.slice(0, cap)) {
    out.push(`${f.file}: ${f.imports} TSL import(s)`);
    for (const fn of f.fns.slice(0, cap)) out.push(`  Fn ${fn.name} (line ${fn.line})${fn.layout ? `, layout "${fn.layout}"` : ", inline (no layout)"}`);
    for (const u of f.uniforms.slice(0, cap)) out.push(`  uniform ${u.name} (line ${u.line})`);
    for (const s of f.slots.slice(0, cap)) out.push(`  ${s.target}.${s.slot} = ${s.expr.slice(0, 70)} (line ${s.line})`);
    if (f.computes.length) out.push(`  compute at line ${f.computes.slice(0, 6).join(", ")}`);
  }
  if (o.files.length > cap) out.push(`+${o.files.length - cap} more file(s)`);
  if (o.findings.length) {
    out.push(`Findings (${o.findings.length}):`);
    for (const x of o.findings.slice(0, detail === "full" ? 200 : 15)) out.push(`  ${x.file}:${x.line} ${x.severity} [${x.rule}] ${x.message} Fix: ${x.fix}`);
  } else out.push("No TSL findings in the review.");
  out.push("Next: three_tsl op graph (the node graph in the running page) or op shader (the code three generated) for an object by name.");
  return out.join("\n");
}

// ---------------------------------------------------------------- live

export interface GraphNode {
  /** Indentation depth. */
  d: number;
  /** One line: type and what identifies it (op, method, name, value). */
  t: string;
}

export interface LiveTsl {
  ok: boolean;
  url: string;
  text: string;
  issues: Issue[];
}

/** In the page: the node graph of the named object's material (or every node material), slot by slot. */
export const GRAPH_EVAL = `(async ([name, maxDepth, maxLines]) => {
  const ts = window.__tsScene;
  const first = (list) => { for (const r of list) { const o = r.deref(); if (o) return o; } return null; };
  const scene = ts && ((ts.last && ts.last.scene) || first(ts.scenes));
  if (!scene) return { error: 'no three.js scene was announced on this page' };
  const objs = [];
  scene.traverse((o) => { const m = o.material && (Array.isArray(o.material) ? o.material[0] : o.material); if (m && (!name || o.name === name || (m.name && m.name === name))) objs.push([o, m]); });
  if (!objs.length) return { error: name ? 'no object or material named "' + name + '"' : 'no object with a material' };
  const SLOTS = ['colorNode','positionNode','normalNode','emissiveNode','opacityNode','roughnessNode','metalnessNode','alphaTestNode','outputNode','fragmentNode','vertexNode','maskNode','depthNode','castShadowNode','receivedShadowNode','aoNode','lightsNode','backdropNode','mrtNode'];
  const label = (n) => {
    const parts = [n.type || (n.constructor && n.constructor.name) || 'Node'];
    if (n.op) parts.push(n.op);
    if (n.method) parts.push(n.method);
    if (n.name) parts.push('"' + n.name + '"');
    else if (n._attributeName) parts.push('"' + n._attributeName + '"');
    if (n.isConstNode || n.isUniformNode || n.isInputNode) { const v = n.value; parts.push('= ' + (v === null || v === undefined ? String(v) : typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v.isColor ? '#' + v.getHexString() : v.isVector2 || v.isVector3 || v.isVector4 ? '(' + v.toArray().map((x) => Math.round(x * 1e3) / 1e3).join(', ') + ')' : v.isTexture ? 'texture "' + (v.name || v.uuid.slice(0, 8)) + '"' : (v.constructor && v.constructor.name) || typeof v)); }
    if (n.isUniformNode) parts.push('(uniform)');
    if (n.components) parts.push('.' + n.components);
    if (n.nodeType) parts.push(': ' + n.nodeType);
    return parts.join(' ');
  };
  const lines = [];
  let truncated = false;
  const walk = (n, d, seen) => {
    if (lines.length >= maxLines) { truncated = true; return; }
    if (!n || typeof n !== 'object' || !n.isNode) { lines.push({ d, t: typeof n === 'number' ? String(n) : '(not a node: ' + (n === null ? 'null' : typeof n) + ')' }); return; }
    if (seen.has(n)) { lines.push({ d, t: label(n) + '  (shared, shown above)' }); return; }
    seen.add(n);
    lines.push({ d, t: label(n) });
    if (d >= maxDepth) { if (n.getChildren && n.getChildren().length) lines.push({ d: d + 1, t: '...' }); return; }
    let kids = [];
    try { kids = n.getChildren ? n.getChildren() : []; } catch (e) { kids = []; }
    for (const k of kids) if (!(k && k.isUniformGroupNode)) walk(k, d + 1, seen);
  };
  const out = [];
  for (const [o, m] of objs.slice(0, 6)) {
    const slots = SLOTS.filter((s) => m[s]);
    out.push({ object: o.name || o.type, material: m.type + (m.name ? ' "' + m.name + '"' : ''), isNode: !!m.isNodeMaterial, slots: slots.length });
    for (const s of slots) { lines.push({ d: 0, t: (o.name || o.type) + '.' + s + ':' }); walk(m[s], 1, new Set()); }
  }
  const r = (ts.last && ts.last.renderer) || first(ts.renderers);
  return { objects: out, lines, truncated, more: Math.max(0, objs.length - 6), renderer: r ? (r.isWebGPURenderer ? 'WebGPURenderer' : r.isWebGLRenderer ? 'WebGLRenderer' : (r.constructor && r.constructor.name) || 'Renderer') : null, backend: r && r.backend ? (r.backend.isWebGPUBackend ? 'WebGPU' : r.backend.isWebGLBackend ? 'WebGL 2' : null) : null };
})`;

/** In the page: the shader code WebGPURenderer generated for an object. */
export const SHADER_EVAL = `(async ([name]) => {
  const ts = window.__tsScene;
  const first = (list) => { for (const r of list) { const o = r.deref(); if (o) return o; } return null; };
  const scene = ts && ((ts.last && ts.last.scene) || first(ts.scenes));
  const renderer = ts && ((ts.last && ts.last.renderer) || first(ts.renderers));
  let camera = ts && ts.last && ts.last.camera;
  if (!scene || !renderer) return { error: 'no three.js scene or renderer on this page' };
  if (!camera) scene.traverse((o) => { if (!camera && o.isCamera) camera = o; });
  if (!renderer.debug || typeof renderer.debug.getShaderAsync !== 'function') return { error: 'the renderer cannot show generated code (this needs WebGPURenderer from three/webgpu, r168 or newer)' };
  let obj = null;
  scene.traverse((o) => { if (!obj && o.material && (o.isMesh || o.isPoints || o.isLine || o.isSprite) && (!name || o.name === name)) obj = o; });
  if (!obj) return { error: name ? 'no drawable object named "' + name + '"' : 'no drawable object' };
  try {
    const s = await renderer.debug.getShaderAsync(scene, camera, obj);
    return { object: obj.name || obj.type, material: obj.material.type, backend: renderer.backend && renderer.backend.isWebGPUBackend ? 'WGSL (WebGPU)' : 'GLSL (WebGL 2 fallback)', vertex: s.vertexShader || '', fragment: s.fragmentShader || '' };
  } catch (e) { return { error: 'getShaderAsync failed: ' + (e && e.message || e) }; }
})`;

export interface LiveOptions extends PageOptions {
  wait?: number;
  /** Object (or material) name; default every object (graph) or the first drawable (shader). */
  object?: string;
  /** shader: show only lines that contain this text (with 2 lines around), e.g. a uniform name. */
  find?: string;
  /** shader: vertex, fragment or both (default fragment). */
  stage?: "vertex" | "fragment" | "both";
  /** graph: depth and lines at most. */
  depth?: number;
  maxLines?: number;
}

function codeView(code: string, find: string | undefined, maxLines: number): string[] {
  const lines = code.split("\n");
  if (!find) return [...lines.slice(0, maxLines).map((l, i) => `${String(i + 1).padStart(4)}  ${l}`), ...(lines.length > maxLines ? [`  ... ${lines.length - maxLines} more line(s); pass find to jump to a name`] : [])];
  const hits = new Set<number>();
  lines.forEach((l, i) => {
    if (l.includes(find)) for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 2); k++) hits.add(k);
  });
  if (!hits.size) return [`  "${find}" is not in this code (${lines.length} lines). Names in TSL: uniform names, .toVar('name'), setLayout names.`];
  const out: string[] = [];
  let prev = -2;
  for (const i of [...hits].sort((a, b) => a - b).slice(0, maxLines)) {
    if (i !== prev + 1) out.push("  ...");
    out.push(`${String(i + 1).padStart(4)}  ${lines[i]}`);
    prev = i;
  }
  return out;
}

export async function live(op: "graph" | "shader", opts: LiveOptions): Promise<LiveTsl> {
  const o = await openRunPage(opts);
  try {
    if (!o.loaded) return { ok: false, url: o.url, text: "The page did not load.", issues: o.issues };
    await settle(o.page, opts.wait ?? 1500);
    const out: string[] = [];
    let ok = true;
    if (op === "graph") {
      const r = (await o.page.evaluate(`${GRAPH_EVAL}(${JSON.stringify([opts.object ?? "", Math.max(1, Math.min(12, opts.depth ?? 6)), Math.max(10, Math.min(600, opts.maxLines ?? 120))])})`)) as
        | { error: string }
        | { objects: { object: string; material: string; isNode: boolean; slots: number }[]; lines: GraphNode[]; truncated: boolean; more: number; renderer: string | null; backend: string | null };
      if ("error" in r) return { ok: false, url: o.url, text: r.error, issues: o.issues };
      out.push(`renderer: ${r.renderer ?? "none"}${r.backend ? ` (${r.backend} backend)` : ""}`);
      for (const x of r.objects) out.push(`${x.object}: ${x.material}${x.isNode ? "" : " (not a node material)"}, ${x.slots} node slot(s)`);
      if (r.renderer === "WebGLRenderer" && r.objects.some((x) => x.slots)) out.push("Note: WebGLRenderer does not build these node slots (only WebGPURenderer from three/webgpu does).");
      if (!r.lines.length) out.push("No node slots are set: the material uses its built-in shader.");
      for (const l of r.lines) out.push(`${"  ".repeat(l.d)}${l.t}`);
      if (r.truncated) out.push("... (max_lines)");
      if (r.more) out.push(`+${r.more} more object(s); pass object to pick one`);
    } else {
      const r = (await o.page.evaluate(`${SHADER_EVAL}(${JSON.stringify([opts.object ?? ""])})`)) as { error: string } | { object: string; material: string; backend: string; vertex: string; fragment: string };
      if ("error" in r) return { ok: false, url: o.url, text: r.error, issues: o.issues };
      out.push(`${r.object} (${r.material}): ${r.backend}`);
      const stage = opts.stage ?? "fragment";
      const cap = opts.find ? 80 : 60;
      if (stage !== "fragment") out.push(`vertex (${r.vertex.split("\n").length} lines):`, ...codeView(r.vertex, opts.find, cap));
      if (stage !== "vertex") out.push(`fragment (${r.fragment.split("\n").length} lines):`, ...codeView(r.fragment, opts.find, cap));
    }
    const errors = o.issues.filter((i) => i.severity === "error");
    if (errors.length) {
      ok = false;
      out.push("Errors on the page:");
      for (const e of errors.slice(0, 6)) out.push(`  [${e.kind}] ${e.message.split("\n")[0]}${e.explanations?.[0] ? ` → ${e.explanations[0].title}: ${e.explanations[0].fix}` : ""}`);
    }
    return { ok, url: o.url, text: out.join("\n"), issues: o.issues };
  } finally {
    await o.close();
  }
}
