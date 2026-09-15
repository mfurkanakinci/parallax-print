import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { projectSurfacePolygon } from '../core/geometry/camera';
import type {
  ArtworkSpec,
  CompiledScene,
  Vec2,
} from '../core/types';
import type { PreviewStatus } from '../state/jobController';
import {
  artworkCorners,
  moveArtwork,
  rotateArtwork,
  samePlacement,
  scaleArtwork,
  screenToSlope,
  slopeScale,
  slopeToScreen,
  type GestureKind,
  type GestureSnapshot,
  type RotateGestureSnapshot,
  type ScaleGestureSnapshot,
  type ViewportSize,
} from './artworkGesture';

/**
 * The direct-manipulation contract EditorPage hands the resolved viewport
 * (§12.1, §12.6). `enabled` is false while the artwork is locked — the
 * frame outline and ghost stay visible but the handles disappear.
 */
export interface ArtworkEditContract {
  readonly enabled: boolean;
  readonly artwork: ArtworkSpec;
  /** widthPx / heightPx of the normalized source — derives widthSlope. */
  readonly sourceAspect: number;
  readonly assetBlob: Blob;
  readonly previewStatus: PreviewStatus;
  readonly onCommit: (next: ArtworkSpec) => void;
}

interface ActiveGesture {
  readonly kind: GestureKind;
  readonly pointerId: number;
  /** The hit element that owns pointer capture for this gesture. */
  readonly captureTarget: SVGElement;
  readonly snapshot:
    | GestureSnapshot
    | ScaleGestureSnapshot
    | RotateGestureSnapshot;
  latest: ArtworkSpec;
}

/** Perimeter order in slope space: BL, BR, TR, TL. */
const CORNER_SIGNS = [
  { sx: -1, sy: -1 },
  { sx: 1, sy: -1 },
  { sx: 1, sy: 1 },
  { sx: -1, sy: 1 },
] as const;

const IDLE_GHOST_OPACITY = 0.26;
const ACTIVE_GHOST_OPACITY = 0.8;
/**
 * While the GPU projector is showing the warped draft on the surfaces the
 * flat ghost fill steps back to a faint presence — the dashed frame and
 * handles stay full-strength so the manipulation target never disappears.
 */
const PROJECTING_GHOST_OPACITY = 0.12;
const HANDLE_HIT_RADIUS = 22; // 44px touch target
const ROTATE_HANDLE_GAP_PX = 26;

export function ArtworkEditOverlay({
  contract,
  scene,
  frame,
  onDraft,
}: {
  readonly contract: ArtworkEditContract;
  readonly scene: CompiledScene;
  readonly frame: ViewportSize & { readonly fovDeg: number };
  /**
   * Live-gesture feed for the viewport's GPU projector: the current draft
   * spec on every pointermove, `null` on release and on every cancel path.
   * Kept off the contract so ArtworkEditContract stays commit-only (§12.5).
   */
  readonly onDraft?: ((spec: ArtworkSpec | null) => void) | undefined;
}) {
  const clipId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const gestureRef = useRef<ActiveGesture | null>(null);
  const onDraftRef = useRef(onDraft);
  useEffect(() => {
    onDraftRef.current = onDraft;
  });
  const [draft, setDraft] = useState<ArtworkSpec | null>(null);
  const [gestureKind, setGestureKind] = useState<GestureKind | null>(null);
  const [ghostHold, setGhostHold] = useState(false);
  const sawUpdating = useRef(false);

  const releasePointerCapture = useCallback((gesture: ActiveGesture | null) => {
    if (!gesture) return;
    try {
      if (gesture.captureTarget.hasPointerCapture(gesture.pointerId)) {
        gesture.captureTarget.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      // Pointer capture may already have been released by the browser.
    }
  }, []);

  // If the overlay unmounts mid-gesture (mode switch, contract removal), drop
  // both the live projection and the pointer capture with it.
  useEffect(
    () => () => {
      const gesture = gestureRef.current;
      gestureRef.current = null;
      releasePointerCapture(gesture);
      onDraftRef.current?.(null);
    },
    [releasePointerCapture],
  );

  const size: ViewportSize = { width: frame.width, height: frame.height };
  const active = draft ?? contract.artwork;
  const widthSlope = active.heightSlope * contract.sourceAspect;
  const scale = slopeScale(size, frame.fovDeg);

  // Managed object URL for the normalized source — revoked on replacement
  // and unmount (§12.6).
  const objectUrl = useMemo(
    () => URL.createObjectURL(contract.assetBlob),
    [contract.assetBlob],
  );
  useEffect(() => () => URL.revokeObjectURL(objectUrl), [objectUrl]);

  // The ghost stays raised after release while the matching preview is
  // still rendering; once an updating→ready (or error) cycle completes the
  // hold drops and the CSS opacity transition fades it back to idle (§12.4).
  useEffect(() => {
    if (contract.previewStatus === 'updating') sawUpdating.current = true;
    if (!ghostHold) return;
    const finished =
      sawUpdating.current &&
      (contract.previewStatus === 'ready' ||
        contract.previewStatus === 'error');
    if (!finished) return;
    sawUpdating.current = false;
    const timer = window.setTimeout(() => setGhostHold(false), 0);
    return () => window.clearTimeout(timer);
  }, [contract.previewStatus, ghostHold]);

  const pointerScreen = (e: {
    readonly clientX: number;
    readonly clientY: number;
  }): Vec2 => {
    const rect = svgRef.current?.getBoundingClientRect();
    return [
      e.clientX - (rect?.left ?? 0),
      e.clientY - (rect?.top ?? 0),
    ];
  };

  const cancelGesture = useCallback(() => {
    // Restores the starting placement without committing — the draft is
    // simply dropped (§12.5 pointer cancel / lost capture / Escape).
    const gesture = gestureRef.current;
    gestureRef.current = null;
    releasePointerCapture(gesture);
    setGestureKind(null);
    setDraft(null);
    onDraftRef.current?.(null);
  }, [releasePointerCapture]);

  // Locking placement is a presentation-only state change, but it must also
  // terminate an active pointer gesture. Otherwise a pointerup after the lock
  // transition could still commit the stale draft through the old snapshot.
  useEffect(() => {
    if (contract.enabled) return;
    let live = true;
    queueMicrotask(() => {
      if (live) cancelGesture();
    });
    return () => {
      live = false;
    };
  }, [contract.enabled, cancelGesture]);

  const beginGesture = (
    kind: GestureKind,
    e: React.PointerEvent<SVGElement>,
    corner?: { readonly sx: 1 | -1; readonly sy: 1 | -1 },
  ) => {
    if (!contract.enabled || gestureRef.current) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic/test pointers and a just-removed target may not support
      // capture; the local draft contract still remains safe.
    }
    const screen = pointerScreen(e);
    const base: GestureSnapshot = {
      artwork: contract.artwork,
      widthSlope: contract.artwork.heightSlope * contract.sourceAspect,
      viewport: size,
      fovDeg: frame.fovDeg,
      startScreen: screen,
      startSlope: screenToSlope(screen, size, frame.fovDeg),
    };
    let snapshot: ActiveGesture['snapshot'] = base;
    if (kind === 'scale' && corner) {
      snapshot = { ...base, corner };
    } else if (kind === 'rotate') {
      const startAngleDeg =
        (Math.atan2(
          base.startSlope[1] - contract.artwork.centerSlope[1],
          base.startSlope[0] - contract.artwork.centerSlope[0],
        ) *
          180) /
        Math.PI;
      snapshot = { ...base, startAngleDeg };
    }
    gestureRef.current = {
      kind,
      pointerId: e.pointerId,
      captureTarget: e.currentTarget,
      snapshot,
      latest: contract.artwork,
    };
    setGestureKind(kind);
  };

  const onPointerMove = (e: React.PointerEvent<SVGElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const screen = pointerScreen(e);
    const next =
      gesture.kind === 'move'
        ? moveArtwork(gesture.snapshot, screen)
        : gesture.kind === 'scale'
          ? scaleArtwork(gesture.snapshot as ScaleGestureSnapshot, screen)
          : rotateArtwork(
              gesture.snapshot as RotateGestureSnapshot,
              screen,
            );
    gesture.latest = next;
    setDraft(next);
    onDraftRef.current?.(next);
  };

  const onPointerUp = (e: React.PointerEvent<SVGElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    // Contract changes (lock, replacement, or an external project update)
    // invalidate the snapshot even if React has not run the cancellation
    // effect before this pointerup is delivered.
    if (!contract.enabled || gesture.snapshot.artwork !== contract.artwork) {
      cancelGesture();
      return;
    }
    gestureRef.current = null;
    releasePointerCapture(gesture);
    setGestureKind(null);
    setDraft(null);
    onDraftRef.current?.(null);
    // One commit per completed gesture, only when values changed (§12.6).
    if (!samePlacement(gesture.latest, gesture.snapshot.artwork)) {
      sawUpdating.current = false;
      setGhostHold(true);
      contract.onCommit(gesture.latest);
    }
  };

  // Escape restores the starting values without committing.
  useEffect(() => {
    if (!gestureKind) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelGesture();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gestureKind, cancelGesture]);

  const toScreen = (slope: Vec2): Vec2 =>
    slopeToScreen(slope, size, frame.fovDeg);

  // Surface polygons projected into the same camera basis as the proof —
  // these form the ghost's clip path (§12.4).
  const clipPolygons = scene.surfaces
    .map((compiled) =>
      projectSurfacePolygon(scene.camera, compiled.surface)
        .filter((s): s is Vec2 => s !== null)
        .map(toScreen),
    )
    .filter((points) => points.length >= 3);

  const corners = artworkCorners(active, widthSlope).map(toScreen);
  const center = toScreen(active.centerSlope);
  const polygonPoints = corners.map((p) => `${p[0]},${p[1]}`).join(' ');

  const rad = (active.rotationDeg * Math.PI) / 180;
  const halfH = active.heightSlope / 2;
  const gapSlope = ROTATE_HANDLE_GAP_PX / scale;
  const topMid = toScreen([
    active.centerSlope[0] - Math.sin(rad) * halfH,
    active.centerSlope[1] + Math.cos(rad) * halfH,
  ]);
  const rotateHandle = toScreen([
    active.centerSlope[0] - Math.sin(rad) * (halfH + gapSlope),
    active.centerSlope[1] + Math.cos(rad) * (halfH + gapSlope),
  ]);

  const ghostW = widthSlope * scale;
  const ghostH = active.heightSlope * scale;
  const ghostActive = gestureKind !== null || ghostHold;
  const ghostOpacity =
    draft !== null
      ? PROJECTING_GHOST_OPACITY
      : ghostActive
        ? ACTIVE_GHOST_OPACITY
        : IDLE_GHOST_OPACITY;

  const hitHandlers = {
    onPointerMove,
    onPointerUp,
    onPointerCancel: cancelGesture,
    onLostPointerCapture: cancelGesture,
  };

  return (
    <svg
      ref={svgRef}
      className="artwork-overlay"
      data-gesture={gestureKind ?? undefined}
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={clipId}>
          {clipPolygons.map((points, i) => (
            <polygon
              key={i}
              points={points.map((p) => `${p[0]},${p[1]}`).join(' ')}
            />
          ))}
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
          <image
            href={objectUrl}
            x={center[0] - ghostW / 2}
            y={center[1] - ghostH / 2}
            width={ghostW}
            height={ghostH}
            preserveAspectRatio="none"
            opacity={ghostOpacity}
            className="artwork-ghost"
            transform={`rotate(${-active.rotationDeg} ${center[0]} ${center[1]})`}
          />
        </g>

      {/* Selection outline — outside the clip path. */}
      <polygon
        className="artwork-frame-outline"
        points={polygonPoints}
        fill="none"
      />

      {contract.enabled ? (
        <>
          {/* Move: transparent frame-body hit area. */}
          <polygon
            className="artwork-hit artwork-hit-move"
            points={polygonPoints}
            fill="transparent"
            {...hitHandlers}
            onPointerDown={(e) => beginGesture('move', e)}
          />

          {/* Uniform scale: four corner marks with invisible 44px hits. */}
          {corners.map((corner, i) => {
            const dx = corner[0] - center[0];
            const dy = corner[1] - center[1];
            const cursor = dx * dy < 0 ? 'nesw-resize' : 'nwse-resize';
            return (
              <g key={i}>
                <rect
                  className="artwork-corner-mark"
                  x={corner[0] - 5}
                  y={corner[1] - 5}
                  width={10}
                  height={10}
                />
                <circle
                  className="artwork-hit artwork-hit-scale"
                  cx={corner[0]}
                  cy={corner[1]}
                  r={HANDLE_HIT_RADIUS}
                  fill="transparent"
                  style={{ cursor }}
                  {...hitHandlers}
                  onPointerDown={(e) =>
                    beginGesture('scale', e, CORNER_SIGNS[i])
                  }
                />
              </g>
            );
          })}

          {/* Rotate: one handle above the top edge joined by a thin rule. */}
          <line
            className="artwork-rotate-rule"
            x1={topMid[0]}
            y1={topMid[1]}
            x2={rotateHandle[0]}
            y2={rotateHandle[1]}
          />
          <circle
            className="artwork-rotate-mark"
            cx={rotateHandle[0]}
            cy={rotateHandle[1]}
            r={7}
          />
          <circle
            className="artwork-hit artwork-hit-rotate"
            cx={rotateHandle[0]}
            cy={rotateHandle[1]}
            r={HANDLE_HIT_RADIUS}
            fill="transparent"
            {...hitHandlers}
            onPointerDown={(e) => beginGesture('rotate', e)}
          />
          {gestureKind === 'rotate' ? (
            <text
              className="artwork-rotate-readout"
              x={rotateHandle[0] + 12}
              y={rotateHandle[1] - 10}
            >
              {`${active.rotationDeg.toFixed(0)}°`}
            </text>
          ) : null}
        </>
      ) : null}
    </svg>
  );
}
