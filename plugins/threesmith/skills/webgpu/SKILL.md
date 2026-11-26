---
name: webgpu
description: Move a three.js project from WebGLRenderer to WebGPURenderer and TSL. Use when asked to switch to WebGPU, port a ShaderMaterial, RawShaderMaterial or onBeforeCompile to TSL or node materials, replace EffectComposer with RenderPipeline, or when a WebGPU page silently runs on WebGL 2. Threesmith lists the blockers, writes a TSL draft per custom shader and checks the result headless.
argument-hint: "[folder or file, optional]"
---

# Move to WebGPURenderer and TSL

Work on $ARGUMENTS (or the project).

1. `three_migrate` with `webgpu: true`: the readiness score, the blockers (GLSL materials, `onBeforeCompile`,
   `EffectComposer`, `ShaderChunk`, code on the raw WebGL context, `WebGLCubeRenderTarget`), the steps (renderer and
   imports) and a TSL draft per custom shader. Show the blockers first.
2. Take a `three_check` baseline of the page on WebGLRenderer before you change anything.
3. Switch the renderer: `new WebGPURenderer()` from `three/webgpu`, `await renderer.init()` before the first
   `render()` (setAnimationLoop does it), and every import from `three/webgpu` and `three/tsl` (one copy of the core).
4. Port each shader from its draft: the draft is a module with `createMaterial( values )` that returns the node
   material and its uniforms. Read every `TODO` (control flow, custom functions, values that were not literal) and
   finish those parts by hand, with `three_api` for every node name you are not sure of. In TSL, maths and branches
   are node methods: `a.mul(b)`, not `a * b`; `If(cond, ...)` and `select(cond, a, b)`, not `if` or `?:`; `assign()`
   only inside a `Fn()`. `three_tsl` (outline) lists what is still written the JavaScript way.
5. Replace `EffectComposer` with `RenderPipeline` (`PostProcessing` before r183) and the TSL passes the readiness
   list names (`pass( scene, camera )`, `bloom()`, ...). No OutputPass: the pipeline does tone mapping and colour space.
6. `three_review` with `only_new: true` after each file: `webgpu-glsl-material` must be gone. When a node material
   looks wrong, `three_tsl` op graph shows the node graph it really has, and op shader the code three generated.
7. `three_check` with `webgpu: true` and the baseline: the `backend` line must say WebGPU (on a machine with an
   adapter; `threesmith doctor --env` says whether this one has one), and also check it on the WebGL 2 fallback.
8. WebGPURenderer and TSL still change from release to release: before a three bump, `three_compare` with
   `with: next` (and `webgpu: true`) runs the page on both releases and names the migration note behind each change.
9. End with the score before and after, the drafts used, what is still TODO, and the screenshot diff.
