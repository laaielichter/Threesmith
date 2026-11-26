<p align="center">
  <img src="docs/logo.svg" alt="Threesmith logo" width="72" height="72">
</p>
<h1 align="center">Threesmith</h1>
<p align="center"><b>Less debugging. More dimension.</b><br>
MCP server, CLI and Claude Code plugin. Works with Claude Code, Codex, Cursor, VS Code, Gemini CLI and any MCP client.</p>
<p align="center">
  <a href="https://github.com/laaielichter/Threesmith/actions/workflows/ci.yml"><img src="https://github.com/laaielichter/Threesmith/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/threesmith"><img src="https://img.shields.io/npm/v/threesmith?color=cb3837&logo=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/three.js-r187-049ef4?logo=threedotjs&logoColor=white" alt="Tested on three.js r187">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
  <a href="https://vscode.dev/redirect/mcp/install?name=threesmith&config=%7B%22name%22%3A%22threesmith%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22threesmith%22%2C%22mcp%22%5D%7D"><img src="https://img.shields.io/badge/VS_Code-Install_MCP_server-0098FF?logo=visualstudiocode&logoColor=white" alt="Install in VS Code"></a>
  <a href="https://cursor.com/en/install-mcp?name=threesmith&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInRocmVlc21pdGgiLCJtY3AiXX0%3D"><img src="https://img.shields.io/badge/Cursor-Install_MCP_server-000000?logo=cursor&logoColor=white" alt="Install in Cursor"></a>
  <a href="#install-in-your-agent"><img src="https://img.shields.io/badge/Claude_Code-Add_plugin-D97757" alt="Add to Claude Code"></a>
  <a href="https://github.com/laaielichter/Threesmith/stargazers"><img src="https://img.shields.io/github/stars/laaielichter/Threesmith?style=social" alt="GitHub stars"></a>
</p>
<p align="center">
  <a href="https://laaielichter.github.io/Threesmith/">Website</a> ·
  <a href="https://laaielichter.github.io/Threesmith/install.html">Install in your agent</a> ·
  <a href="https://laaielichter.github.io/Threesmith/models.html">3D models</a> ·
  <a href="examples/agent-mistakes">Example</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>
<p align="center">
  <a href="https://laaielichter.github.io/Threesmith/"><img src="docs/assets/social.jpg" alt="Threesmith: less debugging, more dimension; a real model built from code" width="1000"></a><br>
  <sub>Explore the <a href="https://laaielichter.github.io/Threesmith/">interactive model preview</a>, toolkit and real before-and-after demo.</sub>
</p>
<p align="center">
  <img src="docs/before-after.jpg" alt="Left: the black canvas of a scene a coding agent wrote. Right: the same scene after the fixes Threesmith listed, a lit crate and a character model" width="860"><br>
  <sub>Real run on <a href="examples/agent-mistakes">examples/agent-mistakes</a>: as the agent wrote it (3 review errors, 2 asset paths that 404, a black canvas), and after <code>threesmith fix</code> plus the fixes <code>threesmith doctor</code> listed (<a href="examples/agent-mistakes-fixed">100/100, check passes</a>).</sub>
</p>

three.js ships a release almost every month and removes old APIs. Coding agents learned it from years of code that used
`THREE.Geometry`, `outputEncoding`, `three/examples/js` and import paths that no longer exist, and they cannot see the
canvas they draw on. Threesmith is the check between the agent and your project: the API of **the three version you
have installed**, a scored review, the assets and decoders the code needs, the page run in headless Chromium with the
frame measured object by object, and safe, undoable edits. Everything runs locally; nothing leaves the machine
(`three_compare` fetches another three release from npm, only when you ask for one).

## New in 0.4: it reads the frame

<p align="center">
  <img src="docs/assets/look-annotated.jpg" alt="A house, a red car and a small robot on grass, each with a numbered box and its share of the frame: 2 House 31%, 3 Car 4.6%, 4 Robot 0.8%" width="860"><br>
  <sub>Real output of <code>threesmith look --annotate</code> on three models Threesmith built. The boxes come from the pixels each object really shows.</sub>
</p>

- **See the frame as numbers.** `three_look` renders with and without each object: how much of the frame it shows,
  where, cut by the edge, hidden behind what, too dark. Claims such as `"car visible >= 5%"` pass or fail.
- **Tune it live, keep it in code.** `three_tune` changes a light, a colour or the camera in the running page, then
  writes each value where your code sets it, as one undoable step.
- **Animation, TSL and motion.** `three_animation` says why a clip does not play and finds feet that sink into the
  floor; `three_tsl` catches `uv().x * 8` and `if` on a node; `three_capture` records frames on a virtual clock.
- **Prove the whole change.** `three_impact` follows the diff to the pages and tests that run it; in CI the receipt
  says what changed between two three releases and why.
- **And:** `three_model_code` (the module or R3F component for a `.glb`), `three_dream` (learns from past sessions on
  your machine), `three_session` with `cdp` (your own Chrome, the real GPU). See the [changelog](CHANGELOG.md).

## Without and with

| Your agent... | On its own | With Threesmith |
| --- | --- | --- |
| writes three.js | `Geometry`, `outputEncoding`, `BoxBufferGeometry`, `examples/js`: old habits | 104 rules pinned to the installed release flag each line with the fix; `fix` does the 23 pure renames |
| calls an API | guesses a name or an import path from memory | `three_api` reads `node_modules/three`: signature, deprecation and the right `three/addons/...` path |
| writes a shader | `#include <encodings_fragment>`, `gl_FragColor` with GLSL3, a `.replace()` on a chunk that is gone | includes checked against the installed `ShaderChunk`, patches that silently do nothing found, renames fixed |
| loads a model | `/models/Car.glb` that is a 404 on Linux, Draco without a decoder | `three_assets` resolves every path like the server does; `three_decoders` wires the decoders from the installed three |
| says "it works" | never opened the page | `three_check` opens it headless: errors with causes, blank frames, a screenshot, baselines |
| gets a black screen | guesses: more light? move the camera? | `three_inspect` reads the live scene and says why each object is not visible |
| says "it looks right" | cannot see the picture it made | `three_look` measures each object's share of the frame, place, cut and hidden parts; claims pass or fail |
| tweaks the look | guesses a number, edits, reloads, guesses again | `three_tune` changes it live in the running page, then writes the value where the code sets it |
| animates a model | a T-pose, a clip that never plays, feet in the floor | `three_animation` says why, poses the model at any time and sweeps a clip for the lowest point |
| writes TSL | `uv().x * 8` and `if` on a node, as if it were GLSL | `three_tsl` finds them, and shows the node graph and the shader three generated in the page |
| fixes a bug | cannot show it was there, or that it is gone | `three_play` runs steps and judges claims frame by frame; `three_scenario` keeps it as a regression test |
| makes it fast | changes things and hopes | `three_perf` counts draw calls, triangles and programs against a budget and the last run; `three_leaks` names what is never disposed |
| upgrades three | merges the "bump three" PR blind | `three_compare` runs your page on both releases and says what changed (console, scene, draw calls, light per object), each change with the migration note that explains it |
| ships it | builds once, deploys, sees a 404 | `three_build` builds, finds two copies of three, missing assets and sub-path URLs, then opens the built page |
| needs a 3D model | needs Blender or a placeholder cube | `three_model_build` makes a clean `.glb` from one of 110 kinds or 1000 library models, then shows it as text views and lints it |
| finishes a change | checks the file it touched, not the pages that run it | `three_impact` names what the change touches, which pages and tests run it, and the checks that prove it |
| does not know the project | reads twenty files | `three_scan` and `three_doctor` give the map and the order to fix things in one call |

<p align="center">
  <a href="https://laaielichter.github.io/Threesmith/models.html"><img src="docs/gallery/overview.jpg" alt="A car, an airship, a wizard tower, an excavator, a treasure chest, a dragon, a lighthouse, a mech, a longship, a stone golem, a hot-air balloon and a castle, built by Threesmith and rendered by three.js" width="860"></a><br>
  <sub>3D models from code, no Blender: 110 ready-made kinds and a library of 1000 base models (see <a href="LIBRARY.md">LIBRARY.md</a>), from cars and airships to swords, teapots and golems, rendered here by three.js itself. <a href="https://laaielichter.github.io/Threesmith/models.html">See all</a></sub>
</p>

## Quickstart

**1. See what is wrong.** Nothing to install but the package:

```sh
npx -y threesmith doctor          # what is wrong, grouped by cause, most urgent first, with next steps
npx -y threesmith review          # score 0-100, `file:line severity [rule] message Fix: ...`
npx -y threesmith check .         # open the page headless, errors and a screenshot
```

**2. Give it to your agent.** In Claude Code:

```text
/plugin marketplace add laaielichter/Threesmith
/plugin install threesmith@threesmith
```

**3. Ask for something.** *"Find out why the scene is black and fix it."* Every three.js file Claude edits is reviewed
right after the edit, its errors and broken asset paths go straight back to Claude, and the session starts with a
brief of the project.

## Install in your agent

| Client | How |
| --- | --- |
| **Claude Code** | `/plugin install threesmith@threesmith` after `/plugin marketplace add laaielichter/Threesmith` (MCP server, hooks incl. protected paths, 12 skills, 3 subagents, settings for tool sets and read-only) |
| **Claude Code, MCP only** | `claude mcp add threesmith -- npx -y threesmith mcp` |
| **Codex** | `codex mcp add threesmith -- npx -y threesmith mcp --tier premium` |
| **Cursor, VS Code** | the buttons at the top |
| **Gemini CLI** | `gemini extensions install https://github.com/laaielichter/Threesmith` |
| **Cline and others** | [llms-install.md](llms-install.md), or `{ "mcpServers": { "threesmith": { "command": "npx", "args": ["-y", "threesmith", "mcp"] } } }` |
| **Docker** | `Dockerfile` |

Run the agent from the project folder, or pass `--project <path>`. Needs Node.js 22.12+ and `three` installed in the
project. The browser tools need `playwright-core` and a Chromium (`npx playwright-core install chromium`);
`threesmith doctor --env` shows what is missing.

Clients without the plugin still get its workflows: the server offers the prompts `threesmith-doctor` (start with
the doctor, fix in its order) and `threesmith-<skill>` for each skill (`debug`, `review`, `perf`, `ship`, `model`,
`upgrade`, `webgpu`, `learn`, `dream`, `tune`), and every skill as a resource (`threesmith://skills/<name>`, Markdown).

### Made for agents: cheap calls, exact answers

- **Two profiles.** `--tier cheap` (the default) gives short, capped output and numbered step-by-step instructions, so
  small models follow the right order; `--tier premium` gives full detail for large models.
- **Tool sets.** `--tools core` loads 18 tools; add `run`, `live`, `build`, `model` when you need them, or name single
  tools. A tool list the client pays for in every turn stays small. The server instructions only ever name tools
  that are loaded.
- **Lean mode.** `--lean` offers two tools instead of 45: `three` runs any tool by name
  (`{"tool": "review", "args": {"only_new": true}}`) and `three_help` gives a tool's parameters when they are needed.
  Same tools, same results, same read-only refusals; the tool list drops from about 22,000 to about 2,600 tokens
  (estimated at 4 characters per token; `threesmith mcp --stats` prints the numbers for your options).
- **Fix loops that cost less.** `three_review` with `only_new: true` shows new findings in full, the ones the agent
  already saw as one short line, and how many are fixed. `code` + `file` reviews code before it is saved.
- **Structured results.** Review, check and doctor return `structuredContent` with an output schema next to the text.
- **One line per finding.** `file:line severity [rule] message Fix: ...`, the same in the CLI (`--compact`), MCP and hooks.
- **Safe writes.** Every write (fix, model build, scenario save) is one journal entry that `three_undo` takes back; a
  file changed by hand since is left alone. `"protect"` in `threesmith.json` (or `THREESMITH_PROTECT`) names
  folders no write may touch. `--read-only` leaves out the tools that always write and refuses write options.
- **It learns, locally.** A finding marked as a false alarm with `three_feedback` is hidden from then on; lessons kept
  with `three_lesson_add` come back under the same error. `three_dream` looks back at past sessions and proposes
  project hints and lesson changes, each with its evidence. Only hashes, counters and scrubbed text, on this machine.

## The 45 tools

**core** · read files, answer, fix

| Tool | What it does |
| --- | --- |
| `three_doctor` | Start here: what is wrong, grouped by cause, most urgent first, with numbered next steps |
| `three_scan` | The project map: bundler, framework, three versions, pages, import maps, renderer settings, assets |
| `three_api` | The exact API in the installed three: signature, deprecation, import path, did-you-mean |
| `three_search` | Classes, constants and members by part of a name |
| `three_review` | Score 0-100 from 104 rules pinned to the installed release; `only_new` for fix loops, `code` for unsaved code |
| `three_types` | The project's own `tsc --noEmit`, each three.js type error answered from the installed release |
| `three_fix` | The renames that mean exactly the same, dry run first, undoable |
| `three_migrate` | Upgrade plan per release (r120 to r188) with file:line, what will look different, a WebGPU readiness report and undoable rewrites |
| `three_impact` | What a change touches in the scene, the pages and tests that run it through the import graph, and the checks that prove it |
| `three_tsl` | TSL: Fn, uniforms and node slots with their mistakes (`uv().x * 8`, `if` on a node); the node graph and generated shader from the page |
| `three_explain` | Cause and fix of a console, build or test message (41 kinds) |
| `three_lessons` | 103 lessons from real three.js and R3F projects by error, words, rule or topic |
| `three_lesson_add` | Keep a lesson learned here, scrubbed of names, paths and code |
| `three_rules` | Every review rule with its category, release gating and fix |
| `three_feedback` | Mark a finding as a false alarm (hidden from then on) or right |
| `three_dream` | Learns from past sessions on this machine: project hints, draft lessons, noisy rules, each with its evidence; applied only when you say so |
| `three_undo` | Undo the last Threesmith writes, newest first |
| `three_version` | Which three release is installed |

**run** · open the page headless

| Tool | What it does |
| --- | --- |
| `three_check` | The page in headless Chromium: errors with causes, shader errors at your line, failed requests, blank frames, screenshot, baselines |
| `three_inspect` | The live scene graph, draw calls, GPU memory, and why each object is not visible |
| `three_look` | The frame as numbers per object: share, place, cut, hidden by what, too dark; claims, and an annotated screenshot |
| `three_capture` | Frames 1/fps apart on a virtual clock: a contact sheet, still scenes and pops, an `.mp4` with ffmpeg |
| `three_play` | Steps (click, press, drag, frames, until), watched values and claims judged frame by frame; `seed` makes runs repeatable |
| `three_scenario` | Keep a passing play run as a regression test; `ci` runs them and writes JUnit |
| `three_perf` | Draw calls, triangles, programs and frame times against a budget and the last run, the cost per object, instancing candidates |
| `three_device` | The page as on a phone, tablet or low-end laptop: texture limits, memory budget, pixel ratio, context loss |
| `three_leaks` | Repeat a cycle and report what grows, down to GPU resources never disposed |
| `three_compare` | The same page on two three releases, each change with the migration note that explains it; `bisect` finds the release |

**live** · a page kept running

| Tool | What it does |
| --- | --- |
| `three_session` | A page kept open between calls, headless or your own Chrome (`cdp`) with the real GPU |
| `three_page` | Drive it without reloading: eval, steps, screenshot, inspect, look, `textures` (colour-space and size mistakes), `diff` |
| `three_tune` | Change a value live (light, colour, camera, exposure, material), then save it where the code sets it, undoable |
| `three_animation` | Clips of a `.glb`; live mixers and why a clip does not play; play, pose and sweep for feet in the floor |

**build** · assets and the deployed output

| Tool | What it does |
| --- | --- |
| `three_assets` | Every asset path resolved like the dev server and the host: missing files, wrong capitals, decoders, huge textures |
| `three_decoders` | Draco, KTX2 and meshopt wired with the decoder files of the installed three, undoable |
| `three_gltf` | Khronos validation, and gltf-transform optimisation with before-and-after numbers (optional packages) |
| `three_build` | Run the build, check the output (copies of three, assets, sub-path URLs) and open the built page |

**model** · 3D models without Blender

| Tool | What it does |
| --- | --- |
| `three_model_brief` | One page before you build a model: nearest kind, parts, real size, rules, order of tools |
| `three_model_identify` | What a thing is (English or Dutch): parts, pivots, typical size, usual mistakes |
| `three_model_spec` | The JSON model spec, an example, and the 110 ready-made kinds |
| `three_model_library` | 1000 ready-made base models (furniture, street, storage, nature, buildings, vehicles, props), searchable in English or Dutch, each with parameters |
| `three_model_build` | A clean, deterministic `.glb` from a kind, a library id or a spec, linted |
| `three_model_view` | A `.glb` as text: front, side and top views, parts with sizes, parts that do not touch |
| `three_model_lint` | Score a `.glb` for the web, and against what it should be |
| `three_model_inspect` | What is in a `.glb` and which loaders and decoders it needs, with the setup code |
| `three_model_code` | The code that loads a `.glb`: an ES module or a React Three Fiber component with its parts, materials and animations |

Every tool explains itself in full to the agent (its MCP description); `threesmith <command> --help` does the same in the shell.

CLI: `threesmith doctor | scan | api | search | review | types | fix | impact | migrate | tsl | rules | dream | undo | lessons | assets | decoders | gltf | check |
inspect | look | capture | play | scenario | perf | device | leaks | compare | build | model <inspect|needs|code|view|lint|identify|brief|spec|kinds|recipes|library|build>
| explain | ci | hook | mcp`. `threesmith <command> --help` lists the options.

### The review

Rules are pinned to the installed release: a removed API is an **error** on a release that removed it and a warning on
an older one; a rule whose replacement does not exist yet in your release stays quiet. The categories:

- **api** (28): removed or renamed APIs and their releases, symbols that do not exist in the installed version, TSL
  names imported from the wrong entry, `three/src` imports, deprecations read from three's own source.
- **correctness** (50): code that renders nothing or the wrong thing — no lights, shadows off, renderer never attached,
  `render(camera, scene)`, `scene.add(gltf)`, a mixer never updated, `getElapsedTime()` and `getDelta()` on one clock,
  instance and attribute updates without `needsUpdate`, raycasting with window instead of canvas coordinates, controls
  bound to `document`, decoders created but never attached or assigned instead of called, a KTX2 transcoder from a CDN of another three release; shaders: `#include` chunks that do not exist in the
  installed release, `onBeforeCompile` patches that do nothing, GLSL3 mistakes, redeclared built-ins, uniforms
  without `{ value }`, GLSL materials under WebGPU and node materials under WebGL; React Three Fiber: state set in
  `useFrame`, objects made in render.
- **performance** (10): allocations and heavy objects per frame, scene traversal per frame, uncapped pixel ratio, huge
  shadow maps, many meshes that should be instanced.
- **lifecycle** (4): no resize handling, removed objects never disposed, `dispose()` without `super.dispose()`, a
  page that renders on demand and never draws again after a lost WebGL context.
- **color** (8): colour textures without `colorSpace`, colour management off, EffectComposer without OutputPass or with
  double gamma, `envMapIntensity` that has no effect.

An upgrade changes the look on purpose, too. `three_migrate` lists those changes for the releases you cross, measured
on your code: colour management (r152), physical light units with starting values (r155), light decay 2 (r147), tone
mapping lost in post-processing without an OutputPass (r155), brighter rough PBR materials with their roughness (r181),
fill lights that reflect, with or without `scene.environment` (r188), and more. Take a `three_check` baseline before
and compare after: these differences are expected.

It reads text, not types (`three_types` adds the type checker for TypeScript). The rules are tested against three's
own examples and addons for false alarms. If a finding is wrong: `three_feedback`, `--disable <rule>`, or
`// threesmith-disable-next-line <rule>` (also `-disable-line`, `-disable-file`); an issue with the snippet is the most
useful bug report.

### GitHub Action

```yaml
- uses: laaielichter/Threesmith@main
  with:
    min-score: 85
    check: dist          # folder with the built index.html; omit to skip the browser
    baseline: home       # screenshot baseline in .threesmith/baselines/home.png
    comment: true        # post the receipt on the pull request
    compare: previous    # on a three bump: the page on both releases, each change with its migration note
    impact: origin/main  # what the change touches and the checks that prove it (checkout with fetch-depth: 0)
```

The receipt (review, check, scenarios) appears in the job summary and optionally as a PR comment. Locally or in any
CI: `threesmith ci --check dist --compare previous --impact origin/main --junit junit.xml --sarif threesmith.sarif`. Commit `.threesmith/baselines/` and
`.threesmith/scenarios/`; the rest of `.threesmith/` is local state and ignored by its own `.gitignore`.

## Limits

- **WebGL 2** in headless Chromium works in GitHub Actions (SwiftShader software rendering). **WebGPU** is best effort
  (`--webgpu`), depending on the runner having an adapter (on Linux: libvulkan and a Vulkan or SwiftShader driver).
  `check` names the backend the page actually drew with (`WebGPU`, `WebGL 2`, or `WebGL 2 (WebGPU fallback)` with a
  warning) and the adapter, so a pass on the WebGL 2 fallback is never taken for a WebGPU pass. `doctor --env` says
  whether this machine has a WebGPU adapter.
- Frame times come from software rendering: compare them before and after on the same machine. Draw calls, triangles,
  programs and resource counts are exact.
- Baselines should be made in the environment that checks them (CI), with the default tolerance.
- The API lookup parses the JSDoc in `three/src`; it is tested on r187, older releases give thinner answers.
- The review is heuristic; the asset check follows paths written as text, not paths built at run time.
- **Optional packages for `three_gltf`**, loaded only when used (the answer says what to install when one is missing):
  `gltf-validator` (Khronos glTF-Validator, Apache-2.0) for `validate`; `@gltf-transform/core`, `extensions` and
  `functions` (MIT) for `optimize`, with `draco3dgltf` (Google Draco, Apache-2.0) for Draco and `meshoptimizer` (MIT)
  for meshopt and simplification. Threesmith does not bundle them; their licences apply when you install them.
  `optimize` leaves textures as they are (KTX2 needs KTX-Software's `toktx`, WebP and resizing need `sharp`).

## Benchmarks

`bench/` has tasks and a deterministic grader for comparing an agent with and without Threesmith. No results are
published yet; see `bench/README.md` for the method.

## Sister tools

From the same author, local and open source: [ReversePort](https://github.com/laaielichter/Reverseport)
(reverse engineer and port games between engines), [Godotwright](https://github.com/laaielichter/Godotwright)
(check the Godot code your agent writes), [Stashpad](https://github.com/laaielichter/Stashpad)
(agent memory you can trust) and [agentdisk](https://github.com/laaielichter/Agentdisk) (clean up after agents).

## Support the project

If Threesmith is useful to you, a ⭐ on [GitHub](https://github.com/laaielichter/Threesmith) helps other people find it.

Thanks to everyone who has contributed: [@chiragjangiir](https://github.com/chiragjangiir), [@timmiballz22](https://github.com/timmiballz22) and [@IG-ABHINAV](https://github.com/IG-ABHINAV).

## Develop

```sh
npm ci
npm run check     # typecheck, tests (incl. headless Chromium), build
```

Try the Claude Code plugin from this checkout, before a release: `npm run build && npm run plugin:local`, then start
Claude Code with the `claude --plugin-dir ...` line it prints.

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Threesmith follows the design of its sister
project for Godot, [Godotwright](https://github.com/laaielichter/Godotwright). MIT licensed, made by laaielichter.
