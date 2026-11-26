import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 3;

const vertexShader = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec3 p = position;
    p.z += sin(p.x * 4.0 + uTime) * 0.1;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const material = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(0x3388ff) },
    uMap: { value: new THREE.TextureLoader().load('grid.png') },
  },
  vertexShader,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uColor;
    uniform sampler2D uMap;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(uMap, vUv);
      float pulse = 0.5 + 0.5 * sin(uTime * 2.0);
      gl_FragColor = vec4(mix(uColor, tex.rgb, 0.5) * pulse, 1.0);
    }
  `,
  side: THREE.DoubleSide,
});
scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2, 32, 32), material));

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.4, 0.85));
composer.addPass(new OutputPass());

renderer.setAnimationLoop((t) => {
  material.uniforms.uTime.value = t / 1000;
  composer.render();
});
