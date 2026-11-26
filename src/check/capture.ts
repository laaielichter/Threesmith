import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { advance, settle } from "./clock.js";
import type { Issue } from "./check.js";
import { diff } from "./diff.js";
import type { PageOptions } from "./page.js";
import { openRunPage, runSteps } from "./play.js";
import { decodePng, encodePng, type Image } from "./png.js";
import type { PlayStep } from "./steps.js";

/**
 * Frames of a page, exactly 1/fps apart: the page runs on the deterministic clock (time and Math.random are
 * virtual), so a slow software renderer still gives smooth, repeatable frames. Each frame is a PNG; a contact sheet
 * shows the motion in one picture; the change from frame to frame finds a scene that does not move and a frame that
 * pops (a big change at once); with ffmpeg on the machine the frames become an .mp4.
 */

export interface CaptureOptions extends PageOptions {
  fps?: number;
  seconds?: number;
  wait?: number;
  steps?: PlayStep[];
  /** Name of the capture folder under .threesmith/capture (default: capture). */
  name?: string;
  /** Also encode an .mp4 with ffmpeg, when it is installed. */
  video?: boolean;
  /** Pictures on the contact sheet (default 12). */
  sheet?: number;
}

export interface CaptureResult {
  ok: boolean;
  url: string;
  dir: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** Share of pixels that change from one frame to the next, per frame (from frame 2). */
  motion: number[];
  /** Frames that change much more than the ones around them. */
  pops: { frame: number; change: number }[];
  still: boolean;
  sheet?: Buffer;
  sheetFile?: string;
  video?: string;
  /** The ffmpeg command that makes the video. */
  ffmpeg: string;
  issues: Issue[];
}

/** Nearest-neighbour downscale, enough for a contact sheet. */
function shrink(img: Image, width: number): Image {
  const w = Math.max(1, Math.min(width, img.width));
  const h = Math.max(1, Math.round((img.height * w) / img.width));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor((y * img.height) / h);
    for (let x = 0; x < w; x++) {
      const sx = Math.floor((x * img.width) / w);
      const s = (sy * img.width + sx) * 4;
      const d = (y * w + x) * 4;
      data[d] = img.data[s]!;
      data[d + 1] = img.data[s + 1]!;
      data[d + 2] = img.data[s + 2]!;
      data[d + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** The pictures side by side, 4 per row, with a 2 px gap. */
export function contactSheet(images: Image[], thumb = 200): Image {
  const t = images.map((i) => shrink(i, thumb));
  const cols = Math.min(4, t.length);
  const rows = Math.ceil(t.length / cols);
  const cw = Math.max(...t.map((i) => i.width));
  const ch = Math.max(...t.map((i) => i.height));
  const gap = 2;
  const W = cols * cw + (cols - 1) * gap;
  const H = rows * ch + (rows - 1) * gap;
  const data = new Uint8Array(W * H * 4).fill(255);
  t.forEach((img, n) => {
    const ox = (n % cols) * (cw + gap);
    const oy = Math.floor(n / cols) * (ch + gap);
    for (let y = 0; y < img.height; y++) data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((oy + y) * W + ox) * 4);
  });
  return { width: W, height: H, data };
}

export async function capture(opts: CaptureOptions): Promise<CaptureResult> {
  const fps = Math.max(1, Math.min(60, Math.round(opts.fps ?? 30)));
  const seconds = Math.max(0.1, Math.min(20, opts.seconds ?? 2));
  const count = Math.max(2, Math.round(fps * seconds));
  const o = await openRunPage({ ...opts, seed: opts.seed ?? 1, fixedDt: 1000 / fps });
  const dir = join(o.stateDir, "capture", (opts.name ?? "capture").replace(/[^\w.-]+/g, "-"));
  const images: Image[] = [];
  const files: string[] = [];
  try {
    if (o.loaded) {
      await settle(o.page, opts.wait ?? 500);
      if (opts.steps?.length) await runSteps(o, opts.steps);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const marked = (await o.page.evaluate("(() => { const r = window.__threesmith && window.__threesmith.renderer; const c = (r && r.domElement) || document.querySelector('canvas'); if (!c) return false; c.setAttribute('data-ts-capture', ''); return true; })()")) as boolean;
      for (let i = 0; i < count; i++) {
        await advance(o.page, 1);
        const shot = marked ? await o.page.locator("[data-ts-capture]").first().screenshot({ type: "png", timeout: 5000 }) : await o.page.screenshot({ type: "png" });
        const f = join(dir, `frame-${String(i + 1).padStart(4, "0")}.png`);
        writeFileSync(f, shot);
        files.push(f);
        images.push(decodePng(shot));
      }
    }
  } finally {
    await o.close();
  }
  const motion: number[] = [];
  for (let i = 1; i < images.length; i++) motion.push(Math.round(diff(images[i - 1]!, images[i]!, { threshold: 12 }).ratio * 1000) / 1000);
  const sorted = [...motion].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const pops = motion.map((c, i) => ({ frame: i + 2, change: c })).filter((m) => m.change > 0.15 && m.change > median * 4 + 0.05).slice(0, 10);
  const still = images.length > 1 && motion.every((m) => m === 0);
  const pick = Math.max(1, Math.min(opts.sheet ?? 12, images.length));
  const chosen = images.length ? Array.from({ length: pick }, (_, i) => images[Math.round((i * (images.length - 1)) / Math.max(1, pick - 1))]!) : [];
  const sheet = chosen.length ? encodePng(contactSheet(chosen)) : undefined;
  const sheetFile = sheet ? join(dir, "sheet.png") : undefined;
  if (sheet && sheetFile) writeFileSync(sheetFile, sheet);
  const rel = relative(process.cwd(), dir) || ".";
  const ffmpeg = `ffmpeg -y -framerate ${fps} -i ${join(rel, "frame-%04d.png")} -pix_fmt yuv420p -preset veryfast ${join(rel, "capture.mp4")}`;
  let video: string | undefined;
  if (opts.video && images.length) {
    const out = join(dir, "capture.mp4");
    const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "frame-%04d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p", "-preset", "veryfast", out], { encoding: "utf8" });
    if (r.status === 0) video = out;
    else o.issues.push({ kind: "video", severity: "warn", message: r.error ? "ffmpeg is not installed: the frames are there; the command below makes the video." : `ffmpeg failed: ${(r.stderr || "").split("\n")[0]}` });
  }
  const first = images[0];
  return {
    ok: o.loaded && images.length === count && !o.issues.some((i) => i.severity === "error"),
    url: o.url,
    dir,
    frames: images.length,
    fps,
    width: first?.width ?? 0,
    height: first?.height ?? 0,
    motion,
    pops,
    still,
    ...(sheet ? { sheet, sheetFile: sheetFile! } : {}),
    ...(video ? { video } : {}),
    ffmpeg,
    issues: o.issues,
  };
}

export function formatCapture(r: CaptureResult): string {
  const out = [`${r.frames} frame(s) at ${r.fps} fps (${r.width}x${r.height}, deterministic clock) in ${r.dir}`];
  if (r.motion.length) {
    const avg = r.motion.reduce((a, b) => a + b, 0) / r.motion.length;
    out.push(`motion: ${Math.round(avg * 1000) / 10}% of the pixels change per frame on average, ${Math.round(Math.max(...r.motion) * 1000) / 10}% at most`);
  }
  if (r.still) out.push("▲ Nothing moves: every frame is the same. The loop does not animate, or the animation waits for input (add steps).");
  for (const p of r.pops) out.push(`▲ frame ${p.frame}: ${Math.round(p.change * 100)}% of the picture changes at once (a pop: a model that appears, a camera cut, a reset)`);
  if (r.sheetFile) out.push(`contact sheet: ${r.sheetFile}`);
  out.push(r.video ? `video: ${r.video}` : `video: ${r.ffmpeg}`);
  for (const i of r.issues.filter((x) => x.severity === "error").slice(0, 5)) out.push(`error [${i.kind}] ${i.message.split("\n")[0]}`);
  return out.join("\n");
}
