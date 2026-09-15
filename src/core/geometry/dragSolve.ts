import { LIMITS } from '../limits';
import {
  add3,
  dot3,
  isFiniteVec3,
  normalize3,
  scale3,
  sub3,
} from '../math/vector';
import type { CornerSpec, Vec2, Vec3 } from '../types';

/**
 * Pure pointer-ray → constraint math for direct scene editing in the 3D
 * viewport. Everything here is deterministic, DOM-free, and THREE-free so the
 * gesture behaviour is unit-testable (same §12.5 contract style as
 * artworkGesture): the viewport freezes a snapshot at pointerdown, each
 * pointermove resolves a value on the frozen constraint, and exactly one
 * commit lands at pointerup.
 *
 * Panel-edge anchors are also owned here (`cornerHandleWorldMm`) so the
 * viewport's marks and the constraint lines agree on the angle tab, which
 * sits on the floor at the end of a protractor arc swept from panel A to
 * panel B. The viewport re-anchors the four panel fins onto the visible
 * wall-slab edges (see `sceneHandles.wallEdgeAnchorMm`); solves are
 * delta-based, so anchor placement never affects the math.
 *
 * All solves are delta-based: `solveXxxRaw` returns the unclamped constraint
 * parameter under the pointer and `resolveXxxDrag` applies
 * `start + (raw − ref0)` so grabbing a handle anywhere inside its hit area
 * never jumps the value. The clamped `solveXxxMm/Deg` helpers answer the
 * absolute value under the ray for callers that want direct placement.
 */

export interface DragRay {
  readonly originMm: Vec3;
  /** Direction of the pointer ray; need not be unit length. */
  readonly directionMm: Vec3;
}

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;
/** World-space vertical axis (the corner seam is x=0, z=0). */
const WORLD_UP: Vec3 = [0, 1, 0];

export const clampMm = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export const clampPanelMm = (v: number): number =>
  clampMm(v, LIMITS.panelMm.min, LIMITS.panelMm.max);

export const clampInteriorAngleDeg = (v: number): number =>
  clampMm(v, LIMITS.angleDeg.min, LIMITS.angleDeg.max);

export const clampEyeCoordMm = (v: number): number =>
  clampMm(v, -LIMITS.viewer.coordAbsMaxMm, LIMITS.viewer.coordAbsMaxMm);

export const clampEyeHeightMm = (v: number): number =>
  clampMm(v, LIMITS.viewer.eyeHeightMinMm, LIMITS.viewer.eyeHeightMaxMm);

/** Aim-on-seam shares the inspector field's range: 0 … panel max. */
export const clampAimHeightMm = (v: number): number =>
  clampMm(v, 0, LIMITS.panelMm.max);

/** Wrap a degree delta to (−180, 180] so a drag through ±180° cannot jump. */
export function wrapDeltaDeg(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/**
 * Ray ∩ the horizontal plane y = heightMm. Returns null when the ray is
 * parallel to the plane, hits it behind the origin, or goes non-finite.
 */
export function intersectHorizontalPlane(
  ray: DragRay,
  heightMm: number,
): Vec3 | null {
  const d = ray.directionMm;
  if (!isFiniteVec3(ray.originMm) || !isFiniteVec3(d)) return null;
  if (Math.abs(d[1]) < LIMITS.parallelDenominatorEps) return null;
  const t = (heightMm - ray.originMm[1]) / d[1];
  if (!Number.isFinite(t) || t <= 0) return null;
  const p = add3(ray.originMm, scale3(d, t));
  return isFiniteVec3(p) ? p : null;
}

/**
 * Parameter s of the point on `lineOriginMm + s · lineDirMm` closest to the
 * ray (closest-points-between-skew-lines). Returns null for parallel or
 * degenerate inputs.
 */
export function closestLineParam(
  ray: DragRay,
  lineOriginMm: Vec3,
  lineDirMm: Vec3,
): number | null {
  const d1 = normalize3(ray.directionMm);
  const d2 = normalize3(lineDirMm);
  if (!d1 || !d2) return null;
  if (!isFiniteVec3(ray.originMm) || !isFiniteVec3(lineOriginMm)) return null;
  const w0 = sub3(ray.originMm, lineOriginMm);
  const a = dot3(d1, d1);
  const b = dot3(d1, d2);
  const c = dot3(d2, d2);
  const d = dot3(d1, w0);
  const e = dot3(d2, w0);
  const denominator = a * c - b * b;
  if (Math.abs(denominator) < LIMITS.parallelDenominatorEps) return null;
  const s = (a * e - b * d) / denominator;
  return Number.isFinite(s) ? s : null;
}

/**
 * Azimuth around the seam (the +Y axis through the origin): the signed angle
 * of `pointMm` from +X in the horizontal plane, degrees in (−180, 180].
 */
export function seamAzimuthDeg(pointMm: Vec3): number {
  return Math.atan2(pointMm[2], pointMm[0]) * DEG_PER_RAD;
}

/** Outward horizontal direction of panel B from the seam. */
export function panelBDirMm(angleDeg: number): Vec3 {
  const rad = angleDeg * RAD_PER_DEG;
  return [Math.cos(rad), 0, Math.sin(rad)];
}

// ——— Clamped absolute solvers (the value under the ray) ———

/** Floor-plane point (y = 0) → eyeMm x/z, clamped to ±coordAbsMaxMm. */
export function solveEyeFloorXZ(ray: DragRay): Vec2 | null {
  const p = intersectHorizontalPlane(ray, 0);
  return p
    ? [clampEyeCoordMm(p[0]), clampEyeCoordMm(p[2])]
    : null;
}

/** Height on a vertical line through (lineXMm, lineZMm), clamped. */
export function solveVerticalHeightMm(
  ray: DragRay,
  lineXMm: number,
  lineZMm: number,
  minMm: number,
  maxMm: number,
): number | null {
  const s = closestLineParam(ray, [lineXMm, 0, lineZMm], WORLD_UP);
  return s === null ? null : clampMm(s, minMm, maxMm);
}

/** Aim height on the seam's vertical line (x=0, z=0). */
export function solveAimHeightMm(ray: DragRay): number | null {
  return solveVerticalHeightMm(ray, 0, 0, 0, LIMITS.panelMm.max);
}

/** Eye height on the vertical line through the eye's floor point. */
export function solveEyeHeightMm(
  ray: DragRay,
  eyeXMm: number,
  eyeZMm: number,
): number | null {
  return solveVerticalHeightMm(
    ray,
    eyeXMm,
    eyeZMm,
    LIMITS.viewer.eyeHeightMinMm,
    LIMITS.viewer.eyeHeightMaxMm,
  );
}

/**
 * Distance along a panel's horizontal axis (a rail through the seam at
 * `railHeightMm`) → panel widthMm, clamped to the panel range.
 */
export function solvePanelWidthMm(
  ray: DragRay,
  axisDirMm: Vec3,
  railHeightMm: number,
): number | null {
  const s = closestLineParam(ray, [0, railHeightMm, 0], axisDirMm);
  return s === null ? null : clampPanelMm(s);
}

/** Height on the vertical line at a panel's outer edge → heightMm. */
export function solvePanelHeightMm(
  ray: DragRay,
  edgeXMm: number,
  edgeZMm: number,
): number | null {
  return solveVerticalHeightMm(
    ray,
    edgeXMm,
    edgeZMm,
    LIMITS.panelMm.min,
    LIMITS.panelMm.max,
  );
}

/** Interior angle from the ray's azimuth on a horizontal plane → clamped. */
export function solveInteriorAngleDeg(
  ray: DragRay,
  planeHeightMm: number,
): number | null {
  const p = intersectHorizontalPlane(ray, planeHeightMm);
  return p ? clampInteriorAngleDeg(seamAzimuthDeg(p)) : null;
}

// ——— Gesture machinery (delta solves against a frozen snapshot) ———

export type CornerDragKind =
  | 'panel-a-width'
  | 'panel-b-width'
  | 'panel-a-height'
  | 'panel-b-height'
  | 'corner-angle';

export type ViewpointDragKind = 'eye-floor' | 'eye-height' | 'aim-height';

export type SceneDragKind = CornerDragKind | ViewpointDragKind;

export const isCornerDragKind = (kind: SceneDragKind): boolean =>
  kind === 'panel-a-width' ||
  kind === 'panel-b-width' ||
  kind === 'panel-a-height' ||
  kind === 'panel-b-height' ||
  kind === 'corner-angle';

/**
 * Radius of the floor protractor arc the angle tab rides (mm). A fixed
 * sweep hugging the seam — a drafting mark, not hardware — shrunk only when
 * panel B is too narrow to contain it.
 */
export const ANGLE_ARC_RADIUS_MM = 150;

export function angleHandleRadiusMm(panelBWidthMm: number): number {
  return Math.min(ANGLE_ARC_RADIUS_MM, panelBWidthMm * 0.8);
}

/** World position of each corner handle for a corner spec (mm). */
export function cornerHandleWorldMm(
  corner: CornerSpec,
): Record<CornerDragKind, Vec3> {
  const { panelA: a, panelB: b } = corner;
  const dirB = panelBDirMm(corner.angleDeg);
  const rB = angleHandleRadiusMm(b.widthMm);
  return {
    'panel-a-width': [a.widthMm, a.heightMm / 2, 0],
    'panel-b-width': [dirB[0] * b.widthMm, b.heightMm / 2, dirB[2] * b.widthMm],
    'panel-a-height': [a.widthMm, a.heightMm, 0],
    'panel-b-height': [dirB[0] * b.widthMm, b.heightMm, dirB[2] * b.widthMm],
    // The angle tab sits on the floor at the arc's panel-B end — its
    // azimuth IS the interior angle.
    'corner-angle': [dirB[0] * rB, 0, dirB[2] * rB],
  };
}

/**
 * Raw (unclamped) constraint parameter under the ray for a corner drag, or
 * null on a miss. Width solves ride the horizontal rail through the seam at
 * the handle's mid-height; height solves ride the vertical line at the
 * panel's outer edge; the angle solve is the azimuth on the floor plane the
 * protractor arc lies on, so the tab tracks the pointer exactly. `corner`
 * is the pointerdown snapshot — the constraint never moves mid-gesture.
 */
export function solveCornerDragRaw(
  kind: CornerDragKind,
  corner: CornerSpec,
  ray: DragRay,
): number | null {
  const { panelA: a, panelB: b } = corner;
  switch (kind) {
    case 'panel-a-width':
      return closestLineParam(ray, [0, a.heightMm / 2, 0], [1, 0, 0]);
    case 'panel-b-width':
      return closestLineParam(
        ray,
        [0, b.heightMm / 2, 0],
        panelBDirMm(corner.angleDeg),
      );
    case 'panel-a-height':
      return closestLineParam(ray, [a.widthMm, 0, 0], WORLD_UP);
    case 'panel-b-height': {
      const dirB = panelBDirMm(corner.angleDeg);
      return closestLineParam(
        ray,
        [dirB[0] * b.widthMm, 0, dirB[2] * b.widthMm],
        WORLD_UP,
      );
    }
    case 'corner-angle': {
      const p = intersectHorizontalPlane(ray, 0);
      return p ? seamAzimuthDeg(p) : null;
    }
  }
}

/** Apply `start + (raw − ref0)` for a corner drag and clamp into range. */
export function resolveCornerDrag(
  kind: CornerDragKind,
  corner: CornerSpec,
  ref0: number,
  raw: number,
): number {
  switch (kind) {
    case 'panel-a-width':
      return clampPanelMm(corner.panelA.widthMm + raw - ref0);
    case 'panel-b-width':
      return clampPanelMm(corner.panelB.widthMm + raw - ref0);
    case 'panel-a-height':
      return clampPanelMm(corner.panelA.heightMm + raw - ref0);
    case 'panel-b-height':
      return clampPanelMm(corner.panelB.heightMm + raw - ref0);
    case 'corner-angle':
      return clampInteriorAngleDeg(
        corner.angleDeg + wrapDeltaDeg(raw - ref0),
      );
  }
}

/** The committed field a corner drag writes (full sub-objects for merging). */
export function cornerDragPatch(
  kind: CornerDragKind,
  corner: CornerSpec,
  value: number,
): Partial<CornerSpec> {
  switch (kind) {
    case 'panel-a-width':
      return { panelA: { ...corner.panelA, widthMm: value } };
    case 'panel-b-width':
      return { panelB: { ...corner.panelB, widthMm: value } };
    case 'panel-a-height':
      return { panelA: { ...corner.panelA, heightMm: value } };
    case 'panel-b-height':
      return { panelB: { ...corner.panelB, heightMm: value } };
    case 'corner-angle':
      return { angleDeg: value };
  }
}

/** The committed value a corner drag started from (for no-op detection). */
export function cornerDragStartValue(
  kind: CornerDragKind,
  corner: CornerSpec,
): number {
  switch (kind) {
    case 'panel-a-width':
      return corner.panelA.widthMm;
    case 'panel-b-width':
      return corner.panelB.widthMm;
    case 'panel-a-height':
      return corner.panelA.heightMm;
    case 'panel-b-height':
      return corner.panelB.heightMm;
    case 'corner-angle':
      return corner.angleDeg;
  }
}

/**
 * Raw (unclamped) constraint value under the ray for a viewpoint drag:
 * eye-floor returns the floor-plane point as [x, z]; the vertical drags
 * return the height parameter on their line. `eyeMm` is the pointerdown
 * snapshot so the stalk's vertical line stays put mid-gesture.
 */
export function solveViewpointDragRaw(
  kind: ViewpointDragKind,
  eyeMm: Vec3,
  ray: DragRay,
): number | Vec2 | null {
  switch (kind) {
    case 'eye-floor': {
      const p = intersectHorizontalPlane(ray, 0);
      return p ? [p[0], p[2]] : null;
    }
    case 'eye-height':
      return closestLineParam(ray, [eyeMm[0], 0, eyeMm[2]], WORLD_UP);
    case 'aim-height':
      return closestLineParam(ray, [0, 0, 0], WORLD_UP);
  }
}

/** Apply `start + (raw − ref0)` for a viewpoint drag and clamp into range. */
export function resolveViewpointDrag(
  kind: ViewpointDragKind,
  start: { readonly eyeMm: Vec3; readonly aimHeightMm: number },
  ref0: number | Vec2,
  raw: number | Vec2,
): { readonly eyeMm?: Vec3; readonly aimHeightMm?: number } {
  switch (kind) {
    case 'eye-floor': {
      const from = ref0 as Vec2;
      const to = raw as Vec2;
      return {
        eyeMm: [
          clampEyeCoordMm(start.eyeMm[0] + to[0] - from[0]),
          start.eyeMm[1],
          clampEyeCoordMm(start.eyeMm[2] + to[1] - from[1]),
        ],
      };
    }
    case 'eye-height':
      return {
        eyeMm: [
          start.eyeMm[0],
          clampEyeHeightMm(
            start.eyeMm[1] + (raw as number) - (ref0 as number),
          ),
          start.eyeMm[2],
        ],
      };
    case 'aim-height':
      return {
        aimHeightMm: clampAimHeightMm(
          start.aimHeightMm + (raw as number) - (ref0 as number),
        ),
      };
  }
}
