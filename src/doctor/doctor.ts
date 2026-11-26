import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findThree } from "../api/install.js";
import { findChromium, loadPlaywright, WEBGL_ARGS, WEBGPU_ARGS } from "../check/browser.js";
import { serveStatic } from "../check/server.js";

/** Where Linux keeps libvulkan.so.1, which Chromium needs for WebGPU (also through SwiftShader). */
const VULKAN_DIRS = ["/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/usr/lib64", "/usr/lib", "/lib/x86_64-linux-gnu", "/lib64"];

/** Is libvulkan there? Only asked on Linux; elsewhere the browser brings what it needs. */
export function hasVulkan(platform: string = process.platform, dirs: readonly string[] = VULKAN_DIRS, exists: (p: string) => boolean = existsSync): boolean | null {
  if (platform !== "linux") return null;
  return dirs.some((d) => exists(join(d, "libvulkan.so.1")));
}

/** What a WebGPU adapter probe found, in words, with the fix when there is none. Pure, for tests. */
export function webgpuItem(adapter: string | null, vulkan: boolean | null): DoctorItem {
  if (adapter !== null) return { name: "WebGPU (headless)", ok: true, detail: `adapter ${adapter || "unnamed"}; three_check webgpu: true tests the WebGPU backend` };
  const lib = vulkan === false ? " libvulkan.so.1 is missing: apt install libvulkan1 mesa-vulkan-drivers." : "";
  return { name: "WebGPU (headless)", ok: true, detail: `no adapter (optional: WebGPURenderer pages fall back to WebGL 2 here, and check says so).${lib}` };
}

export interface DoctorItem {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do when it is not ok. */
  fix?: string;
}

/** Is everything Threesmith needs here? Each item says what is wrong and what to do. */
export async function doctor(path: string, threeDir?: string): Promise<DoctorItem[]> {
  const items: DoctorItem[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  items.push({
    name: "node",
    ok: major >= 22,
    detail: `Node ${process.versions.node}`,
    ...(major >= 22 ? {} : { fix: "Install Node.js 22.12 or newer." }),
  });
  const three = findThree(path, threeDir);
  items.push(
    three
      ? { name: "three", ok: true, detail: `r${three.release} (${three.version}) at ${three.root}` }
      : { name: "three", ok: false, detail: `not found at or above ${path}`, fix: "Run `npm install three` in the project, or pass --three <path to node_modules/three>. api and review need it to be exact." },
  );
  if (three) {
    const addons = existsSync(`${three.root}/examples/jsm`);
    items.push({ name: "three addons", ok: addons, detail: addons ? "examples/jsm present" : "examples/jsm missing", ...(addons ? {} : { fix: "Reinstall three; the addons ship in the package." }) });
  }
  let pw: Awaited<ReturnType<typeof loadPlaywright>> | undefined;
  try {
    pw = await loadPlaywright();
    items.push({ name: "playwright-core", ok: true, detail: "found" });
  } catch (e) {
    items.push({ name: "playwright-core", ok: false, detail: (e as Error).message, fix: "npm i -D playwright-core (only the browser check needs it)." });
  }
  const chromium = findChromium();
  if (pw) {
    try {
      const browser = await pw.chromium.launch({ headless: true, ...(chromium ? { executablePath: chromium } : {}), args: WEBGL_ARGS });
      const page = await browser.newPage();
      const gl = (await page.evaluate(
        `(() => { const c = document.createElement("canvas"); return c.getContext("webgl2") ? "webgl2" : c.getContext("webgl") ? "webgl" : "none"; })()`,
      )) as string;
      await browser.close();
      items.push({ name: "chromium + WebGL", ok: gl !== "none", detail: `launches; ${gl}${chromium ? ` (${chromium})` : ""}`, ...(gl === "none" ? { fix: "Chromium started but has no WebGL. On Linux install mesa/libgl (apt install libgl1-mesa-dri)." } : {}) });
    } catch (e) {
      items.push({ name: "chromium + WebGL", ok: false, detail: String((e as Error).message).split("\n")[0] ?? "", fix: "npx playwright-core install --with-deps chromium, or set THREESMITH_CHROMIUM to a Chromium binary." });
    }
    items.push(webgpuItem(await probeWebgpu(pw, chromium), hasVulkan()));
  }
  return items;
}

/** Asks headless Chromium, with the flags three_check uses for WebGPU, for an adapter (on localhost: WebGPU needs a secure context). */
async function probeWebgpu(pw: Awaited<ReturnType<typeof loadPlaywright>>, chromium: string | undefined): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "threesmith-gpu-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>gpu</title>");
  let server: Awaited<ReturnType<typeof serveStatic>> | undefined;
  try {
    server = await serveStatic(dir);
    const browser = await pw.chromium.launch({ headless: true, ...(chromium ? { executablePath: chromium } : {}), args: [...WEBGL_ARGS, ...WEBGPU_ARGS] });
    try {
      const page = await browser.newPage();
      await page.goto(`${server.url}/index.html`);
      return (await page.evaluate(`(async () => {
        if (!navigator.gpu) return null;
        try {
          const a = await navigator.gpu.requestAdapter();
          if (!a) return null;
          const i = a.info || {};
          return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ') + (i.isFallbackAdapter ? ' (fallback adapter)' : '');
        } catch { return null; }
      })()`)) as string | null;
    } finally {
      await browser.close();
    }
  } catch {
    return null;
  } finally {
    await server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function formatDoctor(items: DoctorItem[]): string {
  const out = items.map((i) => `${i.ok ? "✔" : "✖"} ${i.name}: ${i.detail}${i.fix ? `\n    fix: ${i.fix}` : ""}`);
  const bad = items.filter((i) => !i.ok).length;
  out.push("", bad ? `${bad} problem${bad === 1 ? "" : "s"} found.` : "All good.");
  return out.join("\n");
}
