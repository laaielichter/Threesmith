import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findChromium, WEBGL_ARGS } from "../src/check/browser.js";
import { serveStatic } from "../src/check/server.js";
import { listSessions, pageOp, startSession, stopSession } from "../src/session/session.js";
import { gamePage } from "./run-helpers.js";

const chrome = findChromium();
const PORT = 9300 + Math.floor(Math.random() * 500);
const endpoint = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess | undefined;
// the profile lives outside the test's temp folder: Chromium's helper processes can still write to it for a moment
// after the browser is gone, and the temp folder is removed right after the tests
const profiles = join("node_modules", ".cache", "threesmith", "chrome-profiles");
let profile: string | undefined;

async function up(): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return true;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// the browser must be gone before the test's temp folder (its profile) is removed
afterAll(async () => {
  if (proc && proc.exitCode === null && proc.pid) {
    const gone = new Promise((r) => proc!.once("exit", r));
    try {
      process.kill(-proc.pid, "SIGKILL"); // the whole process group: the browser and its helpers
    } catch {
      proc.kill("SIGKILL");
    }
    await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  }
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe.skipIf(!chrome)("attach to a running browser (needs Chromium)", () => {
  it("finds the tab by URL, installs the hooks with one reload, and leaves the browser running on stop", async () => {
    const dir = gamePage(`import * as THREE from 'three';
const renderer = new THREE.WebGLRenderer(); renderer.setSize(200, 150); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100); camera.position.z = 4;
const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()); m.name = 'crate'; scene.add(m);
renderer.setAnimationLoop(() => renderer.render(scene, camera));`);
    const server = await serveStatic(dir);
    try {
      const url = `${server.url}/index.html`;
      mkdirSync(profiles, { recursive: true });
      profile = mkdtempSync(join(profiles, "p-"));
      proc = spawn(chrome!, [...WEBGL_ARGS, "--no-sandbox", "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", url], { stdio: "ignore", detached: process.platform !== "win32" });
      expect(await up()).toBe(true);
      await expect(startSession({ target: "", cdp: endpoint, match: "nothing-like-this" }, "att")).rejects.toThrow(/No tab in that browser/);
      const r = await startSession({ target: url, cdp: endpoint, match: "index.html", wait: 800 }, "att");
      expect(r.attached).toBe(true);
      expect(r.reloaded).toBe(true);
      expect(r.objects).toBeGreaterThan(1);
      expect(listSessions().find((s) => s.name === "att")?.attached).toBe(true);
      const look = await pageOp({ op: "look", expect: ["crate in view"] }, "att");
      expect(look.ok).toBe(true);
      await stopSession("att");
      expect(await up()).toBe(true);
      await expect(startSession({ target: url, cdp: "http://127.0.0.1:1" }, "att2")).rejects.toThrow(/--remote-debugging-port=9222/);
    } finally {
      await server.close();
    }
  }, 120_000);
});
