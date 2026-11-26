/**
 * Two views of a live page for three_page: the textures the scene uses (slot, size, colour space, mipmaps, the GPU
 * memory they take, and the mistakes: a colour map read as linear, a data map read as sRGB, a texture too big for
 * phones), and a snapshot of the scene that a second call compares with (objects added, removed, moved, hidden,
 * given another material), so an agent sees exactly what an interaction or an edit did.
 */

export interface TextureItem {
  name: string;
  slot: string;
  /** Objects that use it (names), first few. */
  users: string[];
  width: number;
  height: number;
  colorSpace: string;
  mipmaps: boolean;
  compressed: boolean;
  /** Estimated GPU bytes (RGBA8 with mipmaps for plain images). */
  bytes: number;
  problems: string[];
}

export interface TextureReport {
  items: TextureItem[];
  totalBytes: number;
}

/** In the page: every texture on every material in the scene, with its problems. Returns JSON text. */
export const TEXTURES_EVAL = `(() => {
  const ts = window.__tsScene;
  const first = (list) => { for (const x of list) { const o = x.deref(); if (o) return o; } return null; };
  const scene = ts && ((ts.last && ts.last.scene) || first(ts.scenes));
  if (!scene) return JSON.stringify({ items: [], totalBytes: 0 });
  const COLOR = new Set(['map', 'emissiveMap', 'sheenColorMap', 'specularColorMap']);
  const DATA = new Set(['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap', 'displacementMap', 'alphaMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'transmissionMap', 'thicknessMap', 'iridescenceThicknessMap', 'anisotropyMap']);
  const seen = new Map();
  const add = (tex, slot, user) => {
    if (!tex || !tex.isTexture) return;
    let e = seen.get(tex);
    if (!e) {
      const img = tex.image || {};
      const w = img.width || img.videoWidth || (tex.source && tex.source.data && tex.source.data.width) || 0;
      const h = img.height || img.videoHeight || (tex.source && tex.source.data && tex.source.data.height) || 0;
      const compressed = !!tex.isCompressedTexture;
      const mip = compressed ? (tex.mipmaps && tex.mipmaps.length > 1) : tex.generateMipmaps !== false && tex.minFilter !== 1003 && tex.minFilter !== 1006;
      const cube = tex.isCubeTexture ? 6 : 1;
      const bytes = Math.round(w * h * (compressed ? 1 : 4) * cube * (mip ? 4 / 3 : 1));
      e = { tex, name: tex.name || (img.currentSrc || img.src || '').split('/').pop() || tex.uuid.slice(0, 8), slots: new Set(), users: new Set(), width: w, height: h, colorSpace: tex.colorSpace || 'NoColorSpace', mipmaps: !!mip, compressed, bytes };
      seen.set(tex, e);
    }
    e.slots.add(slot);
    if (e.users.size < 4) e.users.add(user);
  };
  scene.traverse((o) => {
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture) add(v, k, o.name || o.type); }
    if (o.isScene) { if (o.background && o.background.isTexture) add(o.background, 'background', 'scene'); if (o.environment && o.environment.isTexture) add(o.environment, 'environment', 'scene'); }
  });
  const items = [...seen.values()].map((e) => {
    const slots = [...e.slots];
    const problems = [];
    if (slots.some((s) => COLOR.has(s)) && e.colorSpace !== 'srgb' && !e.compressed) problems.push('a colour map read as linear: colours look washed out (set texture.colorSpace = THREE.SRGBColorSpace)');
    if (slots.some((s) => DATA.has(s)) && e.colorSpace === 'srgb') problems.push('a data map (' + slots.filter((s) => DATA.has(s)).join(', ') + ') read as sRGB: lighting and normals come out wrong (leave colorSpace as NoColorSpace)');
    if (Math.max(e.width, e.height) > 4096) problems.push(e.width + 'x' + e.height + ' is over 4096: many phones cannot upload it (three_device), and it takes ' + Math.round(e.bytes / 1048576) + ' MB');
    else if (!e.compressed && e.width * e.height >= 2048 * 2048) problems.push('a large uncompressed texture (' + Math.round(e.bytes / 1048576) + ' MB on the GPU): KTX2 (three_gltf optimize, three_decoders) takes about a quarter');
    return { name: e.name, slot: slots.join(', '), users: [...e.users], width: e.width, height: e.height, colorSpace: e.colorSpace, mipmaps: e.mipmaps, compressed: e.compressed, bytes: e.bytes, problems };
  }).sort((a, b) => b.bytes - a.bytes);
  return JSON.stringify({ items: items.slice(0, 60), totalBytes: items.reduce((n, t) => n + t.bytes, 0) });
})()`;

const mb = (b: number) => (b >= 1048576 ? `${Math.round((b / 1048576) * 10) / 10} MB` : `${Math.round(b / 1024)} KB`);

export function formatTextures(r: TextureReport): string {
  if (!r.items.length) return "No textures on the materials, background or environment of the scene.";
  const out = [`${r.items.length} texture(s), about ${mb(r.totalBytes)} on the GPU (estimate), the largest first:`];
  for (const t of r.items.slice(0, 25)) {
    out.push(`  ${t.name} [${t.slot}] ${t.width}x${t.height} ${t.colorSpace}${t.compressed ? ", compressed" : ""}${t.mipmaps ? "" : ", no mipmaps"}, ${mb(t.bytes)}, on ${t.users.join(", ")}`);
    for (const p of t.problems) out.push(`    ▲ ${p}`);
  }
  if (r.items.length > 25) out.push(`  +${r.items.length - 25} more`);
  return out.join("\n");
}

// ---------------------------------------------------------------- scene diff

export interface SnapshotEntry {
  type: string;
  visible: boolean;
  position: [number, number, number];
  scale: [number, number, number];
  material?: string;
}

/** Path ("Scene > car > wheel") → what matters about the object. */
export type Snapshot = Record<string, SnapshotEntry>;

export const SNAPSHOT_EVAL = `(() => {
  const ts = window.__tsScene;
  const first = (list) => { for (const x of list) { const o = x.deref(); if (o) return o; } return null; };
  const scene = ts && ((ts.last && ts.last.scene) || first(ts.scenes));
  const out = {};
  if (!scene) return JSON.stringify(out);
  const r = (n) => Math.round(n * 1000) / 1000;
  const walk = (o, path) => {
    if (Object.keys(out).length >= 2000) return;
    let key = path; let n = 2; while (out[key]) key = path + ' #' + n++;
    const m = o.material && (Array.isArray(o.material) ? o.material[0] : o.material);
    const p = new o.position.constructor(); o.getWorldPosition(p);
    out[key] = { type: o.type, visible: o.visible, position: [r(p.x), r(p.y), r(p.z)], scale: [r(o.scale.x), r(o.scale.y), r(o.scale.z)], ...(m ? { material: m.type + (m.color ? ' #' + m.color.getHexString() : '') + (m.opacity !== undefined && m.opacity < 1 ? ' opacity ' + r(m.opacity) : '') } : {}) };
    for (const c of o.children) walk(c, key + ' > ' + (c.name || c.type));
  };
  scene.updateMatrixWorld();
  walk(scene, scene.name || 'Scene');
  return JSON.stringify(out);
})()`;

export interface SceneDiff {
  added: string[];
  removed: string[];
  changed: { path: string; what: string[] }[];
  total: number;
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

export function diffSnapshots(a: Snapshot, b: Snapshot): SceneDiff {
  const added = Object.keys(b).filter((k) => !a[k]);
  const removed = Object.keys(a).filter((k) => !b[k]);
  const changed: SceneDiff["changed"] = [];
  for (const k of Object.keys(b)) {
    const x = a[k];
    const y = b[k]!;
    if (!x) continue;
    const what: string[] = [];
    if (x.visible !== y.visible) what.push(y.visible ? "shown" : "hidden");
    if (dist(x.position, y.position) > 0.001) what.push(`moved [${x.position.join(", ")}] → [${y.position.join(", ")}]`);
    if (dist(x.scale, y.scale) > 0.001) what.push(`scaled [${x.scale.join(", ")}] → [${y.scale.join(", ")}]`);
    if (x.material !== y.material) what.push(`material ${x.material ?? "none"} → ${y.material ?? "none"}`);
    if (x.type !== y.type) what.push(`type ${x.type} → ${y.type}`);
    if (what.length) changed.push({ path: k, what });
  }
  return { added, removed, changed, total: Object.keys(b).length };
}

export function formatSceneDiff(d: SceneDiff): string {
  if (!d.added.length && !d.removed.length && !d.changed.length) return `Nothing changed in the scene (${d.total} objects) since the last op diff.`;
  const out = [`Since the last op diff (${d.total} objects now):`];
  for (const p of d.added.slice(0, 20)) out.push(`  + ${p}`);
  if (d.added.length > 20) out.push(`  + ${d.added.length - 20} more added`);
  for (const p of d.removed.slice(0, 20)) out.push(`  - ${p}`);
  if (d.removed.length > 20) out.push(`  - ${d.removed.length - 20} more removed`);
  for (const c of d.changed.slice(0, 30)) out.push(`  ~ ${c.path}: ${c.what.join("; ")}`);
  if (d.changed.length > 30) out.push(`  ~ ${d.changed.length - 30} more changed`);
  return out.join("\n");
}
