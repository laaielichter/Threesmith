import { callArgs, closeOf, esc } from "./parse.js";
import { tslImports } from "./scene-rules.js";
import type { SourceFile } from "./source.js";
import type { Rule } from "./types.js";

/**
 * Rules for TSL (three.js shading language) written by hand. TSL is plain JavaScript that builds a node graph, so
 * JavaScript's own operators and `if` run once, on the node objects, while the graph is built: `uv().x * 2` is NaN and
 * `if (a.greaterThan(b))` is always taken. Agents write both all the time because GLSL reads that way. The assign
 * rule is the message three prints itself (TSLCore.js: "No stack defined for assign operation").
 */

/** TSL names that are control flow or helpers, never node values. */
const NOT_NODES = new Set(["Fn", "If", "Loop", "Return", "Break", "Continue", "Switch", "Discard", "select", "wgslFn", "glslFn", "nodeObject", "nodeImmutable", "nodeProxy", "uniformArray", "struct", "code"]);

/** Text with string contents blanked (quotes kept), so operators inside strings are not read as code. */
export function blankStrings(text: string): string {
  return text.replace(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g, (all, q: string, inner: string) => (q === "`" && inner.includes("${") ? all : q + " ".repeat(inner.length) + q));
}

/** Ranges of the callbacks passed to `Fn(`: TSL graph code. */
export function fnBodies(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/(?<![\w$.])(?:[\w$]+\.)?Fn\s*\(/g)) {
    const r = callArgs(text, (m.index ?? 0) + m[0].length - 1);
    if (r) out.push(r);
  }
  return out;
}

/** Ranges of every function body (function, method and arrow with a block). */
function functionBodies(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(/(?:\bfunction\b[^{(]*\([^)]*\)|=>|\)\s*)\s*\{/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = closeOf(text, open);
    if (close > open) out.push({ start: open, end: close });
  }
  return out;
}

const inside = (ranges: { start: number; end: number }[], at: number) => ranges.some((r) => at > r.start && at < r.end);

/**
 * Identifiers in a TSL file that hold nodes: the TSL names it imports (or `TSL.x` of a namespace import), and locals
 * assigned from them (`const t = time.mul(2)`, `const c = vec3(1)`, `const u = uniform(0)`), to a fixpoint.
 */
export function nodeNames(f: SourceFile, text = f.text): Set<string> {
  const names = new Set<string>();
  for (const local of tslImports(f).keys()) if (!NOT_NODES.has(local)) names.add(local);
  const ns = [...text.matchAll(/import\s*\*\s*as\s+([\w$]+)\s+from\s*['"]three\/tsl['"]/g)].map((m) => m[1]!);
  if (!names.size && !ns.length) return names;
  const starts = (expr: string): boolean => {
    const head = /^\s*(?:([\w$]+)\s*\.\s*)?([\w$]+)/.exec(expr);
    if (!head) return false;
    if (head[1] && ns.includes(head[1])) return !NOT_NODES.has(head[2]!);
    return !head[1] && names.has(head[2]!);
  };
  for (let round = 0; round < 4; round++) {
    let grew = false;
    for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*([^;\n]{1,200})/g)) {
      const [, name, expr] = m;
      if (!names.has(name!) && starts(expr!)) {
        names.add(name!);
        grew = true;
      }
    }
    if (!grew) break;
  }
  // a name the file also uses for plain JavaScript values (a loop counter, a parameter, a number) is left out:
  // the scope it is a node in cannot be told apart from text
  const tsl = (expr: string) => starts(expr);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*([^;\n]{1,200})/g)) if (names.has(m[1]!) && !tsl(m[2]!)) names.delete(m[1]!);
  for (const m of text.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([\w$]+)/g)) names.delete(m[1]!);
  for (const m of text.matchAll(/\b(?:const|let|var)\s*[[{]([^\]}=]*)[\]}]\s*=\s*([^;\n]{1,200})/g)) {
    if (tsl(m[2]!)) continue;
    for (const p of m[1]!.split(/[,:\s]+/)) if (p) names.delete(p);
  }
  for (const m of text.matchAll(/\(([^()]*)\)\s*=>|\bfunction\b\s*[\w$]*\s*\(([^()]*)\)|(?<![\w$.])([\w$]+)\s*=>/g)) {
    const params = m[1] ?? m[2] ?? m[3] ?? "";
    // destructured Fn inputs ([a, b]) are nodes; plain parameters are whatever the caller passes
    if (/^\s*\[/.test(params)) continue;
    for (const p of params.split(/[,{}=\s]+/)) if (p && names.has(p)) names.delete(p);
  }
  for (const n of ns) names.add(n);
  return names;
}

const OP_METHOD: Record<string, string> = { "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod" };

/** A node expression next to a JS arithmetic operator: `uv().x * 2`, `2.0 - time`, `a + b`. */
export function operatorUses(text: string, names: Set<string>): { at: number; op: string; name: string }[] {
  if (!names.size) return [];
  const alt = [...names].map(esc).join("|");
  // a node: a name, optionally called, then any .member / .method(...) chain without spaces
  const node = String.raw`(?<![\w$.])(${alt})(?![\w$])(?:\s*\((?:[^()]|\([^()]*\))*\))?(?:\.[\w$]+(?:\((?:[^()]|\([^()]*\))*\))?)*`;
  const out: { at: number; op: string; name: string }[] = [];
  const after = new RegExp(String.raw`${node}\s*([+\-*/%])(?![+\-=*/>])`, "g");
  for (const m of text.matchAll(after)) {
    // a chain that ends in a plain property (`level.width`, `list.length`) is a JavaScript value, not a node;
    // only swizzles (`.x`, `.rgb`) and method results stay nodes
    const last = /\.([\w$]+)(\()?[^.]*$/.exec(m[0].replace(/\s*[+\-*/%]$/, ""));
    if (last && !last[2] && !/^[xyzwrgbastpq]{1,4}$/.test(last[1]!)) continue;
    out.push({ at: m.index ?? 0, op: m[2]!, name: m[1]! });
  }
  const before = new RegExp(String.raw`(?<![+\-*/%=<>!&|?:,(\[{]\s*)(?<=[\w$)\].]\s*)([+\-*/%])(?![+\-=*/])\s*${node}`, "g");
  for (const m of text.matchAll(before)) {
    const last = /\.([\w$]+)(\()?[^.]*$/.exec(m[0]);
    if (last && !last[2] && !/^[xyzwrgbastpq]{1,4}$/.test(last[1]!)) continue;
    out.push({ at: m.index ?? 0, op: m[1]!, name: m[2]! });
  }
  return out;
}

export const TSL_RULES: Rule[] = [
  {
    id: "tsl-js-operator",
    category: "correctness",
    severity: "error",
    title: "JavaScript operator on a TSL node",
    message: "A JavaScript operator on a TSL node runs once while the graph is built: `node * 2` is NaN and `node + x` a string, so the shader gets nothing useful.",
    fix: "Use the node methods: a.add(b), a.sub(b), a.mul(b), a.div(b), a.mod(b) (or add(a, b) from 'three/tsl').",
    check(ctx, report) {
      for (const f of ctx.three) {
        if (!/from\s*['"]three\/tsl['"]/.test(f.text)) continue;
        const text = blankStrings(f.text);
        const names = nodeNames(f, text);
        const fns = fnBodies(text);
        const seen = new Set<number>();
        for (const u of operatorUses(text, names)) {
          // outside Fn, only lines that build a node slot or a uniform-driven expression
          if (!inside(fns, u.at) && !/\.\w+Node\s*=|Node\s*:/.test(text.slice(text.lastIndexOf("\n", u.at) + 1, text.indexOf("\n", u.at) >>> 0))) continue;
          if (seen.has(u.at)) continue;
          seen.add(u.at);
          report(f, u.at, { message: `\`${u.op}\` on the TSL node \`${u.name}\` is a JavaScript operator: it runs once while the graph is built and gives NaN or a string, not shader maths.`, fix: `Use .${OP_METHOD[u.op]}(...) instead of ${u.op}.` });
        }
      }
    },
  },
  {
    id: "tsl-js-condition",
    category: "correctness",
    severity: "error",
    title: "JavaScript if or ?: on a TSL condition",
    message: "A JavaScript `if` or `?:` on a TSL node runs once while the graph is built, and a node is always truthy: the shader always takes the first branch.",
    fix: "Use If(cond, () => { ... }).Else(() => { ... }) for statements, and select(cond, a, b) for values (both from 'three/tsl').",
    check(ctx, report) {
      for (const f of ctx.three) {
        if (!/from\s*['"]three\/tsl['"]/.test(f.text)) continue;
        const text = blankStrings(f.text);
        const names = nodeNames(f, text);
        if (!names.size) continue;
        const alt = [...names].map(esc).join("|");
        const nodeCond = new RegExp(String.raw`\.(?:greaterThan|lessThan|greaterThanEqual|lessThanEqual|equal|notEqual|and|or|not|xor)\s*\(|(?<![\w$.])(?:${alt})\b[\w$.()]*\s*[<>]=?\s*(?![\s>])`);
        for (const body of fnBodies(text)) {
          const part = text.slice(body.start, body.end);
          for (const m of part.matchAll(/\bif\s*\(/g)) {
            const r = callArgs(part, (m.index ?? 0) + m[0].length - 1);
            if (r && nodeCond.test(part.slice(r.start, r.end))) report(f, body.start + (m.index ?? 0), { message: "A JavaScript `if` on a TSL condition is decided once while the graph is built (a node is always truthy); the shader never branches." });
          }
          for (const m of part.matchAll(/(\.(?:greaterThan|lessThan|greaterThanEqual|lessThanEqual|equal|notEqual)\s*\([^()]*\))\s*\?(?![.?])/g)) {
            report(f, body.start + (m.index ?? 0), { message: "A JavaScript `?:` on a TSL condition is decided once while the graph is built; the shader always gets the first value.", fix: "Use select(cond, a, b) from 'three/tsl'." });
          }
        }
      }
    },
  },
  {
    id: "tsl-assign-outside-fn",
    category: "correctness",
    severity: "error",
    title: "TSL assign outside Fn()",
    message: "assign() and the other *Assign() calls need the stack of a Fn(); outside one three prints \"TSL: No stack defined for assign operation\" and the assignment is lost.",
    fix: "Move the assignment into a Fn(() => { ... })() (or a compute Fn).",
    check(ctx, report) {
      for (const f of ctx.three) {
        if (!/from\s*['"]three\/tsl['"]/.test(f.text)) continue;
        const text = blankStrings(f.text);
        const names = nodeNames(f, text);
        if (!names.size) continue;
        const bodies = [...fnBodies(text), ...functionBodies(text)];
        const alt = [...names].map(esc).join("|");
        for (const m of text.matchAll(new RegExp(String.raw`(?<![\w$.])(?:${alt})(?:\.[\w$]+)*\.(?:assign|addAssign|subAssign|mulAssign|divAssign|modAssign)\s*\(`, "g"))) {
          if (!inside(bodies, m.index ?? 0)) report(f, m.index ?? 0);
        }
      }
    },
  },
];
