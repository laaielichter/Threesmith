import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ci } from "../src/ci.js";
import { project, THREE_DIR } from "./helpers.js";

describe("ci receipt", () => {
  it("passes clean code and fails broken code", async () => {
    const good = await ci({ path: project({ "a.js": readFileSync("test/fixtures/modern.js", "utf8") }), three: THREE_DIR, minScore: 90 });
    expect(good.ok).toBe(true);
    expect(good.markdown).toContain("✅ pass");
    const bad = await ci({ path: project({ "a.js": readFileSync("test/fixtures/legacy.js", "utf8") }), three: THREE_DIR, minScore: 90 });
    expect(bad.ok).toBe(false);
    expect(bad.reasons.join(" ")).toContain("below the minimum");
    expect(bad.markdown).toContain("❌ fail");
  });
});

describe.skipIf(!existsSync("dist/cli.js"))("built cli", () => {
  it("prints version and exit codes", () => {
    expect(execFileSync("node", ["dist/cli.js", "--version"]).toString().trim()).toMatch(/^\d+\.\d+\.\d+/);
    const dir = project({ "a.js": "import * as THREE from 'three';\nnew THREE.Geometry();\n" });
    const r = spawnSync("node", ["dist/cli.js", "review", dir, "--three", THREE_DIR, "--fail-on", "error"]);
    expect(r.status).toBe(1);
    expect(r.stdout.toString()).toContain("geometry-class");
    const miss = spawnSync("node", ["dist/cli.js", "api", "Nope", "--three", THREE_DIR]);
    expect(miss.status).toBe(1);

    const badDisable = spawnSync("node", ["dist/cli.js", "review", dir, "--three", THREE_DIR, "--disable", "output-encodin"]);
    expect(badDisable.status).toBe(2);
    expect(badDisable.stderr.toString()).toContain('unknown rule "output-encodin" in --disable (did you mean output-encoding?)');

    const badFix = spawnSync("node", ["dist/cli.js", "fix", dir, "--only", "output-encodin"]);
    expect(badFix.status).toBe(2);
    expect(badFix.stderr.toString()).toContain('unknown rule "output-encodin" in --only (did you mean output-encoding?)');

    const disabled = spawnSync("node", ["dist/cli.js", "review", dir, "--three", THREE_DIR, "--disable", "geometry-class"]);
    expect(disabled.status).toBe(0);
    expect(disabled.stdout.toString()).not.toContain("geometry-class");

    // doctor and undo take the folder as an argument too, like review and scan
    const pos = spawnSync("node", ["dist/cli.js", "doctor", "examples/agent-mistakes", "--no-env"]).stdout.toString();
    expect(pos).toMatch(/^Threesmith doctor: \d+ error/);
    expect(spawnSync("node", ["dist/cli.js", "doctor", "--path", "examples/agent-mistakes", "--no-env"]).stdout.toString()).toBe(pos);
    expect(spawnSync("node", ["dist/cli.js", "undo", dir, "--list"]).stdout.toString()).toContain("No Threesmith writes");

    const badLimit = spawnSync("node", ["dist/cli.js", "search", "Vector3", "--three", THREE_DIR, "--limit", "abc"]);
    expect(badLimit.status).toBe(2);
    expect(badLimit.stderr.toString()).toContain('threesmith: --limit must be a whole number of 1 or more (got "abc")');

    const zeroLimit = spawnSync("node", ["dist/cli.js", "search", "Vector3", "--three", THREE_DIR, "--limit", "0"]);
    expect(zeroLimit.status).toBe(2);
    expect(zeroLimit.stderr.toString()).toContain('threesmith: --limit must be a whole number of 1 or more (got "0")');

    const negLimit = spawnSync("node", ["dist/cli.js", "search", "Vector3", "--three", THREE_DIR, "--limit", "-3"]);
    expect(negLimit.status).toBe(2);
    expect(negLimit.stderr.toString()).toContain('threesmith: --limit must be a whole number of 1 or more (got "-3")');

    const goodLimit = spawnSync("node", ["dist/cli.js", "search", "Vector3", "--three", THREE_DIR, "--limit", "1"]);
    expect(goodLimit.status).toBe(0);
    expect(goodLimit.stdout.toString()).toContain("Vector3");
  });

  it("rejects unknown lesson filters and keeps the valid ones working", () => {
    const badTopic = spawnSync("node", ["dist/cli.js", "lessons", "--topic", "shadowz", "shadow"]);
    expect(badTopic.status).toBe(2);
    expect(badTopic.stderr.toString()).toContain("--topic must be one of rendering, color");
    expect(badTopic.stderr.toString()).toContain('(got "shadowz")');

    const badVerdict = spawnSync("node", ["dist/cli.js", "lessons", "--id", "shadows/acne-and-bias", "--verdict", "helpful"]);
    expect(badVerdict.status).toBe(2);
    expect(badVerdict.stderr.toString()).toContain('--verdict must be helped or wrong (got "helpful")');
    expect(badVerdict.stdout.toString()).not.toContain("recorded:");

    const noId = spawnSync("node", ["dist/cli.js", "lessons", "--verdict", "helped"]);
    expect(noId.status).toBe(2);
    expect(noId.stderr.toString()).toContain("--verdict needs --id");

    const list = spawnSync("node", ["dist/cli.js", "lessons", "--topic", "shadows"]);
    expect(list.status).toBe(0);
    expect(list.stdout.toString()).toContain("shadows/");

    const record = spawnSync("node", ["dist/cli.js", "lessons", "--id", "shadows/acne-and-bias", "--verdict", "helped"]);
    expect(record.status).toBe(0);
    expect(record.stdout.toString()).toContain("recorded: shadows/acne-and-bias helped");
  });

  it("rejects an unknown rules category and lists the valid categories", () => {
    for (const category of ["perf", ""]) {
      const r = spawnSync("node", ["dist/cli.js", "rules", "--category", category]);
      expect(r.status).toBe(2);
      expect(r.stdout.toString()).toBe("");
      expect(r.stderr.toString()).toContain(`--category must be one of correctness, api, performance, lifecycle, color (got "${category}")`);
    }
  });

  it("explains an unmatched rule query while preserving empty JSON output", () => {
    const miss = spawnSync("node", ["dist/cli.js", "rules", "nosuchrule"]);
    expect(miss.status).toBe(1);
    expect(miss.stdout.toString()).toBe('no rule matches "nosuchrule" (threesmith rules lists all of them)\n');
    expect(miss.stderr.toString()).toBe("");

    const json = spawnSync("node", ["dist/cli.js", "rules", "nosuchrule", "--json"]);
    expect(json.status).toBe(1);
    expect(json.stdout.toString()).toBe("[]\n");
    expect(json.stderr.toString()).toBe("");

    const filtered = spawnSync("node", ["dist/cli.js", "rules", "nosuchrule", "--category", "performance"]);
    expect(filtered.status).toBe(1);
    expect(filtered.stdout.toString()).toBe(miss.stdout.toString());
  });

  it("lists categories in rules help and keeps valid filters working", () => {
    const help = spawnSync("node", ["dist/cli.js", "rules", "--help"]);
    expect(help.status).toBe(0);
    for (const category of ["correctness", "api", "performance", "lifecycle", "color"]) {
      expect(help.stdout.toString()).toContain(category);
      const r = spawnSync("node", ["dist/cli.js", "rules", "--category", category, "--json"]);
      expect(r.status).toBe(0);
      const rules = JSON.parse(r.stdout.toString()) as { category: string }[];
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.every((rule) => rule.category === category)).toBe(true);
    }
  });

  it("validates model view options and renders views", () => {
    const robot = "examples/agent-mistakes/public/models/robot.glb";

    const badOnly = spawnSync("node", ["dist/cli.js", "model", "view", robot, "--only", "back"]);
    expect(badOnly.status).toBe(2);
    expect(badOnly.stderr.toString()).toContain('--only must be front, side or top (got "back")');

    const badWidthStr = spawnSync("node", ["dist/cli.js", "model", "view", robot, "--width", "abc"]);
    expect(badWidthStr.status).toBe(2);
    expect(badWidthStr.stderr.toString()).toContain('--width must be a whole number of 1 or more (got "abc")');

    const badWidthZero = spawnSync("node", ["dist/cli.js", "model", "view", robot, "--width", "0"]);
    expect(badWidthZero.status).toBe(2);
    expect(badWidthZero.stderr.toString()).toContain('--width must be a whole number of 1 or more (got "0")');

    const onlyTop = spawnSync("node", ["dist/cli.js", "model", "view", robot, "--only", "top"]);
    expect(onlyTop.status).toBe(0);
    const topOut = onlyTop.stdout.toString();
    expect(topOut).toContain("TOP (from above");
    expect(topOut).not.toContain("FRONT (from +z");
    expect(topOut).not.toContain("SIDE (from the right");

    const withWidth = spawnSync("node", ["dist/cli.js", "model", "view", robot, "--width", "40"]);
    expect(withWidth.status).toBe(0);
    expect(withWidth.stdout.toString()).not.toContain("NaN");
  });
});
void join;
