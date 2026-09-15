import * as THREE from 'three';
import type { CompiledScene, Surface, Vec2, Vec3 } from '../core/types';

/**
 * Viewport-only architectural presentation (AMENDMENTS.md §A). Everything in
 * this module is decorative: it derives a plaster wall/floor shell from the
 * compiled surfaces but never feeds back into geometry, fingerprints, ray
 * intersection, print planning or exports. Dimensions here are presentation
 * defaults, not measured room values.
 *
 * Everything is procedural — DataTextures and BufferGeometry only, no DOM —
 * so the whole module stays deterministic and unit-testable without WebGL.
 */

/** Render-only wall slab thickness behind the authoritative front face. */
export const WALL_DEPTH_MM = 80;
/** Render-only floor slab thickness below y = 0. */
export const FLOOR_DEPTH_MM = 40;
/**
 * Decorative front faces sit this far behind the authoritative front plane
 * so the substrate mesh — which keeps its exact compiled position — can
 * never z-fight the wall it is mounted on.
 */
export const FRONT_GAP_MM = 0.3;
/** Contact-shadow decals sit between the wall front and the substrate. */
const DECAL_GAP_MM = 0.2;
/**
 * Plaster reveal beyond the panel's outer edge and top. Zero: the panels
 * ARE the measured walls, so the slab ends at the measured edges — the
 * rendered wall must equal the calculated wall exactly, and the resize
 * fins mounted on those edges track the true measured extent.
 */
export const WALL_MARGIN_MM = 0;
/**
 * Each wall is extended this far past the corner seam; the tab embeds in
 * the adjoining wall's slab, which keeps the corner joint solid and stays
 * outside the room interior for every supported interior angle.
 */
export const SEAM_EMBED_MM = WALL_DEPTH_MM;
/** Plan-view margin the contextual floor extends beyond the wall slabs. */
export const FLOOR_MARGIN_MM = 750;
/** World size covered by one plaster-texture tile. */
const PLASTER_TILE_MM = 2_400;
/** Width of the ambient-occlusion strip at the seam and wall bases. */
const AO_STRIP_MM = 110;
/** Reach of the soft mount shadow behind the mounted print. */
export const MOUNT_SHADOW_MM = 16;

export const PLASTER_COLOR = '#e7e3da';
export const FLOOR_COLOR = '#d8d4ca';
export const STAGE_BACKGROUND = '#e7e8e5';

function isVerticalSurface(surface: Surface): boolean {
  return Math.abs(surface.frontNormal[1]) < 0.5;
}

/**
 * The corner-seam edge of a wall in local U. The `seam` datum marks the
 * shared corner line for A (U = 0) and B (U = width); floor surfaces have
 * no seam datum.
 */
function seamU(surface: Surface): number | null {
  const seam = surface.datums.find((d) => d.id === 'seam');
  const u = seam?.localMm[0];
  return typeof u === 'number' ? u : null;
}

/** Deterministic PRNG — texture noise must be identical every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plaster wash: per-pixel value noise plus a handful of large soft
 * blotches, hovering near white so it multiplies the material colour by
 * only a few percent. Deterministic for a fixed seed.
 */
export function makePlasterTexture(seed = 0x5eed): THREE.DataTexture {
  const size = 256;
  const rand = mulberry32(seed);
  const data = new Uint8Array(size * size * 4);
  // Low-frequency blotches: gaussian bumps at random centres.
  const blobs = Array.from({ length: 7 }, () => ({
    x: rand() * size,
    y: rand() * size,
    r: 40 + rand() * 90,
    a: (rand() - 0.5) * 14,
  }));
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let v = 244 + (rand() - 0.5) * 12;
      for (const b of blobs) {
        const dx = Math.min(Math.abs(x - b.x), size - Math.abs(x - b.x));
        const dy = Math.min(Math.abs(y - b.y), size - Math.abs(y - b.y));
        const d2 = dx * dx + dy * dy;
        v += b.a * Math.exp(-d2 / (2 * b.r * b.r));
      }
      const i = (y * size + x) * 4;
      const c = Math.max(0, Math.min(255, Math.round(v)));
      data[i] = c;
      data[i + 1] = c;
      data[i + 2] = c;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 1D alpha ramp — opaque near-black at u = 0 fading to transparent at
 * u = 1. Used for the ambient-occlusion strips at the corner seam and the
 * wall/floor junction, and re-usable anywhere a soft darkening is needed.
 */
export function makeAlphaGradientTexture(): THREE.DataTexture {
  const w = 64;
  const data = new Uint8Array(w * 4);
  for (let x = 0; x < w; x += 1) {
    const t = x / (w - 1);
    const i = x * 4;
    data[i] = 16;
    data[i + 1] = 17;
    data[i + 2] = 15;
    data[i + 3] = Math.round(255 * Math.pow(1 - t, 1.7));
  }
  const tex = new THREE.DataTexture(data, w, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Soft mount shadow for the print edge: a distance field around the
 * footprint polygon in surface-UV space — full strength at the edge,
 * fading to zero MOUNT_SHADOW_MM out. Pixels inside the footprint are
 * fully transparent: the opaque proof renders there, and a decal that
 * could ever sort in front of it must never darken the colour-neutral
 * proof (mm-scale coplanar gaps are below depth-buffer resolution).
 */
export function makeMountShadowTexture(
  footprint: readonly Vec2[],
  bbox: { x: number; y: number; width: number; height: number },
  padMm: number,
  texPx = 160,
): THREE.DataTexture {
  const data = new Uint8Array(texPx * texPx * 4);
  const w = bbox.width + padMm * 2;
  const h = bbox.height + padMm * 2;
  const sx = texPx / w;
  const sy = texPx / h;
  const distToEdge = (px: number, py: number): number => {
    let inside = false;
    let best = Infinity;
    for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i, i += 1) {
      const [x1, y1] = footprint[j]!;
      const [x2, y2] = footprint[i]!;
      const ex = x2 - x1;
      const ey = y2 - y1;
      const len2 = ex * ex + ey * ey;
      const t =
        len2 > 0
          ? Math.max(0, Math.min(1, ((px - x1) * ex + (py - y1) * ey) / len2))
          : 0;
      const dx = px - (x1 + t * ex);
      const dy = py - (y1 + t * ey);
      best = Math.min(best, dx * dx + dy * dy);
      if (y1 > py !== y2 > py && px < x1 + ((py - y1) / (y2 - y1)) * ex) {
        inside = !inside;
      }
    }
    return inside ? -1 : Math.sqrt(best);
  };
  for (let ty = 0; ty < texPx; ty += 1) {
    for (let tx = 0; tx < texPx; tx += 1) {
      const px = bbox.x - padMm + (tx + 0.5) / sx;
      const py = bbox.y - padMm + (ty + 0.5) / sy;
      const d = distToEdge(px, py);
      const a = d <= 0 ? 0 : Math.max(0, 1 - d / MOUNT_SHADOW_MM) * 0.5;
      const i = (ty * texPx + tx) * 4;
      data[i] = 14;
      data[i + 1] = 15;
      data[i + 2] = 14;
      data[i + 3] = Math.round(255 * a);
    }
  }
  const tex = new THREE.DataTexture(data, texPx, texPx);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Re-scales a BoxGeometry's per-face 0..1 UVs to world millimetres, using
 * each vertex's normal to pick the tangent axes — keeps the plaster noise
 * at a constant real-world grain on every face of every slab.
 */
export function scaleBoxUVsToWorld(
  geometry: THREE.BufferGeometry,
  texMm: number = PLASTER_TILE_MM,
): void {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  for (let i = 0; i < pos.count; i += 1) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u: number;
    let v: number;
    if (nx >= ny && nx >= nz) {
      u = pos.getZ(i);
      v = pos.getY(i);
    } else if (ny >= nx && ny >= nz) {
      u = pos.getX(i);
      v = pos.getZ(i);
    } else {
      u = pos.getX(i);
      v = pos.getY(i);
    }
    uv.setXY(i, u / texMm, v / texMm);
  }
  uv.needsUpdate = true;
}

/**
 * Broad sky falloff: the wall reads a few percent darker toward the floor
 * and brighter toward the top, like a real plaster surface lit from above.
 * Implemented as vertex colours so it costs no extra draw calls.
 */
function addVerticalGradient(geometry: THREE.BufferGeometry): void {
  const pos = geometry.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pos.count; i += 1) {
    minY = Math.min(minY, pos.getY(i));
    maxY = Math.max(maxY, pos.getY(i));
  }
  const span = Math.max(1, maxY - minY);
  for (let i = 0; i < pos.count; i += 1) {
    const t = (pos.getY(i) - minY) / span;
    const b = 0.92 + 0.08 * t;
    colors[i * 3] = b;
    colors[i * 3 + 1] = b;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

interface SlabRange {
  uLow: number;
  uHigh: number;
  vLow: number;
  vHigh: number;
}

function wallRange(surface: Surface): SlabRange {
  const { boundsMm } = surface;
  const uSeam = seamU(surface);
  const seamAtMin =
    uSeam === null
      ? null
      : Math.abs(uSeam - boundsMm.x) <=
        Math.abs(uSeam - (boundsMm.x + boundsMm.width));
  const uLow =
    uSeam === null
      ? boundsMm.x - WALL_MARGIN_MM
      : seamAtMin
        ? uSeam - SEAM_EMBED_MM
        : boundsMm.x - WALL_MARGIN_MM;
  const uHigh =
    uSeam === null
      ? boundsMm.x + boundsMm.width + WALL_MARGIN_MM
      : seamAtMin
        ? boundsMm.x + boundsMm.width + WALL_MARGIN_MM
        : uSeam + SEAM_EMBED_MM;
  return {
    uLow,
    uHigh,
    vLow: boundsMm.y - FLOOR_DEPTH_MM,
    vHigh: boundsMm.y + boundsMm.height + WALL_MARGIN_MM,
  };
}

/** Local (u, v, front-offset) point on a surface, in world space. */
function surfacePoint(
  surface: Surface,
  u: number,
  v: number,
  frontOffset: number,
): THREE.Vector3 {
  return new THREE.Vector3(
    surface.originMm[0] +
      surface.axisU[0] * u +
      surface.axisV[0] * v +
      surface.frontNormal[0] * frontOffset,
    surface.originMm[1] +
      surface.axisU[1] * u +
      surface.axisV[1] * v +
      surface.frontNormal[1] * frontOffset,
    surface.originMm[2] +
      surface.axisU[2] * u +
      surface.axisV[2] * v +
      surface.frontNormal[2] * frontOffset,
  );
}

/**
 * A plaster wall slab for one vertical surface: a cuboid whose decorative
 * front face sits FRONT_GAP_MM behind the authoritative front plane and
 * whose body extends WALL_DEPTH_MM behind that. The slab reaches
 * WALL_MARGIN_MM past the panel's outer edge and top, SEAM_EMBED_MM past
 * the corner seam, and FLOOR_DEPTH_MM below the floor line so it is buried
 * in the floor slab with no visible joint. UVs carry the plaster texture
 * at a fixed world grain; vertex colours carry the sky falloff.
 */
export function buildWallSlab(surface: Surface): THREE.Mesh {
  const { uLow, uHigh, vLow, vHigh } = wallRange(surface);
  const uLen = uHigh - uLow;
  const vLen = vHigh - vLow;
  const uMid = (uLow + uHigh) / 2;
  const vMid = (vLow + vHigh) / 2;

  const geometry = new THREE.BoxGeometry(uLen, vLen, WALL_DEPTH_MM);
  scaleBoxUVsToWorld(geometry);
  addVerticalGradient(geometry);
  const axisU = new THREE.Vector3(...surface.axisU);
  const axisV = new THREE.Vector3(...surface.axisV);
  // (axisU, axisV, frontNormal) is a proper rotation — using the back
  // direction would make the basis a reflection, which setFromRotationMatrix
  // cannot represent.
  const front = new THREE.Vector3(...surface.frontNormal);
  const basis = new THREE.Matrix4().makeBasis(axisU, axisV, front);
  const mesh = new THREE.Mesh(geometry);
  mesh.quaternion.setFromRotationMatrix(basis);
  mesh.position.copy(
    surfacePoint(surface, uMid, vMid, -(FRONT_GAP_MM + WALL_DEPTH_MM / 2)),
  );
  mesh.userData.architecture = 'wall';
  mesh.userData.surfaceId = surface.id;
  return mesh;
}

/**
 * The contextual room floor: a slab whose top sits FRONT_GAP_MM below
 * y = 0 (so a printable floor piece at y = 0 reads as mounted) and which
 * spans the wall slabs' plan bounds plus FLOOR_MARGIN_MM on every side.
 * It is always built — printable surface C or not — and produces no C
 * output because it never enters geometry, clipping or print planning.
 */
export function buildFloorSlab(walls: readonly THREE.Mesh[]): THREE.Mesh {
  const box = new THREE.Box3();
  for (const wall of walls) {
    wall.updateMatrixWorld(true);
    box.expandByObject(wall);
  }
  const width = box.max.x - box.min.x + 2 * FLOOR_MARGIN_MM;
  const depth = box.max.z - box.min.z + 2 * FLOOR_MARGIN_MM;
  const geometry = new THREE.BoxGeometry(width, FLOOR_DEPTH_MM, depth);
  scaleBoxUVsToWorld(geometry);
  const mesh = new THREE.Mesh(geometry);
  mesh.position.set(
    (box.min.x + box.max.x) / 2,
    -(FRONT_GAP_MM + FLOOR_DEPTH_MM / 2),
    (box.min.z + box.max.z) / 2,
  );
  mesh.userData.architecture = 'floor';
  return mesh;
}

/**
 * Simple two-triangle quad for the AO decals. `uvs` defaults to a standard
 * unit mapping; pass a custom quad when the gradient axis must run along a
 * different edge (the floor strip fades across its depth, not its length).
 */
function quadGeometry(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  p3: THREE.Vector3,
  uvs: readonly number[] = [0, 0, 1, 0, 0, 1, 1, 1],
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(
      [p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z],
      3,
    ),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex([0, 1, 2, 1, 3, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

function makeDecalMaterial(map: THREE.Texture, opacity: number) {
  return new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    opacity,
    // Coplanar decals are pulled forward in depth rather than relying on
    // the sub-millimetre air gap alone — no grazing-angle flicker.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/**
 * Ambient-occlusion decals — the darkening a real room shows where planes
 * meet. A vertical strip on each wall face at the corner seam (darkest at
 * the seam, fading AO_STRIP_MM into the wall) and a strip on the floor
 * along each wall's base (darkest at the wall line, fading into the
 * room). Rendered between the wall front and the substrate, alpha-blended,
 * never written to depth.
 */
export function buildJunctionShadows(
  scene: CompiledScene,
  gradient: THREE.Texture,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.architecture = 'junction-shadows';
  const material = makeDecalMaterial(gradient, 0.5);
  group.userData.disposables = [material];
  for (const compiled of scene.surfaces) {
    const surface = compiled.surface;
    if (!isVerticalSurface(surface)) continue;
    const { uLow, uHigh } = wallRange(surface);
    const { boundsMm } = surface;
    const n = surface.frontNormal;

    // Floor strip: along the wall's base line, AO_STRIP_MM into the room.
    // uv.x runs wall→room so the gradient darkens at the junction.
    const yFloor = -DECAL_GAP_MM;
    const f0 = surfacePoint(surface, uLow, 0, 0).setY(yFloor);
    const f1 = surfacePoint(surface, uHigh, 0, 0).setY(yFloor);
    const f2 = f0
      .clone()
      .add(new THREE.Vector3(n[0], 0, n[2]).multiplyScalar(AO_STRIP_MM));
    const f3 = f1
      .clone()
      .add(new THREE.Vector3(n[0], 0, n[2]).multiplyScalar(AO_STRIP_MM));
    const floorStrip = new THREE.Mesh(
      quadGeometry(f0, f1, f2, f3, [0, 0, 0, 1, 1, 0, 1, 1]),
      material,
    );
    floorStrip.userData.architecture = 'junction-shadow';
    group.add(floorStrip);

    // Seam strip on this wall's face, darkest at the corner edge. The
    // seam-edge vertex comes first so uv.x = 0 lands on the seam whether
    // the seam sits at the low or high end of the panel's U range.
    const uSeam = seamU(surface);
    if (uSeam !== null) {
      const seamAtMin =
        Math.abs(uSeam - boundsMm.x) <=
        Math.abs(uSeam - (boundsMm.x + boundsMm.width));
      const uIn = seamAtMin ? uSeam + AO_STRIP_MM : uSeam - AO_STRIP_MM;
      const off = -DECAL_GAP_MM;
      const s0 = surfacePoint(surface, uSeam, 0, off);
      const s1 = surfacePoint(surface, uIn, 0, off);
      const s2 = surfacePoint(surface, uSeam, boundsMm.y + boundsMm.height, off);
      const s3 = surfacePoint(surface, uIn, boundsMm.y + boundsMm.height, off);
      const seamStrip = new THREE.Mesh(
        quadGeometry(s0, s1, s2, s3),
        material,
      );
      seamStrip.userData.architecture = 'junction-shadow';
      group.add(seamStrip);
    }
  }
  return group;
}

/**
 * The soft edge shadow a mounted print throws on the wall — a
 * distance-field sprite covering each printable footprint, offset a few
 * millimetres down-light so the artwork reads as mounted rather than
 * painted flat.
 */
export function buildMountShadows(
  scene: CompiledScene,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.architecture = 'mount-shadows';
  const padMm = MOUNT_SHADOW_MM + 4;
  for (const compiled of scene.surfaces) {
    const surface = compiled.surface;
    const footprint = compiled.printableFootprintMm;
    if (footprint.length < 3) continue;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [u, v] of footprint) {
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const bbox = {
      x: minU,
      y: minV,
      width: maxU - minU,
      height: maxV - minV,
    };
    const texture = makeMountShadowTexture(footprint, bbox, padMm);
    const material = makeDecalMaterial(texture, 1);
    // Shadow falls away from the overhead light: down the wall and a
    // touch sideways, in the surface's own frame.
    const down = -4.5;
    const lateral = 1.5;
    const geometry = quadGeometry(
      surfacePoint(surface, minU - padMm + lateral, minV - padMm + down, -DECAL_GAP_MM),
      surfacePoint(surface, maxU + padMm + lateral, minV - padMm + down, -DECAL_GAP_MM),
      surfacePoint(surface, minU - padMm + lateral, maxV + padMm + down, -DECAL_GAP_MM),
      surfacePoint(surface, maxU + padMm + lateral, maxV + padMm + down, -DECAL_GAP_MM),
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.architecture = 'mount-shadow';
    mesh.userData.surfaceId = surface.id;
    mesh.userData.disposables = [material, texture];
    group.add(mesh);
  }
  return group;
}

/**
 * One restrained shadow-casting key light plus a soft sky/ground fill. The
 * key comes from the room interior — the normalized sum of the wall front
 * normals — raised high and nudged sideways, so both walls are lit at any
 * supported corner angle and the wall bases throw a soft contact shadow
 * onto the floor.
 */
export function buildDaylightRig(
  center: Vec3,
  extentMm: number,
  wallNormals: readonly Vec3[] = [],
): THREE.Group {
  const group = new THREE.Group();
  const reach = Math.max(extentMm, 1_000);

  const interior = new THREE.Vector3(0, 0, 0);
  for (const n of wallNormals) {
    interior.add(new THREE.Vector3(n[0], 0, n[2]));
  }
  if (interior.lengthSq() < 1e-6) interior.set(0.7, 0, 0.7);
  interior.normalize();
  const lateral = new THREE.Vector3()
    .crossVectors(interior, new THREE.Vector3(0, 1, 0))
    .normalize();
  const dir = interior
    .clone()
    .multiplyScalar(0.85)
    .add(new THREE.Vector3(0, 1.2, 0))
    .add(lateral.multiplyScalar(0.3))
    .normalize();

  const key = new THREE.DirectionalLight('#fff8ee', 2.4);
  key.position.set(
    center[0] + dir.x * reach,
    center[1] + dir.y * reach,
    center[2] + dir.z * reach,
  );
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const cam = key.shadow.camera;
  cam.left = -reach;
  cam.right = reach;
  cam.top = reach;
  cam.bottom = -reach;
  cam.near = reach * 0.2;
  cam.far = reach * 4;
  cam.updateProjectionMatrix();
  key.shadow.normalBias = 3;
  key.shadow.bias = -0.0002;
  key.target.position.set(center[0], center[1], center[2]);
  group.add(key, key.target);

  const fill = new THREE.HemisphereLight('#f2f4f4', '#d3cdc0', 1.1);
  group.add(fill);
  return group;
}

function roomCenter(scene: CompiledScene): { center: Vec3; extent: number } {
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  for (const compiled of scene.surfaces) {
    for (const [u, v] of compiled.surface.polygonMm) {
      p.set(
        compiled.surface.originMm[0] +
          compiled.surface.axisU[0] * u +
          compiled.surface.axisV[0] * v,
        compiled.surface.originMm[1] +
          compiled.surface.axisU[1] * u +
          compiled.surface.axisV[1] * v,
        compiled.surface.originMm[2] +
          compiled.surface.axisU[2] * u +
          compiled.surface.axisV[2] * v,
      );
      box.expandByPoint(p);
    }
  }
  const c = new THREE.Vector3();
  box.getCenter(c);
  return {
    center: [c.x, c.y, c.z],
    extent: Math.max(scene.sceneExtentMm, 500),
  };
}

/**
 * Builds the decorative room shell: plaster walls for the vertical
 * surfaces, the contextual floor slab, the ambient-occlusion decals, the
 * mount shadows and the daylight rig. Everything is tagged
 * `userData.architecture` and lives in its own group, outside the
 * surface, handle and mark groups.
 */
export function buildArchitecture(
  scene: CompiledScene,
  materials: ArchitectureMaterials,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.architecture = true;
  const walls: THREE.Mesh[] = [];
  for (const compiled of scene.surfaces) {
    if (!isVerticalSurface(compiled.surface)) continue;
    const wall = buildWallSlab(compiled.surface);
    wall.material = materials.wall;
    wall.castShadow = true;
    wall.receiveShadow = true;
    walls.push(wall);
    group.add(wall);
  }
  const floor = buildFloorSlab(walls);
  floor.material = materials.floor;
  floor.receiveShadow = true;
  group.add(floor);
  group.add(buildJunctionShadows(scene, materials.gradient));
  group.add(buildMountShadows(scene));
  const { center, extent } = roomCenter(scene);
  group.add(
    buildDaylightRig(
      center,
      extent,
      walls.map((w) => {
        const s = scene.surfaces.find(
          (c) => c.surface.id === (w.userData.surfaceId as string),
        )!;
        return s.surface.frontNormal;
      }),
    ),
  );
  return group;
}

export interface ArchitectureMaterials {
  wall: THREE.MeshStandardMaterial;
  floor: THREE.MeshStandardMaterial;
  plaster: THREE.DataTexture;
  gradient: THREE.DataTexture;
}

/**
 * Mount-shadow decals describe the committed mount — while a draft
 * gesture runs they would linger at the old position, so the viewport
 * hides them with the proof meshes and restores them when the settled
 * presentation returns. Only mount shadows toggle; the junction AO stays
 * (the walls do not move during an artwork drag).
 */
export function setMountShadowsVisible(
  archGroup: THREE.Object3D | null,
  on: boolean,
): void {
  archGroup?.traverse((node) => {
    if (node.userData.architecture === 'mount-shadow') node.visible = on;
  });
}

/**
 * Disposes a built architecture subtree: every mesh geometry, every
 * per-node disposable (mount-shadow materials/textures, decal materials)
 * and — crucially — every light's shadow resources. A shadow-casting
 * DirectionalLight owns a shadow-map render target that is NOT covered
 * by geometry/material disposal; without this, each scene rebuild leaks
 * one render target (the observed +6 textures over six edits). Shared
 * ArchitectureMaterials are intentionally not disposed here — they die
 * with the viewport at unmount.
 */
export function disposeArchitecture(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeArchitecture(child);
    const withGeometry = child as THREE.Mesh;
    if (withGeometry.isMesh && withGeometry.geometry) {
      withGeometry.geometry.dispose();
    }
    const withShadow = child as unknown as {
      isLight?: boolean;
      shadow?: { dispose(): void } | null;
    };
    if (withShadow.isLight && withShadow.shadow) {
      withShadow.shadow.dispose();
    }
    for (const d of (child.userData.disposables ?? []) as {
      dispose(): void;
    }[]) {
      d.dispose();
    }
  }
}

export function makeArchitectureMaterials(): ArchitectureMaterials {
  const plaster = makePlasterTexture();
  const gradient = makeAlphaGradientTexture();
  return {
    plaster,
    gradient,
    wall: new THREE.MeshStandardMaterial({
      color: new THREE.Color(PLASTER_COLOR),
      map: plaster,
      bumpMap: plaster,
      bumpScale: 0.7,
      roughness: 0.95,
      metalness: 0,
      vertexColors: true,
    }),
    floor: new THREE.MeshStandardMaterial({
      color: new THREE.Color(FLOOR_COLOR),
      map: plaster,
      roughness: 0.95,
      metalness: 0,
    }),
  };
}
