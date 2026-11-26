/**
 * A small GLSL-to-TSL translator for the TSL drafts of three_migrate. It handles what simple custom shaders are made
 * of: declarations, assignments (also +=, -=, *=, /=), expressions with + - * /, calls, swizzles and numbers. Anything
 * else (if, for, discard, custom functions, arrays) makes the statement a TODO: the draft quotes the GLSL and keeps
 * a placeholder, so the result always runs and never pretends to be complete.
 */

export interface Scope {
  /** GLSL name -> TSL expression (uniforms, varyings, built-ins). */
  names: Map<string, string>;
  /** GLSL name -> the TSL import its expression needs (built-ins such as positionLocal). */
  needs: Map<string, string>;
  /** Names declared in this function (they become `.toVar()`). */
  locals: Set<string>;
  /** TSL functions the translation used, for the import line. */
  used: Set<string>;
}

const FUNCS = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "abs", "sign", "floor", "ceil", "fract", "mod", "min", "max", "clamp", "mix", "step", "smoothstep", "length", "distance", "dot", "cross", "normalize", "reflect", "refract", "pow", "sqrt", "inverseSqrt", "exp", "exp2", "log", "log2", "radians", "degrees"]);
const CTORS: Record<string, string> = { float: "float", int: "int", bool: "bool", vec2: "vec2", vec3: "vec3", vec4: "vec4", ivec2: "ivec2", ivec3: "ivec3", ivec4: "ivec4", mat2: "mat2", mat3: "mat3", mat4: "mat4" };
const OPS: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div" };
const ASSIGN: Record<string, string> = { "=": "assign", "+=": "addAssign", "-=": "subAssign", "*=": "mulAssign", "/=": "divAssign" };
export const GLSL_TYPES = /^(?:float|int|bool|vec[234]|ivec[234]|mat[234])$/;

type Tok = { t: "num" | "id" | "op"; v: string };

class Untranslatable extends Error {}

function tokens(src: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+\.\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|\d+(?:e[+-]?\d+)?)|([A-Za-z_]\w*)|(\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||[-+*/(),.=<>?:!%\[\]{}]))/gy;
  let m: RegExpExecArray | null;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    m = re.exec(src);
    if (!m || m[0].length === 0) {
      if (/^\s*$/.test(src.slice(i))) break;
      throw new Untranslatable(`cannot read "${src.slice(i, i + 12)}"`);
    }
    i = re.lastIndex;
    if (m[1] !== undefined) out.push({ t: "num", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
    else if (m[3] !== undefined) out.push({ t: "op", v: m[3] });
  }
  return out;
}

/** Translates one GLSL expression to TSL. Throws Untranslatable for what it does not know. */
export function expression(src: string, scope: Scope): string {
  const toks = tokens(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string) => {
    const t = toks[p];
    if (!t || (v !== undefined && t.v !== v)) throw new Untranslatable(`expected ${v ?? "more"} in "${src}"`);
    p++;
    return t;
  };
  const binary = (level: 0 | 1): string => {
    let left = level === 0 ? binary(1) : unary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || !(level === 0 ? ["+", "-"] : ["*", "/"]).includes(t.v)) return left;
      p++;
      const right = level === 0 ? binary(1) : unary();
      left = `${wrap(left)}.${OPS[t.v]}( ${right} )`;
    }
  };
  const unary = (): string => {
    const t = peek();
    if (t?.v === "-") {
      p++;
      const v = unary();
      return /^\d/.test(v) ? `-${v}` : `${wrap(v)}.negate()`;
    }
    if (t?.v === "+") {
      p++;
      return unary();
    }
    return postfix(primary());
  };
  const args = (): string[] => {
    eat("(");
    const out: string[] = [];
    if (peek()?.v !== ")") {
      for (;;) {
        out.push(binary(0));
        if (peek()?.v === ",") p++;
        else break;
      }
    }
    eat(")");
    return out;
  };
  const primary = (): string => {
    const t = eat();
    if (t.t === "num") return String(Number(t.v.replace(/f$/, "")));
    if (t.v === "(") {
      const v = binary(0);
      eat(")");
      return v;
    }
    if (t.t !== "id") throw new Untranslatable(`unexpected "${t.v}" in "${src}"`);
    if (peek()?.v === "(") {
      const a = args();
      if (CTORS[t.v]) {
        scope.used.add(CTORS[t.v]!);
        return `${CTORS[t.v]}( ${a.join(", ")} )`;
      }
      if (FUNCS.has(t.v)) {
        scope.used.add(t.v);
        return `${t.v}( ${a.join(", ")} )`;
      }
      if (t.v === "texture2D" || t.v === "texture") {
        if (a.length !== 2) throw new Untranslatable(`${t.v} with ${a.length} arguments`);
        return `${wrap(a[0]!)}.sample( ${a[1]} )`;
      }
      throw new Untranslatable(`unknown function ${t.v}()`);
    }
    const mapped = scope.names.get(t.v);
    if (mapped !== undefined) {
      const need = scope.needs.get(t.v);
      if (need) scope.used.add(need);
      return mapped;
    }
    if (scope.locals.has(t.v)) return t.v;
    throw new Untranslatable(`unknown name ${t.v}`);
  };
  const postfix = (base: string): string => {
    let out = base;
    while (peek()?.v === ".") {
      p++;
      const f = eat();
      if (f.t !== "id" || !/^[xyzwrgbastpq]{1,4}$/.test(f.v)) throw new Untranslatable(`member .${f.v}`);
      out = `${wrap(out)}.${f.v}`;
    }
    return out;
  };
  const v = binary(0);
  if (p !== toks.length) throw new Untranslatable(`unexpected "${toks[p]!.v}" in "${src}"`);
  return v;
}

/** Numbers need a node before a method can be called on them. */
function wrap(v: string): string {
  return /^-?\d/.test(v) ? `float( ${v} )` : v;
}

/** The statements of a GLSL block (no braces inside), split at top-level semicolons. */
export function statements(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of body) {
    cur += c;
    if (c === "{" || c === "(") depth++;
    else if (c === "}" || c === ")") {
      depth--;
      if (c === "}" && depth === 0) {
        out.push(cur);
        cur = "";
      }
    } else if (c === ";" && depth === 0) {
      out.push(cur.slice(0, -1));
      cur = "";
    }
  }
  out.push(cur);
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export interface Translated {
  /** TSL lines for the body of an Fn(). */
  lines: string[];
  /** GLSL statements that stayed TODO, with why. */
  todo: { glsl: string; why: string }[];
  /** Assignments to these GLSL outputs (gl_Position, gl_FragColor, a varying, ...): name -> TSL expression. */
  outputs: Map<string, string>;
}

/**
 * Translates statements. `outputs` names the variables whose last assignment is the result (gl_FragColor, a varying,
 * `transformed`, `diffuseColor`); assignments to them are recorded instead of written when `capture` is true.
 */
export function translate(stmts: string[], scope: Scope, outputs: Set<string>, opts: { capture?: Set<string> } = {}): Translated {
  const out: Translated = { lines: [], todo: [], outputs: new Map() };
  for (const s of stmts) {
    try {
      if (/[{}]|^\s*(?:if|for|while|return|discard)\b/.test(s)) throw new Untranslatable("control flow");
      const decl = /^(?:const\s+|highp\s+|mediump\s+|lowp\s+)*(float|int|bool|vec[234]|ivec[234]|mat[234])\s+([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(s);
      if (decl) {
        const value = expression(decl[3]!, scope);
        scope.locals.add(decl[2]!);
        out.lines.push(`const ${decl[2]} = ${wrap(value)}.toVar();`);
        continue;
      }
      const asg = /^([A-Za-z_]\w*)((?:\.[xyzwrgba]{1,4})?)\s*(=|\+=|-=|\*=|\/=)\s*([\s\S]+)$/.exec(s);
      if (!asg) throw new Untranslatable("not a declaration or an assignment");
      const [, name, swz, op, rhs] = asg as unknown as [string, string, string, string, string];
      const value = expression(rhs, scope);
      if (opts.capture?.has(name) && !swz && op === "=") {
        out.outputs.set(name, value);
        continue;
      }
      if (outputs.has(name) && !scope.locals.has(name) && !opts.capture?.has(name)) throw new Untranslatable(`writes ${name}`);
      const target = scope.locals.has(name) ? name : scope.names.get(name);
      if (!target) throw new Untranslatable(`assigns ${name}, which is not declared here`);
      out.lines.push(`${target}${swz}.${ASSIGN[op]}( ${value} );`);
    } catch (e) {
      if (!(e instanceof Untranslatable)) throw e;
      out.todo.push({ glsl: s, why: e.message });
      out.lines.push(`// TODO (${e.message}): ${s};`);
    }
  }
  return out;
}

/** The body of `void main() { ... }`, or undefined. */
export function mainBody(glsl: string): string | undefined {
  const m = /\bvoid\s+main\s*\(\s*(?:void)?\s*\)\s*\{/.exec(glsl);
  if (!m) return undefined;
  let depth = 1;
  for (let i = m.index + m[0].length; i < glsl.length; i++) {
    if (glsl[i] === "{") depth++;
    else if (glsl[i] === "}" && --depth === 0) return glsl.slice(m.index + m[0].length, i);
  }
  return undefined;
}

/** `uniform float uTime;` and `varying vec2 vUv;` declarations: name -> type. */
export function declarations(glsl: string, kind: "uniform" | "varying" | "attribute"): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(String.raw`\b${kind === "varying" ? "(?:varying|out|in)" : kind}\s+(?:(?:highp|mediump|lowp|flat)\s+)*(\w+)\s+([\w\s,]+);`, "g");
  for (const m of glsl.matchAll(re)) for (const n of m[2]!.split(",")) out.set(n.trim(), m[1]!);
  return out;
}

/** GLSL with comments removed and #include / #define lines dropped (they do not translate). */
export function cleanGlsl(glsl: string): string {
  return glsl
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/^\s*#\s*(?:include|define|ifdef|ifndef|endif|else|if|version|extension|pragma)\b[^\n]*$/gm, "");
}
