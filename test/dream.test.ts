import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { applyDream, dream, dueOf, formatDream, hintsFile, readHints } from "../src/dream/dream.js";
import { emptySignals, readSignals, recordApiMiss, recordSession, recordUnexplained, recordUndone } from "../src/dream/signals.js";
import { threesmithHome } from "../src/learn/feedback.js";
import { lookup } from "../src/api/lookup.js";
import { indexFor } from "../src/core.js";
import { addLocalLesson, readLocal, recordLessonFeedback } from "../src/lessons/local.js";
import { undoJournal } from "../src/project/journal.js";
import { sessionStart } from "../src/hooks/hooks.js";
import { createServer } from "../src/mcp/server.js";
import { project, THREE_DIR } from "./helpers.js";

const signalsFile = () => join(threesmithHome(), "signals.json");
const fresh = () => {
  for (const f of ["signals.json", "lessons.json", "feedback.json"]) rmSync(join(threesmithHome(), f), { force: true });
};
const textOf = (r: unknown): string => (r as { content: { type: string; text?: string }[] }).content.find((c) => c.type === "text")?.text ?? "";

describe("dream signals", () => {
  beforeEach(fresh);

  it("counts API names that were not there, only with a suggestion from the installed three", () => {
    const index = indexFor(".", THREE_DIR);
    const miss = lookup(index, "BoxBufferGeometry");
    expect(miss.found).toBe(false);
    expect(miss.suggestions?.length).toBeGreaterThan(0);
    recordApiMiss("BoxBufferGeometry", miss.suggestions ?? []);
    recordApiMiss("THREE.BoxBufferGeometry", miss.suggestions ?? []);
    recordApiMiss("my private thing", ["Mesh"]);
    recordApiMiss("Nothing", []);
    const s = readSignals();
    expect(Object.keys(s.apiMisses)).toEqual(["BoxBufferGeometry"]);
    expect(s.apiMisses["BoxBufferGeometry"]!.n).toBe(2);
    const member = lookup(index, "WebGLRenderer.setSise");
    expect(member.suggestions).toContain("WebGLRenderer.setSize");
  });

  it("keeps messages as scrubbed templates, never names or paths", () => {
    recordUnexplained("Uncaught TypeError: Cannot read properties of undefined (reading 'myPrivateLevelName') at /home/someone/game/src/level.js:12:4");
    const keys = Object.keys(readSignals().unexplained);
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain("/home/someone");
    expect(keys[0]).not.toContain(":12:4");
    expect(readFileSync(signalsFile(), "utf8")).not.toContain("someone");
  });

  it("does nothing with learning off", () => {
    process.env["THREESMITH_LEARN"] = "0";
    try {
      recordSession();
      expect(existsSync(signalsFile())).toBe(false);
    } finally {
      delete process.env["THREESMITH_LEARN"];
    }
  });

  it("labels and counts undone writes per tool", () => {
    const dir = project({ "a.js": "x" });
    undoJournal(dir); // nothing to undo: nothing counted
    expect(readSignals().undone).toEqual({});
    recordUndone([{ tool: "three_fix" }, { tool: "fix" }]);
    expect(readSignals().undone["fix"]!.n).toBe(2);
  });
});

describe("dream", () => {
  beforeEach(fresh);

  it("proposes nothing from one-off events, and says why", () => {
    recordApiMiss("BoxBufferGeometry", ["BoxGeometry"]);
    const r = dream();
    expect(r.proposals).toEqual([]);
    expect(formatDream(r)).toMatch(/at least twice/);
  });

  it("turns repeats into numbered proposals with evidence, stable keys and an order", () => {
    for (let i = 0; i < 3; i++) recordApiMiss("BoxBufferGeometry", ["BoxGeometry"]);
    for (let i = 0; i < 2; i++) recordUnexplained("THREE.Fancy: the frobnicator is not ready yet for this pass");
    recordUndone([{ tool: "three_migrate" }, { tool: "three_migrate" }]);
    const r = dream();
    expect(r.proposals.map((p) => p.kind)).toEqual(["api-hint", "draft-lesson", "undone-tool"]);
    expect(r.proposals.map((p) => p.n)).toEqual([1, 2, 3]);
    expect(r.proposals[0]!.evidence).toEqual({ lookups: 3 });
    expect(dream().proposals[0]!.key).toBe(r.proposals[0]!.key);
    const text = formatDream(r);
    expect(text).toContain("1. [project hint]");
    expect(text).toContain("three_lesson_add");
  });

  it("drops a draft once a lesson covers the message", () => {
    const message = "THREE.Fancy: the frobnicator is not ready yet for this pass";
    for (let i = 0; i < 3; i++) recordUnexplained(message);
    expect(dream().proposals.filter((p) => p.kind === "draft-lesson")).toHaveLength(1);
    addLocalLesson({ topic: "rendering", title: "The frobnicator pass needs a warm-up frame first", symptom: "A warning about the frobnicator on the first frame", cause: "The pass is created before the renderer finished its setup", fix: "Render one frame before the pass is enabled", error: message });
    expect(dream().proposals.filter((p) => p.kind === "draft-lesson")).toEqual([]);
  });

  it("retires a local lesson that misled and merges duplicates", () => {
    const a = addLocalLesson({ topic: "lighting", title: "Shadows need castShadow on the light and receiveShadow on the floor", symptom: "No shadow shows on the floor at all", cause: "The light does not cast shadows by default in three", fix: "Set castShadow on the light and receiveShadow on the ground mesh", error: "THREE.Shadowy: the floor receives nothing from this light" }, { now: new Date("2026-01-01") });
    const b = addLocalLesson({ topic: "lighting", title: "No shadow until the light casts and the floor receives", symptom: "The floor has no shadow under the box", cause: "Shadow casting is off on the light by default", fix: "Turn on castShadow for the light and receiveShadow for the floor", error: "THREE.Shadowy: the floor receives nothing from this light" }, { now: new Date("2026-02-01") });
    recordLessonFeedback(a.lesson.id, "wrong");
    recordLessonFeedback(a.lesson.id, "wrong");
    const r = dream();
    const kinds = r.proposals.map((p) => p.kind);
    expect(kinds).toContain("retire-lesson");
    expect(kinds).toContain("merge-lessons");
    const merge = r.proposals.find((p) => p.kind === "merge-lessons")!;
    expect(merge.detail.lessons?.[merge.detail.lessons.length - 1]).toBe(b.lesson.id);
    const root = project({ "a.js": "" });
    applyDream(root, [merge.n]);
    expect(readLocal().lessons.map((l) => l.id)).toEqual([b.lesson.id]);
  });

  it("applies hints through the journal, undoably, and hides what was handled", () => {
    for (let i = 0; i < 2; i++) recordApiMiss("BoxBufferGeometry", ["BoxGeometry"]);
    for (let i = 0; i < 2; i++) recordUnexplained("THREE.Fancy: the frobnicator is not ready yet for this pass");
    const root = project({ "package.json": "{}", "a.js": "" });
    const r = dream();
    const res = applyDream(root, [1, 2, 9]);
    expect(res.applied.map((a) => a.n)).toEqual([1]);
    expect(res.setAside.map((s) => s.n)).toEqual([2]);
    expect(res.unknown).toEqual(["9"]);
    expect(res.journal).toBeGreaterThan(0);
    expect(readHints(root).api).toEqual([{ not: "BoxBufferGeometry", use: "BoxGeometry" }]);
    expect(dream().proposals).toEqual([]);
    expect(dream({ all: true }).proposals).toHaveLength(r.proposals.length);
    undoJournal(root);
    expect(existsSync(hintsFile(root))).toBe(false);
    // undoing the dream's own hints is not counted as a bad write
    expect(readSignals().undone).toEqual({});
  });

  it("is due after enough sessions and a day", () => {
    const s = emptySignals();
    s.sessions.n = 5;
    expect(dueOf(s).due).toBe(true);
    s.lastDream = "2026-03-01";
    s.sessionsAtDream = 1;
    expect(dueOf(s, new Date("2026-03-01T12:00:00Z")).due).toBe(false);
    expect(dueOf(s, new Date("2026-03-03T12:00:00Z")).due).toBe(false);
    s.sessions.n = 6;
    expect(dueOf(s, new Date("2026-03-03T12:00:00Z")).due).toBe(true);
  });

  it("shows hints and a due dream at the session start", () => {
    for (let i = 0; i < 2; i++) recordApiMiss("BoxBufferGeometry", ["BoxGeometry"]);
    const root = project({ "package.json": JSON.stringify({ dependencies: { three: "*" } }), "a.js": "" });
    for (let i = 0; i < 4; i++) recordSession();
    const ctx = sessionStart({ cwd: root })?.hookSpecificOutput?.additionalContext ?? "";
    expect(ctx).toContain("Dream: 1 proposal(s)");
    applyDream(root, [1]);
    const after = sessionStart({ cwd: root })?.hookSpecificOutput?.additionalContext ?? "";
    expect(after).toContain("Hint: `BoxBufferGeometry` does not exist");
    expect(after).not.toContain("Dream:");
  });

  it("runs as an MCP tool, and three_api shows the project hint", async () => {
    for (let i = 0; i < 2; i++) recordApiMiss("BoxBufferGeometry", ["BoxGeometry"]);
    const root = project({ "package.json": "{}", "a.js": "" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({ root }).connect(b);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(a);
    expect(textOf(await c.callTool({ name: "three_dream", arguments: {} }))).toContain("1. [project hint]");
    expect(textOf(await c.callTool({ name: "three_dream", arguments: { apply: [1] } }))).toContain("applied 1");
    const api = await c.callTool({ name: "three_api", arguments: { query: "BoxBufferGeometry", three: THREE_DIR } });
    expect(api.isError).toBe(true);
    expect(textOf(api)).toContain("Project hint");
  });
});
