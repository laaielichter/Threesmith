import { settle } from "./clock.js";
import type { Issue } from "./check.js";
import type { PageOptions } from "./page.js";
import { openRunPage, runSteps } from "./play.js";
import type { PlayStep } from "./steps.js";

/**
 * The frame as text, for agents that cannot see pictures (and for those that can, as numbers): how light or dark the
 * frame is, how much of it is background, and per object (named objects, or the meshes in them) how much of the frame
 * it really covers, where it is, whether the frame edge cuts it, how much of it is hidden and by what. Measured in the
 * page with the scene's own renderer, by rendering with and without each object: exact pixels, no model. Claims
 * ("car visible >= 5%", "car centered", "frame not dark") are judged on the same numbers.
 */

export interface LookObject {
  /** Name of the object (or its path when it has none). */
  name: string;
  /** Share of the frame where it is the visible surface, 0..1. */
  visible: number;
  /** Share of the frame it would cover with nothing in front of it, 0..1. */
  silhouette: number;
  /** Box of its visible pixels in the frame, 0..1: x0, y0, x1, y1 (y down), or null when nothing is visible. */
  box: [number, number, number, number] | null;
  /** Centre of its visible pixels, 0..1. */
  center: [number, number] | null;
  /** Its silhouette touches the frame edge. */
  cut: ("left" | "right" | "top" | "bottom")[];
  /** Mean luma (0..255) of its visible pixels. */
  luma: number | null;
  /** The object that hides most of what is hidden of it, with its share of the silhouette. */
  hiddenBy?: { name: string; share: number };
  meshes: number;
}

export interface LookFrame {
  width: number;
  height: number;
  /** Mean luma 0..255 of the frame. */
  luma: number;
  /** Share of pixels darker than 20 / brighter than 250 (luma). */
  dark: number;
  bright: number;
  /** Share of the frame where no object is (background, clear colour, environment). */
  background: number;
  /** Share of transparent pixels (canvas with alpha). */
  transparent: number;
  /** Box and centre of everything that is not background, 0..1. */
  content: { box: [number, number, number, number]; center: [number, number] } | null;
}

export interface LookReport {
  found: boolean;
  why?: string;
  frame?: LookFrame;
  objects: LookObject[];
  /** Objects in the scene not measured (over the limit). */
  skipped: number;
  renderer?: string;
}

export interface LookVerdict {
  severity: "error" | "warn" | "info";
  kind: string;
  message: string;
}

export interface LookClaim {
  text: string;
  ok: boolean;
  value: string;
}

export interface LookResult {
  ok: boolean;
  url: string;
  report: LookReport;
  verdicts: LookVerdict[];
  claims: LookClaim[];
  issues: Issue[];
  /** With annotate: the frame with boxes and names, PNG. */
  image?: Buffer;
}

export interface LookOptions extends PageOptions {
  /** ms to let the scene run after load (default 1500). */
  wait?: number;
  steps?: PlayStep[];
  /** Claims about the frame: "car visible >= 5%", "car in view", "car centered", "car not cut", "car not hidden", "frame not dark", "frame not bright", "background <= 70%". */
  expect?: string[];
  /** Width of the measuring frame in pixels (default 160, 64..320). */
  size?: number;
  /** Objects to measure at most (default 40). */
  maxObjects?: number;
  /** Also return the frame with a numbered box and the name of each visible object drawn on it. */
  annotate?: boolean;
}

/** In the page: measure the frame. Plain JS, no three import; uses the renderer, scene and camera last rendered. */
export function lookEval(size: number, maxObjects: number): string {
  return `(() => {
  const ts = window.__tsScene;
  const out = { found: false, objects: [], skipped: 0 };
  if (!ts) { out.why = 'no three.js scene was announced on this page'; return out; }
  const first = (list) => { for (const r of list) { const o = r.deref(); if (o) return o; } return null; };
  const last = ts.last;
  const scene = (last && last.scene) || first(ts.scenes);
  const renderer = (last && last.renderer) || first(ts.renderers);
  let camera = last && last.camera;
  if (scene && !camera) scene.traverse((o) => { if (!camera && o.isCamera) camera = o; });
  if (!scene || !renderer || !camera) { out.why = !scene ? 'no scene' : !renderer ? 'no renderer' : 'no camera'; return out; }
  const canvas = renderer.domElement;
  if (!canvas || !canvas.width || !canvas.height) { out.why = 'the canvas has no size'; return out; }
  out.found = true;
  out.renderer = renderer.isWebGLRenderer ? 'WebGLRenderer' : (renderer.constructor && renderer.constructor.name) || 'Renderer';
  const W = Math.max(16, Math.min(${size}, canvas.width));
  const H = Math.max(9, Math.round(W * canvas.height / canvas.width));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const grab = () => { renderer.render(scene, camera); g.clearRect(0, 0, W, H); g.drawImage(canvas, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
  const N = W * H;
  const differ = (a, b) => { const m = new Uint8Array(N); for (let i = 0, o = 0; i < N; i++, o += 4) { if (Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]) + Math.abs(a[o + 3] - b[o + 3]) > 6) m[i] = 1; } return m; };
  const isDrawable = (o) => o.isMesh || o.isPoints || o.isLine || o.isSprite;
  const shown = (o) => { let x = o; while (x) { if (!x.visible) return false; x = x.parent; } return true; };
  const pathOf = (o) => { const p = []; let x = o; while (x && x !== scene) { p.unshift(x.name || x.type); x = x.parent; } return p.join(' > '); };
  // units: whole objects, as a person would name them. From the top of the scene down, the first named object that
  // does not hold everything drawn (so a loaded model counts as one, and a "World" group around it all does not);
  // with nothing named on the way, the nearest named object, else the drawable itself
  const drawables = [];
  scene.traverse((o) => { if (isDrawable(o) && shown(o)) drawables.push(o); });
  const counts = new Map();
  for (const d of drawables) { let x = d; while (x && x !== scene) { counts.set(x, (counts.get(x) || 0) + 1); x = x.parent; } }
  const limit = Math.max(1, drawables.length - 1);
  const units = new Map();
  for (const o of drawables) {
    const chain = []; let x = o; while (x && x !== scene) { chain.unshift(x); x = x.parent; }
    let u = chain.find((n) => n.name && counts.get(n) <= limit);
    if (!u) { u = o; for (let i = chain.length - 1; i >= 0; i--) if (chain[i].name) { u = chain[i]; break; } }
    const key = u.uuid;
    if (!units.has(key)) units.set(key, { node: u, name: u.name || pathOf(u), meshes: [] });
    units.get(key).meshes.push(o);
  }
  const radius = (m) => { const geo = m.geometry; if (!geo) return 1; if (!geo.boundingSphere && geo.computeBoundingSphere) geo.computeBoundingSphere(); const e = m.matrixWorld.elements; const s = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10])); return ((geo.boundingSphere && geo.boundingSphere.radius) || 0) * s; };
  let list = [...units.values()];
  list.forEach((u) => { u.size = Math.max(...u.meshes.map(radius)); });
  list.sort((a, b) => b.size - a.size);
  out.skipped = Math.max(0, list.length - ${maxObjects});
  list = list.slice(0, ${maxObjects});
  // names must tell objects apart
  const seenNames = new Map();
  for (const u of list) { const n = seenNames.get(u.name) || 0; seenNames.set(u.name, n + 1); if (n) u.name = u.name + ' #' + (n + 1); }
  const vis = new Map(drawables.map((d) => [d, d.visible]));
  const casts = new Map(drawables.map((d) => [d, d.castShadow]));
  const setAll = (on) => drawables.forEach((d) => { d.visible = on; });
  const restore = () => drawables.forEach((d) => { d.visible = vis.get(d); d.castShadow = casts.get(d); });
  try {
    const base = grab();
    setAll(false);
    const none = grab();
    restore();
    const bg = differ(base, none);
    const masks = [];
    for (const u of list) {
      setAll(false); u.meshes.forEach((m) => { m.visible = true; m.castShadow = false; });
      const sil = differ(grab(), none);
      restore(); u.meshes.forEach((m) => { m.castShadow = false; });
      const withIt = grab();
      u.meshes.forEach((m) => { m.visible = false; });
      const without = grab();
      restore();
      masks.push({ u, sil, vis: differ(withIt, without) });
    }
    const luma = (o) => 0.2126 * base[o] + 0.7152 * base[o + 1] + 0.0722 * base[o + 2];
    let sum = 0, dark = 0, bright = 0, transp = 0, content = 0, cx = 0, cy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let i = 0, o = 0; i < N; i++, o += 4) {
      const l = luma(o); sum += l; if (l < 20) dark++; if (l > 250) bright++; if (base[o + 3] < 10) transp++;
      if (bg[i]) { content++; const x = i % W, y = (i / W) | 0; cx += x; cy += y; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    }
    const r = (v) => Math.round(v * 1000) / 1000;
    out.frame = { width: canvas.width, height: canvas.height, luma: Math.round(sum / N), dark: r(dark / N), bright: r(bright / N), background: r(1 - content / N), transparent: r(transp / N),
      content: content ? { box: [r(x0 / W), r(y0 / H), r((x1 + 1) / W), r((y1 + 1) / H)], center: [r(cx / content / W), r(cy / content / H)] } : null };
    for (const { u, sil, vis: v } of masks) {
      let nv = 0, ns = 0, sx = 0, sy = 0, l = 0, bx0 = W, by0 = H, bx1 = -1, by1 = -1;
      const cut = new Set();
      const hiders = new Map();
      for (let i = 0; i < N; i++) {
        const x = i % W, y = (i / W) | 0;
        if (sil[i]) { ns++; if (x === 0) cut.add('left'); if (x === W - 1) cut.add('right'); if (y === 0) cut.add('top'); if (y === H - 1) cut.add('bottom');
          if (!v[i]) for (const other of masks) { if (other.u !== u && other.vis[i]) { hiders.set(other.u.name, (hiders.get(other.u.name) || 0) + 1); break; } } }
        if (v[i]) { nv++; sx += x; sy += y; l += luma(i * 4); if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; }
      }
      let top = null; for (const [name, n] of hiders) if (!top || n > top.n) top = { name, n };
      out.objects.push({ name: u.name, meshes: u.meshes.length, visible: r(nv / N), silhouette: r(Math.max(ns, nv) / N),
        box: nv ? [r(bx0 / W), r(by0 / H), r((bx1 + 1) / W), r((by1 + 1) / H)] : null, center: nv ? [r(sx / nv / W), r(sy / nv / H)] : null,
        cut: [...cut], luma: nv ? Math.round(l / nv) : null, ...(top && ns ? { hiddenBy: { name: top.name, share: r(top.n / ns) } } : {}) });
    }
  } finally {
    restore();
    try { renderer.render(scene, camera); } catch (e) { /* the app renders the next frame anyway */ }
  }
  return out;
})()`;
}

const pct = (v: number): string => `${v >= 0.1 ? Math.round(v * 100) : Math.round(v * 1000) / 10}%`;

/** Where a point is in the frame, in words: "top left", "centre", "bottom". */
export function placeOf(c: [number, number]): string {
  const h = c[0] < 0.36 ? "left" : c[0] > 0.64 ? "right" : "";
  const v = c[1] < 0.36 ? "top" : c[1] > 0.64 ? "bottom" : "";
  return [v, h].filter(Boolean).join(" ") || "centre";
}

/** What an agent should know about the frame, worst first. */
export function verdicts(r: LookReport): LookVerdict[] {
  const out: LookVerdict[] = [];
  const f = r.frame;
  if (!r.found || !f) return [{ severity: "error", kind: "no-scene", message: `Nothing to measure: ${r.why ?? "no scene"}. Run three_check or three_inspect first.` }];
  const visible = r.objects.filter((o) => o.visible > 0);
  if (!r.objects.length) out.push({ severity: "error", kind: "empty", message: "The scene draws no objects: the frame is only background." });
  else if (!visible.length) out.push({ severity: "error", kind: "nothing-visible", message: `None of the ${r.objects.length} object(s) shows up in the frame. three_inspect says why per object.` });
  if (f.luma < 18 && f.dark > 0.8) out.push({ severity: "error", kind: "too-dark", message: `The frame is almost black (mean luma ${f.luma}/255, ${pct(f.dark)} dark): a lit material without light or environment, exposure, or the camera inside something.` });
  else if (f.luma < 45 && f.dark > 0.55) out.push({ severity: "warn", kind: "dark", message: `The frame is dark (mean luma ${f.luma}/255, ${pct(f.dark)} of it near black).` });
  if (f.bright > 0.3) out.push({ severity: "warn", kind: "blown-out", message: `${pct(f.bright)} of the frame is near white: too much light or exposure, or no tone mapping.` });
  const subject = [...visible].sort((a, b) => b.visible - a.visible)[0];
  if (visible.length && f.background > 0.97) out.push({ severity: "warn", kind: "tiny", message: `The objects cover only ${pct(1 - f.background)} of the frame: the camera is far away, or the objects are small (three.js units are meters by convention).` });
  for (const o of r.objects) {
    if (o.silhouette > 0.002 && o.visible / o.silhouette < 0.25 && o.hiddenBy) out.push({ severity: "warn", kind: "hidden", message: `${o.name} is mostly hidden: ${pct(1 - o.visible / o.silhouette)} of it is behind ${o.hiddenBy.name}.` });
  }
  if (subject && subject.cut.length && subject.silhouette > 0.05) out.push({ severity: "info", kind: "cut", message: `${subject.name}, the largest object, is cut by the ${subject.cut.join(" and ")} edge of the frame.` });
  if (r.skipped) out.push({ severity: "info", kind: "skipped", message: `${r.skipped} smaller object(s) were not measured (max_objects).` });
  return out;
}

/** Judges claims about the frame. Unknown claim shapes fail with the shapes that work. */
export function judge(r: LookReport, claims: readonly string[]): LookClaim[] {
  const find = (name: string) => r.objects.find((o) => o.name === name) ?? r.objects.find((o) => o.name.toLowerCase() === name.toLowerCase()) ?? r.objects.find((o) => o.name.toLowerCase().includes(name.toLowerCase()));
  const cmp = (a: number, op: string, b: number) => (op === ">=" ? a >= b : op === ">" ? a > b : op === "<=" ? a <= b : op === "<" ? a < b : Math.abs(a - b) < 1e-9);
  return claims.map((text) => {
    const t = text.trim();
    const f = r.frame;
    let m: RegExpExecArray | null;
    if ((m = /^frame\s+(not\s+)?(dark|bright)$/i.exec(t))) {
      if (!f) return { text: t, ok: false, value: "no frame" };
      const isDark = f.luma < 45 && f.dark > 0.55;
      const isBright = f.bright > 0.3;
      const v = m[2]!.toLowerCase() === "dark" ? isDark : isBright;
      return { text: t, ok: m[1] ? !v : v, value: `luma ${f.luma}, ${pct(f.dark)} dark, ${pct(f.bright)} bright` };
    }
    if ((m = /^background\s*(>=|<=|>|<|==)\s*([\d.]+)\s*%$/i.exec(t))) {
      if (!f) return { text: t, ok: false, value: "no frame" };
      return { text: t, ok: cmp(f.background * 100, m[1]!, Number(m[2])), value: pct(f.background) };
    }
    if ((m = /^(.+?)\s+(visible|silhouette)\s*(>=|<=|>|<|==)\s*([\d.]+)\s*%$/i.exec(t))) {
      const o = find(m[1]!.trim());
      if (!o) return { text: t, ok: false, value: `no object "${m[1]!.trim()}"` };
      const v = m[2]!.toLowerCase() === "visible" ? o.visible : o.silhouette;
      return { text: t, ok: cmp(v * 100, m[3]!, Number(m[4])), value: pct(v) };
    }
    if ((m = /^(.+?)\s+(not\s+)?(in view|centered|centred|cut|hidden)$/i.exec(t))) {
      const o = find(m[1]!.trim());
      if (!o) return { text: t, ok: false, value: `no object "${m[1]!.trim()}"` };
      const what = m[3]!.toLowerCase();
      let v: boolean;
      let value: string;
      if (what === "in view") [v, value] = [o.visible > 0, `visible ${pct(o.visible)}`];
      else if (what === "cut") [v, value] = [o.cut.length > 0, o.cut.length ? `cut ${o.cut.join(", ")}` : "not cut"];
      else if (what === "hidden") [v, value] = [o.silhouette > 0 && o.visible / o.silhouette < 0.5, o.silhouette ? `${pct(1 - o.visible / o.silhouette)} hidden` : "not on screen"];
      else [v, value] = [!!o.center && Math.abs(o.center[0] - 0.5) <= 0.15 && Math.abs(o.center[1] - 0.5) <= 0.15, o.center ? `centre at ${o.center.map((c) => Math.round(c * 100) + "%").join(", ")}` : "not visible"];
      return { text: t, ok: m[2] ? !v : v, value };
    }
    return { text: t, ok: false, value: 'unknown claim; use "<name> visible >= 5%", "<name> in view", "<name> centered", "<name> not cut", "<name> not hidden", "frame not dark", "frame not bright", "background <= 70%"' };
  });
}

/** The order objects are numbered in on an annotated frame (and in the text): most of the frame first. */
export const annotationOrder = (r: LookReport): LookObject[] => [...r.objects].filter((o) => o.visible > 0 && o.box).sort((a, b) => b.visible - a.visible).slice(0, 20);

/** In the page: the frame at its own size (at most 960 wide) with a numbered box and the name of each object. */
export function annotateEval(r: LookReport): string {
  const items = annotationOrder(r).map((o, i) => ({ n: i + 1, name: o.name, box: o.box, pct: o.visible }));
  return `(() => {
  const ts = window.__tsScene;
  const first = (list) => { for (const x of list) { const o = x.deref(); if (o) return o; } return null; };
  const scene = ts && ((ts.last && ts.last.scene) || first(ts.scenes));
  const renderer = ts && ((ts.last && ts.last.renderer) || first(ts.renderers));
  const camera = ts && ts.last && ts.last.camera;
  if (!scene || !renderer || !camera) return null;
  const src = renderer.domElement;
  const W = Math.min(960, src.width), H = Math.round(W * src.height / src.width);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  renderer.render(scene, camera);
  g.drawImage(src, 0, 0, W, H);
  const items = ${JSON.stringify(items)};
  const colors = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00', '#af52de', '#ff9500', '#5ac8fa', '#ff2d55'];
  g.font = 'bold ' + Math.max(11, Math.round(W / 60)) + 'px sans-serif';
  g.textBaseline = 'top';
  for (const it of items) {
    const c = colors[(it.n - 1) % colors.length];
    const [x0, y0, x1, y1] = it.box;
    const x = x0 * W, y = y0 * H, w = (x1 - x0) * W, h = (y1 - y0) * H;
    g.lineWidth = 2; g.strokeStyle = c; g.strokeRect(x + 1, y + 1, Math.max(2, w - 2), Math.max(2, h - 2));
    const label = it.n + ' ' + it.name + ' ' + (it.pct >= 0.1 ? Math.round(it.pct * 100) : Math.round(it.pct * 1000) / 10) + '%';
    const tw = g.measureText(label).width + 8, th = Math.max(11, Math.round(W / 60)) + 6;
    const lx = Math.min(Math.max(0, x), W - tw), ly = y - th >= 0 ? y - th : Math.min(H - th, y + 2);
    g.fillStyle = c; g.fillRect(lx, ly, tw, th);
    g.fillStyle = '#000'; g.fillText(label, lx + 4, ly + 3);
  }
  return cv.toDataURL('image/png');
})()`;
}

async function annotate(page: import("playwright-core").Page, r: LookReport): Promise<Buffer | undefined> {
  const url = (await page.evaluate(annotateEval(r))) as string | null;
  return url ? Buffer.from(url.replace(/^data:image\/png;base64,/, ""), "base64") : undefined;
}

/** Opens the page headless, lets it run, and measures the frame. */
export async function look(opts: LookOptions): Promise<LookResult> {
  const size = Math.max(64, Math.min(320, Math.round(opts.size ?? 160)));
  const o = await openRunPage(opts);
  try {
    let report: LookReport = { found: false, objects: [], skipped: 0, why: "the page did not load" };
    let image: Buffer | undefined;
    if (o.loaded) {
      await settle(o.page, opts.wait ?? 1500);
      if (opts.steps?.length) await runSteps(o, opts.steps);
      await settle(o.page, 50);
      report = (await o.page.evaluate(lookEval(size, Math.max(1, Math.min(80, opts.maxObjects ?? 40))))) as LookReport;
      if (opts.annotate && report.found) image = await annotate(o.page, report);
    }
    const v = verdicts(report);
    const claims = judge(report, opts.expect ?? []);
    const errors = o.issues.filter((i) => i.severity === "error");
    return { ok: report.found && !v.some((x) => x.severity === "error") && claims.every((c) => c.ok) && !errors.length, url: o.url, report, verdicts: v, claims, issues: o.issues, ...(image ? { image } : {}) };
  } finally {
    await o.close();
  }
}

export function formatLook(r: Pick<LookResult, "report" | "verdicts" | "claims"> & { issues?: Issue[] }, opts: { maxObjects?: number } = {}): string {
  const out: string[] = [];
  const f = r.report.frame;
  if (f) {
    out.push(`Frame ${f.width}x${f.height}: mean luma ${f.luma}/255, ${pct(f.dark)} near black, ${pct(f.bright)} near white, background ${pct(f.background)}${f.transparent > 0.01 ? `, ${pct(f.transparent)} transparent` : ""}.`);
    if (f.content) out.push(`Content: from ${pct(f.content.box[0])},${pct(f.content.box[1])} to ${pct(f.content.box[2])},${pct(f.content.box[3])} of the frame, weight at the ${placeOf(f.content.center)}.`);
  }
  const objs = [...r.report.objects].sort((a, b) => b.visible - a.visible);
  const num = new Map(annotationOrder(r.report).map((o, i) => [o, i + 1]));
  const cap = opts.maxObjects ?? 15;
  if (objs.length) out.push("Objects (share of the frame it really shows; place; cut by the edge; hidden):");
  for (const o of objs.slice(0, cap)) {
    if (!o.visible) {
      out.push(`  ${o.name}: not visible${o.silhouette ? `: all of it is behind ${o.hiddenBy?.name ?? "other objects"}` : " (off screen, too small, or the same colour as what is behind it)"}`);
      continue;
    }
    const hidden = o.silhouette > 0 ? 1 - o.visible / o.silhouette : 0;
    out.push(
      `  ${num.has(o) ? `${num.get(o)}. ` : ""}${o.name}: ${pct(o.visible)} at the ${placeOf(o.center!)}${o.cut.length ? `, cut ${o.cut.join("/")}` : ""}${hidden >= 0.1 ? `, ${pct(hidden)} hidden${o.hiddenBy ? ` by ${o.hiddenBy.name}` : ""}` : ""}, luma ${o.luma}${o.meshes > 1 ? ` (${o.meshes} meshes)` : ""}`,
    );
  }
  if (objs.length > cap) out.push(`  +${objs.length - cap} more`);
  for (const v of r.verdicts) out.push(`${v.severity === "error" ? "✖" : v.severity === "warn" ? "▲" : "·"} [${v.kind}] ${v.message}`);
  if (!r.verdicts.length && f) out.push("No problems with the frame found.");
  if (r.claims.length) {
    out.push(`Claims: ${r.claims.filter((c) => c.ok).length}/${r.claims.length} hold`);
    for (const c of r.claims) out.push(`  ${c.ok ? "✓" : "✗"} ${c.text} (${c.value})`);
  }
  const errors = (r.issues ?? []).filter((i) => i.severity === "error");
  for (const e of errors.slice(0, 5)) out.push(`error [${e.kind}] ${e.message.split("\n")[0]}`);
  if (r.report.found) out.push("Measured with renderer.render(scene, camera) at a small size: post-processing passes are not in the numbers.");
  return out.join("\n");
}
