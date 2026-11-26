import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll } from "vitest";

// Every test file gets its own temp root (os.tmpdir() reads TMPDIR on each call), removed when the file is done, so
// the temp projects, homes and fixture pages of a run never pile up.
const root = mkdtempSync(join(tmpdir(), "threesmith-test-"));
const before = { TMPDIR: process.env["TMPDIR"], TMP: process.env["TMP"], TEMP: process.env["TEMP"] };
process.env["TMPDIR"] = process.env["TMP"] = process.env["TEMP"] = root;

// THREESMITH_HOME points at a temp folder, so tests never touch the real learning and lessons files
process.env["THREESMITH_HOME"] = mkdtempSync(join(root, "home-"));
// other three releases (three_compare) are fetched once into a cache that outlives the run, so reruns need no network
process.env["THREESMITH_THREE_CACHE"] ??= resolve("node_modules/.cache/threesmith/three");
delete process.env["THREESMITH_PROTECT"];
delete process.env["THREESMITH_LEARN"];

afterAll(() => {
  for (const [k, v] of Object.entries(before)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
