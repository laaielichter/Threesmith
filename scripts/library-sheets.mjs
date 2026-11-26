// Renders the asset library with three.js itself (headless Chromium, software WebGL): one contact sheet per family in
// docs/library/<category>--<family>.jpg, 6 cells per row, each cell 4:3, for docs/library.html.
//   npm run build && node scripts/library-sheets.mjs [family ...]
import { mkdirSync, mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { buildGlb } from "../dist/build/glb.js";
import { buildSpec } from "../dist/build/spec.js";
import { libraryOverview, searchAssets } from "../dist/library/library.js";
import { serveStatic } from "../dist/check/server.js";
import { findChromium, WEBGL_ARGS } from "../dist/check/browser.js";

const COLS = 6, W = 320, H = 240;
const repo = resolve(import.meta.dirname, "..");
const out = join(repo, "docs", "library");
const only = new Set(process.argv.slice(2));
const dir = mkdtempSync(join(tmpdir(), "threesmith-library-"));
const three = join(repo, "node_modules", "three");
cpSync(join(three, "build"), join(dir, "three", "build"), { recursive: true });
for (const sub of ["loaders", "utils", "environments"]) cpSync(join(three, "examples", "jsm", sub), join(dir, "three", "addons", sub), { recursive: true });
writeFileSync(
  join(dir, "index.html"),
  `<!doctype html><html><body style="margin:0">
<script type="importmap">{"imports":{"three":"./three/build/three.module.js","three/addons/":"./three/addons/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
const W = ${W}, H = ${H}, COLS = ${COLS};
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf1ece4);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024);
scene.add(sun, new THREE.HemisphereLight(0xdfe9ff, 0x5a4a3a, 0.6));
const ground = new THREE.Mesh(new THREE.CircleGeometry(1, 96), new THREE.MeshStandardMaterial({ color: 0xd9d0c3, roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
const camera = new THREE.PerspectiveCamera(35, W / H, 0.01, 10000);
const loader = new GLTFLoader();
function draw(model) {
  model.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(model);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const r = Math.max(size.x, size.y, size.z);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  ground.scale.setScalar(r * 1.6); ground.position.y = box.min.y - 0.001;
  const d = new THREE.Vector3(1, 0.55, 1.25).normalize();
  const dist = Math.max(r * 1.9, (sphere.radius * 1.08) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.position.copy(center).addScaledVector(d, dist);
  camera.near = r / 100; camera.far = r * 20; camera.updateProjectionMatrix();
  camera.lookAt(center);
  sun.position.copy(center).add(new THREE.Vector3(r, r * 2, r * 0.6));
  sun.target.position.copy(center); sun.target.updateMatrixWorld();
  const s = sun.shadow.camera; s.left = s.bottom = -r * 1.2; s.right = s.top = r * 1.2; s.far = r * 6; s.updateProjectionMatrix();
  renderer.render(scene, camera);
  scene.remove(model);
  model.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); for (const m of [o.material].flat()) { for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose(); m.dispose(); } } });
}
window.sheet = async (urls) => {
  const rows = Math.ceil(urls.length / COLS);
  const c = document.createElement('canvas'); c.width = COLS * W; c.height = rows * H;
  const g = c.getContext('2d'); g.fillStyle = '#f1ece4'; g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < urls.length; i++) {
    const gltf = await loader.loadAsync(urls[i]);
    draw(gltf.scene);
    g.drawImage(renderer.domElement, (i % COLS) * W, Math.floor(i / COLS) * H);
  }
  return c.toDataURL('image/jpeg', 0.82);
};
window.ready = true;
</script></body></html>`,
);
mkdirSync(out, { recursive: true });
const server = await serveStatic(dir);
const executablePath = findChromium();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), args: WEBGL_ARGS });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("page:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()); });
await page.goto(`${server.url}/index.html`);
await page.waitForFunction("window.ready === true", null, { timeout: 180_000 });
const t0 = Date.now();
for (const c of libraryOverview()) {
  for (const f of c.families) {
    if (only.size && !only.has(f.family)) continue;
    const members = searchAssets({ category: c.category, family: f.family });
    const urls = members.map((a, i) => {
      const name = `${f.family}-${i}.glb`;
      writeFileSync(join(dir, name), buildGlb(buildSpec(a.spec)));
      return `./${name}`;
    });
    const data = await page.evaluate((u) => window.sheet(u), urls);
    writeFileSync(join(out, `${c.category}--${f.family}.jpg`), Buffer.from(data.split(",")[1], "base64"));
    for (const u of urls) rmSync(join(dir, u.slice(2)));
    console.log(`${c.category}/${f.family}: ${members.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
}
await browser.close();
await server.close();
rmSync(dir, { recursive: true, force: true });
