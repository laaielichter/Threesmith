import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The plugin's skills, offered over MCP to clients without the Claude Code plugin: each skill is a resource
 * (`threesmith://skills/<name>`, its Markdown) and, except the general `threesmith` skill, a prompt
 * (`threesmith-<name>`) with the skill's steps and the user's words in place of $ARGUMENTS. `threesmith-doctor` is a
 * prompt of its own: start with three_doctor and fix in its order.
 */

export interface Skill {
  name: string;
  description: string;
  /** What the argument is for, from the skill's argument-hint. */
  hint?: string;
  /** The Markdown without the front matter. */
  body: string;
}

/** The skills folder (plugins/threesmith/skills at the package root), found by walking up from here. */
export function skillsDir(from: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  let dir = from;
  for (let i = 0; i < 5; i++) {
    const d = join(dir, "plugins", "threesmith", "skills");
    if (existsSync(d) && existsSync(join(dir, "package.json"))) return d;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** Splits a SKILL.md into its front matter fields and body. Undefined when it has no name and description. */
export function parseSkill(text: string): Skill | undefined {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1]!] = kv[2]!.replace(/^"(.*)"$/, "$1");
  }
  if (!fields["name"] || !fields["description"]) return undefined;
  return { name: fields["name"], description: fields["description"], ...(fields["argument-hint"] ? { hint: fields["argument-hint"].replace(/^\[|\]$/g, "") } : {}), body: m[2]!.trim() };
}

let cached: Skill[] | undefined;

/** The bundled skills, by name. Empty when the folder is not there (a layout without it): prompts are a help. */
export function loadSkills(dir: string | undefined = skillsDir()): Skill[] {
  if (cached && dir === skillsDir()) return cached;
  const out: Skill[] = [];
  if (dir && existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const skill = parseSkill(readFileSync(file, "utf8"));
      if (skill) out.push(skill);
    }
  }
  if (dir === skillsDir()) cached = out;
  return out;
}

/** A skill's body with the user's words for $ARGUMENTS ("the project" when there are none). */
export function fillSkill(skill: Skill, args?: string): string {
  const words = args?.trim() || "the project";
  return skill.body.replace(/\$ARGUMENTS/g, words);
}

/** The text of the threesmith-doctor prompt. */
export function doctorPrompt(path?: string, symptom?: string): string {
  const where = path?.trim() ? `\`${path.trim()}\`` : "this project";
  return [
    `Find out what is wrong with the three.js code in ${where} and fix it in the right order.${symptom?.trim() ? ` The user sees: ${symptom.trim()}` : ""}`,
    "",
    `1. Call three_doctor${path?.trim() ? ` with path ${JSON.stringify(path.trim())}` : ""}. It groups the problems by cause, most urgent first, and says which ones three_fix does.`,
    "2. Run three_fix without write to see the mechanical renames, then with write: true.",
    "3. Fix the rest by hand, one cause at a time, in the order three_doctor gave. Look up every replacement with three_api; never guess an API from memory.",
    "4. After each change call three_review with only_new: true and fix its errors before the next step.",
    "5. When the page should show something, call three_check on it and look at the screenshot; three_inspect says why objects are not visible.",
    "6. End with the score before and after, what you changed, and what is left for the user.",
  ].join("\n");
}
