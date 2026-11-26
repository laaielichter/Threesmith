import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

const renderer = new THREE.WebGLRenderer();
renderer.useLegacyLights = false;
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 4;
scene.add(new THREE.DirectionalLight(0xffffff, 2));

const uniforms = { uTime: { value: 0 } };
const material = new THREE.MeshStandardMaterial({ color: 0x3366ff, roughness: 0.7 });
material.onBeforeCompile = (shader) => {
  shader.uniforms.uTime = uniforms.uTime;
  shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
    '#include <begin_vertex>',
    '#include <begin_vertex>\n  transformed.y += sin(position.x * 4.0 + uTime) * 0.1;',
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    '#include <color_fragment>\n  diffuseColor.rgb *= 0.8 + 0.2 * sin(uTime);',
  );
};
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 32, 32), material);
scene.add(mesh);

const geo = mesh.geometry;
geo.attributes.position.updateRange.count = 10;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  uniforms.uTime.value = clock.getElapsedTime();
  composer.render();
});
