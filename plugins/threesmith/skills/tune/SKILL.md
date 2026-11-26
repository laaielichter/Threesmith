---
name: tune
description: Get the look of a three.js scene right by tuning it live (light intensity and colour, exposure, camera fov and position, material roughness, metalness and colour, object placement) in a running page, checking the frame as numbers, and writing the final values into the code where they are set. Use when asked to make a scene brighter, darker, warmer, better lit, better framed, or to "tweak until it looks good". Also in Dutch: "mooier belichten", "te donker", "camera beter", "kleur aanpassen".
argument-hint: "[what should look different, optional]"
---

# Tune the look live, keep it in the code

Guessing numbers in an edit-reload loop is slow and every reload loses the state. Tune in a live page instead, and
write the values into the code once they are right.

1. **Start the page once:** `three_session` op start with the page folder or the dev server URL. To tune on the
   real GPU (the user's own Chrome, started with `--remote-debugging-port=9222` and its own `--user-data-dir`), pass
   `cdp: "http://127.0.0.1:9222"` and `match` with part of the tab's URL; `project` names the folder to save into.
2. **Measure first:** `three_look` (or `three_page` op look): how dark the frame is, what is in view, how much of the
   frame each object shows, what is cut or hidden. Say in one sentence what should change ($ARGUMENTS or the user's
   words) in those numbers ("the frame is near black: mean luma 12/255").
3. **Tune:** `three_tune` op set, one value at a time: `{"object": "sun", "prop": "intensity", "value": 3}`,
   `{"object": "renderer", "prop": "toneMappingExposure", "value": 1.3}`, `{"object": "camera", "prop": "fov",
   "value": 45}`, `{"object": "car", "prop": "material.roughness", "value": 0.4}`, `{"object": "car", "prop":
   "position", "value": [0, 0.5, 0]}`. After each change, `three_page` op look with `expect` claims for what the user
   wants ("frame not dark", "car centered", "car visible >= 10%").
4. **Show the user** the list (`three_tune` op list) with the look before and after. `op reset` puts everything back.
5. **Save:** `three_tune` op save (dry run): each value goes where the code sets it (an assignment, a `set()` call, a
   constructor argument, a material option; a new line when the code never sets it). Read the changes, then
   `write: true` (one step that `three_undo` takes back).
6. **Prove it:** `three_page` op reload, `three_look` with the same claims, and `three_review` with `only_new: true`.

Objects are found by `.name`; give the objects you tune a name in the code first if they have none. Values that come
from a loaded model are set after the model loads: save says so instead of guessing a place.
