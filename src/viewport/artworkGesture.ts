import { LIMITS } from '../core/limits';
import type { ArtworkSpec, Vec2 } from '../core/types';

/**
 * Pure pointer/screen math for the resolved-view artwork overlay (§12.3,
 * §12.5). Everything here is deterministic and DOM-free so the gesture
 * behavior is unit-testable without a browser.
 */

export interface ViewportSize {
  readonly width: number;
  readonly height: number;
}

const RAD_PER_DEG = Math.PI / 180;

/** Pixels per slope unit — identical on both axes (§12.3). */
export function slopeScale(viewport: ViewportSize, fovDeg: number): number {
  return viewport.height / (2 * Math.tan((fovDeg * RAD_PER_DEG) / 2));
}

export function slopeToScreen(
  slope: Vec2,
  viewport: ViewportSize,
  fovDeg: number,
): Vec2 {
  const scale = slopeScale(viewport, fovDeg);
  return [
    viewport.width / 2 + slope[0] * scale,
    viewport.height / 2 - slope[1] * scale,
  ];
}

export function screenToSlope(
  screen: Vec2,
  viewport: ViewportSize,
  fovDeg: number,
): Vec2 {
  const scale = slopeScale(viewport, fovDeg);
  return [
    (screen[0] - viewport.width / 2) / scale,
    (viewport.height / 2 - screen[1]) / scale,
  ];
}

/** Wraps to −180 inclusive … 180 exclusive (§12.5). */
export function wrapRotationDeg(deg: number): number {
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

export const clampCenterSlope = (v: number): number =>
  Math.min(
    LIMITS.artworkSlope.centerAbsMax,
    Math.max(-LIMITS.artworkSlope.centerAbsMax, v),
  );

export const clampHeightSlope = (v: number): number =>
  Math.min(
    LIMITS.artworkSlope.heightMax,
    Math.max(LIMITS.artworkSlope.heightMin, v),
  );

/** Perimeter signs in slope space: BL, BR, TR, TL. */
const PERIMETER_SIGNS: readonly (readonly [1 | -1, 1 | -1])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

/** Frame corners in slope space, §12.3's convention (sx, sy ∈ {−1, 1}). */
export function artworkCorners(
  spec: ArtworkSpec,
  widthSlope: number,
): readonly Vec2[] {
  const hw = Math.abs(widthSlope) / 2;
  const hh = Math.abs(spec.heightSlope) / 2;
  const rad = spec.rotationDeg * RAD_PER_DEG;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const [cx, cy] = spec.centerSlope;
  return PERIMETER_SIGNS.map(([sx, sy]) => [
    cx + c * sx * hw - s * sy * hh,
    cy + s * sx * hw + c * sy * hh,
  ]);
}

export type GestureKind = 'move' | 'scale' | 'rotate';

/**
 * Everything a gesture needs, frozen at pointerdown — the FOV and viewport
 * are never recomputed mid-gesture (§12.5 step 1).
 */
export interface GestureSnapshot {
  readonly artwork: ArtworkSpec;
  readonly widthSlope: number;
  readonly viewport: ViewportSize;
  readonly fovDeg: number;
  readonly startScreen: Vec2;
  readonly startSlope: Vec2;
}

export interface ScaleGestureSnapshot extends GestureSnapshot {
  readonly corner: { readonly sx: 1 | -1; readonly sy: 1 | -1 };
}

export interface RotateGestureSnapshot extends GestureSnapshot {
  /** Pointer angle around the frame centre at pointerdown, degrees. */
  readonly startAngleDeg: number;
}

const pointerAngleDeg = (from: Vec2, to: Vec2): number =>
  (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;

/** Move: screen delta → slope delta via the frozen scale (§12.5). */
export function moveArtwork(
  snapshot: GestureSnapshot,
  pointerScreen: Vec2,
): ArtworkSpec {
  const scale = slopeScale(snapshot.viewport, snapshot.fovDeg);
  const dx = (pointerScreen[0] - snapshot.startScreen[0]) / scale;
  const dy = -(pointerScreen[1] - snapshot.startScreen[1]) / scale;
  const [cx, cy] = snapshot.artwork.centerSlope;
  return {
    ...snapshot.artwork,
    centerSlope: [clampCenterSlope(cx + dx), clampCenterSlope(cy + dy)],
  };
}

/**
 * Uniform scale about the frame centre: the pointer's distance along the
 * starting corner diagonal relative to the original corner distance (§12.5).
 * Width follows height through the source aspect, so the ratio is preserved
 * by construction.
 */
export function scaleArtwork(
  snapshot: ScaleGestureSnapshot,
  pointerScreen: Vec2,
): ArtworkSpec {
  const pointer = screenToSlope(
    pointerScreen,
    snapshot.viewport,
    snapshot.fovDeg,
  );
  const center = snapshot.artwork.centerSlope;
  const rad = snapshot.artwork.rotationDeg * RAD_PER_DEG;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const hw = Math.abs(snapshot.widthSlope) / 2;
  const hh = Math.abs(snapshot.artwork.heightSlope) / 2;
  // Starting corner offset from the centre (§12.3 convention).
  const cornerOffset: Vec2 = [
    c * snapshot.corner.sx * hw - s * snapshot.corner.sy * hh,
    s * snapshot.corner.sx * hw + c * snapshot.corner.sy * hh,
  ];
  const startDist = Math.hypot(cornerOffset[0], cornerOffset[1]);
  if (startDist <= 0) return snapshot.artwork;
  const unit: Vec2 = [cornerOffset[0] / startDist, cornerOffset[1] / startDist];
  const along =
    (pointer[0] - center[0]) * unit[0] + (pointer[1] - center[1]) * unit[1];
  const factor = along / startDist;
  return {
    ...snapshot.artwork,
    heightSlope: clampHeightSlope(snapshot.artwork.heightSlope * factor),
  };
}

/** Rotate: pointer angle around the centre minus the starting offset. */
export function rotateArtwork(
  snapshot: RotateGestureSnapshot,
  pointerScreen: Vec2,
): ArtworkSpec {
  const pointer = screenToSlope(
    pointerScreen,
    snapshot.viewport,
    snapshot.fovDeg,
  );
  const angle = pointerAngleDeg(snapshot.artwork.centerSlope, pointer);
  return {
    ...snapshot.artwork,
    rotationDeg: wrapRotationDeg(
      snapshot.artwork.rotationDeg + angle - snapshot.startAngleDeg,
    ),
  };
}

/** True when a gesture result is worth committing (not a no-op). */
export function samePlacement(a: ArtworkSpec, b: ArtworkSpec): boolean {
  return (
    a.assetId === b.assetId &&
    a.centerSlope[0] === b.centerSlope[0] &&
    a.centerSlope[1] === b.centerSlope[1] &&
    a.heightSlope === b.heightSlope &&
    a.rotationDeg === b.rotationDeg
  );
}
