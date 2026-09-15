import * as THREE from 'three';
import {
  ANGLE_ARC_RADIUS_MM,
  angleHandleRadiusMm,
  cornerHandleWorldMm,
  panelBDirMm,
  type CornerDragKind,
  type SceneDragKind,
} from '../core/geometry/dragSolve';
import type { CornerSpec, Vec3 } from '../core/types';
import { WALL_MARGIN_MM } from './architecture';

/**
 * Direct-manipulation contracts and scene-graph builders for the spatial
 * viewport's editing handles (§12-style: draft visuals during the gesture,
 * exactly one commit at pointerup). Pure solve math lives in
 * `core/geometry/dragSolve.ts` — this file only builds and positions meshes.
 */

export interface CornerEditContract {
  readonly corner: CornerSpec;
  readonly onCommit: (patch: Partial<CornerSpec>) => void;
}

export interface ViewpointEditContract {
  readonly eyeMm: Vec3;
  readonly aimHeightMm: number;
  readonly onCommit: (patch: {
    readonly eyeMm?: Vec3;
    readonly aimHeightMm?: number;
  }) => void;
}

/** Accent family shared with the 2D artwork overlay handles. */
const HANDLE_COLOR = '#bd3f27';
/** The eye/aim rig colour already used by the scene marks. */
const RIG_COLOR = '#b53a23';

/**
 * Edge tabs sit essentially on the wall — the lift only biases them a touch
 * toward the interior face so they read as clipped onto the panel rather
 * than skewering it.
 */
const HANDLE_LIFT_MM = 2;
/** The angle tab's floor clearance above the base panel / grid. */
const ANGLE_MARK_LIFT_MM = 3;
/** Draft ghost floats this far off the panel face toward the interior. */
const GHOST_LIFT_MM = 1.5;
/** Stalk handle height above the eye marker. */
export const EYE_STALK_MM = 160;

/**
 * Handle geometry is deliberately per-build. The viewport disposes every
 * handle subtree when the scene/contract changes; module-level Three objects
 * would then be reused after `dispose()`, leaving subsequent mounts with
 * invalidated GPU resources (and sharing disposal ownership between two
 * viewports). Factories keep each built subtree independently disposable.
 */
/** Slim fins pierced by the edge they mark: registration tabs, not hardware. */
const makeWidthMarkGeometry = () => new THREE.BoxGeometry(10, 80, 30);
const makeHeightMarkGeometry = () => new THREE.BoxGeometry(80, 10, 30);
/** Small square grab tile at the floor arc's panel-B end. */
const makeAngleTabGeometry = () => new THREE.BoxGeometry(30, 4, 30);
const makeStalkMarkGeometry = () => new THREE.SphereGeometry(28, 16, 12);
const makeAimMarkGeometry = () => new THREE.OctahedronGeometry(32);
const makeHitProxyGeometry = () => new THREE.SphereGeometry(140, 12, 16);

/**
 * The protractor arc is a flat annulus ribbon on the floor, authored at
 * ANGLE_ARC_RADIUS_MM and rescaled when panel B is narrower. One degree of
 * azimuth per segment lets layoutCornerMatrices truncate the sweep with a
 * plain draw range — no per-move vertex writes.
 */
const ANGLE_ARC_SPAN_DEG = 160; // covers the 45–150° clamp with slack
const ANGLE_ARC_SEGMENTS = 160;
const ANGLE_ARC_HALF_WIDTH_MM = 7;
const ANGLE_ARC_Y_MM = 2;
/** Extra leading vertices: the fixed radial tick at the arc's 0° (panel-A) end. */
const ANGLE_ARC_TICK_VERTS = 6;

function buildAngleArcGeometry(): THREE.BufferGeometry {
  const inner = ANGLE_ARC_RADIUS_MM - ANGLE_ARC_HALF_WIDTH_MM;
  const outer = ANGLE_ARC_RADIUS_MM + ANGLE_ARC_HALF_WIDTH_MM;
  const positions = new Float32Array(
    (ANGLE_ARC_TICK_VERTS + ANGLE_ARC_SEGMENTS * 6) * 3,
  );
  let o = 0;
  const put = (r: number, deg: number): void => {
    const t = (deg * Math.PI) / 180;
    positions[o] = Math.cos(t) * r;
    positions[o + 1] = ANGLE_ARC_Y_MM;
    positions[o + 2] = Math.sin(t) * r;
    o += 3;
  };
  // Registration tick at the fixed panel-A end — a short radial line
  // crossing the ribbon, the fixed jaw of the protractor mark.
  const tickIn = inner - 8;
  const tickOut = outer + 8;
  const tickHalfDeg = 1.4;
  put(tickIn, -tickHalfDeg);
  put(tickOut, -tickHalfDeg);
  put(tickIn, tickHalfDeg);
  put(tickOut, -tickHalfDeg);
  put(tickOut, tickHalfDeg);
  put(tickIn, tickHalfDeg);
  for (let i = 0; i < ANGLE_ARC_SEGMENTS; i += 1) {
    put(inner, i);
    put(outer, i);
    put(inner, i + 1);
    put(outer, i);
    put(outer, i + 1);
    put(inner, i + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setDrawRange(0, 0);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Invisible-but-raycastable hit target: colourWrite/depthWrite off keeps it
 * out of the frame while Mesh.raycast still tests its geometry.
 */
const makeHitProxyMaterial = () =>
  new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

export const CORNER_DRAG_KINDS: readonly CornerDragKind[] = [
  'panel-a-width',
  'panel-b-width',
  'panel-a-height',
  'panel-b-height',
  'corner-angle',
];

function tagKind(node: THREE.Object3D, kind: SceneDragKind): void {
  node.userData.dragKind = kind;
  node.traverse((child) => {
    child.userData.dragKind = kind;
  });
}

function makeHandleNode(
  kind: SceneDragKind,
  mark: THREE.Object3D | null,
): THREE.Group {
  const node = new THREE.Group();
  if (mark) node.add(mark);
  // Both the proxy geometry and material belong to this node's disposable
  // subtree. Do not share either across handle builds or viewport instances.
  node.add(new THREE.Mesh(makeHitProxyGeometry(), makeHitProxyMaterial()));
  tagKind(node, kind);
  // Visible-mark materials the hover tint can brighten without touching the
  // invisible proxy.
  const mats: THREE.MeshBasicMaterial[] = [];
  mark?.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) mats.push(mesh.material as THREE.MeshBasicMaterial);
  });
  node.userData.hoverMats = mats;
  return node;
}

const markMaterial = (color: string) =>
  new THREE.MeshBasicMaterial({ color });

/**
 * The corner handles: slim fins straddling the wall-slab edges they
 * resize, and a protractor mark — a flat floor arc swept from panel A to
 * panel B with a square tab at B's end — that rotates B around the seam.
 * The arc is a sibling of the handle node (it lives at world origin, not
 * on the node) but shares the node's dragKind so presses on it drag the
 * angle.
 */
export function buildCornerHandles(
  group: THREE.Group,
  nodes: Map<string, THREE.Object3D>,
  corner: CornerSpec,
): void {
  for (const kind of CORNER_DRAG_KINDS) {
    const geometry =
      kind === 'corner-angle'
        ? makeAngleTabGeometry()
        : kind === 'panel-a-height' || kind === 'panel-b-height'
          ? makeHeightMarkGeometry()
          : makeWidthMarkGeometry();
    const node = makeHandleNode(
      kind,
      new THREE.Mesh(geometry, markMaterial(HANDLE_COLOR)),
    );
    if (kind === 'corner-angle') {
      const arc = new THREE.Mesh(
        buildAngleArcGeometry(),
        markMaterial(HANDLE_COLOR),
      );
      (arc.material as THREE.MeshBasicMaterial).side = THREE.DoubleSide;
      arc.userData.dragKind = kind;
      node.userData.angleArc = arc;
      (node.userData.hoverMats as THREE.MeshBasicMaterial[]).push(
        arc.material as THREE.MeshBasicMaterial,
      );
      group.add(arc);
    }
    nodes.set(kind, node);
    group.add(node);
  }
  layoutCornerHandles(nodes, corner);
}

/** Wall-face offset so a handle reads as attached to its panel. */
function handleLiftMm(kind: CornerDragKind, angleDeg: number): Vec3 {
  if (kind === 'corner-angle') {
    // The tab floats a whisker above the floor arc's B-end.
    return [0, ANGLE_MARK_LIFT_MM, 0];
  }
  if (kind === 'panel-a-width' || kind === 'panel-a-height') {
    return [0, 0, HANDLE_LIFT_MM];
  }
  const rad = (angleDeg * Math.PI) / 180;
  // Panel B front normal — handles sit on the interior face.
  return [Math.sin(rad) * HANDLE_LIFT_MM, 0, -Math.cos(rad) * HANDLE_LIFT_MM];
}

/** Half the height fin's length — its outer end lands flush on the slab corner. */
const HEIGHT_FIN_HALF_MM = 40;

/**
 * Where a fin is mounted. With the architectural shell the panel's outer
 * and top edges are invisible lines inside continuous plaster, so the
 * fins ride the wall slab's visible edges instead: width fins pierced by
 * the slab's outer vertical edge at mid-height, height fins lying along
 * the slab's top edge and ending flush at its outer corner. Drag solves
 * are delta-based and never read the node position, so anchoring at the
 * slab edge simply makes the wall edge track the pointer exactly.
 */
function wallEdgeAnchorMm(kind: CornerDragKind, corner: CornerSpec): Vec3 {
  const { panelA: a, panelB: b } = corner;
  const m = WALL_MARGIN_MM;
  switch (kind) {
    case 'panel-a-width':
      return [a.widthMm + m, (a.heightMm + m) / 2, 0];
    case 'panel-a-height':
      return [
        a.widthMm + m - HEIGHT_FIN_HALF_MM,
        a.heightMm + m,
        0,
      ];
    default: {
      const dirB = panelBDirMm(corner.angleDeg);
      const u =
        kind === 'panel-b-height'
          ? b.widthMm + m - HEIGHT_FIN_HALF_MM
          : b.widthMm + m;
      const v = kind === 'panel-b-height' ? b.heightMm + m : (b.heightMm + m) / 2;
      return [dirB[0] * u, v, dirB[2] * u];
    }
  }
}

/**
 * Position every corner handle for a (possibly draft) spec. Called both for
 * committed layouts and per-move during a drag — moving B's handles with the
 * draft angle is what makes the ghost read.
 */
export function layoutCornerHandles(
  nodes: Map<string, THREE.Object3D>,
  corner: CornerSpec,
): void {
  const angle = cornerHandleWorldMm(corner)['corner-angle'];
  for (const kind of CORNER_DRAG_KINDS) {
    const node = nodes.get(kind);
    const p = kind === 'corner-angle' ? angle : wallEdgeAnchorMm(kind, corner);
    if (!node || !p) continue;
    const lift = handleLiftMm(kind, corner.angleDeg);
    node.position.set(p[0] + lift[0], p[1] + lift[1], p[2] + lift[2]);
    // Elongated edge marks lie along their wall — B's run at the angle.
    node.rotation.y =
      kind === 'panel-b-width' || kind === 'panel-b-height'
        ? -corner.angleDeg
        : 0;
    const arc = node.userData.angleArc as THREE.Mesh | undefined;
    if (arc) {
      // Truncate the sweep at the current angle and shrink the authored
      // radius when panel B is too narrow to hold it — the tab rides the
      // arc end either way.
      const segments = Math.round(
        Math.min(Math.max(corner.angleDeg, 0), ANGLE_ARC_SPAN_DEG),
      );
      arc.geometry.setDrawRange(
        0,
        ANGLE_ARC_TICK_VERTS + segments * 6,
      );
      arc.scale.setScalar(
        angleHandleRadiusMm(corner.panelB.widthMm) / ANGLE_ARC_RADIUS_MM,
      );
    }
  }
}

/** Draft-ghost wireframe rectangle, shared by every corner drag. */
export function makeGhost(): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(8 * 3), 3),
  );
  const ghost = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: HANDLE_COLOR }),
  );
  ghost.visible = false;
  ghost.frustumCulled = false;
  return ghost;
}

/** Panel-A outline at a draft size, nudged off the wall face. */
export function ghostCornersA(
  widthMm: number,
  heightMm: number,
): readonly Vec3[] {
  const n = GHOST_LIFT_MM;
  return [
    [0, 0, n],
    [widthMm, 0, n],
    [widthMm, heightMm, n],
    [0, heightMm, n],
  ];
}

/** Panel-B outline at a draft size/angle, nudged off its front face. */
export function ghostCornersB(
  widthMm: number,
  heightMm: number,
  angleDeg: number,
): readonly Vec3[] {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dz = Math.sin(rad);
  const nx = Math.sin(rad) * GHOST_LIFT_MM;
  const nz = -Math.cos(rad) * GHOST_LIFT_MM;
  return [
    [nx, 0, nz],
    [dx * widthMm + nx, 0, dz * widthMm + nz],
    [dx * widthMm + nx, heightMm, dz * widthMm + nz],
    [nx, heightMm, nz],
  ];
}

/** Write the four looped outline segments into the ghost buffer. */
export function setGhostRect(
  ghost: THREE.LineSegments,
  corners: readonly Vec3[],
): void {
  const attribute = ghost.geometry.getAttribute(
    'position',
  ) as THREE.BufferAttribute;
  const order = [0, 1, 1, 2, 2, 3, 3, 0];
  for (let i = 0; i < 8; i += 1) {
    const c = corners[order[i]!]!;
    attribute.setXYZ(i, c[0], c[1], c[2]);
  }
  attribute.needsUpdate = true;
  ghost.geometry.computeBoundingSphere();
  ghost.visible = true;
}

export interface ViewpointHandleNodes {
  /** Thin rule from the eye point up to the height handle. */
  readonly stalkLine: THREE.Line;
}

/**
 * The viewpoint rig handles (orbit mode only): an invisible hit sphere over
 * the person's eye position for the floor drag, a stalk mark above it for
 * the height drag, and an aim mark on the seam.
 */
export function buildViewpointHandles(
  group: THREE.Group,
  nodes: Map<string, THREE.Object3D>,
  eyeMm: Vec3,
  aimHeightMm: number,
): ViewpointHandleNodes {
  // The visible eye mark lives in marksGroup — the floor handle is a
  // proxy-only node that rides the same point.
  const eyeNode = makeHandleNode('eye-floor', null);
  nodes.set('eye-floor', eyeNode);
  group.add(eyeNode);

  const stalkGeometry = new THREE.BufferGeometry();
  stalkGeometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(new Float32Array(2 * 3), 3),
  );
  const stalkLine = new THREE.Line(
    stalkGeometry,
    new THREE.LineBasicMaterial({ color: RIG_COLOR }),
  );
  stalkLine.frustumCulled = false;
  group.add(stalkLine);

  const stalkNode = makeHandleNode(
    'eye-height',
    new THREE.Mesh(makeStalkMarkGeometry(), markMaterial(RIG_COLOR)),
  );
  nodes.set('eye-height', stalkNode);
  group.add(stalkNode);

  const aimNode = makeHandleNode(
    'aim-height',
    new THREE.Mesh(makeAimMarkGeometry(), markMaterial(RIG_COLOR)),
  );
  nodes.set('aim-height', aimNode);
  group.add(aimNode);

  const view: ViewpointHandleNodes = { stalkLine };
  layoutViewpointHandles(nodes, view, eyeMm, aimHeightMm);
  return view;
}

/** Position the viewpoint handles for a (possibly draft) eye/aim. */
export function layoutViewpointHandles(
  nodes: Map<string, THREE.Object3D>,
  view: ViewpointHandleNodes | null,
  eyeMm: Vec3,
  aimHeightMm: number,
): void {
  nodes.get('eye-floor')?.position.set(eyeMm[0], eyeMm[1], eyeMm[2]);
  nodes
    .get('eye-height')
    ?.position.set(eyeMm[0], eyeMm[1] + EYE_STALK_MM, eyeMm[2]);
  nodes.get('aim-height')?.position.set(0, aimHeightMm, 0);
  if (view) {
    const attribute = view.stalkLine.geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    attribute.setXYZ(0, eyeMm[0], eyeMm[1], eyeMm[2]);
    attribute.setXYZ(1, eyeMm[0], eyeMm[1] + EYE_STALK_MM, eyeMm[2]);
    attribute.needsUpdate = true;
    view.stalkLine.geometry.computeBoundingSphere();
  }
}
