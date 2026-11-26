import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settle } from "../check/clock.js";
import { diff } from "../check/diff.js";
import { decodePng, encodePng, type Image } from "../check/png.js";
import type { PageOptions } from "../check/page.js";
import { openRunPage, runSteps } from "../check/play.js";
import type { PlayStep } from "../check/steps.js";
import { round, signed } from "../check/util.js";
import { migrations, type MigrationKind } from "../migrate/data.js";
import { migratePlan } from "../migrate/migrate.js";
import { obtainRelease, type Release } from "./releases.js";

/**
 * three_compare: the same page on two three.js releases, compared by meaning. Both runs use the deterministic clock
 * (seed + fixed_dt, see clock.ts), so a difference comes from the release, not from timing. Each run is captured:
 * the picture, renderer.info, the scene graph (every object with its world box and its box on screen), and the
 * console. The two captures are compared, and each change is annotated with the migration entries
 * (data/migrations) of the releases in between that explain it: first the ones that match this code, then, for a
 * console message, any entry that names the same API. A change that no entry explains is a probable regression.
 */

export interface CompareOptions extends PageOptions {
  /** The release to compare with: r186, 0.186.1, next, previous, latest, or a folder with a three package. */
  with: string;
  /** The release of the first run. Default "installed". */
  base?: string;
  /** Milliseconds (frames, under the deterministic clock) before the capture. Default 1500. */
  wait?: number;
  /** Steps run in both pages before the capture (the play steps). */
  steps?: PlayStep[];
  /** Share of changed pixels that counts as a change in the picture. Default 0.005. */
  tolerance?: number;
  /** Per-channel threshold for a changed pixel. Default 16. */
  threshold?: number;
}

export interface SceneObject {
  /** "Scene > car > wheel_fl" (type when unnamed, "#2" for the third sibling with the same name). */
  path: string;
  type: string;
  visible: boolean;
  /** World box size and centre, rounded. */
  size?: [number, number, number];
  center?: [number, number, number];
  /** The box on screen in canvas pixels: x0, y0, x1, y1 (clipped), when in front of the camera. */
  screen?: [number, number, number, number];
}

export interface Capture {
  version: string;
  release: number;
  source: Release["source"];
  /** The revision the page reported (window.__THREE__). */
  revision: string | null;
  /** The three files served from this release. */
  swapped: string[];
  loaded: boolean;
  info: { calls: number; triangles: number; programs: number; geometries: number; textures: number } | null;
  objects: SceneObject[];
  /** Objects in the scene (the list keeps 400). */
  objectCount: number;
  warnings: string[];
  errors: string[];
  screenshot?: string;
  /** Mean luminance of the canvas, 0..255. */
  luminance?: number;
}

export interface Explanation {
  release: number;
  id: string;
  kind: MigrationKind;
  title: string;
  todo: string;
  source: string;
  /** The entry matches this code (three_migrate found it), not only the API in the message. */
  inCode: boolean;
}

export type ChangeKind = "error-new" | "error-gone" | "warning-new" | "warning-gone" | "object-lost" | "object-new" | "object-visibility" | "object-bounds" | "pixels" | "region" | "info";

export interface Change {
  kind: ChangeKind;
  message: string;
  /** Migration entries that explain it; empty for a probable regression. */
  explainedBy: Explanation[];
  /** No entry explains a change that matters: probably a regression (or a change the data does not cover yet). */
  unexplained: boolean;
}

export interface CompareResult {
  ok: boolean;
  url: string;
  base: Capture;
  target: Capture;
  /** "same": nothing changed; "explained": every change has a migration entry; "changed": something has none; "broken": the target throws or loses objects. */
  verdict: "same" | "explained" | "changed" | "broken";
  changes: Change[];
  pixels: { ratio: number; box?: { x: number; y: number; width: number; height: number }; diffImage?: string; sizeMismatch: boolean };
  /** Problems with the comparison itself (the swap did not take, the page did not load). */
  problems: string[];
  note: string;
}

const MAX_OBJECTS = 400;

/** Reads the scene in the page: objects with world and screen boxes, renderer.info. Plain JS, no three import. */
export const CAPTURE_EVAL = `(() => {
  const api = window.__threesmith;
  const scene = api && api.scene;
  const cam = api && api.camera;
  const r = api && api.renderer;
  const info = r && r.info ? { calls: r.info.render.calls, triangles: r.info.render.triangles, programs: (r.info.programs || []).length, geometries: r.info.memory.geometries, textures: r.info.memory.textures } : null;
  const objects = [];
  let count = 0;
  const canvas = (r && r.domElement) || document.querySelector('canvas');
  const W = canvas ? canvas.clientWidth : 0, H = canvas ? canvas.clientHeight : 0;
  const mul = (e, x, y, z) => { const w = e[3] * x + e[7] * y + e[11] * z + e[15]; return [(e[0] * x + e[4] * y + e[8] * z + e[12]) / w, (e[1] * x + e[5] * y + e[9] * z + e[13]) / w, (e[2] * x + e[6] * y + e[10] * z + e[14]) / w, w]; };
  const R = (n) => Math.round(n * 1000) / 1000;
  if (cam && cam.updateMatrixWorld) cam.updateMatrixWorld();
  const visit = (o, path, shown) => {
    count++;
    const vis = shown && o.visible !== false;
    const item = { path, type: o.type, visible: vis };
    const g = o.geometry;
    if (g && g.attributes && g.attributes.position) {
      try {
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox;
        if (b && isFinite(b.min.x) && o.matrixWorld) {
          const e = o.matrixWorld.elements;
          let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity], s0 = [Infinity, Infinity], s1 = [-Infinity, -Infinity], front = false;
          for (let i = 0; i < 8; i++) {
            const p = mul(e, i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z, 1);
            for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[k]); mx[k] = Math.max(mx[k], p[k]); }
            if (cam && cam.matrixWorldInverse && cam.projectionMatrix && W) {
              const v = mul(cam.matrixWorldInverse.elements, p[0], p[1], p[2]);
              const c = mul(cam.projectionMatrix.elements, v[0], v[1], v[2]);
              if (c[3] > 0 || cam.isOrthographicCamera) { front = true; const x = (c[0] + 1) / 2 * W, y = (1 - c[1]) / 2 * H; s0 = [Math.min(s0[0], x), Math.min(s0[1], y)]; s1 = [Math.max(s1[0], x), Math.max(s1[1], y)]; }
            }
          }
          item.size = [R(mx[0] - mn[0]), R(mx[1] - mn[1]), R(mx[2] - mn[2])];
          item.center = [R((mx[0] + mn[0]) / 2), R((mx[1] + mn[1]) / 2), R((mx[2] + mn[2]) / 2)];
          if (front) {
            const x0 = Math.max(0, Math.floor(s0[0])), y0 = Math.max(0, Math.floor(s0[1])), x1 = Math.min(W, Math.ceil(s1[0])), y1 = Math.min(H, Math.ceil(s1[1]));
            if (x1 > x0 && y1 > y0) item.screen = [x0, y0, x1, y1];
          }
        }
      } catch (err) { /* a geometry without positions on the CPU */ }
    }
    if (objects.length < ${MAX_OBJECTS}) objects.push(item);
    const seen = new Map();
    for (const c of o.children || []) {
      const base = c.name || c.type;
      const n = seen.get(base) || 0;
      seen.set(base, n + 1);
      visit(c, path + ' > ' + base + (n ? ' #' + (n + 1) : ''), vis);
    }
  };
  if (scene) visit(scene, scene.name || 'Scene', true);
  return { revision: window.__THREE__ || null, info, objects, count };
})()`;

/** Mean Rec. 709 luma of a region (x0, y0, x1, y1), 0..255. */
export function luminance(img: Image, box?: [number, number, number, number]): number {
  const [x0, y0, x1, y1] = box ?? [0, 0, img.width, img.height];
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      const o = (y * img.width + x) * 4;
      sum += 0.2126 * img.data[o]! + 0.7152 * img.data[o + 1]! + 0.0722 * img.data[o + 2]!;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** A console message without what changes between runs of the same page (ports, numbers in URLs). */
export const normalizeMessage = (m: string): string => m.replace(/https?:\/\/127\.0\.0\.1:\d+/g, "").replace(/\s+/g, " ").trim().slice(0, 300);

/** Opens the page with one release swapped in and captures it. */
export async function capture(opts: CompareOptions, release: Release, shotPath: string): Promise<{ capture: Capture; image?: Image; url: string }> {
  const seeded = opts.seed === undefined && opts.fixedDt === undefined ? { seed: 1 } : {};
  const o = await openRunPage({ ...opts, ...seeded, swapThree: release.dir });
  const cap: Capture = { version: release.version, release: release.release, source: release.source, revision: null, swapped: [], loaded: o.loaded, info: null, objects: [], objectCount: 0, warnings: [], errors: [] };
  let image: Image | undefined;
  try {
    if (o.loaded) {
      await settle(o.page, opts.wait ?? 1500);
      if (opts.steps?.length) await runSteps(o, opts.steps);
      await settle(o.page, 50);
      const got = (await o.page.evaluate(CAPTURE_EVAL)) as { revision: string | null; info: Capture["info"]; objects: SceneObject[]; count: number };
      cap.revision = got.revision;
      cap.info = got.info;
      cap.objects = got.objects;
      cap.objectCount = got.count;
      // the canvas only: the page around it would dilute the share of changed pixels and the luminance
      const marked = (await o.page.evaluate("(() => { const r = window.__threesmith.renderer; const c = (r && r.domElement) || document.querySelector('canvas'); if (!c) return false; c.setAttribute('data-ts-compare', ''); return true; })()")) as boolean;
      let shot: Buffer;
      try {
        shot = marked ? await o.page.locator("[data-ts-compare]").first().screenshot({ type: "png", timeout: 5000 }) : await o.page.screenshot({ type: "png" });
      } catch {
        shot = await o.page.screenshot({ type: "png" });
      }
      writeFileSync(shotPath, shot);
      cap.screenshot = shotPath;
      image = decodePng(shot);
      cap.luminance = round(luminance(image), 1);
    }
  } finally {
    await o.close();
  }
  cap.swapped = o.swapped.sort();
  for (const i of o.issues) {
    const m = normalizeMessage(i.message);
    if (i.severity === "error") cap.errors.push(`${i.kind}: ${m}`);
    else if (i.kind === "console-warn") cap.warnings.push(m);
  }
  cap.errors = [...new Set(cap.errors)];
  cap.warnings = [...new Set(cap.warnings)];
  return { capture: cap, ...(image ? { image } : {}), url: o.url };
}

/** API names in a migration title or todo: CamelCase words, dotted names and calls ("Clock", "renderer.outputEncoding", "load()"). */
export function apiNames(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[A-Z][a-z]{2,}(?=\b))|\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b\w+(?=\(\))/g)) out.add(m[0]);
  // single capitalised words ("Clock") are names only when the title starts with them or puts them in code style
  return [...out].filter((n) => n.length >= 4 && !/^(?:The|This|They|There|Use|Uses|When|With|What|Pass|Replace|Remove|Check|Call|Materials|Background|Pixel|Struct|Light|Lights)$/.test(n));
}

export interface Annotator {
  /** Entries for a console message: the ones naming an API in it. */
  forMessage(m: string): Explanation[];
  /** Entries in this code of these kinds. */
  inCode(kinds: MigrationKind[]): Explanation[];
}

/** The migration entries between two releases, with the ones three_migrate finds in this code marked. */
export function annotator(folder: string, a: number, b: number): Annotator {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const all: Explanation[] = [];
  for (const rel of migrations()) {
    if (rel.release <= lo || rel.release > hi) continue;
    for (const e of rel.entries) all.push({ release: rel.release, id: e.id, kind: e.kind, title: e.title, todo: e.todo, source: e.source, inCode: false });
  }
  const hits = new Set<string>();
  if (lo < hi) {
    try {
      const plan = migratePlan({ path: folder, from: `r${lo}`, to: `r${hi}` });
      // a copy of three inside the project (vendor/three.module.js) is not the project's code
      const own = (f: string) => !/(?:^|\/)three\.(?:module|core|webgpu|tsl|cjs)(?:\.min)?\.js$/.test(f);
      for (const r of plan.releases) for (const e of r.entries) if (r.release > lo && e.where.some((w) => own(w.file))) hits.add(`${r.release}:${e.id}`);
    } catch {
      /* no code to scan (a URL, or no three files): explanations from the messages only */
    }
  }
  for (const e of all) e.inCode = hits.has(`${e.release}:${e.id}`);
  return {
    forMessage(m: string) {
      const named = all.filter((e) => apiNames(`${e.title} ${e.todo}`).some((n) => new RegExp(`\\b${n.replace(/[^\w]/g, "")}\\b`).test(m)));
      return named.sort((x, y) => Number(y.inCode) - Number(x.inCode)).slice(0, 3);
    },
    inCode(kinds: MigrationKind[]) {
      return all.filter((e) => e.inCode && kinds.includes(e.kind));
    },
  };
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-3, 0.01 * Math.max(Math.abs(a), Math.abs(b)));

/** Compares two captures. Pure (the annotator and images come in), so it is tested without a browser. */
export function compareCaptures(base: Capture, target: Capture, ann: Annotator, images: { base?: Image; target?: Image }, o: { tolerance?: number; threshold?: number } = {}): { changes: Change[]; pixels: CompareResult["pixels"]; diffImage?: Image } {
  const changes: Change[] = [];
  const add = (kind: ChangeKind, message: string, explainedBy: Explanation[], matters = true) => changes.push({ kind, message, explainedBy, unexplained: matters && !explainedBy.length });
  const look = ann.inCode(["appearance"]);
  const behaviour = ann.inCode(["behaviour", "removed", "rename"]);
  const label = `r${base.release} → r${target.release}`;

  const errs = (c: Capture) => new Set(c.errors);
  for (const e of errs(target)) if (!errs(base).has(e)) add("error-new", `new error on r${target.release}: ${e}`, ann.forMessage(e).length ? ann.forMessage(e) : behaviour);
  for (const e of errs(base)) if (!errs(target).has(e)) add("error-gone", `error gone on r${target.release}: ${e}`, ann.forMessage(e), false);
  const warns = (c: Capture) => new Set(c.warnings);
  for (const w of warns(target)) if (!warns(base).has(w)) add("warning-new", `new warning on r${target.release}: ${w}`, ann.forMessage(w));
  for (const w of warns(base)) if (!warns(target).has(w)) add("warning-gone", `warning gone on r${target.release}: ${w}`, ann.forMessage(w), false);

  const byPath = (c: Capture) => new Map(c.objects.map((x) => [x.path, x]));
  const A = byPath(base);
  const B = byPath(target);
  const lost = [...A.keys()].filter((p) => !B.has(p));
  const gained = [...B.keys()].filter((p) => !A.has(p));
  if (lost.length) add("object-lost", `${lost.length} object(s) missing on r${target.release}: ${lost.slice(0, 5).join("; ")}${lost.length > 5 ? " …" : ""}`, behaviour);
  if (gained.length) add("object-new", `${gained.length} new object(s) on r${target.release}: ${gained.slice(0, 5).join("; ")}${gained.length > 5 ? " …" : ""}`, behaviour);
  const regions: { path: string; box: [number, number, number, number] }[] = [];
  for (const [p, a] of A) {
    const b = B.get(p);
    if (!b) continue;
    if (a.visible !== b.visible) add("object-visibility", `${p} is ${b.visible ? "visible" : "hidden"} on r${target.release} (was ${a.visible ? "visible" : "hidden"})`, behaviour);
    if (a.size && b.size && a.center && b.center && ![0, 1, 2].every((k) => sameNumber(a.size![k]!, b.size![k]!) && sameNumber(a.center![k]!, b.center![k]!)))
      add("object-bounds", `${p} moved or changed size: centre ${a.center.join(",")} → ${b.center.join(",")}, size ${a.size.join(",")} → ${b.size.join(",")}`, behaviour);
    if (a.visible && b.visible && a.screen && /Mesh|Points|Line|Sprite/.test(a.type)) regions.push({ path: p, box: a.screen });
  }

  if (base.info && target.info) {
    const parts = (["calls", "triangles", "programs", "geometries", "textures"] as const).filter((k) => base.info![k] !== target.info![k]).map((k) => `${k} ${base.info![k]} → ${target.info![k]} (${signed(target.info![k] - base.info![k])})`);
    if (parts.length) add("info", `renderer.info ${label}: ${parts.join(", ")}`, [...look, ...behaviour], false);
  }

  let pixels: CompareResult["pixels"] = { ratio: 0, sizeMismatch: false };
  let diffImage: Image | undefined;
  if (images.base && images.target) {
    const d = diff(images.base, images.target, { threshold: o.threshold ?? 16 });
    pixels = { ratio: round(d.ratio, 4), sizeMismatch: d.sizeMismatch, ...(d.box ? { box: d.box } : {}) };
    diffImage = d.image;
    if (d.sizeMismatch) add("pixels", `the screenshot size changed: ${images.base.width}x${images.base.height} → ${images.target.width}x${images.target.height}`, behaviour);
    else if (d.ratio > (o.tolerance ?? 0.005)) {
      const lb = base.luminance ?? luminance(images.base);
      const lt = target.luminance ?? luminance(images.target);
      const box = d.box ? ` in a ${d.box.width}x${d.box.height} area at ${d.box.x},${d.box.y}` : "";
      add("pixels", `${round(d.ratio * 100, 2)}% of the pixels changed${box}; mean luminance ${round(lb, 1)} → ${round(lt, 1)} (${signed(round(lt - lb, 1))})`, look.length ? look : behaviour);
      // per object: the mean luminance inside its box on screen, the ones that changed most first
      const per = regions
        .map((r) => ({ ...r, a: luminance(images.base!, r.box), b: luminance(images.target!, r.box) }))
        .filter((r) => Math.abs(r.b - r.a) >= 1 && Math.abs(r.b - r.a) / Math.max(r.a, 1) >= 0.02)
        .sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a))
        .slice(0, 5);
      for (const r of per) add("region", `${r.path}: ${signed(round(((r.b - r.a) / Math.max(r.a, 1)) * 100, 1))}% luminance (${round(r.a, 1)} → ${round(r.b, 1)}) in its box on screen ${r.box.join(",")}`, look.length ? look : behaviour);
    }
  }
  return { changes, pixels, ...(diffImage ? { diffImage } : {}) };
}

export async function compare(opts: CompareOptions): Promise<CompareResult> {
  const folder = /^https?:\/\//.test(opts.target) ? process.cwd() : opts.target;
  const baseRelease = await obtainRelease(opts.base ?? "installed", folder);
  const targetRelease = await obtainRelease(opts.with, folder);
  const stateDir = opts.stateDir ?? join(folder, ".threesmith");
  const dir = join(stateDir, "compare");
  mkdirSync(dir, { recursive: true });
  const a = await capture(opts, baseRelease, join(dir, `r${baseRelease.release}-${baseRelease.version}.png`));
  const b = await capture(opts, targetRelease, join(dir, `r${targetRelease.release}-${targetRelease.version}.png`));
  const problems: string[] = [];
  for (const c of [a.capture, b.capture]) {
    if (!c.loaded) problems.push(`the page did not load on ${c.version}`);
    else if (!c.swapped.some((p) => /^build\/three\.(?:module|core|webgpu)(?:\.min)?\.js$/.test(p)))
      problems.push(`the page loaded no three build file Threesmith could swap (bundled by Vite/webpack, or three from an unknown URL): both runs may use the same three. Compare a page that imports three through an import map, node_modules/three or a CDN URL with three@<version>.`);
    else if (c.revision && c.revision !== String(c.release)) problems.push(`the page reported three r${c.revision} on the ${c.version} run: part of it still loads another copy of three`);
  }
  const ann = annotator(folder, baseRelease.release, targetRelease.release);
  const r = compareCaptures(a.capture, b.capture, ann, { ...(a.image ? { base: a.image } : {}), ...(b.image ? { target: b.image } : {}) }, opts);
  if (r.diffImage && r.pixels.ratio > 0) {
    const p = join(dir, `diff-r${baseRelease.release}-r${targetRelease.release}.png`);
    writeFileSync(p, encodePng(r.diffImage));
    r.pixels.diffImage = p;
  }
  const broken = r.changes.some((c) => c.kind === "error-new" || c.kind === "object-lost") || (a.capture.loaded && !b.capture.loaded);
  const verdict: CompareResult["verdict"] = broken ? "broken" : !r.changes.length ? "same" : r.changes.some((c) => c.unexplained) ? "changed" : "explained";
  return {
    ok: !problems.length && (verdict === "same" || verdict === "explained"),
    url: b.url,
    base: a.capture,
    target: b.capture,
    verdict,
    changes: r.changes,
    pixels: r.pixels,
    problems: [...new Set(problems)],
    note: "Both runs use the deterministic clock (seed, fixed_dt) and SwiftShader; renderer.info counts are exact. A change no migration entry explains is a probable regression, or a change the migration data does not cover yet.",
  };
}

const VERDICT: Record<CompareResult["verdict"], string> = {
  same: "no difference",
  explained: "changes, all explained by the migration notes",
  changed: "changes that no migration note explains (probable regression)",
  broken: "the page breaks on the new release",
};

export function formatCompare(r: CompareResult): string {
  const c = (x: Capture) => `r${x.release} (${x.version}, ${x.source})`;
  const out = [`Threesmith compare: ${r.ok ? "OK" : "FAIL"} ${c(r.base)} → ${c(r.target)}: ${VERDICT[r.verdict]} – ${r.url}`];
  for (const x of [r.base, r.target]) {
    out.push(`  ${c(x)}: page says r${x.revision ?? "?"}; ${x.objectCount} objects; ${x.info ? `calls ${x.info.calls}, triangles ${x.info.triangles}, programs ${x.info.programs}, textures ${x.info.textures}` : "no renderer"}; ${x.errors.length} error(s), ${x.warnings.length} warning(s)${x.luminance !== undefined ? `; luminance ${x.luminance}` : ""}`);
  }
  for (const p of r.problems) out.push(`✖ ${p}`);
  const told = new Set<string>();
  for (const ch of r.changes) {
    out.push(`${ch.unexplained ? "✖" : ch.kind.endsWith("-gone") || ch.kind === "info" ? "·" : "▲"} [${ch.kind}] ${ch.message}`);
    for (const e of ch.explainedBy.slice(0, 3)) {
      const key = `${e.release}:${e.id}`;
      out.push(told.has(key) ? `    expected: r${e.release} ${e.id} (above)` : `    expected: r${e.release} ${e.title}${e.inCode ? " (in this code)" : ""} – ${e.todo} ${e.source}`);
      told.add(key);
    }
    if (ch.unexplained) out.push("    no migration entry explains this: probable regression (or a change the data does not cover yet)");
  }
  if (!r.changes.length && !r.problems.length) out.push("Same picture, scene, renderer.info and console on both releases.");
  if (r.pixels.diffImage) out.push(`diff: ${r.pixels.diffImage}`);
  if (r.target.screenshot) out.push(`screenshots: ${r.base.screenshot ?? "-"} | ${r.target.screenshot}`);
  out.push(`note: ${r.note}`);
  return out.join("\n");
}
