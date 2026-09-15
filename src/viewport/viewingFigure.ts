import * as THREE from 'three';
import type { CompiledScene, Vec3 } from '../core/types';
import { surfaceUvToWorld } from '../core/geometry/surfaces';

/** An architectural scale figure, not measured anatomy or printable geometry. */
export interface ViewingFigure {
  readonly root: THREE.Group;
  readonly head: THREE.Group;
  readonly eyeAnchor: THREE.Object3D;
  readonly hoverMaterials: readonly THREE.MeshStandardMaterial[];
}

const UP = new THREE.Vector3(0, 1, 0);

export function buildViewingFigure(eyeMm: Vec3, aimHeightMm: number): ViewingFigure {
  const root = new THREE.Group();
  root.name = 'viewing-person';
  root.userData.presentationOnly = true;
  const coat = new THREE.MeshStandardMaterial({ color: '#28545a', roughness: 0.92 });
  const trousers = new THREE.MeshStandardMaterial({ color: '#18383d', roughness: 0.96 });
  const porcelain = new THREE.MeshStandardMaterial({ color: '#ece6da', roughness: 0.9 });
  const eyeInk = new THREE.MeshBasicMaterial({ color: '#bb432c' });

  const add = (
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    position: Vec3,
    parent: THREE.Group = root,
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    // The person never alters the room's shadow map or any picking surface.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.raycast = () => {};
    parent.add(mesh);
    return mesh;
  };
  const ellipsoid = (name: string, position: Vec3, scale: Vec3, material: THREE.Material, parent = root) => {
    const mesh = add(name, new THREE.SphereGeometry(1, 16, 12), material, position, parent);
    mesh.scale.set(...scale);
    return mesh;
  };
  const limb = (name: string, from: Vec3, to: Vec3, radius: number, material: THREE.Material) => {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const direction = end.clone().sub(start);
    const mesh = add(name,
      new THREE.CapsuleGeometry(radius, Math.max(0, direction.length() - radius * 2), 4, 10),
      material, start.clone().add(end).multiplyScalar(0.5).toArray() as [number, number, number]);
    mesh.quaternion.setFromUnitVectors(UP, direction.normalize());
  };

  const torsoProfile = [
    [0, 0.53], [0.075, 0.54], [0.084, 0.58], [0.075, 0.69],
    [0.101, 0.83], [0.098, 0.86], [0.063, 0.88], [0, 0.89],
  ].map(([r, y]) => new THREE.Vector2(r!, y!));
  const torso = add('torso', new THREE.LatheGeometry(torsoProfile, 20), coat, [0, 0, -0.045]);
  torso.scale.z = 0.62;
  ellipsoid('hips', [0, 0.535, -0.045], [0.085, 0.063, 0.054], trousers);
  limb('neck', [0, 0.87, -0.045], [0, 0.935, -0.045], 0.028, porcelain);

  for (const side of [-1, 1]) {
    const suffix = side < 0 ? 'left' : 'right';
    limb(`${suffix}-upper-arm`, [side * 0.109, 0.85, -0.045], [side * 0.135, 0.675, -0.06], 0.029, coat);
    limb(`${suffix}-forearm`, [side * 0.135, 0.675, -0.06], [side * 0.123, 0.515, -0.015], 0.023, coat);
    ellipsoid(`${suffix}-hand`, [side * 0.123, 0.492, -0.009], [0.023, 0.036, 0.024], porcelain);
    limb(`${suffix}-thigh`, [side * 0.046, 0.54, -0.046], [side * 0.06, 0.286, -0.035], 0.041, trousers);
    limb(`${suffix}-shin`, [side * 0.06, 0.286, -0.035], [side * 0.065, 0.059, -0.029], 0.029, trousers);
    ellipsoid(`${suffix}-foot`, [side * 0.065, 0.022, 0.001], [0.037, 0.022, 0.069], trousers);
  }

  const head = new THREE.Group();
  head.name = 'head-at-eye-level';
  head.position.y = 1;
  root.add(head);
  ellipsoid('head', [0, -0.006, -0.047], [0.056, 0.073, 0.055], porcelain, head);
  // A restrained accent at the eyes replaces the old floating dot and label.
  for (const side of [-1, 1]) {
    ellipsoid(`eye-${side}`, [side * 0.018, 0, 0.006], [0.007, 0.004, 0.003], eyeInk, head);
  }

  const eyeAnchor = new THREE.Object3D();
  eyeAnchor.name = 'exact-viewing-position';
  eyeAnchor.position.y = 1;
  root.add(eyeAnchor);
  for (const [radius, opacity] of [[0.16, 0.055], [0.11, 0.075]]) {
    const shadow = add('contact-shadow', new THREE.CircleGeometry(radius!, 32),
      new THREE.MeshBasicMaterial({ color: '#18383d', transparent: true, opacity: opacity!, depthWrite: false }), [0, 0.0007, -0.026]);
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.y = 0.65;
  }

  const figure: ViewingFigure = { root, head, eyeAnchor, hoverMaterials: [coat, trousers] };
  positionViewingFigure(figure, eyeMm, aimHeightMm);
  return figure;
}

/** The foot plane stays at y=0 and the eye anchor stays exactly at eyeMm. */
export function positionViewingFigure(figure: ViewingFigure, eyeMm: Vec3, aimHeightMm: number): void {
  const height = Math.max(1, eyeMm[1]);
  figure.root.position.set(eyeMm[0], 0, eyeMm[2]);
  figure.root.scale.setScalar(height);
  figure.root.rotation.y = Math.atan2(-eyeMm[0], -eyeMm[2]);
  figure.head.rotation.x = Math.atan2(eyeMm[1] - aimHeightMm, Math.hypot(eyeMm[0], eyeMm[2]));
  figure.root.updateMatrixWorld(true);
}

export function viewingFigureVisible(figure: ViewingFigure, cameraPosition: THREE.Vector3): boolean {
  const eye = figure.eyeAnchor.getWorldPosition(new THREE.Vector3());
  return cameraPosition.distanceTo(eye) > Math.max(40, figure.root.scale.y * 0.2);
}

/** Frame the person and measured walls in Orbit only; never change the design eye. */
export function frameViewingFigureInOrbit(
  camera: THREE.PerspectiveCamera,
  scene: CompiledScene,
  figure: ViewingFigure,
): THREE.Vector3 {
  const points = scene.surfaces.flatMap(({ surface }) => surface.polygonMm.map((uv) => new THREE.Vector3(...surfaceUvToWorld(surface, uv))));
  const figureBounds = new THREE.Box3().setFromObject(figure.root);
  for (const x of [figureBounds.min.x, figureBounds.max.x]) {
    for (const y of [figureBounds.min.y, figureBounds.max.y]) {
      for (const z of [figureBounds.min.z, figureBounds.max.z]) points.push(new THREE.Vector3(x, y, z));
    }
  }
  const bounds = new THREE.Box3().setFromPoints(points);
  const target = bounds.getCenter(new THREE.Vector3());
  const direction = new THREE.Vector3(...scene.camera.eyeMm).sub(new THREE.Vector3(...scene.camera.targetMm));
  direction.applyAxisAngle(UP, Math.PI / 5);
  direction.y += Math.max(150, scene.sceneExtentMm * 0.15);
  direction.normalize();
  const right = new THREE.Vector3().crossVectors(UP, direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const tanH = tanV * Math.max(0.01, camera.aspect);
  let distance = 1;
  for (const point of points) {
    const delta = point.clone().sub(target);
    distance = Math.max(distance, delta.dot(direction) + Math.max(Math.abs(delta.dot(right)) / tanH, Math.abs(delta.dot(up)) / tanV));
  }
  camera.position.copy(target).addScaledVector(direction, distance * 1.18 + 40);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return target;
}
