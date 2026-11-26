import { cpSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appearanceNote, lights, pbrMaterials } from "../src/migrate/appearance.js";
import { formatMigrate } from "../src/migrate/format.js";
import { migratePlan } from "../src/migrate/migrate.js";
import { makeSourceFile } from "../src/review/source.js";
import { project, THREE_DIR } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "migrate");
const fixture = (name: string) => {
  const dir = project({});
  cpSync(join(FIXTURES, name), dir, { recursive: true });
  return dir;
};
const src = (code: string) => [makeSourceFile("a.js", code)];
const notes = (dir: string, to?: string) => Object.fromEntries(migratePlan({ path: dir, three: THREE_DIR, ...(to ? { to } : {}) }).appearance.map((a) => [a.id, a.note]));

describe("reading materials and lights", () => {
  it("takes literal roughness, metalness, intensity and decay, with nested calls in the arguments", () => {
    const code = src(`import * as THREE from 'three';
const a = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 1 });
const b = new THREE.MeshPhysicalMaterial();
const c = new THREE.MeshStandardMaterial({ roughness: r });
const p = new THREE.PointLight(new THREE.Color(1, 0.5, 0), 4, 0, 1);
const h = new THREE.HemisphereLight(0xffffff, 0x222222, 0.5);
const s = new THREE.SpotLight(0xffffff);
`);
    expect(pbrMaterials(code)).toEqual([
      { type: "MeshStandardMaterial", file: "a.js", line: 2, roughness: 0.3, metalness: 1 },
      { type: "MeshPhysicalMaterial", file: "a.js", line: 3 },
      { type: "MeshStandardMaterial", file: "a.js", line: 4 },
    ]);
    expect(lights(code)).toEqual([
      { type: "PointLight", file: "a.js", line: 5, intensity: 4, decay: 1 },
      { type: "HemisphereLight", file: "a.js", line: 6, intensity: 0.5 },
      { type: "SpotLight", file: "a.js", line: 7 },
    ]);
  });
  it("counts rough materials (the default is 1), fills against the environment, and decay 2", () => {
    const code = src(`const a = new MeshStandardMaterial({ roughness: 0.3, metalness: 0.9 });
const b = new MeshStandardMaterial();
scene.add(new AmbientLight(0xffffff, 0.4));
scene.environment = pmrem.texture;
const p = new PointLight(0xffffff, 2);`);
    expect(appearanceNote("rough-pbr-brighter", code)).toBe("1 of 2 PBR material(s) are rough (roughness > 0.5; the default is 1): MeshStandardMaterial (default 1) a.js:2.");
    expect(appearanceNote("ambient-hemisphere-specular", code)).toBe(
      "1 fill light(s): AmbientLight intensity 0.4 a.js:3. scene.environment is set too, so the fill now reflects on top of it: lower the fill intensity. 1 metallic material(s) (metalness > 0.5) change most: MeshStandardMaterial a.js:1.",
    );
    expect(appearanceNote("light-decay-2", code)).toBe("1 Point/Spot light(s) without a decay now fall off with decay 2: PointLight a.js:5.");
    expect(appearanceNote("legacy-lights-off", code)).toContain("PointLight 2 -> 6.28 a.js:5");
    expect(appearanceNote("multi-bounce-ao", src("m.aoMapIntensity = 1.5;"))).toBe("aoMapIntensity above 1 gives artifacts now: 1.5 a.js:1.");
    expect(appearanceNote("multi-bounce-ao", src("m.aoMapIntensity = 1;"))).toBeUndefined();
    expect(appearanceNote("tone-mapping-to-screen", src("renderer.toneMapping = THREE.ACESFilmicToneMapping;"))).toMatch(/^renderer\.toneMapping is ACESFilmicToneMapping and the sRGB output are not applied/);
    expect(appearanceNote("unknown-id", code)).toBeUndefined();
  });
});

describe("will look different, on the fixtures", () => {
  it("r150-colour to r188: the rough floor and ball, the textures, the hemisphere fill with an environment", () => {
    const n = notes(fixture("r150-colour"), "r188");
    expect(n["rough-pbr-brighter"]).toBe("2 of 2 PBR material(s) are rough (roughness > 0.5; the default is 1): MeshStandardMaterial roughness 0.9 scene.js:16, MeshStandardMaterial roughness 0.8 scene.js:20.");
    expect(n["ambient-hemisphere-specular"]).toContain("HemisphereLight intensity 1 scene.js:23. scene.environment is set too");
    expect(n["color-management-on"]).toContain("1 texture load(s) (load scene.js:14)");
    expect(n["pmrem-reflections"]).toBe("2 PBR material(s) in the code, lit by scene.environment.");
  });
  it("r125-geometry: decay 2 on the point light and physical light units with a starting value", () => {
    const n = notes(fixture("r125-geometry"));
    expect(n["light-decay-2"]).toBe("1 Point/Spot light(s) without a decay now fall off with decay 2: PointLight main.js:24.");
    expect(n["legacy-lights-off"]).toBe("2 light(s) are now in physical units. Starting points at about x PI: PointLight 1 -> 3.14 main.js:24. Compare a screenshot from before and tune by eye.");
  });
  it("names tone mapping lost in post-processing from r154, and says to take a baseline first", () => {
    const dir = project({
      "package.json": "{}",
      "a.js": "import * as THREE from 'three';\nimport { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';\nrenderer.toneMapping = THREE.AgXToneMapping;\nconst composer = new EffectComposer(renderer);\n",
    });
    const p = migratePlan({ path: dir, three: THREE_DIR, from: "r154" });
    expect(p.appearance.find((a) => a.id === "tone-mapping-to-screen")?.note).toMatch(/^renderer\.toneMapping is AgXToneMapping/);
    expect(formatMigrate(p)).toContain("Take a three_check baseline before the upgrade");
  });
});
