import type { SourceFile } from "../review/source.js";
import { lineOf } from "../review/source.js";

/**
 * Measured notes for the changes that make a scene look different: not only "this release changed PBR", but how many
 * of this code's materials and lights it touches, with their values, so the agent knows what to compare and what
 * to retune. Each note reads only the code (literal values); values set at run time are not seen, and the note says
 * so when nothing literal was found.
 */

const NS = String.raw`(?:[\w$]+\.)?`;

interface Material {
  type: string;
  file: string;
  line: number;
  roughness?: number;
  metalness?: number;
}

interface Light {
  type: string;
  file: string;
  line: number;
  intensity?: number;
  decay?: number;
}

const num = (s: string | undefined): number | undefined => (s !== undefined && /^\d*\.?\d+$/.test(s.trim()) ? Number(s) : undefined);
const prop = (body: string, name: string): number | undefined => num(new RegExp(String.raw`\b${name}\s*:\s*([\d.]+)\b`).exec(body)?.[1]);

/** PBR materials made in the code, with their literal roughness and metalness. */
export function pbrMaterials(files: SourceFile[]): Material[] {
  const out: Material[] = [];
  const re = new RegExp(String.raw`\bnew\s+${NS}(Mesh(?:Standard|Physical)(?:Node)?Material)\s*\(\s*(\{[^{}]*\})?`, "g");
  for (const f of files) {
    for (const m of f.text.matchAll(re)) {
      const body = m[2] ?? "";
      const r = prop(body, "roughness");
      const mt = prop(body, "metalness");
      out.push({ type: m[1]!, file: f.path, line: lineOf(f.text, m.index ?? 0), ...(r !== undefined ? { roughness: r } : {}), ...(mt !== undefined ? { metalness: mt } : {}) });
    }
  }
  return out;
}

const ARGS: Record<string, number> = { AmbientLight: 1, HemisphereLight: 2, DirectionalLight: 1, PointLight: 1, SpotLight: 1, RectAreaLight: 1 };
const DECAY: Record<string, number> = { PointLight: 3, SpotLight: 5 };

/** Lights made in the code, with the literal intensity and decay passed to the constructor. */
export function lights(files: SourceFile[]): Light[] {
  const out: Light[] = [];
  const re = new RegExp(String.raw`\bnew\s+${NS}(AmbientLight|HemisphereLight|DirectionalLight|PointLight|SpotLight|RectAreaLight)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)`, "g");
  for (const f of files) {
    for (const m of f.text.matchAll(re)) {
      const args = splitArgs(m[2] ?? "");
      const type = m[1]!;
      const intensity = num(args[ARGS[type]!]);
      const decay = DECAY[type] !== undefined ? num(args[DECAY[type]!]) : undefined;
      out.push({ type, file: f.path, line: lineOf(f.text, m.index ?? 0), ...(intensity !== undefined ? { intensity } : {}), ...(decay !== undefined ? { decay } : {}) });
    }
  }
  return out;
}

/** Top-level comma-separated arguments. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of s) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const at = (x: { file: string; line: number }) => `${x.file}:${x.line}`;
const list = <T extends { file: string; line: number }>(xs: T[], show: (x: T) => string, max = 4) => xs.slice(0, max).map((x) => `${show(x)} ${at(x)}`).join(", ") + (xs.length > max ? `, ${xs.length - max} more` : "");
const round = (n: number) => Math.round(n * 100) / 100;

/** The measured note for an appearance change, or undefined when there is nothing to measure for it. */
export function appearanceNote(id: string, files: SourceFile[]): string | undefined {
  const all = files.map((f) => f.text).join("\n");
  const gltf = /\bGLTFLoader\b/.test(all) ? " Loaded glTF models are PBR too." : "";
  const env = /\.environment\s*=/.test(all);
  switch (id) {
    case "rough-pbr-brighter":
    case "rough-less-shiny": {
      const mats = pbrMaterials(files);
      if (!mats.length) return gltf ? `No PBR material is made in the code.${gltf}` : undefined;
      const rough = mats.filter((m) => (m.roughness ?? 1) > 0.5);
      return `${rough.length} of ${mats.length} PBR material(s) are rough (roughness > 0.5; the default is 1): ${list(rough, (m) => `${m.type}${m.roughness !== undefined ? ` roughness ${m.roughness}` : " (default 1)"}`)}.${gltf}`;
    }
    case "pbr-indirect-specular":
    case "pmrem-reflections":
    case "pmrem-cube": {
      const mats = pbrMaterials(files);
      return `${mats.length} PBR material(s) in the code${env ? ", lit by scene.environment" : ""}.${gltf}`;
    }
    case "ambient-hemisphere-specular": {
      const fills = lights(files).filter((l) => l.type === "AmbientLight" || l.type === "HemisphereLight");
      const metals = pbrMaterials(files).filter((m) => (m.metalness ?? 0) > 0.5);
      const parts = [`${fills.length} fill light(s): ${list(fills, (l) => `${l.type}${l.intensity !== undefined ? ` intensity ${l.intensity}` : ""}`)}.`];
      if (env) parts.push("scene.environment is set too, so the fill now reflects on top of it: lower the fill intensity.");
      else parts.push("No scene.environment: metals no longer render black under the fill alone.");
      if (metals.length) parts.push(`${metals.length} metallic material(s) (metalness > 0.5) change most: ${list(metals, (m) => m.type)}.`);
      return parts.join(" ");
    }
    case "legacy-lights-off": {
      const ls = lights(files);
      if (!ls.length) return undefined;
      const known = ls.filter((l) => l.intensity !== undefined);
      const hint = known.length ? ` Starting points at about x PI: ${list(known, (l) => `${l.type} ${l.intensity} -> ${round(l.intensity! * Math.PI)}`)}.` : " The intensities are not literal in the code: scale them where they are set.";
      return `${ls.length} light(s) are now in physical units.${hint} Compare a screenshot from before and tune by eye.`;
    }
    case "light-decay-2": {
      const ls = lights(files).filter((l) => (l.type === "PointLight" || l.type === "SpotLight") && l.decay === undefined);
      return ls.length ? `${ls.length} Point/Spot light(s) without a decay now fall off with decay 2: ${list(ls, (l) => l.type)}.` : undefined;
    }
    case "color-management-on": {
      const loads = files.flatMap((f) => [...f.text.matchAll(/\bnew\s+(?:[\w$]+\.)?TextureLoader\s*\(\s*\)\s*\.load\s*\(|\.load(?:Async)?\s*\(\s*['"][^'"]+\.(?:png|jpe?g|webp|avif)['"]/g)].map((m) => ({ file: f.path, line: lineOf(f.text, m.index ?? 0) })));
      const spaces = (all.match(/\.colorSpace\s*=/g) ?? []).length;
      const hexes = (all.match(/\b0x[0-9a-fA-F]{6}\b/g) ?? []).length;
      const tex = loads.length ? `${loads.length} texture load(s) (${list(loads, () => "load")}) and ${spaces} colorSpace assignment(s): give colour maps texture.colorSpace = SRGBColorSpace.` : "";
      return `${hexes} hex colour(s) in the code are sRGB and converted to linear now.${tex ? ` ${tex}` : ""}`;
    }
    case "tone-mapping-to-screen": {
      const tm = /\.toneMapping\s*=\s*(?:THREE\.)?(\w+)/.exec(all)?.[1];
      return `${tm ? `renderer.toneMapping is ${tm}` : "The renderer's tone mapping"} and the sRGB output are not applied to an EffectComposer's result without an OutputPass at the end.`;
    }
    case "multi-bounce-ao": {
      const over = files.flatMap((f) => [...f.text.matchAll(/\baoMapIntensity\s*[:=]\s*([\d.]+)/g)].filter((m) => Number(m[1]) > 1).map((m) => ({ file: f.path, line: lineOf(f.text, m.index ?? 0), v: Number(m[1]) })));
      return over.length ? `aoMapIntensity above 1 gives artifacts now: ${list(over, (o) => `${o.v}`)}.` : undefined;
    }
    default:
      return undefined;
  }
}
