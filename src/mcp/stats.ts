import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { estimateTokens } from "./lean.js";
import { createServer, type ServerOptions } from "./server.js";

/** The tool list (names, descriptions, schemas) and instructions a client receives from a server with these options. */
export async function toolList(options: ServerOptions): Promise<{ tools: unknown[]; instructions: string }> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(b);
  const c = new Client({ name: "threesmith-stats", version: "0" });
  await c.connect(a);
  const { tools } = await c.listTools();
  const instructions = c.getInstructions() ?? "";
  await c.close();
  return { tools, instructions };
}

/** What the tool list costs per turn, full and lean, for `threesmith mcp --stats`. Token counts are estimates. */
export async function toolListCost(options: ServerOptions): Promise<string> {
  const full = await toolList({ ...options, lean: false });
  const lean = await toolList({ ...options, lean: true });
  const f = estimateTokens(full.tools) + estimateTokens(full.instructions);
  const l = estimateTokens(lean.tools) + estimateTokens(lean.instructions);
  return [
    `full: ${full.tools.length} tools, about ${f.toLocaleString("en-US")} tokens (tool list and instructions)`,
    `lean: ${lean.tools.length} tools, about ${l.toLocaleString("en-US")} tokens (${Math.round((1 - l / f) * 100)}% less)`,
    "Estimates at about 4 characters per token; the parameters of a tool are read with three_help when needed.",
  ].join("\n");
}
