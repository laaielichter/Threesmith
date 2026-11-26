/**
 * The server instructions per profile, filtered by the tools that are enabled, so an agent is never told to call a
 * tool that is not there. A line is split into parts by "|": a part that names a tool that is not enabled is left out,
 * and a line whose first part is left out is dropped. A part that starts with "{three_a three_b}" is also left out
 * unless one of those tools is enabled. Lines that start with "#." are numbered steps.
 */
const CHEAP: string[] = [
  "Threesmith checks three.js code against the three version installed in this project, and runs the page headless.| Follow these steps:",
  "#. In a project you do not know yet, or when a scene is broken and you do not know where to start, call three_doctor: what is wrong, in which order to fix it.",
  "#. Call three_scan once to learn the stack, pages, three files, renderer settings and assets.",
  "#. Before you use a three.js class, method, property or import path you are not sure about, call three_api. Never guess: three removes APIs often and your memory holds old ones.",
  "#. Before you save new three.js code, pass it to three_review (code + file) and fix every error.",
  "#. After every edit, call three_review with only_new: true. Fix all errors before the next step.",
  "#. Before you finish, call three_impact: what your change touches, which pages and scenarios run it, and the checks that prove it.",
  "#. Before you finish, call three_check on the page (a folder with index.html or the dev server URL) and look at the screenshot.",
  "In a TypeScript project, call three_types after a change: the project's own tsc, with the three.js errors answered from the installed release.",
  "When the picture is black, empty or wrong, call three_inspect before you guess: it reads the live scene and says why objects are not visible.",
  "After you change the camera, lights, materials or layout, call three_look: the frame as text (what is in view, how much of the frame, cut by the edge, hidden behind what, too dark or blown out), with expect claims such as \"car visible >= 5%\" and \"car not cut\".",
  "When a scene takes long to load or a state is hard to reach, call three_session op start once and then three_page (eval, steps, until, screenshot, inspect) instead of a new three_check each time; stop it when done.",
  "To get a look right (light, colour, exposure, camera, placement), tune it live with three_tune op set on the three_session page| and check with three_look|, then three_tune op save (dry run, then write: true) writes the values into the code instead of guessing numbers in an edit-reload loop.",
  "When a model does not animate, slides, sinks into the floor or stands in a T-pose, call three_animation: op clips on the file, then on the three_session page op mixers (what runs and why not), op play, op pose and op sweep (the lowest point per step of a clip).",
  "When the console, the build or a test prints an error you do not understand, pass it to three_explain|; three_lessons with the message as error gives lessons from real projects|.",
  "For findings three_fix can do (renamed classes, import paths, color space renames, pixel ratio), call three_fix (dry run, then write: true) instead of editing them by hand.",
  "When the code was written for an older three release, or the user wants to move to a newer one, call three_migrate first: the changes per release that apply to this code, the TO DO list and what will look different; write: true makes the exact rewrites (undoable). With webgpu: true it also lists what stops WebGPURenderer and writes a TSL draft per ShaderMaterial and onBeforeCompile.",
  "Before you write or change TSL (node materials, three/tsl, WebGPURenderer), call three_tsl: the Fn, uniforms and node slots in the files with the TSL mistakes (JavaScript operators or if on nodes: use .mul() and If()); op graph and op shader show the node graph and the generated code in the page.",
  "If a three_fix write made things worse, call three_undo.",
  "If you verified that a review finding is a false alarm, pass it to three_feedback with verdict wrong.",
  "When the session start says a dream is due, or the user asks what was learned, call three_dream, show the proposals and apply only the numbers the user approves.",
  "When a model is Draco, KTX2 or meshopt compressed (or a decoder 404s), call three_decoders: write: true copies the installed three's decoder files and sets them up on the GLTFLoader.",
  "When a model from elsewhere misbehaves, call three_gltf op validate; to make a model smaller, three_gltf op optimize| (then three_decoders for the decoder it adds).",
  "Before you load a model or texture, call three_assets (or read the assets part of three_scan): a wrong path is a 404 that GLTFLoader reports as a parse error.",
  "When you fixed something that took more than one try, keep the lesson with three_lesson_add (general words, no names or code).",
  "To prove an interaction works, call three_play with steps, watch and expect|; when it passes, keep it with three_scenario op save|.",
  "To check motion (an animation, a camera move, a transition), call three_capture: frames 1/fps apart on a virtual clock, a contact sheet, a scene that does not move or a frame that pops, and a video.",
  "Measure with three_perf before and after a performance change (draw calls and triangles are exact; frame times are relative).",
  "Before a three.js upgrade (or to review a bump PR), call three_compare with: next (or the target release): the same page on both releases, each change in the picture, scene, renderer.info and console annotated with the migration note that explains it; an unexplained change is a probable regression.",
  "Before you ship to phones, call three_device with profile phone and lose_context: true: pixel ratio, texture limits and memory, frame times with the CPU slowed down, and the scene back after a lost WebGL context.",
  "When memory grows while the user switches levels or opens and closes things, call three_leaks with the steps of one cycle.",
  "Before you call a build done, call three_build: it builds, checks the output (two copies of three, missing assets, base path) and opens it headless.",
  "{three_model_brief three_model_identify three_model_library three_model_build three_model_view three_model_lint three_model_inspect three_model_code}To make or check a 3D model (.glb):| three_model_brief first (one page with everything).| three_model_identify says what the thing is: parts, size, pivots.| three_model_library has 1000 ready-made base models: build one by id or start from its spec.| three_model_spec shows the spec format.| three_model_build builds it.| three_model_view shows it as text (you cannot see pictures).| three_model_lint checks it.| three_model_inspect says what is in any .glb, and which loaders and decoders three.js needs for it.| three_model_code writes the code that loads it (a module or an R3F component) with its parts, materials and animations.",
  "Keep each change small. Pin import paths to the installed release: 'three/addons/...' for addons.",
];

const PREMIUM: string[] = [
  "Threesmith gives you exact three.js knowledge for the release installed in this project, and runs the page in headless Chromium (software WebGL 2).",
  "- three_doctor answers \"what is wrong here, and in which order do I fix it\": versions, the scene showing nothing, assets that will not load, removed APIs, colour, performance and cleanup, grouped by cause, most urgent first,| with what three_fix can do,| then numbered next steps. Start here in a project you do not know or when something is broken.",
  "- three_scan maps the project: bundler and framework, versions of three, @types/three and the libraries around it, pages and import maps, every file that uses three with what it makes (renderer, cameras, lights, controls, loaders, the loop), renderer settings and assets.",
  "- three_api and three_search answer from node_modules/three (JSDoc and exports), offline: constructors, members, deprecations and the import path. Use them instead of memory.",
  "- three_review is a scored static review (0-100) pinned to the installed release: removed and renamed APIs, symbols that do not exist, code that renders nothing, per-frame allocations, resize and dispose, colour management. `code` + `file` reviews unsaved code; `only_new: true` shows only what changed since the last review; `files` focuses the list.",
  "- three_types runs the project's own tsc --noEmit and answers each three.js type error from the installed release (the member that exists, the real import path, @types/three on another release).",
  "- three_impact is the whole change before it is run: changed files (git or a list), what each touches (the whole picture, lights, camera, materials, shaders, assets, loop, disposal, input, the three version), the files and pages that run it through the import graph, the scenarios and baselines that cover it, and the checks that prove it; run: true reviews the changed files and runs those scenarios.",
  "- three_fix applies the renames that mean exactly the same (dry run first, then write: true, undoable with three_undo).",
  "- three_migrate plans an upgrade between two three releases (r120 to r188, from the migration guide): the changes per release that apply to this code with file:line, a TO DO list with the replacement checked against the installed API, and what will look different; write: true makes the exact rewrites as one undoable step; webgpu: true adds the WebGPU readiness (blockers, steps, a score) and a TSL draft module per ShaderMaterial / onBeforeCompile. `from` is read from CDN URLs, package files or git history.",
  "- three_tsl works on TSL: op outline maps Fn (with layout or inline), uniforms, node slots and compute kernels with the review's TSL findings; op graph reads the node graph each material really has in the page as a tree; op shader shows the WGSL or GLSL WebGPURenderer generated for an object (find jumps to a name).",
  "- three_rules lists every review rule with its fix; three_feedback marks a finding as a false alarm (hidden on this machine from then on).",
  "- three_explain gives the likely cause and fix of a console, build or test message, with the right import path for the installed release.",
  "- three_lessons answers from lessons learned in real three.js projects (symptom, cause, fix, how to test): by words, by an error message, by a rule. three_lesson_add keeps one you learned here, scrubbed of names, paths and code.",
  "- three_decoders wires Draco, KTX2 and meshopt for the models in the project with the decoder files of the installed three: which model needs which, whether the served files hash-match the installed three, a CDN transcoder of another release; write: true copies the files and adds the loader setup as one undoable step.",
  "- three_gltf validates a .glb/.gltf with the Khronos glTF-Validator (errors with their JSON pointer) or optimises it with gltf-transform (dedup, prune, weld, Draco or meshopt, simplify), with the measured size before and after; write: true saves the output. Both packages are optional.",
  "- three_assets resolves every asset path in the code like the dev server and a static host do: missing files, paths that only work on a case-insensitive disk, Draco/KTX2 decoder folders, glTF files that need a decoder the code never sets up, huge textures, unused files.",
  "- three_check opens the page headless: console and page errors with explanations, failed requests, no canvas or context, lost context, blank frames, a screenshot, and screenshot baselines with a diff. `steps` interact first.",
  "- three_inspect reads the live scene graph (three's devtools hook): camera, draw calls, triangles, GPU memory growth, and why objects are not visible.",
  "- three_look measures the frame with the scene's own renderer, by rendering with and without each object: luma, near-black and near-white share, background share, and per object the share of the frame it shows, its place, whether the edge cuts it and what hides it; verdicts and expect claims on the same numbers.",
  "- three_session keeps a headless page open between calls|; three_page looks at it and drives it without reloading: eval JS against the live scene (scene, camera, renderer, $('name') in scope, compact JSON back), interactions, frames, until a condition holds, screenshots, inspect, reload after edits, with the new console errors after every answer|.",
  "- three_tune changes values in the live page (a light's intensity, a material option, the camera's fov, a position, the exposure) with no reload, and op save writes them where the code sets them (assignment, set() call, constructor argument, material option; a new line when the code never sets it), dry run first, undoable.",
  "- three_animation lists the clips of a .glb, and in the live page every mixer with its actions and what is wrong (no clip played, update never called, weight or speed 0, tracks that drive no node, bind pose); it plays a clip, poses the model at a time, and sweeps a clip for the lowest point and node positions per step.",
  "- three_play runs steps (click, press, hold, drag, wheel, frames, eval, until) and returns the values you watch after each step, with expect claims judged; three_scenario keeps a passing run as a regression test that ci runs.",
  "- three_capture records frames exactly 1/fps apart on the deterministic clock: a contact sheet, the change per frame (still scenes, pops) and an .mp4 with ffmpeg.",
  "- three_perf measures frames, draw calls, triangles, programs and textures against a budget and against the last run; three_leaks repeats a cycle of steps and reports what grows per cycle.",
  "- three_compare runs the page on two three releases (installed and with: r186, next, a folder) with the deterministic clock and compares by meaning: console errors and warnings, objects lost or resized, renderer.info, pixels and luminance per object, each change annotated with the migration entry that explains it, unexplained ones flagged as probable regressions.",
  "- three_device runs the page as on a phone, tablet or low-end laptop (pixel ratio, touch, CPU slow-down, WebGL limits clamped): textures over the limit or resized, texture memory, an uncapped pixel ratio, a missing viewport meta, frame times.",
  "- three_build runs the project's build, checks the output (two copies of three, missing assets, absolute paths that break under a sub-path, case) and opens the built page headless.",
  "{three_model_brief three_model_identify three_model_library three_model_spec three_model_build three_model_view three_model_lint three_model_inspect three_model_code}- 3D models without Blender:| three_model_brief is one page before you build;| three_model_identify says what a thing is (parts, pivots, size);| three_model_library searches 1000 ready-made base models (furniture, street, storage, nature, buildings, vehicles, props) in English or Dutch: build one by id or copy its spec;| three_model_spec explains the JSON spec;| three_model_build makes a clean .glb from a kind or a spec;| three_model_view draws a .glb as text views for agents that cannot see pictures;| three_model_lint scores a .glb (and checks it against what it should be);| three_model_inspect lists what is in a .glb and which three.js loaders and decoders it needs;| three_model_code writes the module or React Three Fiber component that loads it, with its named parts, materials and animation actions.",
  "- three_dream looks back at what agents ran into on this machine (API names that were not there, messages nothing explained, misleading or duplicate lessons, noisy rules, undone writes) and proposes project hints and lesson changes with their evidence; apply only what the user approves.",
  "- three_undo undoes the last Threesmith writes, newest first; a file changed by hand since is left alone.",
  "Work in reviewed steps: look up the API, write, review (only_new), fix, then check the page before you finish.| When a fix was hard, keep the lesson (three_lesson_add).",
];

const TOOL = /\bthree_[a-z_]+/g;
const ANY = /^\{([^}]*)\}/;

function keep(part: string, enabled: ReadonlySet<string>): boolean {
  const tag = ANY.exec(part);
  if (tag && !tag[1]!.split(/\s+/).some((t) => enabled.has(t))) return false;
  return [...part.replace(ANY, "").matchAll(TOOL)].every((m) => enabled.has(m[0]));
}

export type Tier = "cheap" | "premium";

export function renderInstructions(tier: Tier, enabled: ReadonlySet<string>, readOnly = false): string {
  const out: string[] = [];
  let step = 0;
  for (const line of tier === "cheap" ? CHEAP : PREMIUM) {
    const parts = line.split("|");
    const kept = parts.map((p) => keep(p, enabled));
    if (!kept[0]) continue;
    let text = parts
      .filter((_, i) => kept[i])
      .map((p) => p.replace(ANY, ""))
      .join("");
    if (text.startsWith("#. ")) text = `${++step}. ${text.slice(3)}`;
    out.push(text);
    if (out.length === 1 && readOnly) out.push("This session is read-only: tools that change project files only show their dry run, and write options are refused.");
  }
  if (step === 0 && out[0]) out[0] = out[0].replace(" Follow these steps:", "");
  return out.join("\n");
}
