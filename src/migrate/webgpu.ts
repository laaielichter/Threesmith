import { lineOf, type SourceFile } from "../review/source.js";
import { cleanGlsl, declarations, GLSL_TYPES, mainBody, statements, translate, type Scope } from "./glsl.js";

/**
 * WebGPU readiness for three_migrate (`webgpu: true`): what stops this code from running under WebGPURenderer, the
 * steps of the move, a heuristic score, and a TSL draft per custom shader. ShaderMaterial, RawShaderMaterial and
 * onBeforeCompile are GLSL and do not run under WebGPURenderer; the drafts port them to node materials with uniform(),
 * varyings, colorNode / positionNode / emissiveNode, translate the simple GLSL statements and quote the rest as TODO.
 * A draft is a module that runs as it is (a placeholder where it could not translate), never a finished port.
 */

export interface ReadinessItem {
  file: string;
  line: number;
  kind: "blocker" | "warning" | "step";
  id: string;
  message: string;
}

export interface TslDraft {
  /** Where the GLSL material is. */
  file: string;
  line: number;
  source: "ShaderMaterial" | "RawShaderMaterial" | "onBeforeCompile";
  /** The node material the draft makes. */
  material: string;
  /** The draft module. */
  code: string;
  /** GLSL statements (or parts) it could not translate. */
  todo: string[];
}

export interface WebgpuReadiness {
  score: number;
  blockers: number;
  warnings: number;
  items: ReadinessItem[];
  drafts: TslDraft[];
}

const NS = String.raw`(?:[\w$]+\.)?`;

/** The end of a balanced (), {} or [] that opens at `open`, skipping strings and template literals. */
export function closeOf(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return i;
    }
  }
  return -1;
}

/** The value text of `key:` at the top level of an object literal body (or the key itself for a shorthand). */
export function property(body: string, key: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < body.length && body[i] !== c; i++) if (body[i] === "\\") i++;
      continue;
    }
    if ("({[".includes(c)) depth++;
    else if (")}]".includes(c)) depth--;
    else if (depth === 0 && body.startsWith(key, i) && !/[\w$]/.test(body[i - 1] ?? "") && !/[\w$]/.test(body[i + key.length] ?? "")) {
      const rest = body.slice(i + key.length);
      const colon = /^\s*:/.exec(rest);
      if (!colon) {
        if (/^\s*(?:,|$)/.test(rest)) return key; // shorthand
        continue;
      }
      const start = i + key.length + colon[0].length;
      let d = 0;
      for (let j = start; j < body.length; j++) {
        const ch = body[j]!;
        if (ch === "'" || ch === '"' || ch === "`") {
          for (j++; j < body.length && body[j] !== ch; j++) if (body[j] === "\\") j++;
          continue;
        }
        if ("({[".includes(ch)) d++;
        else if (")}]".includes(ch)) d--;
        if ((ch === "," && d === 0) || d < 0) return body.slice(start, j).trim();
      }
      return body.slice(start).trim();
    }
  }
  return undefined;
}

const unescape = (s: string) => s.replace(/\\(n|t|r|'|"|`|\\)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "" })[c as "n"] ?? c);

/** A JS string expression ('a' + "b", a template without ${}, or a const with one) as text; undefined otherwise. */
export function stringValue(expr: string, fileText: string, depth = 0): string | undefined {
  const e = expr.trim().replace(/^\(([\s\S]*)\)$/, "$1").replace(/\.trim\(\s*\)$/, "");
  const parts: string[] = [];
  const re = /\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\$]|\$(?!\{))*)`|([A-Za-z_$][\w$]*))\s*(\+|$)/gy;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < e.length && (m = re.exec(e))) {
    at = re.lastIndex;
    if (m[1] !== undefined || m[2] !== undefined) parts.push(unescape(m[1] ?? m[2]!));
    else if (m[3] !== undefined) parts.push(m[3].replace(/\\`/g, "`").replace(/\\\\/g, "\\"));
    else if (m[4] !== undefined && depth < 3) {
      const def = new RegExp(String.raw`\b(?:const|let|var)\s+${m[4]}\s*=\s*`).exec(fileText);
      if (!def) return undefined;
      const start = def.index + def[0].length;
      const end = endOfExpression(fileText, start);
      const v = stringValue(fileText.slice(start, end), fileText, depth + 1);
      if (v === undefined) return undefined;
      parts.push(v);
    } else return undefined;
    if (!m[5]) break;
  }
  return at >= e.length && parts.length ? parts.join("") : undefined;
}

/** Where an expression that starts at `start` ends: a top-level `;` or a line break after a complete expression. */
function endOfExpression(text: string, start: number): number {
  let d = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if ("({[".includes(c)) d++;
    else if (")}]".includes(c)) d--;
    if (d < 0 || (d === 0 && (c === ";" || (c === "\n" && !/^\s*[+.]/.test(text.slice(i + 1)) && !/[+,(]\s*$/.test(text.slice(start, i)))))) return i;
  }
  return text.length;
}

interface UniformIn {
  name: string;
  type?: string;
  /** The JS value expression, as written. */
  value?: string;
}

const VERTEX_NAMES: [string, string, string][] = [
  ["position", "positionLocal", "positionLocal"],
  ["normal", "normalLocal", "normalLocal"],
  ["uv", "uv()", "uv"],
  ["modelMatrix", "modelWorldMatrix", "modelWorldMatrix"],
  ["modelViewMatrix", "modelViewMatrix", "modelViewMatrix"],
  ["projectionMatrix", "cameraProjectionMatrix", "cameraProjectionMatrix"],
  ["viewMatrix", "cameraViewMatrix", "cameraViewMatrix"],
  ["normalMatrix", "modelNormalMatrix", "modelNormalMatrix"],
  ["cameraPosition", "cameraPosition", "cameraPosition"],
];

const DEFAULTS: Record<string, string> = { float: "0", int: "0", bool: "false", vec2: "new THREE.Vector2()", vec3: "new THREE.Vector3()", vec4: "new THREE.Vector4()", mat3: "new THREE.Matrix3()", mat4: "new THREE.Matrix4()" };

const isLiteral = (v: string | undefined) => !!v && (/^-?\d*\.?\d+(?:e-?\d+)?$/.test(v) || /^(?:true|false)$/.test(v) || /^new\s+(?:THREE\.)?(?:Vector[234]|Color|Matrix[34])\s*\(\s*[-\d.,\s]*\)$|^new\s+(?:THREE\.)?Color\s*\(\s*0x[0-9a-fA-F]+\s*\)$/.test(v));
const jsValue = (v: string) => v.replace(/^new\s+(?!THREE\.)/, "new THREE.");

function scopeFor(uniforms: UniformIn[]): Scope {
  const s: Scope = { names: new Map(), needs: new Map(), locals: new Set(), used: new Set() };
  for (const u of uniforms) s.names.set(u.name, u.name);
  return s;
}

/** The `const uX = uniform( ... )` lines of a draft; samplers become texture nodes. */
function uniformLines(uniforms: UniformIn[], used: Set<string>): string[] {
  return uniforms.map((u) => {
    const was = u.value ? ` // was ${u.name}: { value: ${u.value.replace(/\s+/g, " ").slice(0, 60)} }` : "";
    if (u.type === "sampler2D" || u.type === "samplerCube" || (!u.type && /texture|map|tex/i.test(u.name))) {
      used.add(u.type === "samplerCube" ? "cubeTexture" : "texture");
      return `  const ${u.name} = ${u.type === "samplerCube" ? "cubeTexture" : "texture"}( values.${u.name} ?? new THREE.${u.type === "samplerCube" ? "CubeTexture" : "Texture"}() );${was}`;
    }
    used.add("uniform");
    const def = isLiteral(u.value) ? jsValue(u.value!) : (DEFAULTS[u.type ?? "float"] ?? "0");
    return `  const ${u.name} = uniform( values.${u.name} ?? ${def} );${was}${!isLiteral(u.value) && u.value ? " (TODO: pass it in values)" : ""}`;
  });
}

/** Every TSL name a draft may use; the import line lists the ones its code does use. */
const TSL_NAMES = ["Fn", "uniform", "texture", "cubeTexture", "uv", "varying", "positionLocal", "normalLocal", "modelWorldMatrix", "modelViewMatrix", "cameraProjectionMatrix", "cameraViewMatrix", "modelNormalMatrix", "cameraPosition", "materialColor", "materialOpacity", "materialEmissive", "materialRoughness", "materialMetalness", "float", "int", "bool", "vec2", "vec3", "vec4", "ivec2", "ivec3", "ivec4", "mat2", "mat3", "mat4", "sin", "cos", "tan", "asin", "acos", "atan", "abs", "sign", "floor", "ceil", "fract", "mod", "min", "max", "clamp", "mix", "step", "smoothstep", "length", "distance", "dot", "cross", "normalize", "reflect", "refract", "pow", "sqrt", "inverseSqrt", "exp", "exp2", "log", "log2", "radians", "degrees"];

function module(header: string, _used: Set<string>, body: string[], names: string[]): string {
  const code = body.filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/\/\/[^\n]*/g, "");
  const tsl = TSL_NAMES.filter((n) => new RegExp(String.raw`(?<![\w$.])${n}(?![\w$])`).test(code)).sort();
  return [
    `// ${header}`,
    "// Written by three_migrate as a starting point: check every TODO, then compare a screenshot with the GLSL version.",
    "import * as THREE from 'three/webgpu';",
    ...(tsl.length ? [`import { ${tsl.join(", ")} } from 'three/tsl';`] : []),
    "",
    "export function createMaterial( values = {} ) {",
    ...body,
    `  return { material, uniforms: { ${names.join(", ")} } };`,
    "}",
    "",
  ].join("\n");
}

const PROJECTION = [/^cameraProjectionMatrix\.mul\( modelViewMatrix \)\.mul\( vec4\( (.+), 1 \) \)$/, /^cameraProjectionMatrix\.mul\( cameraViewMatrix \)\.mul\( modelWorldMatrix \)\.mul\( vec4\( (.+), 1 \) \)$/];

/** A draft for one ShaderMaterial / RawShaderMaterial object literal. */
export function shaderMaterialDraft(f: SourceFile, at: number, type: "ShaderMaterial" | "RawShaderMaterial", body: string, release: number): TslDraft {
  const todo: string[] = [];
  const vsExpr = property(body, "vertexShader");
  const fsExpr = property(body, "fragmentShader");
  const vs = vsExpr ? stringValue(vsExpr, f.text) : undefined;
  const fs = fsExpr ? stringValue(fsExpr, f.text) : undefined;
  if (vsExpr && vs === undefined) todo.push(`vertexShader ${vsExpr.slice(0, 40)} is not a string in this file: port it by hand`);
  if (fsExpr && fs === undefined) todo.push(`fragmentShader ${fsExpr.slice(0, 40)} is not a string in this file: port it by hand`);
  const vGlsl = cleanGlsl(vs ?? "");
  const fGlsl = cleanGlsl(fs ?? "");
  const declared = new Map([...declarations(vGlsl, "uniform"), ...declarations(fGlsl, "uniform")]);
  const uniforms: UniformIn[] = [];
  const ublock = property(body, "uniforms");
  if (ublock?.startsWith("{")) {
    for (const m of ublock.slice(1, -1).matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\{/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const inner = ublock.slice(1, -1).slice(open + 1, closeOf(ublock.slice(1, -1), open));
      const value = property(inner, "value");
      uniforms.push({ name: m[1]!, ...(declared.get(m[1]!) ? { type: declared.get(m[1]!)! } : {}), ...(value ? { value } : {}) });
    }
  } else if (ublock) todo.push(`uniforms ${ublock.slice(0, 40)} is not an object literal: list them by hand`);
  for (const [name, t] of declared) if (!uniforms.some((u) => u.name === name)) uniforms.push({ name, type: t });

  const used = new Set<string>(["Fn"]);
  const varyings = new Map([...declarations(vGlsl, "varying")]);
  // vertex: gl_Position and the varyings
  const vScope = scopeFor(uniforms);
  for (const [g, tsl, need] of VERTEX_NAMES) {
    vScope.names.set(g, tsl);
    vScope.needs.set(g, need);
  }
  const vBody = mainBody(vGlsl);
  const vOut = translate(statements(vBody ?? ""), vScope, new Set(["gl_Position", ...varyings.keys()]), { capture: new Set(["gl_Position", ...varyings.keys()]) });
  for (const t of vOut.todo) todo.push(`vertex: ${t.glsl} (${t.why})`);
  for (const n of vScope.used) used.add(n);
  const lines: string[] = [];
  const pos = vOut.outputs.get("gl_Position");
  let positionNode: string | undefined;
  if (pos) {
    const inner = PROJECTION.map((re) => re.exec(pos)?.[1]).find(Boolean);
    if (!inner) todo.push("vertex: gl_Position is not the standard projection: set material.vertexNode by hand");
    else if (inner !== "positionLocal") positionNode = inner;
  }
  // fragment
  const fScope = scopeFor(uniforms);
  const varyingTsl = new Map<string, string>();
  for (const [name] of varyings) {
    const v = vOut.outputs.get(name);
    if (!v) continue;
    // a varying of built-ins and uniforms only can be read in the fragment stage directly or through varying()
    if (/^(?:uv\(\)|positionLocal|normalLocal)$/.test(v)) varyingTsl.set(name, v);
    else if (![...vScope.locals].some((l) => new RegExp(String.raw`\b${l}\b`).test(v))) {
      used.add("varying");
      varyingTsl.set(name, `varying( ${v} )`);
    } else if (positionNode && v === positionNode) {
      varyingTsl.set(name, "positionLocal");
    } else todo.push(`varying ${name} = ${v} uses vertex locals: compute it in the fragment stage or with varying()`);
  }
  for (const [name, v] of varyingTsl) {
    fScope.names.set(name, v);
    const need = /^([a-z]\w*)/.exec(v)?.[1];
    if (need) fScope.needs.set(name, need);
  }
  const fBody = mainBody(fGlsl);
  const outVar = /\bout\s+(?:highp\s+|mediump\s+|lowp\s+)?vec4\s+(\w+)\s*;/.exec(fGlsl)?.[1] ?? "gl_FragColor";
  const fOut = translate(statements(fBody ?? ""), fScope, new Set([outVar]), { capture: new Set([outVar]) });
  for (const t of fOut.todo) todo.push(`fragment: ${t.glsl} (${t.why})`);
  for (const n of fScope.used) used.add(n);
  const color = fOut.outputs.get(outVar);
  if (!color) {
    used.add("vec4");
    todo.push("fragment: no translatable colour output: the draft draws magenta");
  }

  lines.push(...uniformLines(uniforms, used));
  lines.push("  const material = new THREE.MeshBasicNodeMaterial();");
  for (const key of ["transparent", "side", "depthWrite", "depthTest", "blending", "wireframe"]) {
    const v = property(body, key);
    if (v && /^(?:true|false|(?:THREE\.)?\w+Side|(?:THREE\.)?\w+Blending)$/.test(v)) lines.push(`  material.${key} = ${v.replace(/^(?!THREE\.)([A-Z]\w+)$/, "THREE.$1")};`);
  }
  if (positionNode) {
    lines.push("  material.positionNode = Fn( () => {", ...vOut.lines.map((l) => `    ${l}`), `    return ${positionNode};`, "  } )();");
  }
  lines.push("  material.colorNode = Fn( () => {", ...fOut.lines.map((l) => `    ${l}`), `    return ${color ?? "vec4( 1, 0, 1, 1 )"};`, "  } )();");
  void release;
  const line = lineOf(f.text, at);
  return {
    file: f.path,
    line,
    source: type,
    material: "MeshBasicNodeMaterial",
    code: module(`TSL draft of the ${type} at ${f.path}:${line}.`, used, lines, uniforms.map((u) => u.name)),
    todo,
  };
}

/** Which node a chunk hook of onBeforeCompile becomes: the GLSL variable it edits and how that starts. */
const HOOKS: Record<string, { node: string; variable: string; start: string; needs: string[]; stage: "vertex" | "fragment" }> = {
  begin_vertex: { node: "positionNode", variable: "transformed", start: "positionLocal.toVar()", needs: ["positionLocal"], stage: "vertex" },
  color_fragment: { node: "colorNode", variable: "diffuseColor", start: "vec4( materialColor, materialOpacity ).toVar()", needs: ["vec4", "materialColor", "materialOpacity"], stage: "fragment" },
  emissivemap_fragment: { node: "emissiveNode", variable: "totalEmissiveRadiance", start: "materialEmissive.toVar()", needs: ["materialEmissive"], stage: "fragment" },
  roughnessmap_fragment: { node: "roughnessNode", variable: "roughnessFactor", start: "materialRoughness.toVar()", needs: ["materialRoughness"], stage: "fragment" },
  metalnessmap_fragment: { node: "metalnessNode", variable: "metalnessFactor", start: "materialMetalness.toVar()", needs: ["materialMetalness"], stage: "fragment" },
};

/** The value of `shader.uniforms.x = <expr>`: an `{ value }` literal or `obj.name` of a `const obj = { name: { value } }`. */
function uniformValue(expr: string, fileText: string): string | undefined {
  const direct = /^\{\s*value\s*:\s*([\s\S]+?)\s*\}$/.exec(expr.trim());
  if (direct) return direct[1];
  const ref = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(expr.trim());
  if (!ref) return undefined;
  const def = new RegExp(String.raw`\b(?:const|let|var)\s+${ref[1]}\s*=\s*\{`).exec(fileText);
  if (!def) return undefined;
  const open = def.index + def[0].length - 1;
  const obj = fileText.slice(open + 1, closeOf(fileText, open));
  const entry = property(obj, ref[2]!);
  return entry ? uniformValue(entry, fileText) : undefined;
}

/** A draft for one `material.onBeforeCompile = (shader) => { ... }`. */
export function onBeforeCompileDraft(f: SourceFile, at: number, target: string, fnBody: string): TslDraft {
  const todo: string[] = [];
  const used = new Set<string>(["Fn"]);
  const decl = new RegExp(String.raw`\b${target.replace(/[.$]/g, "\\$&")}\s*=\s*new\s+${NS}(Mesh\w+Material)\s*\(`).exec(f.text);
  const baseType = decl?.[1] ?? "MeshStandardMaterial";
  const nodeType = baseType.replace(/Material$/, "NodeMaterial");
  if (!decl) todo.push(`the type of ${target} was not found in this file: the draft assumes MeshStandardMaterial`);
  const params = decl ? (() => {
    const open = f.text.indexOf("(", decl.index + decl[0].length - 1);
    return f.raw.slice(open + 1, closeOf(f.text, open)).trim();
  })() : "";

  const injected = [...fnBody.matchAll(/['"`]([^'"`]*\buniform\s+\w+\s+\w+\s*;[^'"`]*)['"`]/g)].map((m) => unescape(m[1]!)).join("\n");
  const types = declarations(injected, "uniform");
  const uniforms: UniformIn[] = [];
  for (const m of fnBody.matchAll(/\b\w+\.uniforms\.([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
    const value = uniformValue(m[2]!, f.raw);
    if (!value) todo.push(`uniform ${m[1]} = ${m[2]!.trim()}: its value was not found; pass it in values`);
    uniforms.push({ name: m[1]!, ...(types.get(m[1]!) ? { type: types.get(m[1]!)! } : {}), ...(value ? { value } : {}) });
  }
  const varyingDecl = declarations(injected + "\n" + [...fnBody.matchAll(/['"`]([^'"`]*\bvarying\s+\w+\s+\w+\s*;[^'"`]*)['"`]/g)].map((m) => unescape(m[1]!)).join("\n"), "varying");

  const lines = uniformLines(uniforms, used);
  lines.push(`  const material = new THREE.${nodeType}(${params ? ` ${params} ` : ""});`);
  const varyingTsl = new Map<string, string>();
  const replaceRe = /\.replace(?:All)?\s*\(\s*(['"`])\s*#include\s*<(\w+)>\s*\1\s*,/g;
  const hooks: { chunk: string; code: string }[] = [];
  for (const m of fnBody.matchAll(replaceRe)) {
    const open = fnBody.lastIndexOf("(", (m.index ?? 0) + m[0].indexOf("(") + 1);
    const close = closeOf(fnBody, open);
    const second = fnBody.slice((m.index ?? 0) + m[0].length, close).trim().replace(/,$/, "");
    const code = stringValue(second, f.text);
    if (code === undefined) {
      todo.push(`#include <${m[2]}>: the replacement is not a string in this file`);
      continue;
    }
    hooks.push({ chunk: m[2]!, code: cleanGlsl(code.replace(new RegExp(String.raw`#include\s*<${m[2]}>`), "")) });
  }
  // vertex hooks first: their varyings feed the fragment hooks
  hooks.sort((a, b) => Number(HOOKS[b.chunk]?.stage === "vertex") - Number(HOOKS[a.chunk]?.stage === "vertex"));
  for (const h of hooks) {
    const hook = HOOKS[h.chunk];
    if (!hook) {
      todo.push(`#include <${h.chunk}> has no node equivalent in this draft: port it by hand`);
      lines.push(`  // TODO: the code added at #include <${h.chunk}>:`, ...h.code.split("\n").filter((l) => l.trim()).map((l) => `  //   ${l.trim()}`));
      continue;
    }
    const scope = scopeFor(uniforms);
    scope.locals.add(hook.variable);
    if (hook.stage === "vertex") {
      for (const [g, tsl, need] of VERTEX_NAMES) {
        scope.names.set(g, tsl);
        scope.needs.set(g, need);
      }
    } else {
      for (const [n, v] of varyingTsl) {
        scope.names.set(n, v);
        const need = /^([a-z]\w*)/.exec(v)?.[1];
        if (need) scope.needs.set(n, need);
      }
    }
    const out = translate(statements(h.code), scope, new Set(varyingDecl.keys()), { capture: new Set(varyingDecl.keys()) });
    for (const t of out.todo) todo.push(`${h.chunk}: ${t.glsl} (${t.why})`);
    for (const [n, v] of out.outputs) {
      if (/^(?:uv\(\)|positionLocal|normalLocal)$/.test(v)) varyingTsl.set(n, v);
      else if (!new RegExp(String.raw`\b${hook.variable}\b`).test(v)) {
        used.add("varying");
        varyingTsl.set(n, `varying( ${v} )`);
      } else todo.push(`varying ${n} = ${v} depends on ${hook.variable}: compute it in the fragment stage`);
    }
    for (const n of [...scope.used, ...hook.needs]) used.add(n);
    lines.push(`  material.${hook.node} = Fn( () => {`, `    const ${hook.variable} = ${hook.start};`, ...out.lines.map((l) => `    ${l}`), `    return ${hook.variable};`, "  } )();");
  }
  if (!hooks.length) todo.push("no #include replacement found in onBeforeCompile: port the shader changes by hand");
  const line = lineOf(f.text, at);
  return { file: f.path, line, source: "onBeforeCompile", material: nodeType, code: module(`TSL draft of the onBeforeCompile of ${target} at ${f.path}:${line}.`, used, lines, uniforms.map((u) => u.name)), todo };
}

const POST: Record<string, string> = {
  RenderPass: "pass( scene, camera )",
  UnrealBloomPass: "bloom( scenePass, strength, radius, threshold )",
  OutputPass: "nothing: the pipeline applies tone mapping and colour space itself (outputColorTransform)",
  SMAAPass: "smaa( scenePass )",
  BokehPass: "dof( scenePass, viewZ, focus, aperture, maxblur )",
  GTAOPass: "ao( depth, normal, camera ) (GTAONode)",
  SSAOPass: "ao( depth, normal, camera ) (GTAONode)",
  AfterimagePass: "afterImage( scenePass, damp )",
  FilmPass: "film( scenePass )",
  DotScreenPass: "dotScreen( scenePass )",
  OutlinePass: "outline( scene, camera, { selectedObjects } )",
  SSRPass: "ssr( ... ) (SSRNode)",
  TAARenderPass: "traa( ... ) (TRAANode)",
  ShaderPass: "a node function of your own (FXAAShader: fxaa( scenePass ))",
};

/** The readiness report and the drafts. `release` is the installed (target) release. */
export function webgpuReadiness(files: SourceFile[], release: number): WebgpuReadiness {
  const items: ReadinessItem[] = [];
  const drafts: TslDraft[] = [];
  const add = (f: SourceFile, index: number, kind: ReadinessItem["kind"], id: string, message: string) => items.push({ file: f.path, line: lineOf(f.text, index), kind, id, message });
  const pipeline = release >= 183 ? "RenderPipeline" : "PostProcessing";
  for (const f of files) {
    if (!f.usesThree) continue;
    for (const m of f.text.matchAll(new RegExp(String.raw`\bnew\s+${NS}(ShaderMaterial|RawShaderMaterial)\s*\(\s*\{`, "g"))) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(f.text, open);
      if (close < 0) continue;
      const draft = shaderMaterialDraft(f, m.index ?? 0, m[1] as "ShaderMaterial", f.raw.slice(open + 1, close), release);
      drafts.push(draft);
      add(f, m.index ?? 0, "blocker", "glsl-material", `${m[1]} is GLSL and does not run under WebGPURenderer: port it to a node material (TSL draft ${drafts.length}${draft.todo.length ? `, ${draft.todo.length} TODO` : ", fully translated"}).`);
    }
    for (const m of f.text.matchAll(/([\w$.]+)\.onBeforeCompile\s*=\s*(?:function\s*\w*\s*\([^)]*\)|\(?[^)=]*\)?\s*=>)\s*\{/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const close = closeOf(f.text, open);
      if (close < 0) continue;
      const draft = onBeforeCompileDraft(f, m.index ?? 0, m[1]!, f.raw.slice(open + 1, close));
      drafts.push(draft);
      add(f, m.index ?? 0, "blocker", "on-before-compile", `onBeforeCompile patches GLSL, which WebGPURenderer does not use: move the changes to node properties of ${draft.material} (TSL draft ${drafts.length}${draft.todo.length ? `, ${draft.todo.length} TODO` : ", fully translated"}).`);
    }
    const imp = /\bimport\s*\{[^}]*\bEffectComposer\b[^}]*\}/.exec(f.text) ?? /\bnew\s+(?:[\w$]+\.)?EffectComposer\s*\(/.exec(f.text);
    if (imp) {
      const passes = [...new Set([...f.text.matchAll(/\bnew\s+(?:[\w$]+\.)?(\w+Pass)\s*\(/g)].map((p) => p[1]!))];
      const mapped = passes.map((p) => `${p} -> ${POST[p] ?? "no node equivalent known: port by hand"}`).join("; ");
      add(f, imp.index, "blocker", "effect-composer", `EffectComposer does not run under WebGPURenderer: use ${pipeline} from three/webgpu with TSL passes${mapped ? ` (${mapped})` : ""}.`);
    }
    for (const m of f.text.matchAll(/\b(?:ShaderChunk|ShaderLib|UniformsLib|UniformsUtils)\b/g)) add(f, m.index ?? 0, "blocker", "shader-chunks", `${m[0]} is part of the GLSL renderer: replace it with node materials and TSL.`);
    for (const m of f.text.matchAll(/\.getContext\s*\(\s*\)|\.extensions\.get\s*\(|\bgl\.(?:getExtension|getParameter|pixelStorei|texImage2D)\s*\(/g)) add(f, m.index ?? 0, "blocker", "webgl-context", "Code that talks to the WebGL context directly has no WebGPU equivalent here: remove it or move it to the renderer's API.");
    for (const m of f.text.matchAll(new RegExp(String.raw`\bnew\s+${NS}WebGLCubeRenderTarget\s*\(`, "g"))) add(f, m.index ?? 0, "blocker", "cube-render-target", "WebGLCubeRenderTarget does not work with WebGPURenderer: use CubeRenderTarget.");
    for (const m of f.text.matchAll(new RegExp(String.raw`\bnew\s+${NS}(WebGLRenderTarget|WebGL3DRenderTarget|WebGLArrayRenderTarget)\s*\(`, "g"))) add(f, m.index ?? 0, "warning", "webgl-render-target", `${m[1]}: use ${m[1]!.replace("WebGL", "")} with WebGPURenderer.`);
    for (const m of f.text.matchAll(new RegExp(String.raw`\bnew\s+${NS}WebGLRenderer\s*\(`, "g"))) add(f, m.index ?? 0, "step", "renderer", "new WebGPURenderer( { antialias: true } ) from 'three/webgpu', then await renderer.init() before the first render() (setAnimationLoop does it for you). It falls back to WebGL 2 where WebGPU is missing.");
    for (const m of f.text.matchAll(/\bfrom\s*(['"])three\1/g)) add(f, m.index ?? 0, "step", "import", "Import from 'three/webgpu' (and TSL from 'three/tsl') instead of 'three', so there is one copy of the core.");
  }
  const blockers = items.filter((i) => i.kind === "blocker").length;
  const warnings = items.filter((i) => i.kind === "warning").length;
  return { score: Math.max(0, 100 - 15 * blockers - 5 * warnings), blockers, warnings, items, drafts };
}

export function formatReadiness(r: WebgpuReadiness, opts: { drafts?: number } = {}): string[] {
  const out = ["", `WebGPU readiness: ${r.score}/100 (heuristic: 15 off per blocker, 5 per warning): ${r.blockers} blocker(s), ${r.warnings} warning(s).`];
  for (const kind of ["blocker", "warning", "step"] as const) {
    const items = r.items.filter((i) => i.kind === kind);
    if (!items.length) continue;
    out.push(`  ${kind === "blocker" ? "Blockers" : kind === "warning" ? "Warnings" : "Steps"}:`);
    for (const i of items.slice(0, 20)) out.push(`    ${i.file}:${i.line} [${i.id}] ${i.message}`);
    if (items.length > 20) out.push(`    ... ${items.length - 20} more`);
  }
  if (!r.items.length) out.push("  Nothing in this code stops WebGPURenderer: switch the renderer and the imports, then check the page.");
  const show = r.drafts.slice(0, opts.drafts ?? 3);
  for (const [i, d] of show.entries()) {
    out.push("", `TSL draft ${i + 1}: ${d.source} at ${d.file}:${d.line} -> ${d.material}${d.todo.length ? ` (${d.todo.length} TODO)` : ""}`);
    for (const t of d.todo) out.push(`  TODO: ${t}`);
    out.push("```js", d.code.trimEnd(), "```");
  }
  if (r.drafts.length > show.length) out.push(`${r.drafts.length - show.length} more draft(s) (detail full).`);
  return out;
}
