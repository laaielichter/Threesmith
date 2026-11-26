import { loadGltf } from "../model/gltf.js";
import { pageOp } from "../session/session.js";

/**
 * Animation, from the file and in the running page. From a .glb: every clip with its length, the nodes and
 * properties it moves and whether those nodes exist. In the page that three_session keeps running: every
 * AnimationMixer with its actions (playing, weight, time, speed, loop), whether its clock moves, and the tracks that
 * found no node to drive (the clip was made for another model, or the names changed). Then play or stop a clip, put
 * the model at a time, and sweep a clip: where named parts are and where the model's lowest point is at each step,
 * so feet that sink into the ground or float, and a clip that is shown in its bind pose, are found without looking.
 */

export interface FileClip {
  name: string;
  /** Seconds. */
  duration: number;
  channels: number;
  /** Paths it animates, with how many channels: translation 3, rotation 12, weights 1. */
  paths: Record<string, number>;
  /** Nodes it moves (names from the file; index for unnamed ones). */
  nodes: string[];
  /** Channels whose node does not exist in the file. */
  missing: number;
}

export interface FileAnimations {
  file: string;
  clips: FileClip[];
  skins: number;
  bones: number;
  morphTargets: string[];
}

export function fileAnimations(file: string): FileAnimations {
  const g = loadGltf(file);
  const j = g.json;
  const clips: FileClip[] = [];
  for (const [i, a] of (j.animations ?? []).entries()) {
    const samplers = (a as { samplers?: { input: number }[] }).samplers ?? [];
    let duration = 0;
    for (const s of samplers) {
      const acc = j.accessors?.[s.input];
      const max = acc?.max?.[0];
      if (typeof max === "number" && max > duration) duration = max;
    }
    const paths: Record<string, number> = {};
    const nodes = new Set<string>();
    let missing = 0;
    for (const c of a.channels ?? []) {
      const path = c.target?.path ?? "?";
      paths[path] = (paths[path] ?? 0) + 1;
      const n = c.target?.node;
      if (n === undefined || !j.nodes?.[n]) missing++;
      else nodes.add(j.nodes[n]!.name || `#${n}`);
    }
    clips.push({ name: a.name || `animation_${i}`, duration: Math.round(duration * 1000) / 1000, channels: a.channels?.length ?? 0, paths, nodes: [...nodes], missing });
  }
  const skins = (j.skins ?? []) as { joints?: number[] }[];
  const targets = new Set<string>();
  for (const m of j.meshes ?? []) {
    const names = (m as { extras?: { targetNames?: string[] } }).extras?.targetNames;
    if (names) for (const n of names) targets.add(n);
    else if (m.primitives.some((p) => p.targets?.length)) targets.add(`${m.name || "mesh"}: ${m.primitives[0]?.targets?.length ?? 0} unnamed`);
  }
  return { file, clips, skins: skins.length, bones: skins.reduce((n, s) => n + (s.joints?.length ?? 0), 0), morphTargets: [...targets] };
}

export function formatFileAnimations(a: FileAnimations): string {
  if (!a.clips.length) return `${a.file}: no animations${a.skins ? ` (${a.skins} skin(s), ${a.bones} bone(s): rigged, but no clip in this file)` : ""}.`;
  const out = [`${a.file}: ${a.clips.length} clip(s)${a.skins ? `, ${a.skins} skin(s) with ${a.bones} bone(s)` : ""}${a.morphTargets.length ? `, morph targets: ${a.morphTargets.slice(0, 8).join(", ")}` : ""}`];
  for (const c of a.clips) {
    out.push(`  "${c.name}": ${c.duration}s, ${c.channels} channel(s) (${Object.entries(c.paths).map(([p, n]) => `${p} ${n}`).join(", ")}) on ${c.nodes.length} node(s)${c.missing ? `, ${c.missing} channel(s) without a node` : ""}`);
  }
  out.push("Play one: mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, name)).play(), and mixer.update(delta) every frame.");
  return out.join("\n");
}

// ---------------------------------------------------------------- live

/** Shared in-page helpers: the mixers that are alive, a clip's action by name, the world position of a node. */
const PRELUDE = `
  const ts = window.__tsScene;
  const mixers = ((ts && ts.mixers) || []).map((r) => r.deref()).filter(Boolean);
  const nameOf = (o) => (o && (o.name || (o.userData && o.userData.name) || o.type)) || '?';
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const findAction = (clip) => { for (const m of mixers) for (const a of m._actions || []) if (a.getClip().name === clip) return { m, a }; return null; };
  const worldY = (root) => { let min = Infinity; root.updateWorldMatrix(true, true); root.traverse((o) => { if (!(o.isMesh || o.isSkinnedMesh) || !o.geometry) return; const p = o.geometry.attributes.position; if (!p) return; const step = Math.max(1, Math.floor(p.count / 400)); const v = { x: 0, y: 0, z: 0 }; for (let i = 0; i < p.count; i += step) { let x = p.getX(i), y = p.getY(i), z = p.getZ(i); if (o.isSkinnedMesh && o.getVertexPosition) { const t = o.getVertexPosition(i, (o.__tsV ||= o.position.clone())); x = t.x; y = t.y; z = t.z; } const e = o.matrixWorld.elements; const wy = e[1] * x + e[5] * y + e[9] * z + e[13]; if (wy < min) min = wy; } }); return min; };
`;

/** Every mixer and its actions, whether its clock moved over a few frames, and tracks that drive nothing. */
const MIXERS_JS = `${PRELUDE}
  if (!mixers.length) {
    let skinned = 0; const scene = window.__threesmith && window.__threesmith.scene;
    if (scene) scene.traverse((o) => { if (o.isSkinnedMesh) skinned++; });
    return JSON.stringify({ mixers: [], skinned });
  }
  const t0 = mixers.map((m) => m.time);
  await new Promise((res) => { let n = 0; const tick = () => (++n >= 5 ? res() : requestAnimationFrame(tick)); requestAnimationFrame(tick); });
  return JSON.stringify({ mixers: mixers.slice(0, 8).map((m, i) => {
    const unbound = new Set();
    const actions = (m._actions || []).slice(0, 24).map((a) => {
      for (const b of a._propertyBindings || []) { const pb = b && b.binding; if (pb && !pb.node) unbound.add(pb.path); }
      return { clip: a.getClip().name, duration: r3(a.getClip().duration), running: a.isRunning(), enabled: a.enabled, paused: a.paused, weight: r3(a.getEffectiveWeight()), timeScale: r3(a.getEffectiveTimeScale()), time: r3(a.time), loop: a.loop === 2200 ? 'once' : a.loop === 2202 ? 'pingpong' : 'repeat', repetitions: a.repetitions };
    });
    return { root: nameOf(m.getRoot()), time: r3(m.time), moved: r3(m.time - t0[i]), timeScale: m.timeScale, actions, unbound: [...unbound].slice(0, 12), unboundCount: unbound.size };
  }), skinned: 0 });
`;

export interface LiveMixer {
  root: string;
  time: number;
  moved: number;
  timeScale: number;
  actions: { clip: string; duration: number; running: boolean; enabled: boolean; paused: boolean; weight: number; timeScale: number; time: number; loop: string; repetitions: number }[];
  unbound: string[];
  unboundCount: number;
}

export interface MixerReport {
  mixers: LiveMixer[];
  skinned: number;
  problems: string[];
}

export function diagnoseMixers(r: { mixers: LiveMixer[]; skinned: number }): string[] {
  const out: string[] = [];
  if (!r.mixers.length) {
    if (r.skinned) out.push(`${r.skinned} skinned mesh(es) but no AnimationMixer: the model stands in its bind pose (often a T-pose). Make a mixer, play a clip, and call mixer.update(delta) every frame.`);
    return out;
  }
  for (const m of r.mixers) {
    const running = m.actions.filter((a) => a.running);
    if (!m.actions.length) out.push(`The mixer on ${m.root} has no actions: no clipAction(...) was made.`);
    else if (!running.length) out.push(`No clip runs on ${m.root}: none of ${m.actions.map((a) => `"${a.clip}"`).join(", ")} was played (action.play()), or all finished${m.actions.some((a) => a.loop === "once") ? " (LoopOnce: set action.clampWhenFinished = true to keep the last pose)" : ""}.`);
    if (m.moved === 0 && running.length) out.push(`The mixer on ${m.root} did not move over 5 frames: mixer.update(delta) is not called every frame${m.timeScale === 0 ? ", or mixer.timeScale is 0" : ", or delta is 0 (a second Clock.getDelta() in the same frame returns 0)"}.`);
    for (const a of running) {
      if (a.weight === 0) out.push(`"${a.clip}" runs with weight 0 on ${m.root}: it shows nothing (setEffectiveWeight, or a fade that ended at 0).`);
      if (a.timeScale === 0 && !a.paused) out.push(`"${a.clip}" runs with timeScale 0 on ${m.root}: it stands still.`);
    }
    if (m.unboundCount) out.push(`${m.unboundCount} track(s) on ${m.root} drive no node (${m.unbound.slice(0, 4).join(", ")}${m.unboundCount > 4 ? ", ..." : ""}): the clip belongs to another model, or the node names differ. Play clips on the model they came from.`);
  }
  return out;
}

export async function mixers(name: string): Promise<MixerReport> {
  const r = await pageOp({ op: "eval", js: MIXERS_JS }, name);
  if (!r.ok) throw new Error(r.text);
  const v = JSON.parse(String(r.value)) as { mixers: LiveMixer[]; skinned: number };
  return { ...v, problems: diagnoseMixers(v) };
}

export function formatMixers(r: MixerReport): string {
  const out: string[] = [];
  if (!r.mixers.length) out.push("No AnimationMixer in the page.");
  for (const m of r.mixers) {
    out.push(`mixer on ${m.root}: time ${m.time}s (moved ${m.moved}s over 5 frames)${m.timeScale !== 1 ? `, timeScale ${m.timeScale}` : ""}`);
    for (const a of m.actions) out.push(`  "${a.clip}" ${a.duration}s: ${a.running ? "running" : "stopped"}${a.paused ? ", paused" : ""}${a.enabled ? "" : ", disabled"}, weight ${a.weight}, speed ${a.timeScale}, at ${a.time}s, ${a.loop}`);
  }
  for (const p of r.problems) out.push(`▲ ${p}`);
  if (!r.problems.length && r.mixers.length) out.push("No animation problems found.");
  return out.join("\n");
}

/** Play one clip (stopping or fading out the others on its mixer), or stop all. */
export async function playClip(name: string, clip: string | null, opts: { fade?: number; loop?: "repeat" | "once" | "pingpong"; speed?: number } = {}): Promise<string> {
  const js = `${PRELUDE}
    const want = ${JSON.stringify(clip)};
    if (want === null) { mixers.forEach((m) => m.stopAllAction()); return 'stopped every action on ' + mixers.length + ' mixer(s)'; }
    const hit = findAction(want);
    if (!hit) {
      const clips = []; for (const m of mixers) for (const a of m._actions || []) clips.push(a.getClip().name);
      throw new Error('no action for clip "' + want + '"' + (clips.length ? '; the page has: ' + clips.join(', ') : '; the page made no clipAction yet'));
    }
    const { m, a } = hit;
    const fade = ${JSON.stringify(opts.fade ?? 0)};
    for (const other of m._actions) if (other !== a && other.isRunning()) { if (fade > 0) other.fadeOut(fade); else other.stop(); }
    a.reset();
    ${opts.loop ? `a.setLoop(${opts.loop === "once" ? 2200 : opts.loop === "pingpong" ? 2202 : 2201}, Infinity); if (${JSON.stringify(opts.loop)} === 'once') a.clampWhenFinished = true;` : ""}
    ${opts.speed !== undefined ? `a.setEffectiveTimeScale(${Number(opts.speed)});` : ""}
    if (fade > 0) a.fadeIn(fade);
    a.play();
    return 'playing "' + want + '" on ' + nameOf(m.getRoot()) + (fade > 0 ? ' (fading ' + fade + 's)' : '');
  `;
  const r = await pageOp({ op: "eval", js }, name);
  if (!r.ok) throw new Error(r.text.replace(/^error: (?:Error: )?/, "").split("\n")[0]);
  return String(r.value);
}

export interface Sample {
  t: number;
  /** Lowest world y of the mixer's model. */
  lowest: number;
  nodes: Record<string, [number, number, number]>;
}

export interface Sweep {
  clip: string;
  root: string;
  duration: number;
  samples: Sample[];
  /** Ground height the lowest point is judged against. */
  ground: number;
  problems: string[];
}

/** Put the model at a time of a clip (paused there), or step through the clip: lowest point and named nodes. */
export async function sweep(name: string, clip: string, opts: { at?: number; steps?: number; nodes?: string[]; ground?: number } = {}): Promise<Sweep> {
  const steps = opts.at !== undefined ? 1 : Math.max(2, Math.min(60, opts.steps ?? 12));
  const js = `${PRELUDE}
    const hit = findAction(${JSON.stringify(clip)});
    if (!hit) { const clips = []; for (const m of mixers) for (const a of m._actions || []) clips.push(a.getClip().name); throw new Error('no action for clip "' + ${JSON.stringify(clip)} + '"' + (clips.length ? '; the page has: ' + clips.join(', ') : '; the page made no clipAction yet')); }
    const { m, a } = hit;
    const root = m.getRoot();
    const names = ${JSON.stringify(opts.nodes ?? [])};
    const d = a.getClip().duration;
    for (const other of m._actions) if (other !== a) other.stop();
    a.reset(); a.play(); a.paused = false; a.setEffectiveWeight(1); a.setEffectiveTimeScale(1);
    const times = ${opts.at !== undefined ? `[${Number(opts.at)}]` : `Array.from({ length: ${steps} }, (_, i) => d * i / (${steps} - 1))`};
    const samples = [];
    for (const t of times) {
      m.setTime(Math.min(t, d));
      root.updateWorldMatrix(true, true);
      const nodes = {};
      for (const n of names) { const o = root.getObjectByName(n) || (() => { let f = null; root.traverse((x) => { if (!f && x.userData && x.userData.name === n) f = x; }); return f; })(); if (o) { const e = o.matrixWorld.elements; nodes[n] = [r3(e[12]), r3(e[13]), r3(e[14])]; } }
      samples.push({ t: r3(t), lowest: r3(worldY(root)), nodes });
    }
    ${opts.at !== undefined ? "a.paused = true;" : "m.setTime(0);"}
    return JSON.stringify({ clip: a.getClip().name, root: nameOf(root), duration: r3(d), samples });
  `;
  const r = await pageOp({ op: "eval", js }, name);
  if (!r.ok) throw new Error(r.text.replace(/^error: (?:Error: )?/, "").split("\n")[0]);
  const v = JSON.parse(String(r.value)) as Omit<Sweep, "problems" | "ground">;
  const ground = opts.ground ?? 0;
  const problems: string[] = [];
  const lows = v.samples.map((s) => s.lowest).filter((x) => Number.isFinite(x));
  if (lows.length > 1) {
    const min = Math.min(...lows);
    const max = Math.max(...lows);
    const deep = v.samples.find((s) => s.lowest === min)!;
    const high = v.samples.find((s) => s.lowest === max)!;
    if (min < ground - 0.02) problems.push(`The model goes ${Math.round((ground - min) * 100) / 100} below the ground (y ${ground}) at ${deep.t}s: it sinks in. Lift the model, or check the clip's root motion.`);
    if (min > ground + 0.02) problems.push(`The model never touches the ground (y ${ground}): its lowest point is ${min} at ${deep.t}s. Lower the model by ${Math.round((min - ground) * 100) / 100}.`);
    if (max - min > 0.5 && !/jump|fall|fly|climb/i.test(v.clip)) problems.push(`The lowest point moves ${Math.round((max - min) * 100) / 100} up and down over the clip (highest at ${high.t}s): it may bounce or float.`);
  }
  for (const n of opts.nodes ?? []) if (!v.samples.some((s) => s.nodes[n])) problems.push(`No node "${n}" under ${v.root}.`);
  return { ...v, ground, problems };
}

export function formatSweep(s: Sweep): string {
  const out = [`"${s.clip}" on ${s.root} (${s.duration}s)${s.samples.length === 1 ? `: paused at ${s.samples[0]!.t}s` : `, ${s.samples.length} steps`}:`];
  for (const x of s.samples.slice(0, 30)) out.push(`  t ${x.t}s: lowest y ${x.lowest}${Object.keys(x.nodes).length ? `; ${Object.entries(x.nodes).map(([n, p]) => `${n} [${p.join(", ")}]`).join("; ")}` : ""}`);
  for (const p of s.problems) out.push(`▲ ${p}`);
  if (s.samples.length === 1) out.push("Next: three_look (or three_page op screenshot) shows the pose; play again with op play.");
  return out.join("\n");
}
