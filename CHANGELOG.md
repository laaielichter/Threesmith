# Changelog

## Unreleased

## 0.5.0

- **New tool `three_model_library` (`threesmith model library`), 45 tools now:** 1000 ready-made base models in seven categories (furniture, street, storage, nature, buildings, vehicles, props), ported from Godotwright with identical geometry, names and materials. Search in English or Dutch ("oak chair", "eiken stoel"), see an asset's parts and parameters, print its spec, or build it by id with `three_model_build` / `model build <id> --param name=value`. Every asset passes the model lint and its archetype check at its defaults and at the ends of its parameter ranges; the catalogue is in LIBRARY.md. `model brief` names matching library assets. The site has a library page with every model rendered by three.js (`npm run site:library`). Builder: `ellipsoid` gets `cuts` (broken stone), new textures (granite, grain, fabric, leather, painted, plastic, brushed, rust) and 26 new archetypes.
- **Look:** an object is now the whole thing a person would name: a loaded model with named parts counts as one (the first named object from the top of the scene that does not hold everything drawn), so a frame with a house, a car and a robot reports three objects, not two hundred parts.
- **Site and README:** a "New in 0.4" section with a real annotated frame, the new tools in the tables, a shorter tool list per set, and a FAQ on using your own browser and GPU.

## 0.4.0

- **CI and the Action:** `ci --compare <release>` (input `compare`) runs the check page on another three release too and puts each change, with the migration note that explains it, in the receipt; a page that breaks fails it. `ci --impact <ref>` (input `impact`) adds what the change touches and the checks that prove it.
- **Live page:** `three_page` op `textures` (every texture with slot, size, colour space and GPU memory, and the colour-space and size mistakes) and op `diff` (what changed in the scene since the last diff).
- **Session:** `three_session` op start with `cdp` (`http://127.0.0.1:9222`) attaches to your own running Chrome: the real GPU, extensions and state. The tab is found by its URL and reloaded once to install the hooks; every live tool works on it; stop only disconnects.
- **New tool `three_capture` (`threesmith capture`), 44 tools now:** frames exactly 1/fps apart on the deterministic clock, a contact sheet, the change per frame (still scenes, pops), the PNG frames and an `.mp4` with ffmpeg.
- **New tool `three_animation`, 43 tools now:** the clips of a `.glb`; every live AnimationMixer with what is wrong (no clip played, `update` never called or with delta 0, weight or speed 0, tracks that drive no node, bind pose); play, pose and sweep a clip for the lowest point and node positions per step.
- **New tool `three_model_code` (`threesmith model code`), 42 tools now:** the ES module (or TypeScript) or React Three Fiber component that loads a `.glb` with the decoders it needs, its parts by name, materials and animation actions; checked in a real page.
- **Look and perf:** `three_look` with `annotate: true` returns the frame with numbered boxes and names; `three_perf` lists the cost per object and the meshes one `InstancedMesh` could draw in one call.
- **New tool `three_tune`, 41 tools now:** change values in the page `three_session` keeps running with no reload (an object by name, or `camera`, `renderer`, `scene`, `fog`; `intensity`, `color`, `position`, `fov`, `toneMappingExposure`, `material.roughness`, ...), then `op: save` writes them where the code sets them: an assignment, a `set()` call, a constructor argument (`DirectionalLight(color, intensity)`, `PerspectiveCamera(fov, ...)`), a material option, or one new line. Dry run first, one undoable step. New `tune` skill.
- **New tool `three_tsl` (`threesmith tsl`), 40 tools now:** `outline` maps every `Fn` (layout or inline), uniform, node slot and compute kernel with the TSL findings; `graph` reads the node graph each material really has in the running page; `shader` shows the WGSL or GLSL WebGPURenderer generated, with `find`.
- **Review:** three TSL rules, 104 in all: `tsl-js-operator` (`uv().x * 8` is NaN; use `.mul()`), `tsl-js-condition` (a JavaScript `if`/`?:` on a node is always taken; use `If()`/`select()`) and `tsl-assign-outside-fn`. Quiet on three's own addons and on the 244 official WebGPU examples.
- **Explain:** six TSL runtime messages from the r187 source (assign without a stack, wrong `Fn()` inputs, `Return()` in an inline `Fn()`, derivatives in the vertex stage, `texture()` without a texture, no normals), 41 kinds in all.
- **New tool `three_look` (`threesmith look`, `three_page` op `look`), 39 tools now:** the frame as text, measured by rendering with and without each object: brightness, background share, and per object the share of the frame it really shows, its place, whether the edge cuts it and what hides it; verdicts and `expect` claims (`"car visible >= 5%"`, `"car centered"`, `"frame not dark"`) on the same numbers.
- **New tool `three_impact` (`threesmith impact`), 38 tools now:** what a change touches in the scene (the whole picture, lights, camera, materials, shaders, assets, loop, disposal, input, the three version, the build), the pages, scenarios and baselines that run it through the import graph, and the numbered checks that prove it; `run: true` reviews the changed files and runs those scenarios.
- **New tool `three_dream` (`threesmith dream`), 37 tools now:** looks back at what agents ran into on this machine (API names that were not there, messages nothing explained, misleading or duplicate lessons, noisy rules, undone writes) and proposes project hints and lesson changes with their evidence; applied only when approved, hints undoable. The session start shows the hints and says when a dream is due. New `dream` skill.
- **Device:** `three_device` with `lose_context: true` (`--lose-context`) loses the WebGL context (`WEBGL_lose_context`), restores it and checks that the scene comes back: the draw calls in the second after the restore, a blank canvas, and for a scene that does not move by itself the share of pixels that differ from before. three r187 restores its own state and an animated scene recovers by itself; a page that renders on demand stays blank until the next input, which the tool names with the fix. New review rule `no-context-loss-handler` (lifecycle, info: a WebGLRenderer page with no animation loop and no `webglcontextrestored` listener; 101 rules) and a lesson (103).
- **New tool `three_device` (`threesmith device <page> --profile phone`), 35 tools now:** runs the page as on a `phone` (390x844 at DPR 3, touch, CPU 4x slower, textures up to 4096), a `tablet` or a `low-end-laptop`, or a `.json` profile of your own (`extends` a preset). The WebGL limits the page reads are clamped to the profile (`MAX_TEXTURE_SIZE`, cube maps, renderbuffer, viewport), so three resizes images as it would there. It reports textures uploaded over the limit (DataTextures, render targets and compressed textures, which three cannot resize and the device cannot upload), the textures three resized, texture memory against the profile budget, a pixel ratio above what the profile is worth rendering at, a page without a viewport meta (laid out 980 wide on a phone), and frame and script times under the CPU slow-down (`budget.frameMs`). The profiles are presets to test against, not measurements of real devices; frame times come from software rendering, so compare runs on one machine.
- **Check:** a request that failed with a 404 is no longer listed twice (`-> HTTP 404` and `net::ERR_ABORTED`).
- **New tool `three_gltf` (`threesmith gltf validate|optimize`), 34 tools now:** `validate` gives the Khronos glTF-Validator report of a `.glb`/`.gltf` (errors and warnings with their JSON pointer, external buffers read only from the model's folder); `optimize` runs gltf-transform `dedup`, `prune` and `weld`, with optional Draco or meshopt compression (`--draco`, `--meshopt`) and meshoptimizer simplification (`--simplify 0.5`), reports the size and triangles before and after as measured on the written bytes, and validates the output. A dry run unless `write: true` (`--write`), which saves `<name>.optimized.glb` (or `--out`) as one undoable step. `gltf-validator`, `@gltf-transform/*`, `draco3dgltf` and `meshoptimizer` are optional packages loaded on use: a missing one is answered with what to install. Textures are left as they are.
- **New tool `three_decoders` (`threesmith decoders`), 33 tools now:** wires Draco, KTX2 (Basis) and meshopt with the decoder files of the installed three (`node_modules/three/examples/jsm/libs`). It reads which models need which decoder (extensionsUsed and extensionsRequired), how the code points each loader at its files (three's own folder, a local folder, a CDN), checks the served files by hash against the installed three, and flags a CDN transcoder of another three release. `write: true` (`--write`) copies the files into the served folder (`public/` with a bundler, else next to the page; the glTF-only Draco build unless the code loads `.drc` files), adds the missing setup after `new GLTFLoader()` (`setDRACOLoader`, `setKTX2Loader` with `detectSupport(renderer)`, `setMeshoptDecoder`, imports in the file's own style; `useGLTF.setDecoderPath` for React Three Fiber), sets an explicit path where a bundler moves three's files, pins CDN paths and turns an assigned setter into a call, as one journal entry that `three_undo` takes back. What it cannot do safely is listed as hand work (KTX2 under drei, a renderer in another file, a GLTFLoader that is not in a variable). `three_doctor` points to it when a decoder is missing. New `assets` skill (10 skills).
- **Review:** two new rules, 100 in all: `decoder-setter-assigned` (`loader.setKTX2Loader = ktx2` replaces the method instead of calling it) and `ktx2-transcoder-version` (a KTX2 transcoder from a CDN of another or an unpinned three release). Two new lessons (102).
- **Check:** a file that three's `FileLoader` reads through a stream reader (models, decoders) is no longer reported as a failed request: Chromium reports such fetches as `net::ERR_ABORTED` after the whole response arrived, which made `check` fail on pages that load fine. A request without a good response is still reported.
- **Migrate:** `three_migrate` with `webgpu: true` (`--webgpu`) reports the WebGPU readiness: the blockers (ShaderMaterial, RawShaderMaterial, `onBeforeCompile`, EffectComposer with its passes mapped to TSL, ShaderChunk, raw WebGL context code, WebGLCubeRenderTarget), the steps (renderer, imports) and a heuristic score. It writes a TSL draft module per custom shader: uniforms become `uniform()`/`texture()`, varyings and the built-ins map to their nodes, the `#include` hooks of `onBeforeCompile` become `positionNode`/`colorNode`/`emissiveNode`/`roughnessNode`/`metalnessNode`, simple GLSL statements are translated and the rest is marked TODO. The drafts pass the review and render under WebGPURenderer with its WebGL 2 backend in the tests. New `webgpu` skill and `three-migrator` subagent (9 skills, 3 subagents).
- **Migrate:** "Will look different" is measured on the code: how many PBR materials are rough (with their roughness; the default 1 counts), which fill lights reflect now and whether `scene.environment` is set (r188), physical light units with a starting value per literal intensity (r155), Point/Spot lights without a decay (r147), texture loads and hex colours under colour management (r152), tone mapping lost in an EffectComposer without OutputPass (r155, now an appearance change), and `aoMapIntensity` above 1 (r188). The plan ends with the advice to take a baseline before the upgrade.
- **Migrate:** `three_migrate` with `write: true` (`threesmith migrate --write`) makes the exact rewrites as one journal entry that `three_undo` takes back: the `three_fix` renames plus 22 rewrites of the migration data (TSL `varying`/`label`/`TextureNode.uv`, `Timer` from core, `ColorManagement` renames, Euler/Object3D statics, `Data3DTexture`, `BufferGeometryUtils` namespace import, dropped `physicallyCorrectLights`/`useLegacyLights = false` lines and more). A rewrite whose new name the installed three does not have yet is left out and named. The plan marks the places it rewrites with `(write)`; read-only servers refuse `write`.
- **Migrate:** `three_migrate` with `write: true` (`threesmith migrate --write`) makes the exact rewrites as one journal entry that `three_undo` takes back: the `three_fix` renames plus 22 rewrites of the migration data (TSL `.varying()`/`.label()` chaining and `TextureNode.uv`, `Timer` from core, `ColorManagement` renames, Euler/Object3D statics, `Data3DTexture`, `BufferGeometryUtils` namespace import, dropped `physicallyCorrectLights`/`useLegacyLights = false` lines and more). A rewrite whose new name the installed three does not have yet is left out and named. The plan marks the places it rewrites with `(write)`; read-only servers refuse `write`.
- **New tool `three_migrate` (`threesmith migrate`), 32 tools now:** the plan to move code from an older three release to the installed one (or `--to r188`): 202 changes from r120 to r188, written from the three.js migration guide with a pull request or guide link each, found in this code by pattern or by review rule. Per release, the changes that apply with file:line (rename, removed, behaviour, appearance); a TO DO list for the hand work, with the replacement checked against the installed API; which places `three_fix` renames; and what will look different. `--from auto` reads CDN URLs, package.json, `@types/three`, the lockfile and the git history of package.json. Read-only; rewrites, appearance details and WebGPU readiness follow.
- **Run:** a deterministic clock for `check`, `play` and scenarios: `seed` (and `fixed_dt`, default 16.67 ms) over MCP, `--seed`/`--fixed-dt` on the CLI, `"seed"`/`"fixedDt"` in a scenario file. It seeds `Math.random`, pauses `requestAnimationFrame`, `performance.now()` and `Date` and moves them one fixed frame at a time, and turns waits into frames, so two runs give the same frames, watched values and pixels. Timers and network loads still run in real time (wait for a load with `until`); `perf`, `leaks` and live sessions are unchanged.
- **MCP:** prompts and resources for clients without the plugin: the prompt `threesmith-doctor` (optional `path` and `symptom`: start with three_doctor and fix in its order), a `threesmith-<skill>` prompt per plugin skill with your words in place of its arguments, and every skill as a Markdown resource at `threesmith://skills/<name>`. The `.mcpb` bundle and the Docker image now ship the skills.
- **MCP:** `threesmith mcp --lean` (or `THREESMITH_LEAN=1`, or the plugin's new "Lean tool list" setting) offers two tools instead of 31: `three` runs any tool by name and `three_help` gives a tool's parameters, finds tools by words or lists them all. Same tools, results and read-only refusals; arguments are checked strictly, so a misspelt one answers with the parameters. `threesmith mcp --stats` prints what the tool list costs, full and lean (about 13,300 against about 1,600 tokens, estimated).
- **Check:** `check` names the backend the page actually drew with (`WebGPU`, `WebGL 2`, `WebGL 1`, or `WebGL 2 (WebGPU fallback)`) and the adapter (the WebGL renderer string or the WebGPU adapter), in the text, the JSON, the MCP structured output and the CI receipt. A `WebGPURenderer` page that silently fell back to WebGL 2 gets a `webgpu-fallback` warning that says why, so a pass on the fallback is no longer taken for a WebGPU pass. `doctor --env` probes for a WebGPU adapter and, on Linux, says when libvulkan is missing.
- **CLI:** `undo --steps` refuses `abc`, `0`, `-2` and `1.5` with exit 2 (`--steps must be a whole number of 1 or more`) before any file is touched, instead of saying "Nothing to undo." or undoing a write you did not ask for. `undo`, `undo --steps N` and `undo --list` work as before. Thanks to @ADAMDEV01! (#27, #76)
- **CLI:** `review --limit` and `assets --limit` refuse `abc`, `0`, `-3` and `1.5` with exit 2 (`--limit must be a whole number of 1 or more`) instead of silently hiding every finding. Valid limits work as before. Thanks to @ADAMDEV01! (#26, #74)
- **CLI:** a path that does not exist stops `review`, `fix`, `ci`, `doctor`, `scan` and `assets` with `threesmith: path not found: <path>` and exit 2 before anything is scanned, so `ci ./typo` can no longer pass, and `scan`/`assets` no longer report on the enclosing project instead. A folder without three.js code and a single file work as before. Thanks to @ADAMDEV01! (#37, #72)
- **Review:** new `buffer-attribute-plain-array` rule: `new THREE.BufferAttribute(...)` / `new THREE.InstancedBufferAttribute(...)` with a plain array throws at load, and the review gave it 100/100 (#39). Literal arrays only for now; the plain-variable case is a follow-up. The rule count is now 98. Thanks to @IG-ABHINAV! (#39, #60)
- **Scenarios:** `scenario run <name>` with a name that matches no scenario now fails with exit 2 (`no scenario matches "jmup" (known: jump)`, at most 10 names listed) before any browser starts, also over MCP, instead of printing "No scenarios to run." and writing an empty, green JUnit report. Thanks to @timmiballz22! (#51, #66)
- **Model lint:** `--max-triangles` and `--max-draw-calls` refuse `abc`, `0`, `-5` and `1.5` with exit 2 instead of silently turning the budget off and scoring 100/100. Thanks to @timmiballz22! (#28, #62)

## 0.3.0

The first release on npm since 0.1.0: it holds everything below, 0.2.0 included.

- **50 new ready-made 3D models, 110 in all**, each an adjustable blueprint with 5 to 12 parameters (sizes, counts,
  styles, optional parts, colours, seeds) and pivots on the parts that move, linting 100/100 against what it should be:
  - vehicles and vessels: ambulance, fire truck, forklift, excavator, tram, go-kart, horse-drawn carriage, submarine,
    hovercraft, Viking longship;
  - air, space and machines: hot-air balloon, airship (zeppelin or steampunk), seaplane, space station, lunar lander,
    Mars rover, mech walker, robot, vending machine, arcade cabinet;
  - buildings and street: lighthouse, gas station, wizard tower, tavern, market stall, water tower, greenhouse,
    bus stop, fire hydrant, well;
  - items and furniture: sword, shield, battle axe, potion bottle, treasure chest, lantern, teapot, sofa, bookshelf,
    grandfather clock;
  - nature and creatures: cactus, mushroom, crystal cluster, boulder, birch, dog, cow, deer, snowman, stone golem.
- **Blueprints are easier to adapt:** `"visible"` leaves a part out, enum params work in expressions (`$style`,
  `$style_military`), `"material": "paint_{colour}"` picks a material by param, and `repeat` takes a count of 0.
- "lighthouse", "water tower" and "tram" now name their own archetypes instead of the generic tower and train.
- Security and robustness fixes from code scanning: step and watch code reaches the page as data instead of being
  pasted into a script, files are read and created without a check-then-use gap (undo journal, review memory,
  `.threesmith/.gitignore`), lesson placeholders are removed until none is left, Markdown escaping in the CI receipt
  escapes backslashes too, and the import-map rule reads `</script >` in any case.
- **Stricter CLI options, with exit code 2 and a clear message instead of a silent wrong answer:**
  - `review --disable`, `ci --disable` and `fix --only` refuse an unknown rule id and suggest the closest real one (#17).
  - `threesmith lessons` refuses an unknown `--topic` or `--verdict`, and `--verdict` without `--id` (#12).
  - `threesmith search --limit` must be a whole number of 1 or more, so `--limit abc` or `0` no longer says "No match" for a name that exists (#16).
  - `threesmith model view` refuses an unknown `--only` view and a non-positive or non-numeric `--width`, instead of showing all views or printing `NaN m` (#18).

### Thanks

- @chiragjangiir for the rule-id check in `review`, `ci` and `fix` (#20) and the `search --limit` check (#19) and the `model view` option checks (#23); #20 and #19 were their first contributions to Threesmith.
- @bfs2021 for the stricter `lessons` options (#13).

## 0.2.0 (not published on npm; ships in 0.3.0)

The agent-first toolkit of Godotwright (the same project for Godot), ported to three.js and extended with what coding
agents get wrong in three.js.

- **Start here:** `three_doctor` (also `threesmith doctor`) groups the problems of a project by cause, most urgent
  first, with what `three_fix` does and numbered next steps; `three_scan` maps the stack, versions, pages, the files
  that use three, renderer settings and assets in one call. The session-start hook gives a short brief of it.
- **Review:** 97 rules (was 39), pinned to the installed release. New: shaders checked against the installed
  `ShaderChunk` (unknown includes, `onBeforeCompile` patches that do nothing, GLSL3 mistakes, built-ins redeclared,
  uniforms without `{ value }`, GLSL under WebGPU, node materials under WebGL), loaders and decoders, TSL import paths,
  import maps, controls, animation mixers and clocks, instance and attribute updates, raycasting coordinates, render
  argument order, `scene.add(gltf)`, colour and post-processing (OutputPass, double gamma), deprecations read from
  three's source, and React Three Fiber (state in `useFrame`, objects in render, render priority). `fix` does 23
  rules. 17 new `explain` patterns (35 in all).
- **Fix loops that cost less:** `three_review` takes unsaved `code` + `file`, `only_new` (new findings in full, seen
  ones as a short line, the number fixed) and `files`; one line per finding (`--compact` on the CLI); SARIF output.
- **`three_types`:** the project's own `tsc --noEmit`, each three.js type error answered from the installed release.
- **Lessons:** 100 lessons from real three.js and react-three-fiber projects, by error message, words, rule or topic
  (`three_lessons`, `threesmith lessons`), shown under review, check, explain, doctor and hook output;
  `three_lesson_add` keeps one learned here, scrubbed of names, paths and code.
- **Assets:** `three_assets` resolves every path in the code like the dev server and a static host do: missing files,
  paths that only work on a case-insensitive disk, decoder folders, glTF files that need a decoder the code never
  sets up, textures above 4096, unused files. The edit hook names broken paths right after an edit.
- **Prove it:** `three_play` (steps, watched values per frame, claims judged at the end, any moment or every frame),
  `three_scenario` (passing runs kept as regression tests; `ci` runs them and writes JUnit), `three_perf` (draw
  calls, triangles, programs, textures and frame times against a budget and the last run), `three_leaks` (what grows
  per cycle, down to the GPU resources never disposed, by type).
- **Live page:** `three_session` and `three_page` keep a headless page open between calls: eval against the live
  scene, steps, frames, until, screenshots, inspect, reload, new errors after every answer.
- **Ship:** `three_build` runs the build, checks the output (copies of three, missing assets, sub-path URLs,
  decoders) and opens the built page headless.
- **3D models without Blender:** `three_model_build` builds clean, deterministic `.glb` files from 110 kinds or a JSON
  spec; `three_model_view` draws them as text; `three_model_lint` scores them for the web and against 129 archetypes;
  `three_model_inspect` says which loaders and decoders three.js needs and checks the code sets them up.
- **For agents and teams:** tool sets (`--tools core` loads 14 tools), `--tier cheap|premium`, `--read-only`,
  structured results, server instructions that name only loaded tools, an undo journal for every write
  (`three_undo`), protected paths, and false-alarm feedback that hides a finding on this machine.
- **Plugin:** a pre-edit hook that refuses Claude's edits into protected paths (and of the protect list); settings
  for protected paths, tool sets and read-only; full-detail profile; an icon; passes `claude plugin validate`. Skills `debug`, `perf`, `review`, `upgrade`, `ship`, `model`, `learn`; a `three-debugger` subagent.
- CLI output falls back to plain ASCII on a Windows pipe, where PowerShell turned `✖` into `Ôƒû` (`THREESMITH_ASCII`).
- Fixed: the API lookup found no members for classes re-exported through a local export list (every material).

## 0.1.0

First version.

- `threesmith api` / `search`: API lookup pinned to the installed three.
- `threesmith review`: scored review, 39 rules, symbol validation.
- `threesmith check`: headless WebGL 2 check with screenshot baselines.
- `threesmith ci`, GitHub Action, MCP server (`three_api`, `three_search`, `three_review`, `three_fix`, `three_check`, `three_inspect`, `three_explain`, `three_version`).
- `threesmith fix` / `three_fix`: mechanical renames, dry run unless `--write`.
- Inline `// threesmith-disable-next-line|-line|-file [rule]` comments.
- `check --steps` / `steps` in `three_check`: click, press, drag, wheel, wait, wait-for before the screenshot.
- Install buttons (VS Code, Cursor) in the README and on the site.
- `threesmith inspect` / `three_inspect`: the live scene graph, camera and renderer stats from the running page, with a
  diagnosis of why objects are not visible, and GPU memory sampled twice to catch leaks. `check --inspect` adds it to a
  check, and a blank frame gets it automatically.
- `threesmith explain` / `three_explain`: cause and fix for 18 kinds of three.js runtime errors, with the right import
  path for the installed version. `check` attaches it to every console error.
- Shader compile errors in `check` are parsed and pointed at the file and line in your project.
- The Claude Code hook explains three.js errors in command output.
- Benchmark tasks and grader (no results yet).
- Claude Code plugin (skill, `three-reviewer` agent, hooks that review edited files), Claude Desktop bundle, Gemini CLI extension, Dockerfile, `llms-install.md`, `threesmith doctor`, `mcp --project`.
- Release and publish workflows (npm trusted publishing, MCP registry), CodeQL, Dependabot, project site in `docs/`.

Packaging, hooks, workflows and community files are adapted from Godotwright.
