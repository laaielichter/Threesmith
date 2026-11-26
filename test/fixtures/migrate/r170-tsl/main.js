import * as THREE from 'three/webgpu';
import { color, uniform, positionLocal, sin, PI2, texture, uv } from 'three/tsl';

const renderer = new THREE.WebGPURenderer({ colorBufferType: THREE.HalfFloatType });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
await renderer.init();
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
const time = uniform(0);
const wave = sin(positionLocal.x.mul(PI2).add(time)).varying();
const map = new THREE.TextureLoader().load('grid.png');

const material = new THREE.MeshStandardNodeMaterial();
material.colorNode = texture(map).uv(uv().mul(2)).mul(color(0x88ccff)).mul(wave);
scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));

const post = new THREE.PostProcessing(renderer);
post.outputNode = color(1, 0, 0).label('red');

renderer.setAnimationLoop(() => {
  time.value += 0.01;
  renderer.renderAsync(scene, camera);
});
