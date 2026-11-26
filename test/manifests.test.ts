import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../src/mcp/toolsets.js";
import { LEAN_TOOLS } from "../src/mcp/lean.js";
import { HOOK_EVENTS } from "../src/hooks/hooks.js";
import { buildProgram } from "../src/program.js";

const plugin = (dir: string): string[] => readdirSync(`plugins/threesmith/${dir}`).filter((f) => !f.startsWith("."));

const json = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const { version } = json("package.json");

describe("manifests", () => {
  it("carry the package version (run `node scripts/sync-version.mjs`)", () => {
    expect(json("server.json").version).toBe(version);
    expect(json("server.json").packages[0].version).toBe(version);
    expect(json("plugins/threesmith/.claude-plugin/plugin.json").version).toBe(version);
    expect(json("plugins/threesmith/.mcp.json").mcpServers.threesmith.args).toContain(`threesmith@${version}`);
    expect(json("gemini-extension.json").version).toBe(version);
    expect(json("gemini-extension.json").mcpServers.threesmith.args).toContain(`threesmith@${version}`);
  });
  it("name the same mcp server and plugin", () => {
    expect(json("server.json").name).toBe(json("package.json").mcpName);
    const market = json(".claude-plugin/marketplace.json");
    expect(market.plugins[0].source).toBe("./plugins/threesmith");
    expect(json("plugins/threesmith/.claude-plugin/plugin.json").name).toBe(market.plugins[0].name);
  });
  it("keep hooks pointing at the runner and the skill front matter valid", () => {
    const hooks = json("plugins/threesmith/hooks/hooks.json");
    const cmds = JSON.stringify(hooks);
    for (const e of HOOK_EVENTS) expect(cmds).toContain(`run.mjs\\" ${e}`);
    const plugin = json("plugins/threesmith/.claude-plugin/plugin.json");
    const env = json("plugins/threesmith/.mcp.json").mcpServers.threesmith.env;
    for (const key of Object.keys(plugin.userConfig)) expect(JSON.stringify(env), key).toContain(`user_config.${key}`);
    const skill = readFileSync("plugins/threesmith/skills/threesmith/SKILL.md", "utf8");
    expect(skill).toMatch(/^---\nname: threesmith\ndescription: .+\n---/);
    expect(readFileSync("plugins/threesmith/agents/three-reviewer.md", "utf8")).toMatch(/^---\nname: three-reviewer\n/);
  });
  it("lists every mcp tool in the readme, and names no tool that does not exist", () => {
    const readme = readFileSync("README.md", "utf8");
    for (const t of ALL_TOOLS) expect(readme, t).toContain(`\`${t}\``);
    const docs = ["README.md", "llms-install.md", "docs/llms.txt", "plugins/threesmith/README.md", ...plugin("skills").map((d) => `plugins/threesmith/skills/${d}/SKILL.md`), ...plugin("agents").map((f) => `plugins/threesmith/agents/${f}`)];
    for (const f of docs) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bthree_[a-z_]+[a-z]\b/g)) expect([...ALL_TOOLS, ...LEAN_TOOLS], `${f} names ${m[0]}`).toContain(m[0]);
    }
  });
  it("gives every skill and agent valid front matter", () => {
    for (const d of plugin("skills")) expect(readFileSync(`plugins/threesmith/skills/${d}/SKILL.md`, "utf8"), d).toMatch(new RegExp(`^---\\nname: ${d}\\ndescription: .+`));
    for (const f of plugin("agents")) expect(readFileSync(`plugins/threesmith/agents/${f}`, "utf8"), f).toMatch(new RegExp(`^---\\nname: ${f.replace(/\.md$/, "")}\\n`));
  });

  it("states the real tool count everywhere it is written", () => {
    const n = ALL_TOOLS.length;
    const places: [string, RegExp][] = [
      ["README.md", /## The (\d+) tools/],
      ["README.md", /two tools instead of (\d+)/],
      ["docs/index.html", /(\d+) MCP tools, one CLI/],
      ["plugins/threesmith/.claude-plugin/plugin.json", /Empty means all (\d+)\./],
      ["plugins/threesmith/README.md", /MCP server \((\d+) tools/],
      ["plugins/threesmith/README.md", /empty means all (\d+)\)/],
    ];
    for (const [file, re] of places) expect(Number(re.exec(readFileSync(file, "utf8"))?.[1]), `${file} ${re}`).toBe(n);
  });

  it("names every CLI command in the README and llms.txt command lists", () => {
    const commands = buildProgram().commands.map((c) => c.name());
    const readme = /CLI: `threesmith ([^`]+)`/.exec(readFileSync("README.md", "utf8"))?.[1] ?? "";
    const llms = /- CLI: threesmith (.+)/.exec(readFileSync("docs/llms.txt", "utf8"))?.[1] ?? "";
    const listed = (text: string) => new Set(text.replace(/<[^>]*>/g, "").split(/[\s|]+/).filter(Boolean));
    // hook is for the plugin's hooks, not for people
    for (const c of commands) expect(listed(readme).has(c), `README CLI list lacks ${c}`).toBe(true);
    for (const c of commands.filter((x) => x !== "hook")) expect(listed(llms).has(c), `llms.txt CLI list lacks ${c}`).toBe(true);
  });
});
