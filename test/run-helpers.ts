import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, THREE_DIR } from "./helpers.js";

/** A temp folder with index.html, three next to it (import map) and main.js: the fixture game, or the given script. */
export function gamePage(script?: string, extra: Record<string, string> = {}): string {
  const dir = project({
    "index.html": `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js"}}</script><script type="module" src="./main.js"></script></body></html>`,
    "main.js": script ?? readFileSync(join(import.meta.dirname, "fixtures", "run", "game.js"), "utf8"),
    ...extra,
  });
  mkdirSync(join(dir, "three"), { recursive: true });
  cpSync(join(THREE_DIR, "build", "three.module.js"), join(dir, "three", "three.module.js"));
  cpSync(join(THREE_DIR, "build", "three.core.js"), join(dir, "three", "three.core.js"));
  return dir;
}

/**
 * A copy of the installed three as another "release", no network needed: REVISION and the package version set to
 * `revision`, and each patch (a regular expression on three.core.js and its replacement) applied, or it throws.
 */
export function fakeRelease(revision: string, patches: [RegExp, string][] = []): string {
  const dir = project({});
  mkdirSync(join(dir, "build"), { recursive: true });
  for (const f of ["three.module.js", "three.core.js"]) cpSync(join(THREE_DIR, "build", f), join(dir, "build", f));
  let core = readFileSync(join(dir, "build", "three.core.js"), "utf8");
  for (const [re, by] of [[/^const REVISION = '\d+';/m, `const REVISION = '${revision}';`] as [RegExp, string], ...patches]) {
    const next = core.replace(re, by);
    if (next === core) throw new Error(`${re} not found in three.core.js`);
    core = next;
  }
  writeFileSync(join(dir, "build", "three.core.js"), core);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "three", version: `0.${revision}.0` }));
  return dir;
}
