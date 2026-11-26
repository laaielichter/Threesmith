import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { BufferGeometryUtils } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const renderer = new THREE.WebGLRenderer();
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputEncoding = THREE.sRGBEncoding;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.z = 5;

const geometry = new THREE.Geometry();
geometry.vertices.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0));
geometry.faces.push(new THREE.Face3(0, 1, 2));
geometry.computeFaceNormals();

const box = new THREE.BoxBufferGeometry(1, 1, 1);
const merged = BufferGeometryUtils.mergeBufferGeometries([box, new THREE.SphereBufferGeometry(0.5)]);
const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: 0x44aa88, skinning: true }));
scene.add(mesh);

const light = new THREE.PointLight(0xffffff, 1);
light.position.set(2, 2, 2);
scene.add(light, new THREE.AmbientLight(0x404040));

const controls = new OrbitControls(camera, renderer.domElement);
const inverse = new THREE.Matrix4().getInverse(mesh.matrixWorld);

function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();
