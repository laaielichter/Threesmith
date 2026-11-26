import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createServer, type ServerOptions } from "../src/mcp/server.js";
import { fillSkill, loadSkills, parseSkill, skillsDir } from "../src/mcp/prompts.js";
import { ALL_TOOLS } from "../src/mcp/toolsets.js";

async function client(options: ServerOptions = {}): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(b);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(a);
  return c;
}

const textOf = (r: { messages: { content: { type: string; text?: string } }[] }) => r.messages.map((m) => m.content.text ?? "").join("\n");
const skillNames = readdirSync("plugins/threesmith/skills").filter((d) => !d.startsWith(".")).sort();

describe("mcp prompts and resources", () => {
  it("lists the doctor prompt and one prompt per task skill", async () => {
    const c = await client();
    const names = (await c.listPrompts()).prompts.map((p) => p.name).sort();
    expect(names).toEqual(["threesmith-doctor", ...skillNames.filter((n) => n !== "threesmith").map((n) => `threesmith-${n}`)].sort());
  });

  it("fills the doctor prompt with the path and the symptom, naming only tools that exist", async () => {
    const c = await client();
    const r = await c.getPrompt({ name: "threesmith-doctor", arguments: { path: "web", symptom: "a black screen" } });
    const text = textOf(r as never);
    expect(text).toContain("`web`");
    expect(text).toContain("The user sees: a black screen");
    expect(text).toContain('three_doctor with path "web"');
    for (const m of text.matchAll(/\bthree_[a-z_]+[a-z]\b/g)) expect(ALL_TOOLS).toContain(m[0]);
  });

  it("turns a skill into a prompt with the user's words for $ARGUMENTS", async () => {
    const c = await client();
    const r = textOf((await c.getPrompt({ name: "threesmith-upgrade", arguments: { arguments: "src/legacy" } })) as never);
    expect(r).toContain("Bring the project (or src/legacy) up to the installed three release.");
    expect(r).not.toContain("$ARGUMENTS");
    expect(r).not.toMatch(/^---/);
    const none = textOf((await c.getPrompt({ name: "threesmith-upgrade", arguments: {} })) as never);
    expect(none).toContain("(or the project)");
  });

  it("offers every skill as a Markdown resource", async () => {
    const c = await client();
    const resources = (await c.listResources()).resources;
    expect(resources.map((r) => r.uri).sort()).toEqual(skillNames.map((n) => `threesmith://skills/${n}`));
    const r = await c.readResource({ uri: "threesmith://skills/debug" });
    const content = r.contents[0] as { text: string; mimeType: string };
    expect(content.mimeType).toBe("text/markdown");
    expect(content.text).toContain("three_inspect");
  });

  it("leaves the doctor prompt out when three_doctor is off", async () => {
    const c = await client({ tools: "run" });
    expect((await c.listPrompts()).prompts.map((p) => p.name)).not.toContain("threesmith-doctor");
  });

  it("parses front matter and finds the skills folder", () => {
    expect(skillsDir()).toBeTruthy();
    expect(loadSkills().map((s) => s.name)).toEqual(skillNames);
    const s = parseSkill('---\nname: x\ndescription: Does x.\nargument-hint: "[a file, optional]"\n---\n\nDo $ARGUMENTS now.\n');
    expect(s).toEqual({ name: "x", description: "Does x.", hint: "a file, optional", body: "Do $ARGUMENTS now." });
    expect(fillSkill(s!, "  a.js ")).toBe("Do a.js now.");
    expect(parseSkill("no front matter")).toBeUndefined();
    expect(parseSkill("---\nname: x\n---\nbody")).toBeUndefined();
    expect(loadSkills("/nonexistent-folder").length).toBe(0);
  });
});
