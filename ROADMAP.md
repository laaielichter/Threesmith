# Roadmap

Done in 0.1.0 (each has tests):

- [x] Version-pinned API lookup and search from the installed three (`api`, `search`, MCP).
- [x] Scored review with 39 rules, release-gated, symbol validation against the installed exports.
- [x] Headless WebGL 2 check: errors, blank frames, context loss, screenshot, baselines with diff image.
- [x] MCP server, CLI, `ci` receipt, GitHub Action, agent skill.
- [x] Interaction steps for `check`.
- [x] `fix` for mechanical renames and inline disable comments.
- [x] Claude Code plugin with hooks, Claude Desktop bundle, Gemini extension, Docker, `doctor`.
- [x] Benchmark tasks and a model-free grader.

Done since (unreleased, each has tests):

- [x] Doctor grouped by cause and project map (`three_doctor`, `three_scan`).
- [x] Tool sets, cheap and premium profiles, read-only mode, structured results.
- [x] Review: 101 rules incl. shaders against the installed ShaderChunk, R3F, loaders; only_new, unsaved code, SARIF.
- [x] Type-aware review for TypeScript projects (`three_types`, the project's own tsc).
- [x] Lessons from real projects and local lessons; false-alarm feedback.
- [x] Asset check (paths, case, decoders); build check of the deployed output.
- [x] Play with claims, scenarios as regression tests (JUnit), perf budgets, leak cycles.
- [x] A live headless page between calls (`three_session`, `three_page`).
- [x] 3D models without Blender: build, view as text, lint, inspect with loader needs.
- [x] Undo journal for every write, protected paths.
- [x] Lean mode (`three` + `three_help`), MCP prompts and the skills as resources.
- [x] Deterministic clock (`seed`, `fixed_dt`) for check, play and scenarios.
- [x] Upgrade plans from the migration guide r120 to r188 (`three_migrate`): exact rewrites with undo, what will look
  different, WebGPU readiness and TSL drafts.
- [x] Decoders wired from the installed three (`three_decoders`), glTF validate and optimize (`three_gltf`).
- [x] Device profiles, clamped WebGL limits and context-loss recovery (`three_device`).
- [x] The same page on two three releases, compared by meaning and explained by the migration notes, with bisect to
  the first release that changes it (`three_compare`).
- [x] Dreaming (`three_dream`, `threesmith dream`): counters kept while agents work (API names that were not there,
  messages nothing explained, undone writes) become numbered proposals with evidence: project hints, draft lessons,
  lessons to retire or merge, noisy rules. Applied only when approved; hints are undoable.
- [x] The whole change (`three_impact`, `threesmith impact`): changed files to the scene areas they touch, the import
  graph to the pages, scenarios and baselines that run them, and the checks that prove the change.
- [x] The frame as text (`three_look`, `threesmith look`, `three_page` op `look`): per object the share of the frame
  it really shows, place, cut by the edge, hidden by what, and the frame's light, measured by rendering with and
  without each object; verdicts and claims on the same numbers.
- [x] TSL (`three_tsl`, `threesmith tsl`): outline of Fn, uniforms, node slots and compute with the review's TSL
  findings; three review rules for JavaScript operators and conditions on nodes and `assign()` outside `Fn()`
  (quiet on three's own addons and the 244 official WebGPU examples); six TSL runtime messages explained; the node
  graph and the generated shader read from the running page.

Next:

- [ ] Publish to npm and the MCP registry; add the Action to the marketplace.
- [ ] Action input `compare: next`: a `three_compare` receipt on every three bump pull request.
- [ ] Run the benchmark with real agents (N >= 10 per arm) and publish outputs and results.
- [ ] More rules from the migration guide as three releases (each verified in the source).
- [ ] Best-effort WebGPU runs on runners with a usable adapter; GPU-based baselines.
