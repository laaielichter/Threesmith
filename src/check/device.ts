import { readFileSync } from "node:fs";
import type { Issue } from "./check.js";
import { blankness, diff } from "./diff.js";
import { decodePng } from "./png.js";
import type { PageOptions } from "./page.js";
import { summarize, TIMING_NOTE, type Stats } from "./perf.js";
import { openRunPage } from "./play.js";
import type { FrameRecord } from "./runtime.js";
import { formatIssues, round } from "./util.js";

/**
 * three_device: the page run as on a phone, a tablet or a low-end laptop. The profile sets the viewport, the device
 * pixel ratio, touch and a CPU slow-down (Chrome DevTools Protocol), and clamps the WebGL limits the page reads
 * (MAX_TEXTURE_SIZE, MAX_CUBE_MAP_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE), so three resizes images the way it would there
 * and a texture uploaded over the limit is named. The profiles are presets to compare against, not measurements of
 * real devices: pass your own as a JSON file. Frame times still come from SwiftShader: compare runs on one machine.
 */

export interface DeviceProfile {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  /** CPU slow-down factor (Emulation.setCPUThrottlingRate); 1 = none. */
  cpuThrottle: number;
  /** Clamp for MAX_TEXTURE_SIZE and MAX_CUBE_MAP_TEXTURE_SIZE. */
  maxTextureSize: number;
  /** Clamp for MAX_RENDERBUFFER_SIZE and MAX_VIEWPORT_DIMS. */
  maxRenderbufferSize: number;
  /** Texture memory budget in MB (level 0 of what was uploaded, RGBA8 estimate). */
  textureMb: number;
  /** Highest pixel ratio worth rendering at on this device. */
  maxPixelRatio: number;
  note: string;
}

/** Presets. The limits are conservative values to test against (WebGL 2 guarantees a MAX_TEXTURE_SIZE of 2048), not the numbers of a given device. */
export const PROFILES: Record<string, DeviceProfile> = {
  phone: { name: "phone", width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, cpuThrottle: 4, maxTextureSize: 4096, maxRenderbufferSize: 4096, textureMb: 256, maxPixelRatio: 2, note: "a mid-range phone: 390x844 CSS pixels at DPR 3, touch, CPU 4x slower, textures up to 4096" },
  tablet: { name: "tablet", width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true, hasTouch: true, cpuThrottle: 2, maxTextureSize: 8192, maxRenderbufferSize: 8192, textureMb: 512, maxPixelRatio: 2, note: "a tablet: 820x1180 at DPR 2, touch, CPU 2x slower, textures up to 8192" },
  "low-end-laptop": { name: "low-end-laptop", width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: false, cpuThrottle: 4, maxTextureSize: 8192, maxRenderbufferSize: 8192, textureMb: 512, maxPixelRatio: 1.5, note: "an older laptop with integrated graphics: 1366x768 at DPR 1, CPU 4x slower, textures up to 8192" },
};

/** A profile by name, or from a JSON file (fields of DeviceProfile, missing ones taken from "phone" or its "extends"). */
export function loadProfile(spec: string = "phone"): DeviceProfile {
  if (Object.hasOwn(PROFILES, spec)) return PROFILES[spec]!;
  if (!/\.json$/i.test(spec)) throw new Error(`unknown device profile "${spec}"; use ${Object.keys(PROFILES).join(", ")}, or a .json file`);
  let raw: Partial<DeviceProfile> & { extends?: string };
  try {
    raw = JSON.parse(readFileSync(spec, "utf8")) as Partial<DeviceProfile> & { extends?: string };
  } catch (e) {
    throw new Error(`cannot read the device profile ${spec}: ${(e as Error).message}`);
  }
  const base = loadProfile(raw.extends && Object.hasOwn(PROFILES, raw.extends) ? raw.extends : "phone");
  const p: DeviceProfile = { ...base, ...raw, name: raw.name ?? spec.replace(/^.*[\\/]/, "").replace(/\.json$/i, ""), note: raw.note ?? `custom profile from ${spec}` };
  for (const k of ["width", "height", "deviceScaleFactor", "cpuThrottle", "maxTextureSize", "maxRenderbufferSize", "textureMb", "maxPixelRatio"] as const) {
    if (!(typeof p[k] === "number" && Number.isFinite(p[k]) && p[k] > 0)) throw new Error(`device profile ${spec}: "${k}" must be a positive number`);
  }
  return p;
}

/** The in-page part: clamps the limits and records texture uploads. Runs before the page's scripts. */
export function deviceInit(p: DeviceProfile): string {
  return `(() => {
  const L = { tex: ${Math.floor(p.maxTextureSize)}, rb: ${Math.floor(p.maxRenderbufferSize)} };
  const rec = (window.__tsDevice = { over: [], bytes: 0, uploads: 0, draws: 0, contexts: [] });
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = gc.call(this, type, ...rest);
    if (ctx && /^(?:webgl2?|experimental-webgl)$/.test(type) && !rec.contexts.includes(ctx)) rec.contexts.push(ctx);
    return ctx;
  };
  const size = (args) => {
    if (typeof args[3] === 'number' && typeof args[4] === 'number' && args.length >= 8) return [args[3], args[4]];
    const s = args[5] || args[3];
    if (s && typeof s === 'object') return [s.videoWidth || s.naturalWidth || s.displayWidth || s.width || 0, s.videoHeight || s.naturalHeight || s.displayHeight || s.height || 0];
    return [0, 0];
  };
  const note = (fn, w, h) => {
    rec.uploads++;
    rec.bytes += w * h * 4;
    if (Math.max(w, h) > L.tex && rec.over.length < 20) rec.over.push({ fn, width: w, height: h });
  };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    const P = C.prototype;
    const gp = P.getParameter;
    P.getParameter = function (p) {
      const v = gp.call(this, p);
      if (p === 0x0d33 || p === 0x851c) return Math.min(v, L.tex);
      if (p === 0x84e8) return Math.min(v, L.rb);
      if (p === 0x0d3a && v && v.length === 2) return new Int32Array([Math.min(v[0], L.rb), Math.min(v[1], L.rb)]);
      return v;
    };
    const ti = P.texImage2D;
    P.texImage2D = function (...a) { if (a[1] === 0) { const [w, h] = size(a); note('texImage2D', w, h); } return ti.apply(this, a); };
    if (P.texStorage2D) {
      const ts = P.texStorage2D;
      P.texStorage2D = function (...a) { note('texStorage2D', a[3], a[4]); return ts.apply(this, a); };
    }
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const f = P[name];
      if (f) P[name] = function (...a) { rec.draws++; return f.apply(this, a); };
    }
    const ct = P.compressedTexImage2D;
    P.compressedTexImage2D = function (...a) { if (a[1] === 0) { rec.uploads++; rec.bytes += a[3] * a[4]; if (Math.max(a[3], a[4]) > L.tex && rec.over.length < 20) rec.over.push({ fn: 'compressedTexImage2D', width: a[3], height: a[4] }); } return ct.apply(this, a); };
  }
})();`;
}

export interface DeviceOptions extends PageOptions {
  profile?: string;
  /** Milliseconds to let the scene start before measuring. Default 1500. */
  wait?: number;
  /** Seconds to measure frames. Default 3. */
  seconds?: number;
  budget?: { frameMs?: number; textureMb?: number };
  /** Lose the WebGL context (WEBGL_lose_context), restore it, and check that the scene comes back. */
  loseContext?: boolean;
  /** Share of changed pixels after the restore that still counts as recovered. Default 0.01. */
  tolerance?: number;
}

export interface ContextLossResult {
  /** The context was lost on request (false: no WebGL context or no WEBGL_lose_context). */
  lost: boolean;
  restored: boolean;
  /** Draw calls in the second after the restore. */
  drawsAfter: number;
  /** Share of pixels that differ from the frame before the loss. */
  changed: number;
  blankAfter: boolean;
  /** The picture did not change by itself before the loss, so it is compared pixel for pixel. */
  still: boolean;
  recovered: boolean;
}

export interface DeviceFinding {
  severity: "error" | "warn" | "info";
  kind: "texture-over-limit" | "texture-resized" | "texture-memory" | "pixel-ratio" | "frame-time" | "viewport-meta" | "context-loss";
  message: string;
  fix: string;
}

export interface DeviceResult {
  ok: boolean;
  url: string;
  profile: DeviceProfile;
  canvas?: { cssWidth: number; cssHeight: number; width: number; height: number; pixelRatio: number };
  textures: { uploads: number; mb: number; over: { fn: string; width: number; height: number }[] };
  frames: number;
  frame: Stats;
  script: Stats;
  calls: number;
  triangles: number;
  contextLoss?: ContextLossResult;
  findings: DeviceFinding[];
  issues: Issue[];
  note: string;
}

/** Loses and restores the page's WebGL context and compares the picture before and after. */
async function loseAndRestore(o: Awaited<ReturnType<typeof openRunPage>>, tolerance: number): Promise<ContextLossResult> {
  const before = decodePng(await o.page.screenshot());
  await o.page.waitForTimeout(200);
  // a scene that moves by itself cannot be compared pixel for pixel: then only "draws again, not blank" counts
  const still = diff(before, decodePng(await o.page.screenshot())).ratio <= tolerance;
  const lost = (await o.page.evaluate(`(() => {
    const d = window.__tsDevice;
    const gl = d && d.contexts.find((c) => !c.isContextLost());
    const ext = gl && gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    d.lose = { gl, ext };
    ext.loseContext();
    return true;
  })()`)) as boolean;
  if (!lost) return { lost: false, restored: false, drawsAfter: 0, changed: 0, blankAfter: false, still, recovered: false };
  await o.page.waitForTimeout(300);
  await o.page.evaluate("(() => { const d = window.__tsDevice; d.lose.ext.restoreContext(); d.drawsAtRestore = d.draws; })()");
  await o.page.waitForTimeout(1000);
  const state = (await o.page.evaluate("(() => { const d = window.__tsDevice; return { restored: !d.lose.gl.isContextLost(), draws: d.draws - d.drawsAtRestore }; })()")) as { restored: boolean; draws: number };
  const after = decodePng(await o.page.screenshot());
  const changed = diff(before, after).ratio;
  const blankAfter = blankness(after).blank && !blankness(before).blank;
  return { lost: true, restored: state.restored, drawsAfter: state.draws, changed: round(changed, 4), blankAfter, still, recovered: state.restored && !blankAfter && (still ? changed <= tolerance : state.draws > 0) };
}

export async function device(opts: DeviceOptions): Promise<DeviceResult> {
  const profile = loadProfile(opts.profile);
  const o = await openRunPage({
    ...opts,
    width: profile.width,
    height: profile.height,
    device: { deviceScaleFactor: profile.deviceScaleFactor, isMobile: profile.isMobile, hasTouch: profile.hasTouch, cpuThrottle: profile.cpuThrottle },
    extraInit: [deviceInit(profile), ...(opts.extraInit ?? [])],
  });
  let frames: FrameRecord[] = [];
  let contextLoss: ContextLossResult | undefined;
  let page: { layoutWidth?: number; canvas?: DeviceResult["canvas"]; dev?: { over: DeviceResult["textures"]["over"]; bytes: number; uploads: number } } = {};
  try {
    if (o.loaded) {
      await o.page.waitForTimeout(opts.wait ?? 1500);
      await o.page.evaluate("window.__tsRun.rec = []");
      await o.page.waitForTimeout(Math.min(Math.max(opts.seconds ?? 3, 0.5), 60) * 1000);
      frames = (await o.page.evaluate("(() => { const r = window.__tsRun.rec || []; window.__tsRun.rec = null; return r; })()")) as FrameRecord[];
      if (opts.loseContext) contextLoss = await loseAndRestore(o, opts.tolerance ?? 0.01);
      page = (await o.page.evaluate(`(() => {
        const r = window.__threesmith && window.__threesmith.renderer;
        const c = (r && r.domElement) || document.querySelector('canvas');
        const d = window.__tsDevice;
        const canvas = c ? { cssWidth: Math.round(c.clientWidth), cssHeight: Math.round(c.clientHeight), width: c.width, height: c.height, pixelRatio: r && r.getPixelRatio ? r.getPixelRatio() : (c.clientWidth ? c.width / c.clientWidth : 1) } : undefined;
        return { layoutWidth: window.innerWidth, canvas, dev: d ? { over: d.over, bytes: d.bytes, uploads: d.uploads } : undefined };
      })()`)) as typeof page;
    }
  } finally {
    await o.close();
  }
  const s = summarize(frames);
  const findings: DeviceFinding[] = [];
  const over = page.dev?.over ?? [];
  const mb = round((page.dev?.bytes ?? 0) / 1048576, 1);
  for (const t of over) {
    findings.push({
      severity: "error",
      kind: "texture-over-limit",
      message: `A ${t.width}x${t.height} texture was uploaded (${t.fn}) on a ${profile.name} that allows ${profile.maxTextureSize}: on such a device the upload fails and the texture is black (three only resizes images and canvases, not DataTextures, render targets or compressed textures).`,
      fix: `Keep textures at ${profile.maxTextureSize} or less (or check renderer.capabilities.maxTextureSize and pick a smaller version).`,
    });
  }
  const resized = o.issues.filter((i) => /Texture has been resized from/.test(i.message));
  if (resized.length)
    findings.push({
      severity: "warn",
      kind: "texture-resized",
      message: `three resized ${resized.length} texture(s) to fit ${profile.maxTextureSize} (${resized[0]!.message.replace(/^.*resized from /, "from ")}): the device downloads the full size and then throws detail away, on the main thread.`,
      fix: `Ship a ${profile.maxTextureSize} (or smaller) version for phones, or use KTX2.`,
    });
  if (mb > (opts.budget?.textureMb ?? profile.textureMb))
    findings.push({ severity: "warn", kind: "texture-memory", message: `About ${mb} MB of textures were uploaded (level 0 as RGBA8, compressed formats at their size), over the ${opts.budget?.textureMb ?? profile.textureMb} MB budget of this profile.`, fix: "Use smaller textures or KTX2 (it stays compressed on the GPU), and share textures between materials." });
  if (profile.isMobile && page.layoutWidth && page.layoutWidth > profile.width + 1)
    findings.push({
      severity: "warn",
      kind: "viewport-meta",
      message: `The page lays out ${page.layoutWidth} CSS pixels wide on a ${profile.width}-wide ${profile.name}: without <meta name="viewport"> mobile browsers zoom out a desktop layout, so the canvas and every touch target are drawn small and more pixels are rendered.`,
      fix: '<meta name="viewport" content="width=device-width, initial-scale=1"> in the page head.',
    });
  const c = page.canvas;
  if (c && c.pixelRatio > profile.maxPixelRatio + 0.01)
    findings.push({
      severity: "warn",
      kind: "pixel-ratio",
      message: `The canvas renders at pixel ratio ${round(c.pixelRatio, 2)} (${c.width}x${c.height} pixels for ${c.cssWidth}x${c.cssHeight} CSS pixels): ${round((c.pixelRatio / profile.maxPixelRatio) ** 2, 1)}x the pixels of ratio ${profile.maxPixelRatio}, for a sharpness few people see on a ${profile.name}.`,
      fix: `renderer.setPixelRatio(Math.min(window.devicePixelRatio, ${profile.maxPixelRatio}))`,
    });
  if (opts.budget?.frameMs !== undefined && s.frame.p95 > opts.budget.frameMs)
    findings.push({ severity: "warn", kind: "frame-time", message: `p95 frame time ${s.frame.p95} ms with the CPU ${profile.cpuThrottle}x slower, over the budget of ${opts.budget.frameMs} ms.`, fix: "three_perf names the slowest frames and their cause; compare before and after on the same machine." });
  if (contextLoss && !contextLoss.lost)
    findings.push({ severity: "warn", kind: "context-loss", message: "The context-loss test did not run: the page has no WebGL context with WEBGL_lose_context (WebGPU, or no canvas yet).", fix: "Run it on a WebGLRenderer page, after the scene has started (wait)." });
  else if (contextLoss && !contextLoss.recovered)
    findings.push({
      severity: "error",
      kind: "context-loss",
      message: !contextLoss.restored
        ? "The WebGL context was lost and never came back: the page stays black after a phone backgrounds it."
        : contextLoss.drawsAfter === 0
          ? `After the context was restored nothing was drawn${contextLoss.blankAfter ? " and the canvas is blank" : ""}: the page renders on demand (or its loop stopped), and nothing renders again on webglcontextrestored.`
          : `After the restore the page draws again, but ${Math.round(contextLoss.changed * 100)}% of the picture differs from before${contextLoss.blankAfter ? " (blank)" : ""}: content made once (render targets drawn at start-up, textures whose image was freed, custom GL state) is gone.`,
      fix: contextLoss.drawsAfter === 0
        ? "renderer.domElement.addEventListener('webglcontextrestored', () => render()); (three restores its own state; the page has to draw again)"
        : "On webglcontextrestored, rebuild what was made once (render targets, freed texture images) and render again.",
    });
  const issues = o.issues.filter((i) => !resized.includes(i));
  if (o.loaded && !frames.length) issues.push({ kind: "no-frames", severity: "warn", message: "No animation frame ran while measuring: the page renders on demand, so there are no frame times." });
  const ok = o.loaded && !issues.some((i) => i.severity === "error") && !findings.some((f) => f.severity === "error");
  return {
    ok,
    url: o.url,
    profile,
    ...(c ? { canvas: c } : {}),
    textures: { uploads: page.dev?.uploads ?? 0, mb, over },
    ...(contextLoss ? { contextLoss } : {}),
    frames: s.frames,
    frame: s.frame,
    script: s.script,
    calls: s.calls.max,
    triangles: s.triangles.max,
    findings,
    issues,
    note: TIMING_NOTE,
  };
}

export function formatDevice(r: DeviceResult): string {
  const p = r.profile;
  const out = [`Threesmith device: ${r.ok ? "OK" : "FAIL"} on ${p.name} (${p.note}) – ${r.url}`];
  if (r.canvas) out.push(`canvas ${r.canvas.cssWidth}x${r.canvas.cssHeight} CSS at pixel ratio ${round(r.canvas.pixelRatio, 2)} = ${r.canvas.width}x${r.canvas.height} pixels`);
  out.push(`frames ${r.frames}: frame ms p50 ${r.frame.p50} p95 ${r.frame.p95} max ${r.frame.max}, script ms p95 ${r.script.p95} (CPU ${p.cpuThrottle}x slower) · draw calls ${r.calls} · triangles ${r.triangles}`);
  out.push(`textures: ${r.textures.uploads} upload(s), about ${r.textures.mb} MB (budget ${p.textureMb} MB), limit ${p.maxTextureSize}`);
  const cl = r.contextLoss;
  if (cl?.lost) out.push(`context loss: lost and ${cl.restored ? "restored" : "NOT restored"}; ${cl.drawsAfter} draw call(s) in the second after; ${Math.round(cl.changed * 1000) / 10}% of the pixels differ from before${cl.blankAfter ? ", blank" : ""}: ${cl.recovered ? "recovered" : "NOT recovered"}`);
  for (const f of r.findings) out.push(`${f.severity} [device-${f.kind}] ${f.message} Fix: ${f.fix}`);
  if (!r.findings.length) out.push("Nothing over this profile's limits.");
  out.push(...formatIssues(r.issues));
  out.push(`note: the profile is a preset to test against, not a real device. ${r.note}`);
  return out.join("\n");
}
