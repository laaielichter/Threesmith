import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callArgs, splitTop } from "../review/parse.js";
import { collect, lineOf } from "../review/source.js";
import { pageOp, sessionFolder } from "../session/session.js";

/**
 * Tune a scene live, then keep the result in the code. An agent (or a person through it) changes a value in the page
 * three_session keeps running (a light's intensity, a material's roughness, the camera's fov, an object's position,
 * the exposure) and sees the result at once, without a reload. When it looks right, `save` finds where each value is
 * set in the source (an assignment, a set() call, a constructor argument, an option of the material) and writes the
 * new values there, as one undoable step; a value the code never sets gets one new line after the object is made.
 */

export type ValueKind = "number" | "boolean" | "color" | "vector" | "string";

export interface Tweak {
  object: string;
  prop: string;
  kind: ValueKind;
  /** The value before the first tweak of this object and property (for reset). */
  original: unknown;
  value: unknown;
}

export class TuneError extends Error {}

/** Tweaks per live page name, in the order they were made (the last one of a property wins). */
const tweaks = new Map<string, Tweak[]>();

export function tweaksOf(name = "main"): Tweak[] {
  return tweaks.get(name) ?? [];
}

export function clearTweaks(name = "main"): void {
  tweaks.delete(name);
}

const PROP = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,3}$/;
const OBJECT = /^[^'"`\\\n]{1,80}$/;

/** In the page: set object.prop to value and return what it was and is, in a form that can be written as code. */
function setJs(object: string, prop: string, value: unknown): string {
  return `
    const want = ${JSON.stringify(value)};
    const name = ${JSON.stringify(object)};
    const root = name === 'camera' ? camera : name === 'renderer' ? renderer : name === 'scene' ? scene : name === 'fog' ? scene && scene.fog : $(name);
    if (!root) throw new Error('no object named "' + name + '" in the scene (camera, renderer, scene and fog work too)');
    const path = ${JSON.stringify(prop)}.split('.');
    let owner = root;
    for (const k of path.slice(0, -1)) { owner = owner[k]; if (owner === undefined || owner === null) throw new Error('"' + k + '" is not set on ' + name); }
    const key = path[path.length - 1];
    const cur = owner[key];
    const r = (n) => Math.round(n * 1e4) / 1e4;
    const read = (v) => v && v.isColor ? { kind: 'color', v: '#' + v.getHexString() } : v && (v.isVector2 || v.isVector3 || v.isVector4 || v.isEuler) ? { kind: 'vector', v: v.toArray().slice(0, v.isEuler ? 3 : undefined).map(r) } : typeof v === 'number' ? { kind: 'number', v: r(v) } : typeof v === 'boolean' ? { kind: 'boolean', v } : typeof v === 'string' ? { kind: 'string', v } : { kind: 'other', v: v === undefined ? 'undefined' : (v && v.constructor && v.constructor.name) || typeof v };
    const before = read(cur);
    if (cur && cur.isColor) cur.set(want);
    else if (cur && (cur.isVector2 || cur.isVector3 || cur.isVector4 || cur.isEuler)) { if (!Array.isArray(want)) throw new Error(key + ' is a vector: pass an array such as [0, 1, 0]'); cur.fromArray(want); }
    else if (before.kind === 'other' && cur !== undefined && cur !== null) throw new Error(key + ' is a ' + before.v + ', not a number, colour, vector or flag');
    else owner[key] = want;
    if (owner.isMaterial && typeof want === 'boolean') owner.needsUpdate = true;
    if ((owner.isPerspectiveCamera || owner.isOrthographicCamera) && /^(fov|near|far|zoom|aspect|left|right|top|bottom|filmGauge|filmOffset)$/.test(key)) owner.updateProjectionMatrix();
    if (owner.isTexture) owner.needsUpdate = true;
    const after = read(owner[key]);
    return { before, after };
  `;
}

export interface SetResult {
  object: string;
  prop: string;
  kind: ValueKind;
  before: unknown;
  after: unknown;
  errors: string[];
}

/** Change a value in the live page and remember it for save. */
export async function tuneSet(name: string, object: string, prop: string, value: unknown): Promise<SetResult> {
  if (!OBJECT.test(object)) throw new TuneError("object must be a name (no quotes or backslashes), or camera, renderer, scene, fog");
  if (!PROP.test(prop)) throw new TuneError(`prop must be a property path such as intensity, position, material.roughness (got "${prop}")`);
  if (!["number", "boolean", "string"].includes(typeof value) && !(Array.isArray(value) && value.length >= 2 && value.length <= 4 && value.every((x) => typeof x === "number" && Number.isFinite(x)))) {
    throw new TuneError("value must be a number, true/false, a colour ('#ff8800' or 0xff8800 as a number) or an array of 2 to 4 numbers");
  }
  if (typeof value === "number" && !Number.isFinite(value)) throw new TuneError("value must be a finite number");
  const r = await pageOp({ op: "eval", js: setJs(object, prop, value) }, name);
  if (!r.ok) throw new TuneError(r.text.replace(/^error: (?:Error: )?/, "").split("\n")[0] ?? r.text);
  const v = r.value as { before: { kind: string; v: unknown }; after: { kind: string; v: unknown } };
  const kind = (["number", "boolean", "color", "vector", "string"].includes(v.after.kind) ? v.after.kind : "number") as ValueKind;
  const list = tweaks.get(name) ?? [];
  const old = list.find((t) => t.object === object && t.prop === prop);
  if (old) old.value = v.after.v;
  else list.push({ object, prop, kind, original: v.before.v, value: v.after.v });
  tweaks.set(name, list);
  return { object, prop, kind, before: v.before.v, after: v.after.v, errors: r.errors.filter((e) => e.kind !== "console-warn").map((e) => e.message) };
}

/** Put every tweaked value back to what it was before the first tweak. */
export async function tuneReset(name: string): Promise<number> {
  const list = tweaksOf(name);
  for (const t of [...list].reverse()) await pageOp({ op: "eval", js: setJs(t.object, t.prop, t.original) }, name);
  clearTweaks(name);
  return list.length;
}

// ---------------------------------------------------------------- back to the source

export interface Edit {
  file: string;
  line: number;
  /** assignment, set() call, constructor argument, material option, or a new line. */
  how: "assignment" | "setter" | "constructor" | "option" | "insert";
  start: number;
  end: number;
  from: string;
  to: string;
}

export interface SavePlan {
  root: string;
  edits: (Edit & { tweak: Tweak })[];
  /** Tweaks with no place found in the code (an object the code does not name, a value from a model). */
  missing: { tweak: Tweak; why: string }[];
  files: { file: string; data: string }[];
}

/** Constructor arguments by class: which argument is which property. */
const CTOR: Record<string, string[]> = {
  AmbientLight: ["color", "intensity"],
  HemisphereLight: ["color", "groundColor", "intensity"],
  DirectionalLight: ["color", "intensity"],
  PointLight: ["color", "intensity", "distance", "decay"],
  SpotLight: ["color", "intensity", "distance", "angle", "penumbra", "decay"],
  RectAreaLight: ["color", "intensity", "width", "height"],
  PerspectiveCamera: ["fov", "aspect", "near", "far"],
  OrthographicCamera: ["left", "right", "top", "bottom", "near", "far"],
  Fog: ["color", "near", "far"],
  FogExp2: ["color", "density"],
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const num = (n: number) => String(Math.round(n * 1e4) / 1e4);

/** The new value as code, in the style of the old one (0x hex, a '#hex' string, a number). */
export function codeFor(t: Pick<Tweak, "kind" | "value">, old = ""): string {
  if (t.kind === "color") {
    const hex = String(t.value).replace(/^#/, "").toLowerCase();
    const q = /^\s*(['"`])/.exec(old)?.[1];
    return q ? `${q}#${hex}${q}` : `0x${hex}`;
  }
  if (t.kind === "vector") return (t.value as number[]).map(num).join(", ");
  if (t.kind === "number") return num(t.value as number);
  if (t.kind === "string") return JSON.stringify(t.value);
  return String(t.value);
}

interface Src {
  file: string;
  raw: string;
  /** Comments blanked, same offsets. */
  text: string;
}

/** Where the code names an object: variables that hold it, and the offset of the statement that made or named it. */
function holders(srcs: Src[], object: string): { src: Src; v: string; at: number }[] {
  const out: { src: Src; v: string; at: number }[] = [];
  const special: Record<string, string> = { camera: "(?:Perspective|Orthographic)Camera", renderer: "(?:WebGL|WebGPU)Renderer", scene: "Scene", fog: "Fog(?:Exp2)?" };
  for (const src of srcs) {
    if (special[object]) {
      for (const m of src.text.matchAll(new RegExp(String.raw`([\w$]+(?:\.[\w$]+)*)\s*=\s*new\s+(?:[\w$]+\.)?(?:${special[object]})\s*\(`, "g"))) out.push({ src, v: m[1]!, at: m.index ?? 0 });
      continue;
    }
    for (const m of src.text.matchAll(new RegExp(String.raw`([\w$]+(?:\.[\w$]+)*)\.name\s*=\s*['"\`]${esc(object)}['"\`]`, "g"))) out.push({ src, v: m[1]!, at: m.index ?? 0 });
    for (const m of src.text.matchAll(new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=\s*[\w$.]+\.getObjectByName\(\s*['"\`]${esc(object)}['"\`]\s*\)`, "g"))) out.push({ src, v: m[1]!, at: m.index ?? 0 });
  }
  return out;
}

/** `v = new Cls(args)`: the class and the argument list. */
function creation(src: Src, v: string): { cls: string; args: { start: number; end: number }; at: number } | undefined {
  const m = new RegExp(String.raw`(?<![\w$.])${esc(v)}\s*=\s*new\s+(?:[\w$]+\.)?([\w$]+)\s*\(`).exec(src.text);
  if (!m) return undefined;
  const args = callArgs(src.text, (m.index ?? 0) + m[0].length - 1);
  return args ? { cls: m[1]!, args, at: m.index ?? 0 } : undefined;
}

const parts = (src: Src, r: { start: number; end: number }) => splitTop(src.text.slice(r.start, r.end)).map((p) => ({ text: p.text, offset: r.start + p.at }));

/** Find the place in the code for one tweak of a variable `v`, or undefined. */
function placeFor(src: Src, v: string, t: Tweak, depth = 0): Edit | undefined {
  const path = t.prop;
  const at = (start: number) => lineOf(src.raw, start);
  const edit = (how: Edit["how"], start: number, end: number, to: string): Edit => ({ file: src.file, line: at(start), how, start, end, from: src.raw.slice(start, end), to });
  // 1. v.prop = value  (a vector or colour assigned a new object keeps its shape: replace only its arguments)
  const assign = new RegExp(String.raw`(?<![\w$.])${esc(v)}\.${esc(path)}\s*=(?!=)\s*`, "g");
  for (const m of src.text.matchAll(assign)) {
    const from = (m.index ?? 0) + m[0].length;
    const end = from + (/^[^;\n]*/.exec(src.text.slice(from))?.[0].trimEnd().length ?? 0);
    const rhs = src.raw.slice(from, end);
    const ctor = /^new\s+(?:[\w$]+\.)?(?:Color|Vector[234]|Euler)\s*\(/.exec(rhs);
    if (ctor) {
      const args = callArgs(src.text, from + ctor[0].length - 1);
      if (args) return edit("assignment", args.start, args.end, codeFor(t, src.raw.slice(args.start, args.end)));
    }
    if (t.kind === "vector") continue;
    return edit("assignment", from, end, codeFor(t, rhs));
  }
  // 2. v.prop.set(...), setHex, setScalar, setRGB with one value
  const setter = new RegExp(String.raw`(?<![\w$.])${esc(v)}\.${esc(path)}\.(set|setHex|setStyle)\s*\(`, "g");
  for (const m of src.text.matchAll(setter)) {
    const args = callArgs(src.text, (m.index ?? 0) + m[0].length - 1);
    if (args) return edit("setter", args.start, args.end, codeFor(t, src.raw.slice(args.start, args.end)));
  }
  const made = creation(src, v);
  // 3. constructor argument
  const order = made && CTOR[made.cls];
  const ix = order ? order.indexOf(path) : -1;
  if (made && ix >= 0) {
    const ps = parts(src, made.args);
    const p = ps[ix];
    if (p && p.text.trim()) {
      const s = p.offset + (p.text.length - p.text.trimStart().length);
      return edit("constructor", s, p.offset + p.text.trimEnd().length, codeFor(t, p.text));
    }
  }
  // 4. an option of the object's own constructor ({ color, roughness }) or of its material
  const [head, ...rest] = path.split(".");
  if (made && !rest.length) {
    const first = parts(src, made.args).find((p) => p.text.trim().startsWith("{"));
    if (first && /Material$/.test(made.cls)) {
      const key = new RegExp(String.raw`(?:^|[{,]\s*)${esc(path)}\s*:\s*`).exec(first.text);
      if (key) {
        const s = first.offset + key.index + key[0].length;
        const value = /^(?:[^,{}()[\]]|\([^()]*\)|\[[^[\]]*\])*/.exec(src.text.slice(s))?.[0].trimEnd() ?? "";
        if (value) return edit("option", s, s + value.length, t.kind === "vector" ? `[${codeFor(t)}]` : codeFor(t, value));
      }
      const open = first.offset + first.text.indexOf("{");
      const empty = /^\{\s*\}$/.test(first.text.trim());
      return edit("option", open + 1, open + 1, ` ${path}: ${t.kind === "vector" ? `[${codeFor(t)}]` : codeFor(t)}${empty ? " " : ","}`);
    }
  }
  if (head === "material" && rest.length && depth < 1 && made && /Mesh|Points|Line|Sprite/.test(made.cls)) {
    const mat = parts(src, made.args)[made.cls === "Sprite" ? 0 : 1];
    const m = mat?.text.trim();
    if (m && /^[\w$]+$/.test(m)) {
      const inner = placeFor(src, m, { ...t, prop: rest.join(".") }, depth + 1);
      if (inner) return inner;
    } else if (mat && m && /^new\s/.test(m)) {
      // an inline material: its options object
      const cls = /^new\s+(?:[\w$]+\.)?([\w$]+)\s*\(/.exec(m);
      const argsAt = mat.offset + mat.text.indexOf("(");
      const args = cls && callArgs(src.text, argsAt);
      if (cls && args && /Material$/.test(cls[1]!)) {
        const opt = parts(src, args).find((p) => p.text.trim().startsWith("{"));
        const key = rest.join(".");
        if (opt) {
          const k = new RegExp(String.raw`(?:^|[{,]\s*)${esc(key)}\s*:\s*`).exec(opt.text);
          if (k) {
            const s = opt.offset + k.index + k[0].length;
            const value = /^(?:[^,{}()[\]]|\([^()]*\)|\[[^[\]]*\])*/.exec(src.text.slice(s))?.[0].trimEnd() ?? "";
            if (value) return edit("option", s, s + value.length, codeFor(t, value));
          }
          const open = opt.offset + opt.text.indexOf("{");
          return edit("option", open + 1, open + 1, ` ${key}: ${codeFor(t)},`);
        }
      }
    }
  }
  return undefined;
}

/** The new line for a value the code never sets: after the statement that made or named the object. */
function insertFor(src: Src, v: string, at: number, t: Tweak): Edit {
  const lineEnd = src.raw.indexOf("\n", at);
  let end = lineEnd < 0 ? src.raw.length : lineEnd;
  // a creation that spans lines: after its closing bracket
  const made = creation(src, v);
  if (made && made.at === at) {
    const nl = src.raw.indexOf("\n", made.args.end);
    end = nl < 0 ? src.raw.length : nl;
  }
  const lineStart = src.raw.lastIndexOf("\n", at) + 1;
  const indent = /^[ \t]*/.exec(src.raw.slice(lineStart))?.[0] ?? "";
  const code = t.kind === "vector" || t.kind === "color" ? `${v}.${t.prop}.set(${codeFor(t)});` : `${v}.${t.prop} = ${codeFor(t)};`;
  return { file: src.file, line: lineOf(src.raw, end) + 1, how: "insert", start: end, end, from: "", to: `\n${indent}${code}` };
}

/** Where each tweak goes in the code, and the files with the new values (nothing is written here). */
export function planSave(root: string, list: readonly Tweak[]): SavePlan {
  const srcs: Src[] = collect(root)
    .files.filter((f) => !/\.html?$/.test(f.path) || /<script/i.test(f.raw))
    .map((f) => ({ file: f.path, raw: f.raw, text: f.text }));
  const plan: SavePlan = { root, edits: [], missing: [], files: [] };
  for (const t of list) {
    const hs = holders(srcs, t.object);
    if (!hs.length) {
      plan.missing.push({ tweak: t, why: t.object === "camera" || t.object === "renderer" || t.object === "scene" || t.object === "fog" ? `no \`new ...\` for the ${t.object} in the code` : `the code never names an object "${t.object}" (.name = '${t.object}'); it may come from a model, so set it after the model loads` });
      continue;
    }
    let done: Edit | undefined;
    for (const h of hs) {
      done = placeFor(h.src, h.v, t);
      if (done) break;
    }
    if (!done) {
      const h = hs[0]!;
      if (t.prop.includes(".") && !/^(?:material|shadow|position|rotation|scale)\./.test(t.prop)) {
        plan.missing.push({ tweak: t, why: `no place for ${t.prop} found on ${h.v} in ${h.src.file}` });
        continue;
      }
      done = insertFor(h.src, h.v, h.at, t);
    }
    plan.edits.push({ ...done, tweak: t });
  }
  // apply per file from the end, so offsets stay right; two tweaks on the same span: the later one wins
  const byFile = new Map<string, (Edit & { tweak: Tweak })[]>();
  for (const e of plan.edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const [file, edits] of byFile) {
    let data = readFileSync(join(root, file), "utf8");
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
    let limit = Infinity;
    for (const e of sorted) {
      if (e.end > limit) continue;
      data = data.slice(0, e.start) + e.to + data.slice(e.end);
      limit = e.start;
    }
    plan.files.push({ file, data });
  }
  return plan;
}

/** The project folder of a live page, or the path given. */
export function projectOf(name: string, path?: string): string {
  const folder = path ?? sessionFolder(name);
  if (!folder) throw new TuneError("the live page runs from a dev server URL: pass path (the project folder) to save into its source");
  return folder;
}

const show = (v: unknown): string => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));

export function formatSet(r: SetResult): string {
  return [`${r.object}.${r.prop}: ${show(r.before)} → ${show(r.after)}`, ...r.errors.slice(0, 3).map((e) => `page error: ${e}`), "Next: three_look (or three_page op screenshot) to see it; three_tune op save when it looks right."].join("\n");
}

export function formatTweaks(list: readonly Tweak[]): string {
  if (!list.length) return "No tweaks on this page yet. Use op set.";
  return list.map((t) => `${t.object}.${t.prop}: ${show(t.original)} → ${show(t.value)}`).join("\n");
}

export function formatSave(p: SavePlan, written: number | undefined): string {
  const out: string[] = [];
  if (!p.edits.length && !p.missing.length) return "No tweaks to save.";
  for (const e of p.edits) out.push(`${e.file}:${e.line} ${e.how}: ${e.from ? `${e.from.trim()} → ` : "+ "}${e.to.trim()}  (${e.tweak.object}.${e.tweak.prop})`);
  for (const m of p.missing) out.push(`not saved: ${m.tweak.object}.${m.tweak.prop}: ${m.why}`);
  if (written === undefined) out.push(p.edits.length ? "Dry run: pass write: true to write these changes (one undoable step)." : "");
  else if (written) out.push(`Written as journal entry #${written}; three_undo takes it back. three_page op reload loads the code, three_review with only_new: true checks it.`);
  return out.filter(Boolean).join("\n");
}
