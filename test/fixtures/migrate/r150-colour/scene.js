import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.physicallyCorrectLights = true;
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 1, 4);

const texture = new THREE.TextureLoader().load('wood.jpg');
texture.encoding = THREE.sRGBEncoding;
const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ map: texture, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5), new THREE.MeshStandardMaterial({ color: 0xff8844, roughness: 0.8, metalness: 0.1 }));
scene.add(ball);

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1));
const lamp = new THREE.PointLight(0xffffff, 2);
lamp.position.set(1, 3, 1);
scene.add(lamp);

new RGBELoader().load('studio.hdr', (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = hdr;
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  ball.position.y = Math.sin(clock.getElapsedTime());
  renderer.render(scene, camera);
});
