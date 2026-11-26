---
name: assets
description: Load models and textures in a three.js project without 404s or decoder errors. Use when adding a .glb/.gltf, when a model is Draco, KTX2 (Basis) or meshopt compressed, when GLTFLoader says "No DRACOLoader instance provided", "setKTX2Loader must be called", "setMeshoptDecoder must be called", "expected magic word 00 61 73 6d" or "Unexpected token '<'", or after a three upgrade broke KTX2 textures.
argument-hint: "[folder or model, optional]"
---

# Models, textures and their decoders

Work on $ARGUMENTS (or the project).

1. `three_assets`: every path in the code resolved like the dev server and a static host (public/ served at /, the
   page's folder). Fix missing files and wrong capitals first: a 404 reaches GLTFLoader as an HTML page.
2. `three_model_inspect` on a new model: which extensions it uses and which loaders and decoders three.js needs.
3. `three_decoders` (dry run): per decoder, which models need it, how the code points the loader at its files (three's
   own folder, a local folder, a CDN) and whether the served files hash-match the installed three. A KTX2 transcoder
   from another three release is an error: KTX2Loader's worker must match `basis_transcoder.js`.
4. `three_decoders` with `write: true`: it copies the decoder files from `node_modules/three/examples/jsm/libs` into
   the served folder and adds the setup after `new GLTFLoader()` (or `useGLTF.setDecoderPath` with drei), as one
   step that `three_undo` takes back. Do the "By hand" items it lists (a GLTFLoader that is not in a variable, KTX2
   under drei, a renderer in another file).
5. `three_check` on the page: no request failures and no decoder errors; `three_inspect` shows the meshes.
6. After every three upgrade, run `three_decoders` again: the copied files must be the new release's.
