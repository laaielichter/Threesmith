import { z } from "zod";
import { levenshtein } from "../api/lookup.js";
import { TOOLSET_NAMES, TOOLSETS } from "./toolsets.js";

/**
 * Lean mode (`threesmith mcp --lean`): the server offers two tools instead of all of them. Every tool definition is
 * sent to the model on every turn, so the full list costs thousands of tokens before the agent has done anything. In
 * lean mode the list is a short catalogue inside one tool (`three`, which runs any tool by name), and the parameters
 * of a tool are read when they are needed (`three_help`). The tools, their read-only refusals and their results are
 * the same as on the full server.
 */

export interface LeanTool {
  name: string;
  title: string;
  description: string;
  shape: Record<string, z.ZodType>;
  run: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
}

/** The two tools a lean server lists. */
export const LEAN_TOOLS = ["three", "three_help"] as const;

const short = (name: string) => name.replace(/^three_/, "");

/** The tool a name means: with or without `three_`, in any case, with dashes or spaces for underscores. */
export function findTool(tools: ReadonlyMap<string, LeanTool>, name: string): LeanTool | undefined {
  const key = name.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return tools.get(key) ?? tools.get(`three_${key}`);
}

/** What to say for a name that is no tool: the nearest names, then how to list them all. */
export function unknownTool(tools: ReadonlyMap<string, LeanTool>, name: string): string {
  const want = short(name.trim().toLowerCase());
  const near = [...tools.keys()]
    .map(short)
    .map((n) => ({ n, d: n.startsWith(want) || (want.length > 2 && n.includes(want)) ? 0 : levenshtein(want, n, 3) }))
    .filter((x) => x.d <= 3)
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, 4)
    .map((x) => x.n);
  return `no tool "${name}"${near.length ? `; did you mean ${near.join(", ")}?` : "."} Call three_help without arguments for the list.`;
}

/** One line per set: the names to pass to `three`, each with what it is for. */
export function catalogue(tools: ReadonlyMap<string, LeanTool>): string {
  const out: string[] = [];
  for (const set of TOOLSET_NAMES) {
    const here = (TOOLSETS[set] as readonly string[]).filter((name) => tools.has(name));
    if (here.length) out.push(`${set}: ${here.map((name) => `${short(name)} (${tools.get(name)!.title})`).join("; ")}`);
  }
  return out.join("\n");
}

type Json = { type?: string | string[]; enum?: unknown[]; items?: Json; anyOf?: Json[]; description?: string; properties?: Record<string, Json>; required?: string[] };

function typeText(s: Json | undefined): string {
  if (!s) return "any";
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (s.anyOf) return [...new Set(s.anyOf.map(typeText))].join(" | ");
  const type = Array.isArray(s.type) ? s.type.join(" | ") : s.type;
  if (type === "array") return `${typeText(s.items)}[]`;
  if (type === "object" && s.properties) return `{${Object.entries(s.properties).map(([k, v]) => `${k}${s.required?.includes(k) ? "" : "?"}: ${typeText(v)}`).join(", ")}}`;
  return type ?? "any";
}

/** The parameters of a tool, one per line: name, `?` when optional, its type and what it is for. */
export function parameters(tool: LeanTool): string[] {
  const schema = z.toJSONSchema(z.object(tool.shape), { io: "input", unrepresentable: "any" }) as Json;
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, prop]) => `  ${name}${required.has(name) ? "" : "?"}: ${typeText(prop)}${prop.description ? `  ${prop.description}` : ""}`);
}

/** Everything about one tool: what it does, its parameters, and how to call it. */
export function describeTool(tool: LeanTool): string {
  const params = parameters(tool);
  return [`${tool.name}: ${tool.title}`, tool.description, params.length ? "Parameters (? = optional):" : "No parameters.", ...params, `Call it: three {"tool": "${short(tool.name)}", "args": {...}}`].join("\n");
}

/** The tools that match the words best: name first, then title, then description. */
export function searchTools(tools: ReadonlyMap<string, LeanTool>, query: string, limit = 5): LeanTool[] {
  const words = query.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1);
  return [...tools.values()]
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const title = tool.title.toLowerCase();
      const body = tool.description.toLowerCase();
      let score = 0;
      for (const w of words) score += (name.includes(w) ? 6 : 0) + (title.includes(w) ? 3 : 0) + (body.includes(w) ? 1 : 0);
      return { tool, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
    .map((s) => s.tool);
}

const firstSentence = (s: string) => {
  const end = s.search(/[.:](\s|$)/);
  return end > 0 && end < 220 ? s.slice(0, end + 1) : `${s.slice(0, 200)}...`;
};

/** The answer of `three_help`: one tool in full, the best matches for words, or the whole catalogue. */
export function help(tools: ReadonlyMap<string, LeanTool>, input: { tool?: string; query?: string }): { text: string; ok: boolean } {
  if (input.tool) {
    const tool = findTool(tools, input.tool);
    return tool ? { ok: true, text: describeTool(tool) } : { ok: false, text: unknownTool(tools, input.tool) };
  }
  if (input.query?.trim()) {
    const hits = searchTools(tools, input.query);
    if (!hits.length) return { ok: true, text: `no tool matches "${input.query}". All tools:\n${catalogue(tools)}` };
    // The best match in full (it is usually the one), the others as one line each.
    return { ok: true, text: [describeTool(hits[0]!), ...(hits.length > 1 ? ["", "Also:"] : []), ...hits.slice(1).map((t) => `  ${short(t.name)}: ${firstSentence(t.description)}`)].join("\n") };
  }
  return { ok: true, text: `${tools.size} tools, by set (three_help {"tool": name} gives the parameters):\n${catalogue(tools)}` };
}

/**
 * Checks the arguments of a call against the tool's parameters, strictly: a name the tool does not have is an error,
 * because the model has not seen the parameters and a dropped argument would silently change what the call does.
 */
export function checkArgs(tool: LeanTool, args: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  let value = args ?? {};
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, message: `${tool.name}: args must be an object, e.g. {"tool": "${short(tool.name)}", "args": {...}}\nParameters (? = optional):\n${parameters(tool).join("\n")}` };
    }
  }
  const parsed = z.strictObject(tool.shape).safeParse(value);
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  const issues = parsed.error.issues.map((i) => (i.code === "unrecognized_keys" ? `no parameter ${(i as { keys: string[] }).keys.join(", ")}` : `${i.path.join(".") || "args"}: ${i.message}`));
  return { ok: false, message: `${tool.name}: ${issues.join("; ")}\nParameters (? = optional):\n${parameters(tool).join("\n")}` };
}

/** What a lean server tells the model first, before the usual instructions (which name the tools as `three_...`). */
export const LEAN_NOTE =
  'This server runs lean: its tools are not in your tool list. Run any tool named below with `three`, e.g. three {"tool": "review", "args": {"only_new": true}} (the name with or without three_). Before the first call of a tool, read its parameters with three_help {"tool": "review"}; three_help {"query": "words"} finds a tool.';

/** A rough token count of a tool list as the client receives it (about 4 characters per token for JSON). */
export function estimateTokens(tools: unknown): number {
  return Math.round(JSON.stringify(tools).length / 4);
}
