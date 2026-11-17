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

  it("rejects unmatched scenario names before writing JUnit reports", () => {
    const dir = project({ ".threesmith/scenarios/jump.json": JSON.stringify({ name: "jump", steps: [], expect: ["1 == 1 @ end"] }) });
    const junit = join(dir, "unmatched.xml");
    for (const args of [[], ["--json"]]) {
      const bad = spawnSync("node", ["dist/cli.js", "scenario", "run", "jmup", "--path", dir, "--junit", junit, ...args]);
      expect(bad.status).toBe(2);
      expect(bad.stderr.toString()).toContain('no scenario matches "jmup" (known: jump)');
      expect(existsSync(junit)).toBe(false);
    }
    const empty = project({});
    const noScenarios = spawnSync("node", ["dist/cli.js", "scenario", "run", "--path", empty]);
    expect(noScenarios.status).toBe(0);
    expect(noScenarios.stdout.toString()).toContain("No scenarios to run.");
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

    for (const value of ["abc", "0", "-3", "1.5", "Infinity", "NaN"]) {
      const invalid = spawnSync("node", ["dist/cli.js", "lessons", "shadow", "--limit", value]);
      expect(invalid.status).toBe(2);
      expect(invalid.stderr.toString()).toContain(`--limit must be a whole number of 1 or more (got "${value}")`);
      expect(invalid.stdout.toString()).not.toContain("no lessons");
    }

    for (const args of [
      ["--rule", "no-lights"],
      ["--error", "THREE.WebGLRenderer: Context Lost."],
    ]) {
      const invalid = spawnSync("node", ["dist/cli.js", "lessons", ...args, "--limit", "0"]);
      expect(invalid.status).toBe(2);
      expect(invalid.stderr.toString()).toContain('--limit must be a whole number of 1 or more (got "0")');
    }

    const single = spawnSync("node", ["dist/cli.js", "lessons", "dispose", "--limit", "1", "--json"]);
    expect(single.status).toBe(0);
    expect(JSON.parse(single.stdout.toString())).toHaveLength(1);

    const limited = spawnSync("node", ["dist/cli.js", "lessons", "--topic", "shadows", "--limit", "1", "--json"]);
    expect(limited.status).toBe(0);
    expect(JSON.parse(limited.stdout.toString())).toHaveLength(1);

    const list = spawnSync("node", ["dist/cli.js", "lessons", "--topic", "shadows"]);
    expect(list.status).toBe(0);
    expect(list.stdout.toString()).toContain("shadows/");

    const record = spawnSync("node", ["dist/cli.js", "lessons", "--id", "shadows/acne-and-bias", "--verdict", "helped"]);
    expect(record.status).toBe(0);
    expect(record.stdout.toString()).toContain("recorded: shadows/acne-and-bias helped");
  });

  it("rejects invalid model lint budgets and accepts valid ones", () => {
    const robot = "examples/agent-mistakes/public/models/robot.glb";
    const cases: Array<[string, string]> = [
      ["--max-triangles", "abc"],
      ["--max-triangles", "0"],
      ["--max-triangles", "-5"],
      ["--max-triangles", "1.5"],
      ["--max-draw-calls", "abc"],
      ["--max-draw-calls", "0"],
      ["--max-draw-calls", "-5"],
      ["--max-draw-calls", "1.5"],
    ];
    for (const [flag, value] of cases) {
      const result = spawnSync("node", ["dist/cli.js", "model", "lint", robot, flag, value]);
      expect(result.status).toBe(2);
      expect(result.stderr.toString()).toContain(`${flag} must be a whole number of 1 or more (got "${value}")`);
    }
    for (const flag of ["--max-triangles", "--max-draw-calls"]) {
      const result = spawnSync("node", ["dist/cli.js", "model", "lint", robot, flag, "100000"]);
      expect(result.status).toBe(0);
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
