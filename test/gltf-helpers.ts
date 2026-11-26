import { Document, NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, KHRDracoMeshCompression, KHRTextureBasisu } from "@gltf-transform/extensions";
import { createDefaultContainer, write as writeKtx2 } from "ktx-parse";
// @ts-expect-error draco3dgltf ships no types
import draco3d from "draco3dgltf";
import { MeshoptEncoder } from "meshoptimizer";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { project, THREE_DIR } from "./helpers.js";

/** A 4x4 uncompressed RGBA8 KTX2 texture (no Basis): KTX2Loader reads it without the transcoder. */
export function rawKtx2(rgba: [number, number, number, number] = [200, 60, 40, 255]): Uint8Array {
  const c = createDefaultContainer();
  c.vkFormat = 37; // VK_FORMAT_R8G8B8A8_UNORM
  c.pixelWidth = 4;
  c.pixelHeight = 4;
  c.typeSize = 1;
  const data = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) data.set(rgba, i * 4);
  c.levels = [{ levelData: data, uncompressedByteLength: data.byteLength }];
  return writeKtx2(c);
}

/** A unit box (24 vertices, uv), as a glTF document. */
export function boxDocument(): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = pos.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      pos.push(n[0]! + a * u[0]! + b * v[0]!, n[1]! + a * u[1]! + b * v[1]!, n[2]! + a * u[2]! + b * v[2]!);
      uv.push((a + 1) / 2, (b + 1) / 2);
    }
    idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos.map((x) => x * 0.5))).setBuffer(buffer))
    .setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(new Float32Array(uv)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint16Array(idx)).setBuffer(buffer))
    .setMaterial(doc.createMaterial("box").setBaseColorFactor([1, 1, 1, 1]));
  const mesh = doc.createMesh("box").addPrimitive(prim);
  doc.createScene("scene").addChild(doc.createNode("box").setMesh(mesh));
  return doc;
}

/** A .glb of the box, compressed with Draco and/or meshopt and/or a KTX2 base colour texture. */
export async function boxGlb(opts: { draco?: boolean; meshopt?: boolean; ktx2?: boolean }): Promise<Uint8Array> {
  const doc = boxDocument();
  const io = new NodeIO();
  if (opts.ktx2) {
    doc.createExtension(KHRTextureBasisu).setRequired(true);
    const tex = doc.createTexture("color").setImage(rawKtx2()).setMimeType("image/ktx2");
    doc.getRoot().listMaterials()[0]!.setBaseColorTexture(tex);
  }
  if (opts.draco) {
    doc.createExtension(KHRDracoMeshCompression).setRequired(true).setEncoderOptions({ method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER });
    io.registerExtensions([KHRDracoMeshCompression]).registerDependencies({ "draco3d.encoder": await draco3d.createEncoderModule() });
  }
  if (opts.meshopt) {
    await MeshoptEncoder.ready;
    doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
    io.registerExtensions([EXTMeshoptCompression]).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  }
  if (opts.ktx2) io.registerExtensions([KHRTextureBasisu]);
  return io.writeBinary(doc);
}

const JSM = ["loaders/GLTFLoader.js", "loaders/DRACOLoader.js", "loaders/KTX2Loader.js", "utils/BufferGeometryUtils.js", "utils/SkeletonUtils.js", "utils/WorkerPool.js", "libs/ktx-parse.module.js", "libs/zstddec.module.js", "libs/meshopt_decoder.module.js", "math/ColorSpaces.js"];

export const MAIN = `import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const renderer = new THREE.WebGLRenderer();
renderer.setSize(320, 240);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x203040);
scene.add(new THREE.AmbientLight(0xffffff, 2));
const camera = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 100);
camera.position.set(2, 2, 3);
camera.lookAt(0, 0, 0);

const gltfLoader = new GLTFLoader();
for (const url of ['./models/box.glb', './models/packed.glb']) {
  const gltf = await gltfLoader.loadAsync(url);
  scene.add(gltf.scene);
}
// the test models' KTX2 texture is uncompressed, so load the Basis transcoder explicitly to prove it is served
if (gltfLoader.ktx2Loader) await gltfLoader.ktx2Loader.init();
renderer.setAnimationLoop(() => renderer.render(scene, camera));
`;

/** An import-map page (no bundler) that loads a Draco + KTX2 model and a meshopt model, with no decoders set up. */
export async function importMapProject(main = MAIN): Promise<string> {
  const dir = project({
    "package.json": `{"name":"decoder-fixture","private":true}`,
    "index.html": `<!doctype html><html><body style="margin:0"><script type="importmap">{"imports":{"three":"./three/three.module.js","three/addons/":"./three/jsm/"}}</script><script type="module" src="./main.js"></script></body></html>`,
    "main.js": main,
  });
  for (const f of ["three.module.js", "three.core.js"]) cpSync(join(THREE_DIR, "build", f), join(dir, "three", f), { recursive: true });
  for (const f of JSM) cpSync(join(THREE_DIR, "examples", "jsm", f), join(dir, "three", "jsm", f));
  mkdirSync(join(dir, "models"), { recursive: true });
  writeFileSync(join(dir, "models", "box.glb"), await boxGlb({ draco: true, ktx2: true }));
  writeFileSync(join(dir, "models", "packed.glb"), await boxGlb({ meshopt: true }));
  return dir;
}


/** A UV sphere with `segments` rings and sectors (about segments^2 * 2 triangles), plus an unused material and a duplicate one. */
export async function sphereGlb(segments = 64): Promise<Uint8Array> {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  for (let y = 0; y <= segments; y++) {
    const v = y / segments;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const px = -Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
      const py = Math.cos(v * Math.PI);
      const pz = Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
      pos.push(px, py, pz);
      nor.push(px, py, pz);
    }
  }
  const row = segments + 1;
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * row + x;
      if (y !== 0) idx.push(a, a + row, a + 1);
      if (y !== segments - 1) idx.push(a + 1, a + row, a + row + 1);
    }
  }
  const material = doc.createMaterial("red").setBaseColorFactor([0.8, 0.2, 0.1, 1]).setRoughnessFactor(0.6);
  doc.createMaterial("unused").setBaseColorFactor([0, 1, 0, 1]);
  const prim = doc
    .createPrimitive()
    .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(new Float32Array(pos)).setBuffer(buffer))
    .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(new Float32Array(nor)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(idx)).setBuffer(buffer))
    .setMaterial(material);
  doc.createScene("scene").addChild(doc.createNode("sphere").setMesh(doc.createMesh("sphere").addPrimitive(prim)));
  return new NodeIO().writeBinary(doc);
}

/** Rewrites the JSON chunk of a .glb (to make a broken file on purpose). */
export function patchGlbJson(glb: Uint8Array, change: (json: Record<string, unknown>) => void): Uint8Array {
  const buf = Buffer.from(glb);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8")) as Record<string, unknown>;
  change(json);
  let text = JSON.stringify(json);
  while (Buffer.byteLength(text) % 4) text += " ";
  const jsonBuf = Buffer.from(text);
  const rest = buf.subarray(20 + jsonLen);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + jsonBuf.length + rest.length, 8);
  head.writeUInt32LE(jsonBuf.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return new Uint8Array(Buffer.concat([head, jsonBuf, rest]));
}
