import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadLibrary } from "../../src/archetype/library.js";
import { buildKind } from "../../src/build/generators/index.js";
import { buildSpec } from "../../src/build/spec.js";
import { catalogMarkdown } from "../../src/library/format.js";
import { CATEGORIES, box, combos, num, type Family } from "../../src/library/kit.js";
import { assetsOf, getAsset, libraryOverview, loadAssetLibrary, searchAssets } from "../../src/library/library.js";
import { createServer } from "../../src/mcp/server.js";
import { project } from "../helpers.js";
import { tempFolder } from "../model-helpers.js";

const library = loadAssetLibrary();
const archetypes = loadLibrary();
const CHAIR = "furniture/dining-chair-oak-ladder";

describe("the asset library", () => {
  it("holds a thousand assets with unique ids, in every category", () => {
    expect(library.size).toBeGreaterThanOrEqual(1000);
    const overview = libraryOverview();
    expect(overview.map((c) => c.category)).toEqual([...CATEGORIES]);
    expect(overview.reduce((n, c) => n + c.count, 0)).toBe(library.size);
  });

  it("gives every asset a known archetype, text, tags and parameters with a range", () => {
    for (const a of library.values()) {
      expect(archetypes.get(a.archetype), a.id).toBeDefined();
      expect(a.id.startsWith(`${a.category}/${a.family}`), a.id).toBe(true);
      expect(a.title.length, a.id).toBeGreaterThan(3);
      expect(a.description.length, a.id).toBeGreaterThan(30);
      expect(a.tags.length, a.id).toBeGreaterThan(0);
      const params = a.spec["params"] as { min?: number; max?: number }[];
      expect(params.length, a.id).toBeGreaterThanOrEqual(2);
      expect(params.every((p) => p.min !== undefined && p.max !== undefined && p.min < p.max), a.id).toBe(true);
    }
  });

  it("has no two assets with the same spec, and no Godot words in the text", () => {
    const seen = new Map<string, string>();
    for (const a of library.values()) {
      const key = JSON.stringify({ ...a.spec, name: "", description: "" });
      expect(seen.get(key), `${a.id} is a copy of ${seen.get(key)}`).toBeUndefined();
      seen.set(key, a.id);
      expect(`${a.title} ${a.description}`, a.id).not.toMatch(/godot|OmniLight|-col\b|convcol/i);
    }
  });

  it("refuses bad ids, duplicates and drafts without parameters", () => {
    const fam = (slugs: string[], params = [num("w", 1, 0.5, 2, "width")]): Family => ({
      id: "thing",
      category: "props",
      archetype: "thing",
      tags: [],
      assets: () => slugs.map((slug) => ({ slug, title: "T", description: "d", params, materials: {}, nodes: [box("Body", [1, 1, 1], { material: "wood" })] })),
    });
    expect(() => assetsOf([fam(["Bad Slug"])])).toThrow(/not a valid id/);
    expect(() => assetsOf([fam(["a", "a"])])).toThrow(/defined twice/);
    expect(() => assetsOf([fam(["a"]), fam(["b"])])).toThrow(/family "thing" defined twice/);
    expect(() => assetsOf([fam(["a"], [])])).toThrow(/no parameters/);
    expect(assetsOf([fam(["a-b"])]).get("props/a-b")!.spec["version"]).toBe(1);
  });

  it("crosses option lists in a fixed order", () => {
    expect(combos({ a: [1, 2], b: ["x", "y"] })).toEqual([{ a: 1, b: "x" }, { a: 1, b: "y" }, { a: 2, b: "x" }, { a: 2, b: "y" }]);
  });
});

describe("searching the library", () => {
  it("finds assets by English words, title first", () => {
    const hits = searchAssets({ text: "oak chair" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title.toLowerCase()).toContain("oak");
    expect(hits.every((a) => /chair|stool/.test(`${a.title} ${a.tags.join(" ")}`.toLowerCase()))).toBe(true);
  });

  it("understands Dutch words for finishes, colours and things", () => {
    const dutch = searchAssets({ text: "eiken stoel" }).map((a) => a.id);
    expect(dutch).toContain(CHAIR);
    expect(dutch).toEqual(searchAssets({ text: "oak chair" }).map((a) => a.id));
  });

  it("filters by category, family and archetype, and finds nothing for nonsense", () => {
    expect(searchAssets({ family: "dining-chair" }).length).toBe(24);
    expect(searchAssets({ category: "nature" }).every((a) => a.category === "nature")).toBe(true);
    expect(searchAssets({ archetype: "plant.tree" }).every((a) => a.archetype.startsWith("plant.tree"))).toBe(true);
    expect(searchAssets({ archetype: "plant.tree" }).length).toBeGreaterThan(0);
    expect(searchAssets({ text: "zzqx flurb" })).toEqual([]);
  });

  it("finds an asset lazily with the same result as a full load", () => {
    const id = [...library.keys()].find((k) => k.startsWith("street/bus-stop-"))!;
    expect(getAsset(id)).toEqual(library.get(id));
    expect(getAsset("vehicles/car-sedan-silver")).toEqual(library.get("vehicles/car-sedan-silver"));
    expect(getAsset("vehicles/car")).toBeUndefined();
    expect(getAsset("nonsense")).toBeUndefined();
    expect(searchAssets({ archetype: "prop.chair" }).map((a) => a.id)).toEqual([...library.values()].filter((a) => a.archetype === "prop.chair").map((a) => a.id).sort());
  });
});

describe("using an asset", () => {
  it("builds as a kind, with parameters, and refuses an unknown id", () => {
    const scene = buildKind(CHAIR, { seatHeight: 0.5 });
    expect(scene.archetype).toBe("prop.chair");
    expect(scene).toEqual(buildSpec(getAsset(CHAIR)!.spec, { seatHeight: 0.5 }));
    expect(() => buildKind("furniture/no-such-thing")).toThrow(/model library/);
  });

  it("answers through the MCP tool, and builds by id with three_model_build", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({}).connect(b);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join("\n"), error: r.isError === true };
    };
    expect((await call("three_model_library", {})).text).toContain("base recipes");
    expect((await call("three_model_library", { query: "rode bank", limit: 5 })).text).toMatch(/red/i);
    const one = (await call("three_model_library", { id: CHAIR })).text;
    expect(one).toContain("Build it:");
    expect(one).toContain("threesmith model build");
    expect(JSON.parse((await call("three_model_library", { id: CHAIR, spec: true })).text).name).toBe("dining-chair-oak-ladder");
    expect((await call("three_model_library", { id: "furniture/nope" })).error).toBe(true);
    expect((await call("three_model_library", { spec: true })).error).toBe(true);
    const dir = project({ "package.json": "{}" });
    const built = await call("three_model_build", { out: "public/chair.glb", kind: CHAIR, path: dir });
    expect(built.error).toBe(false);
    expect(built.text).toContain("checked as prop.chair");
    expect(existsSync(join(dir, "public/chair.glb"))).toBe(true);
    expect(client.getInstructions()).toContain("three_model_library");
    await client.close();
  }, 60_000);
});

describe.skipIf(!existsSync("dist/cli.js"))("the library in the built cli", () => {
  const cli = (...args: string[]) => {
    const r = spawnSync("node", ["dist/cli.js", ...args], { encoding: "utf8" });
    return { output: r.stdout + r.stderr, exitCode: r.status };
  };

  it("shows, searches and prints the spec", () => {
    const overview = cli("model", "library");
    expect(overview.output).toMatch(/Asset library: \d{4} base recipes/);
    expect(overview.output).toContain("furniture (");
    const one = cli("model", "library", CHAIR);
    expect(one.output).toContain("archetype prop.chair");
    expect(one.output).toContain("seatHeight=0.46");
    expect(JSON.parse(cli("model", "library", CHAIR, "--spec").output).archetype).toBe("prop.chair");
    const found = cli("model", "library", "eiken", "stoel", "--limit", "2");
    expect(found.output).toContain("furniture/dining-chair-oak");
    expect(found.output).toMatch(/and \d+ more/);
    expect(cli("model", "library", "nothing-like-this", "--spec").exitCode).toBe(2);
  });

  it("builds by id, named after the asset", () => {
    const dir = tempFolder("threesmith-library-");
    const run = cli("model", "build", CHAIR, "-o", join(dir, "chair.glb"));
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("checked as prop.chair");
    expect(run.output).toContain("dining-chair-oak-ladder");
    expect(existsSync(join(dir, "chair.glb"))).toBe(true);
  }, 60_000);
});

describe("the catalogue", () => {
  it("the site page docs/library.html shows every asset with its picture (regenerate with: npm run site:library)", () => {
    const html = readFileSync(new URL("../../docs/library.html", import.meta.url), "utf8");
    expect(html).toContain(`${library.size} base models`);
    for (const id of library.keys()) expect(html, id).toContain(`data-id="${id}"`);
    for (const c of libraryOverview()) for (const f of c.families) expect(existsSync(new URL(`../../docs/library/${c.category}--${f.family}.jpg`, import.meta.url)), f.family).toBe(true);
  });

  it("LIBRARY.md lists every asset and is up to date (regenerate with: npm run build:library)", () => {
    const text = readFileSync(new URL("../../LIBRARY.md", import.meta.url), "utf8");
    expect(text).toBe(catalogMarkdown());
    for (const id of library.keys()) expect(text).toContain(`\`${id}\``);
  });
});
