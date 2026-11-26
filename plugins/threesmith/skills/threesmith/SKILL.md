---
name: threesmith
description: Use when writing, changing, debugging or shipping three.js or react-three-fiber code. Looks up the exact API of the installed three version, reviews code against it, checks the assets and decoders the code loads, opens the page in headless Chromium and reads the live scene, proves behaviour with steps and claims, measures draw calls and leaks, and builds 3D models without Blender. Prevents the classic mistakes: removed APIs, wrong import paths, black scenes, 404 models, shaders that no longer compile, per-frame allocations.
---

# Threesmith for three.js

three.js changes every month and your memory holds old versions of it. Check every API against the installed release,
and look at the page before you say it works.

## Workflow

1. **New project or broken scene:** `three_doctor` first (what is wrong, in which order), `three_scan` for the map
   (stack, pages, files that use three, renderer settings, assets).
2. **Before writing code that uses an API you are not sure of:** `three_api` (it reads `node_modules/three`), or
   `three_search` to find a name. "Not exported" means it does not exist in this release: do not invent it.
3. **Before saving new code:** `three_review` with `code` + `file`. **After every edit:** `three_review` with
   `only_new: true`, and in TypeScript `three_types`. Fix errors first; `three_fix` does the pure renames (dry run,
   then `write: true`; `three_undo` if needed). A verified false alarm goes to `three_feedback`.
4. **Loading models or textures:** `three_assets`: every path must resolve with exact capitals, and Draco, meshopt or
   KTX2 files need their decoder set up on the GLTFLoader: `three_decoders` (then `write: true`) wires them with the
   installed three's decoder files. `three_model_inspect` says what a `.glb` needs; `three_gltf` validates and
   optimizes it.
5. **Before saying it works:** `three_impact` names what your change touches and the checks that prove it. Then
   `three_check` on the page (a folder with `index.html` or the dev server URL) and look at the screenshot, or
   `three_look` for the frame as text (what is in view, how much, cut, hidden, too dark). Black, empty or wrong:
   `three_inspect` says why per object. To get a look right, `three_tune` the values in a live page and save them
   into the code. Motion: `three_capture` (frames, contact sheet, pops); animation: `three_animation`. On the real
   GPU: `three_session` with `cdp` attaches to the user's own Chrome.
6. **Proving behaviour:** `three_play` with `steps`, `watch` and `expect`; keep a passing run with `three_scenario`
   op save. For a state that is slow to reach, `three_session` once and `three_page` to drive it.
7. **Errors you do not understand:** `three_explain` with the message as printed, `three_lessons` with it as `error`.
   When a fix took more than one try, `three_lesson_add`.
8. **Speed and memory:** `three_perf` before and after a change; `three_leaks` with the steps of one cycle;
   `three_device` with `profile: phone` for phones and low-end laptops.
9. **Before deploying:** `three_build`. **Old code or a three upgrade:** `three_migrate` gives the plan per release
   (`write: true` makes the exact rewrites); `three_compare` with `with: next` (or the target release) runs the page
   on both releases, every change with the migration note that explains it.
10. **TSL and node materials:** `three_tsl` before you edit (Fn, uniforms, node slots, the JavaScript-operator and
   `if` mistakes); op graph and op shader in the page when a node material looks wrong.
11. **Past sessions:** when the session start says a dream is due, `three_dream`, and apply what the user approves.
12. **Loading a model in code:** `three_model_code` writes the module or R3F component for a `.glb`.
13. **3D models:** `three_model_brief`, `three_model_library` (1000 base models), `three_model_build`, `three_model_view` (text views), `three_model_lint`.

## Rules of thumb

- Import addons from `three/addons/...` (with `.js`). `OrbitControls`, `GLTFLoader` and friends are not in `three`.
- `WebGPURenderer` and node materials come from `three/webgpu`, TSL from `three/tsl`; `ShaderMaterial` and
  `onBeforeCompile` do not work under WebGPU.
- Colour textures need `texture.colorSpace = THREE.SRGBColorSpace`; with EffectComposer, end with an `OutputPass`.
- Shadows need `renderer.shadowMap.enabled = true`, a light with `castShadow`, casters and receivers.
- Add `gltf.scene`, not `gltf`. Await the loader before using the model.
- Never `new` a Vector3, geometry or material inside the loop; `dispose()` what you remove.
- After changing `camera.aspect`, call `camera.updateProjectionMatrix()`.
