import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer, type ServerOptions } from "../src/mcp/server.js";
import { LEAN_TOOLS, findTool, unknownTool, type LeanTool } from "../src/mcp/lean.js";
import { toolListCost } from "../src/mcp/stats.js";
import { ALL_TOOLS } from "../src/mcp/toolsets.js";
import { project, THREE_DIR } from "./helpers.js";

async function client(options: ServerOptions = {}): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(b);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(a);
  return c;
}

type Result = { content: { type: string; text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const textOf = (r: unknown): string => (r as Result).content.find((c) => c.type === "text")?.text ?? "";

describe("lean mode", () => {
  it("lists two tools, with every tool in the catalogue and the lean note first in the instructions", async () => {
    const c = await client({ lean: true });
    const tools = (await c.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...LEAN_TOOLS].sort());
    const run = tools.find((t) => t.name === "three")!;
    for (const name of ALL_TOOLS) expect(run.description).toContain(name.replace(/^three_/, ""));
    expect(c.getInstructions()).toMatch(/^This server runs lean: its tools are not in your tool list\. Run any tool named below with `three`/);
  });

  it("gives the same results through three as the full server does", async () => {
    const lean = await client({ lean: true });
    const full = await client();
    const viaLean = await lean.callTool({ name: "three", arguments: { tool: "api", args: { query: "Mesh", three: THREE_DIR } } });
    const direct = await full.callTool({ name: "three_api", arguments: { query: "Mesh", three: THREE_DIR } });
    expect(textOf(viaLean)).toBe(textOf(direct));
    expect(textOf(viaLean)).toContain("import { Mesh } from 'three'");
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nconst g = new THREE.Geometry();\n" });
    const review = (await lean.callTool({ name: "three", arguments: { tool: "three_review", args: { path: dir, three: THREE_DIR } } })) as Result;
    expect(textOf(review)).toContain("a.js:2 error [geometry-class]");
    expect(review.structuredContent?.["errors"]).toBeGreaterThan(0);
  });

  it("answers an unknown tool with near names, and wrong arguments with the parameters", async () => {
    const c = await client({ lean: true });
    const miss = (await c.callTool({ name: "three", arguments: { tool: "reveiw" } })) as Result;
    expect(miss.isError).toBe(true);
    expect(textOf(miss)).toMatch(/no tool "reveiw"; did you mean review/);
    const bad = (await c.callTool({ name: "three", arguments: { tool: "api", args: { qeury: "Mesh" } } })) as Result;
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("no parameter qeury");
    expect(textOf(bad)).toMatch(/\n {2}query: string/);
    const str = (await c.callTool({ name: "three", arguments: { tool: "version", args: `{"three": "${THREE_DIR.replace(/\\/g, "\\\\")}"}` as never } })) as Result;
    expect(textOf(str)).toMatch(/three r\d+/);
  });

  it("keeps the read-only refusals and tool sets", async () => {
    const c = await client({ lean: true, readOnly: true, tools: "core" });
    const dir = project({ "package.json": "{}", "a.js": "import * as THREE from 'three';\nnew THREE.BoxBufferGeometry();\n" });
    const r = (await c.callTool({ name: "three", arguments: { tool: "fix", args: { path: dir, write: true, three: THREE_DIR } } })) as Result;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("read-only");
    const off = (await c.callTool({ name: "three", arguments: { tool: "check" } })) as Result;
    expect(off.isError).toBe(true);
    const undo = (await c.callTool({ name: "three", arguments: { tool: "undo" } })) as Result;
    expect(textOf(undo)).toContain('no tool "undo"');
  });

  it("three_help describes one tool, finds tools by words, and lists them all", async () => {
    const c = await client({ lean: true });
    const one = textOf(await c.callTool({ name: "three_help", arguments: { tool: "check" } }));
    expect(one).toMatch(/^three_check: /);
    expect(one).toContain("Parameters (? = optional):");
    expect(one).toContain('Call it: three {"tool": "check"');
    const words = textOf(await c.callTool({ name: "three_help", arguments: { query: "memory leaks" } }));
    expect(words).toMatch(/^three_leaks: /);
    const all = textOf(await c.callTool({ name: "three_help", arguments: {} }));
    expect(all).toContain(`${ALL_TOOLS.length} tools, by set`);
    expect(all).toMatch(/\nmodel: model_brief/);
  });

  it("matches tool names loosely and suggests nothing for nonsense", () => {
    const tools = new Map<string, LeanTool>(["three_model_view", "three_review"].map((n) => [n, { name: n, title: n, description: "", shape: {}, run: async () => undefined }]));
    expect(findTool(tools, "Model-View")?.name).toBe("three_model_view");
    expect(findTool(tools, "three_review")?.name).toBe("three_review");
    expect(unknownTool(tools, "zzzzzzzz")).toBe('no tool "zzzzzzzz". Call three_help without arguments for the list.');
  });

  it("costs a fraction of the full tool list", async () => {
    const s = await toolListCost({});
    const [full, lean] = [...s.matchAll(/about ([\d,]+) tokens/g)].map((m) => Number(m[1]!.replace(/,/g, "")));
    expect(s).toContain(`full: ${ALL_TOOLS.length} tools`);
    expect(s).toContain("lean: 2 tools");
    expect(lean!).toBeLessThan(full! / 4);
  });
});
