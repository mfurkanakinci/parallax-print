import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import '../styles/viewport-presentation.css';
import {
  resolvedVerticalFovDeg,
  surfaceSlopeExtent,
} from '../core/geometry/camera';
import {
  buildArtworkFrame,
  buildSurfaceHomography,
} from '../core/geometry/homography';
import { surfaceUvToWorld } from '../core/geometry/surfaces';
import {
  cornerDragPatch,
  cornerDragStartValue,
  isCornerDragKind,
  resolveCornerDrag,
  resolveViewpointDrag,
  solveCornerDragRaw,
  solveViewpointDragRaw,
  type CornerDragKind,
  type SceneDragKind,
  type ViewpointDragKind,
  type DragRay,
} from '../core/geometry/dragSolve';
import type {
  ArtworkSpec,
  CompiledScene,
  CornerSpec,
  PreviewSurfaceResult,
  SurfaceId,
  Vec2,
  Vec3,
} from '../core/types';
import {
  ArtworkEditOverlay,
  type ArtworkEditContract,
} from './ArtworkEditOverlay';
import {
  buildArchitecture,
  disposeArchitecture,
  makeArchitectureMaterials,
  setMountShadowsVisible,
  STAGE_BACKGROUND,
  type ArchitectureMaterials,
} from './architecture';
import { setDraftProjectionVisible } from './draftVisibility';
import {
  buildViewingFigure,
  frameViewingFigureInOrbit,
  positionViewingFigure,
  viewingFigureVisible,
  type ViewingFigure,
} from './viewingFigure';
import {
  buildCornerHandles,
  buildViewpointHandles,
  ghostCornersA,
  ghostCornersB,
  layoutCornerHandles,
  layoutViewpointHandles,
  makeGhost,
  setGhostRect,
  type CornerEditContract,
  type ViewpointEditContract,
  type ViewpointHandleNodes,
} from './sceneHandles';

const PAPER_WHITE = '#fdfcf8';

/**
 * Runtime availability of the WebGL viewport.
 * - probing: renderer not yet created (initial mount).
 * - ready: a live context is rendering.
 * - lost: the context was lost at runtime; rendering is paused and the UI
 *   announces the interruption until `webglcontextrestored` arrives.
 * - unavailable: context creation failed at startup (terminal — remount to
 *   retry).
 */
export type SpatialAvailability =
  | 'probing'
  | 'ready'
  | 'lost'
  | 'unavailable';

export type SpatialAvailabilityEvent =
  | 'ready'
  | 'failed'
  | 'lost'
  | 'restored';

export function spatialAvailabilityReducer(
  state: SpatialAvailability,
  event: SpatialAvailabilityEvent,
): SpatialAvailability {
  switch (event) {
    case 'ready':
      return state === 'probing' ? 'ready' : state;
    case 'failed':
      return state === 'probing' ? 'unavailable' : state;
    case 'lost':
      return state === 'ready' ? 'lost' : state;
    case 'restored':
      return state === 'lost' ? 'ready' : state;
  }
}

/**
 * A hidden mobile preview reports a zero-sized client box. Keeping that size
 * out of the renderer prevents a collapse from changing the camera's FOV or
 * replacing a useful frame with a 1×1 canvas; the next non-zero resize restores
 * the presentation without touching scene/document state.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function usableViewportSize(
  width: number,
  height: number,
): { readonly width: number; readonly height: number } | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 2 ||
    height < 2
  ) {
    return null;
  }
  return { width, height };
}

/** A single continuation decision keeps Orbit's RAF scheduler idempotent. */
// eslint-disable-next-line react-refresh/only-export-components
export function orbitNeedsAnotherFrame(
  mode: 'resolved' | 'orbit',
  contextLost: boolean,
  controlsMoving: boolean,
): boolean {
  return mode === 'orbit' && !contextLost && controlsMoving;
}

/**
 * The preview raster uploaded as the proof texture. The raster's alpha is
 * the real coverage (0 outside the printable footprint); it is NOT
 * pre-composited over paper — the proof shader composites over the paper
 * colour so uncovered wall area can discard to the plaster underneath
 * (AMENDMENTS.md §A).
 */
function previewCanvas(preview: PreviewSurfaceResult): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = preview.widthPx;
  canvas.height = preview.heightPx;
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(
    new ImageData(
      new Uint8ClampedArray(preview.pixels),
      preview.widthPx,
      preview.heightPx,
    ),
    0,
    0,
  );
  return canvas;
}

function makeLabelSprite(text: string, color = '#242724'): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = '600 40px "Instrument Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false }),
  );
  sprite.scale.set(90, 90, 1);
  return sprite;
}

function surfaceGeometry(
  compiled: CompiledScene['surfaces'][number],
  preview: PreviewSurfaceResult | null,
  polygon: readonly Vec2[] = compiled.surface.polygonMm,
): THREE.BufferGeometry {
  const { surface } = compiled;
  const bounds = surface.boundsMm;
  const texWidthMm = preview ? preview.widthPx * preview.mmPerPixel : bounds.width;
  const texHeightMm = preview
    ? preview.heightPx * preview.mmPerPixel
    : bounds.height;
  const positions: number[] = [];
  const uvs: number[] = [];
  // Raw surface-local millimetre UVs for the draft projector — the existing
  // `uv` attribute is normalized into the preview texture's extent with a
  // V flip, so the homography cannot consume it directly.
  const surfUvs: number[] = [];
  for (let i = 1; i < polygon.length - 1; i += 1) {
    for (const uv of [polygon[0]!, polygon[i]!, polygon[i + 1]!]) {
      const w = surfaceUvToWorld(surface, uv);
      positions.push(w[0], w[1], w[2]);
      uvs.push(
        (uv[0] - bounds.x) / texWidthMm,
        1 - (bounds.y + bounds.height - uv[1]) / texHeightMm,
      );
      surfUvs.push(uv[0], uv[1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute(
    'surfUv',
    new THREE.Float32BufferAttribute(surfUvs, 2),
  );
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The settled proof path (AMENDMENTS.md §A): the footprint-shaped mesh
 * samples the real raster; its alpha is the actual coverage, composited
 * over paper white — so transparent source pixels still print white while
 * anything outside the printable footprint has no geometry at all and the
 * plaster wall shows through. Unlit and colour-neutral by construction:
 * architectural lighting never touches the proof.
 */
const PROOF_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PROOF_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uPaper;
  uniform float uHasMap;
  varying vec2 vUv;
  void main() {
    vec4 tex = texture2D(uMap, vUv);
    float cover = tex.a * uHasMap;
    gl_FragColor = vec4(mix(uPaper, tex.rgb, cover), 1.0);
    #include <colorspace_fragment>
  }
`;

function makeProofMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null as THREE.Texture | null },
      uPaper: { value: new THREE.Color(PAPER_WHITE) },
      uHasMap: { value: 0 },
    },
    vertexShader: PROOF_VERTEX,
    fragmentShader: PROOF_FRAGMENT,
    side: THREE.DoubleSide,
    // The proof is the mounted paper — the front-most layer on the wall.
    // Coplanar junction/mount decals sit sub-millimetre behind it, which
    // is below depth resolution at room distances; the decal materials
    // pull themselves forward (−2), so the proof pulls further (−4) to
    // guarantee it can never be darkened by them.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

/**
 * Mid-drag artwork feedback (§12.5): each surface's draft mesh uses this
 * shader while a gesture is live. `uH` is the rasterizer's own
 * surface-mm-UV → source-UV homography (`buildSurfaceHomography`), so the
 * warped result is identical by construction — uv in [0,1] samples the
 * source; outside the draft frame it discards to the wall, matching the
 * settled footprint rule (AMENDMENTS.md §A). `s.z` is the camera-forward
 * depth (third row of surfaceToImagePlane); non-positive means behind the
 * eye → discard.
 */
const PROJECTOR_VERTEX = /* glsl */ `
  attribute vec2 surfUv;
  varying vec2 vSurfUv;
  void main() {
    vSurfUv = surfUv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PROJECTOR_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform mat3 uH;
  uniform vec3 uPaper;
  uniform float uHasMap;
  varying vec2 vSurfUv;
  void main() {
    vec3 s = uH * vec3(vSurfUv, 1.0);
    vec2 uv = s.xy / s.z;
    bool inFrame =
      s.z > 0.0 &&
      uv.x >= 0.0 && uv.x <= 1.0 &&
      uv.y >= 0.0 && uv.y <= 1.0;
    if (!inFrame) discard;
    vec4 tex = texture2D(uMap, uv);
    float cover = tex.a * uHasMap;
    gl_FragColor = vec4(mix(uPaper, tex.rgb, cover), 1.0);
    #include <colorspace_fragment>
  }
`;

function makeProjectorMaterial(uH: THREE.Matrix3): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: null as THREE.Texture | null },
      uH: { value: uH },
      uPaper: { value: new THREE.Color(PAPER_WHITE) },
      uHasMap: { value: 0 },
    },
    vertexShader: PROJECTOR_VERTEX,
    fragmentShader: PROJECTOR_FRAGMENT,
    side: THREE.DoubleSide,
    // Same front-most ordering as the settled proof (−4 beats the decal
    // pull of −2) so live drafts are never darkened by junction decals.
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

interface ProjectorSlot {
  readonly material: THREE.ShaderMaterial;
  /** Row-major Mat3 bound as the uH uniform — refilled per draft move. */
  readonly uH: THREE.Matrix3;
}

/** GPU-side state for the live draft projection on the surface meshes. */
interface ArtworkProjector {
  /** Decoded from the contract's asset blob once, reused every gesture. */
  texture: THREE.Texture | null;
  /** The blob `texture` was decoded from (identity, not contents). */
  blob: Blob | null;
  /** draft mesh → its live projection material + homography uniform. */
  slots: Map<THREE.Mesh, ProjectorSlot>;
}

/** Diagnostics overlay: drafting grid and surface-letter labels. */
function setDiagnosticsVisible(
  handles: ViewportHandles,
  on: boolean,
): void {
  for (const child of handles.marksGroup.children) {
    if (child.userData.diagnostic) child.visible = on;
  }
}



/**
 * Refreshes every surface's draft uH from the current gesture draft — the
 * cheap mat3 path that mirrors the rasterizer exactly — and swaps the
 * surface groups to the live projection. A null spec (or a missing
 * scene/contract) restores the settled footprint presentation instead.
 */
function applyArtworkProjection(
  handles: ViewportHandles,
  spec: ArtworkSpec | null,
  scene: CompiledScene | null,
  contract: ArtworkEditContract | null | undefined,
): void {
  if (spec === null || !scene || !contract) {
    setDraftProjectionVisible(handles, false);
    return;
  }
  // Only the source ratio enters buildArtworkFrame's width, so the
  // contract's aspect is a complete stand-in for pixel metadata.
  const frame = buildArtworkFrame(spec, {
    assetId: spec.assetId,
    widthPx: contract.sourceAspect,
    heightPx: 1,
  });
  const projector = handles.projector;
  for (const group of handles.surfacesGroup.children) {
    const compiled = scene.surfaces.find(
      (s) => s.surface.id === (group.userData.surfaceId as SurfaceId),
    );
    if (!compiled) continue;
    for (const mesh of group.children as THREE.Mesh[]) {
      if (!mesh.isMesh || mesh.userData.role !== 'draft') continue;
      const slot = projector.slots.get(mesh);
      if (!slot) continue;
      const h = buildSurfaceHomography(compiled.surface, scene.camera, frame);
      // Matrix3.set takes row-major arguments — the same layout as Mat3 —
      // so uH * vec3(uv, 1) in the shader reproduces applyMat3 exactly.
      slot.uH.set(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]);
      slot.material.uniforms.uMap!.value = projector.texture;
      slot.material.uniforms.uHasMap!.value = projector.texture ? 1 : 0;
    }
  }
  setDraftProjectionVisible(handles, true);
}

/**
 * Resolved framing derives only from the projected surface polygons — never
 * from the artwork — so dragging the frame cannot move the camera under the
 * pointer (§12.2). Falls back to the historical 50° when nothing visible
 * projects.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolvedFovDegFor(
  scene: CompiledScene,
  aspect: number,
): number {
  const extent = surfaceSlopeExtent(
    scene.camera,
    scene.surfaces.map((compiled) => compiled.surface),
  );
  return extent ? resolvedVerticalFovDeg(extent, aspect) : 50;
}

function disposeChildren(group: THREE.Object3D): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeChildren(child);
    const withGeometry = child as THREE.Mesh;
    if (
      (withGeometry.isMesh ||
        (child as THREE.Line).isLine ||
        (child as THREE.LineSegments).isLineSegments) &&
      withGeometry.geometry
    ) {
      withGeometry.geometry.dispose();
    }
    const material = withGeometry.material as
      | THREE.Material
      | THREE.Material[]
      | undefined;
    const materials = Array.isArray(material)
      ? material
      : material
        ? [material]
        : [];
    for (const m of materials) {
      (m as THREE.MeshBasicMaterial).map?.dispose();
      m.dispose();
    }
  }
}

/**
 * A live scene-handle gesture. Mirrors the artwork overlay's contract
 * (§12.5): the spec snapshot and the raw constraint parameter are frozen at
 * pointerdown, pointermoves only move draft visuals, and pointerup lands at
 * most one commit.
 */
interface ActiveSceneDrag {
  readonly kind: SceneDragKind;
  readonly pointerId: number;
  /** Raw constraint parameter at pointerdown — the delta reference. */
  ref0: number | Vec2 | null;
  readonly startCorner: CornerSpec | null;
  readonly startEyeMm: Vec3 | null;
  readonly startAimMm: number | null;
  /** Latest resolved draft: number for scalar drags, Vec3 for the eye. */
  latest: number | Vec3 | null;
  changed: boolean;
}

const DRAG_CURSORS: Record<SceneDragKind, string> = {
  'panel-a-width': 'ew-resize',
  'panel-b-width': 'ew-resize',
  'panel-a-height': 'ns-resize',
  'panel-b-height': 'ns-resize',
  'corner-angle': 'grabbing',
  'eye-floor': 'grabbing',
  'eye-height': 'ns-resize',
  'aim-height': 'ns-resize',
};

interface ViewportHandles {
  renderer: THREE.WebGLRenderer;
  scene3: THREE.Scene;
  resolvedCam: THREE.PerspectiveCamera;
  orbitCam: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Decorative room shell — outside surfaces/marks/handles (§A). */
  archGroup: THREE.Group | null;
  /** Long-lived shared architectural materials (disposed at unmount). */
  archMaterials: ArchitectureMaterials;
  surfacesGroup: THREE.Group;
  marksGroup: THREE.Group;
  /** Edit handles and the draft ghost live here — never raycasts surfaces. */
  handlesGroup: THREE.Group;
  raycaster: THREE.Raycaster;
  /** dragKind → positioned node for every live edit handle. */
  handleNodes: Map<string, THREE.Object3D>;
  /** Draft panel outline for corner drags; hidden while idle. */
  ghost: THREE.LineSegments | null;
  viewNodes: ViewpointHandleNodes | null;
  /** Viewport-only person, with an eye anchor at the exact viewing coordinate. */
  viewingFigure: ViewingFigure | null;
  drag: ActiveSceneDrag | null;
  textures: Map<string, { texture: THREE.CanvasTexture; canvas: HTMLCanvasElement }>;
  /** Live draft-artwork projection state (see applyArtworkProjection). */
  projector: ArtworkProjector;
  /** Scheduled one-shot draw (resolved mode). */
  frameRaf: number;
  /** Perpetual draw loop id — only non-zero while Orbit is live. */
  orbitRaf: number;
  introRaf: number;
  introDone: boolean;
  contextLost: boolean;
  /** Camera inputs last used to initialise the two viewport cameras. */
  lastCameraKey: string | null;
  resizeObserver: ResizeObserver;
  /**
   * Single source of camera framing: derives the resolved FOV from the
   * current scene and mount aspect, assigns `resolvedCam.fov`, refreshes both
   * projection matrices, resizes the renderer, and publishes the same values
   * to `frame` so the overlay can never disagree with the camera (§12.2/§26).
   */
  updateFraming: () => void;
  invalidate: () => void;
  renderNow: () => void;
  ensureOrbitLoop: () => void;
  /** Cancel a live handle drag without committing (contract/mode change). */
  cancelSceneDrag: () => void;
  /** Projects handle nodes to element px and publishes data-handle-* attrs. */
  publishHandleAttrs: () => void;
  /** Removes stale automation/read-back attrs while the context is lost. */
  clearHandleAttrs: () => void;
  onLost: (e: Event) => void;
  onRestored: () => void;
  onPointerDownCapture: (e: Event) => void;
}

export function SpatialViewport({
  scene,
  previews,
  mode,
  artworkEditing,
  cornerEditing,
  viewpointEditing,
  introReveal = false,
  diagnostics = false,
  onUserOrbitIntent,
}: {
  readonly scene: CompiledScene | null;
  readonly previews: readonly PreviewSurfaceResult[] | null;
  readonly mode: 'resolved' | 'orbit';
  readonly artworkEditing?: ArtworkEditContract | undefined;
  readonly cornerEditing?: CornerEditContract | undefined;
  readonly viewpointEditing?: ViewpointEditContract | undefined;
  readonly introReveal?: boolean;
  /** Shows the drafting grid and diagnostic labels (hidden by default). */
  readonly diagnostics?: boolean;
  readonly onUserOrbitIntent?: (() => void) | undefined;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const handlesRef = useRef<ViewportHandles | null>(null);
  const sceneRef = useRef(scene);
  const modeRef = useRef(mode);
  const introRevealRef = useRef(introReveal);
  const orbitIntentRef = useRef(onUserOrbitIntent);
  const cornerEditingRef = useRef(cornerEditing);
  const viewpointEditingRef = useRef(viewpointEditing);
  const artworkEditingRef = useRef(artworkEditing);
  /** Live overlay draft while an artwork gesture runs — drives the projector. */
  const artworkDraftRef = useRef<ArtworkSpec | null>(null);
  const introCancelRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    sceneRef.current = scene;
    modeRef.current = mode;
    introRevealRef.current = introReveal;
    orbitIntentRef.current = onUserOrbitIntent;
    cornerEditingRef.current = cornerEditing;
    viewpointEditingRef.current = viewpointEditing;
    artworkEditingRef.current = artworkEditing;
  });
  const [availability, setAvailability] =
    useState<SpatialAvailability>('probing');
  const [frame, setFrame] = useState({ width: 0, height: 0, fovDeg: 50 });
  const diagnosticsRef = useRef(diagnostics);
  useEffect(() => {
    diagnosticsRef.current = diagnostics;
  }, [diagnostics]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const dispatch = (event: SpatialAvailabilityEvent) =>
      setAvailability((prev) => spatialAvailabilityReducer(prev, event));
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      queueMicrotask(() => dispatch('failed'));
      return;
    }
    queueMicrotask(() => dispatch('ready'));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    // One bounded shadow map for the architectural shell. If the driver
    // refuses it, the scene simply renders unshadowed — never fatal (§A).
    try {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
    } catch {
      // Shadow-disabled fallback.
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const scene3 = new THREE.Scene();
    scene3.background = new THREE.Color(STAGE_BACKGROUND);
    const resolvedCam = new THREE.PerspectiveCamera(50, 1, 1, 2_000_000);
    resolvedCam.up.set(0, 1, 0);
    const orbitCam = new THREE.PerspectiveCamera(50, 1, 1, 2_000_000);
    orbitCam.up.set(0, 1, 0);
    const controls = new OrbitControls(orbitCam, renderer.domElement);
    controls.enableDamping =
      typeof matchMedia === 'function' &&
      !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const surfacesGroup = new THREE.Group();
    const marksGroup = new THREE.Group();
    const handlesGroup = new THREE.Group();
    scene3.add(surfacesGroup, marksGroup, handlesGroup);
    const raycaster = new THREE.Raycaster();
    const tmpWorld = new THREE.Vector3();
    const attrCache = new Map<string, string>();
    const clearHandleAttrs = (): void => {
      for (const key of attrCache.keys()) {
        if (key !== 'handles') mount.removeAttribute(`data-handle-${key}`);
      }
      attrCache.clear();
      mount.removeAttribute('data-handles');
    };
    const markTexturesForUpload = (root: THREE.Object3D | null): void => {
      root?.traverse((node) => {
        const material = (node as THREE.Mesh).material as
          | THREE.Material
          | THREE.Material[]
          | undefined;
        const materials = Array.isArray(material)
          ? material
          : material
            ? [material]
            : [];
        for (const current of materials) {
          const textured = current as THREE.Material & {
            map?: THREE.Texture | null;
            bumpMap?: THREE.Texture | null;
            alphaMap?: THREE.Texture | null;
          };
          if (textured.map) textured.map.needsUpdate = true;
          if (textured.bumpMap) textured.bumpMap.needsUpdate = true;
          if (textured.alphaMap) textured.alphaMap.needsUpdate = true;
        }
      });
    };

    const archMaterials = makeArchitectureMaterials();

    const handles: ViewportHandles = {
      renderer,
      scene3,
      resolvedCam,
      orbitCam,
      controls,
      archGroup: null,
      archMaterials,
      surfacesGroup,
      marksGroup,
      handlesGroup,
      raycaster,
      handleNodes: new Map(),
      ghost: null,
      viewNodes: null,
      viewingFigure: null,
      drag: null,
      textures: new Map(),
      projector: {
        texture: null,
        blob: null,
        slots: new Map(),
      },
      frameRaf: 0,
      orbitRaf: 0,
      introRaf: 0,
      introDone: false,
      contextLost: false,
      lastCameraKey: null,
      resizeObserver: new ResizeObserver(() => handles.updateFraming()),
      updateFraming: () => {
        const size = usableViewportSize(mount.clientWidth, mount.clientHeight);
        if (!size) return;
        const { width: w, height: h } = size;
        renderer.setSize(w, h);
        resolvedCam.aspect = w / h;
        orbitCam.aspect = w / h;
        const current = sceneRef.current;
        const fovDeg = current ? resolvedFovDegFor(current, w / h) : 50;
        resolvedCam.fov = fovDeg;
        resolvedCam.updateProjectionMatrix();
        orbitCam.updateProjectionMatrix();
        setFrame((previous) =>
          previous.width === w &&
          previous.height === h &&
          previous.fovDeg === fovDeg
            ? previous
            : { width: w, height: h, fovDeg },
        );
        handles.invalidate();
      },
      invalidate: () => {
        if (handles.frameRaf !== 0 || handles.contextLost) return;
        handles.frameRaf = requestAnimationFrame(() => {
          handles.frameRaf = 0;
          handles.renderNow();
        });
      },
      renderNow: () => {
        if (handles.contextLost) return;
        const cam = modeRef.current === 'orbit' ? orbitCam : resolvedCam;
        if (handles.viewingFigure) {
          handles.viewingFigure.root.visible = viewingFigureVisible(handles.viewingFigure, cam.position);
          const visible = String(handles.viewingFigure.root.visible);
          if (mount.dataset.viewerVisible !== visible) mount.dataset.viewerVisible = visible;
        }
        renderer.render(scene3, cam);
        handles.publishHandleAttrs();
      },
      ensureOrbitLoop: () => {
        if (handles.orbitRaf !== 0 || modeRef.current !== 'orbit') return;
        handles.orbitRaf = requestAnimationFrame(orbitTick);
      },
      cancelSceneDrag: () => {
        finishSceneDrag(false);
      },
      publishHandleAttrs: () => {
        const w = mount.clientWidth;
        const h = mount.clientHeight;
        if (w < 2 || h < 2) return;
        const cam = modeRef.current === 'orbit' ? orbitCam : resolvedCam;
        const seen: string[] = [];
        for (const [kind, node] of handles.handleNodes) {
          node.getWorldPosition(tmpWorld);
          tmpWorld.project(cam);
          const value = `${(((tmpWorld.x + 1) / 2) * w).toFixed(1)},${(
            ((1 - tmpWorld.y) / 2) *
            h
          ).toFixed(1)}`;
          seen.push(kind);
          if (attrCache.get(kind) !== value) {
            attrCache.set(kind, value);
            mount.setAttribute(`data-handle-${kind}`, value);
          }
        }
        seen.sort();
        const joined = seen.join(',');
        if (attrCache.get('handles') !== joined) {
          attrCache.set('handles', joined);
          if (joined) mount.setAttribute('data-handles', joined);
          else mount.removeAttribute('data-handles');
        }
        // Drop attrs for handles that no longer exist.
        for (const key of [...attrCache.keys()]) {
          if (key === 'handles') continue;
          if (!seen.includes(key)) {
            attrCache.delete(key);
            mount.removeAttribute(`data-handle-${key}`);
          }
        }
      },
      clearHandleAttrs,
      onLost: (e: Event) => {
        // preventDefault() is required for the context to be restorable.
        e.preventDefault();
        // A lost context cannot deliver a reliable pointerup. Drop any
        // in-flight scene gesture before pausing the canvas so it can never
        // commit stale geometry after restore.
        handles.contextLost = true;
        handles.cancelSceneDrag();
        clearHandleAttrs();
        dispatch('lost');
      },
      onRestored: () => {
        handles.contextLost = false;
        for (const entry of handles.textures.values()) {
          entry.texture.needsUpdate = true;
        }
        if (handles.projector.texture) {
          handles.projector.texture.needsUpdate = true;
        }
        // Three recreates the context lazily on the next draw. Mark both
        // shared room maps and per-footprint decal maps so the first restored
        // frame cannot show an untextured wall or stale mount shadow.
        handles.archMaterials.plaster.needsUpdate = true;
        handles.archMaterials.gradient.needsUpdate = true;
        markTexturesForUpload(handles.archGroup);
        // Surface-letter/Eye sprites and any future diagnostic marks own
        // their CanvasTextures outside the proof texture map as well.
        markTexturesForUpload(handles.marksGroup);
        markTexturesForUpload(handles.handlesGroup);
        dispatch('restored');
        // Draw once, and resume the Orbit loop only if Orbit is active.
        handles.invalidate();
        handles.ensureOrbitLoop();
      },
      onPointerDownCapture: (e: Event) => {
        introCancelRef.current?.();
        const pe = e as PointerEvent;
        // A press on an edit handle starts a scene drag — it must never fall
        // through to the orbit-intent path (which would flip Resolved →
        // Orbit out from under the gesture).
        if (pe.button === 0) {
          const kind = pickSceneDrag(pe);
          if (kind !== null && beginSceneDrag(kind, pe)) return;
        }
        if (orbitIntentRef.current && modeRef.current === 'resolved') {
          controls.enabled = true;
          orbitIntentRef.current();
        }
      },
    };
    handlesRef.current = handles;
    // Capture phase so OrbitControls' own bubble-phase pointerdown sees
    // enabled === true for this same event and the drag starts immediately.
    renderer.domElement.addEventListener(
      'pointerdown',
      handles.onPointerDownCapture,
      true,
    );
    renderer.domElement.addEventListener('webglcontextlost', handles.onLost);
    renderer.domElement.addEventListener(
      'webglcontextrestored',
      handles.onRestored,
    );

    // ——— Scene-handle dragging (§12-style commit-once gestures) ———
    // The pointer ray is rebuilt per event from the ACTIVE camera; the solve
    // itself is pure math in core/geometry/dragSolve.

    const rayForEvent = (e: PointerEvent): DragRay => {
      const rect = renderer.domElement.getBoundingClientRect();
      const nx =
        ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny =
        -(((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
      raycaster.setFromCamera(
        new THREE.Vector2(nx, ny),
        modeRef.current === 'orbit' ? orbitCam : resolvedCam,
      );
      const { origin, direction } = raycaster.ray;
      return {
        originMm: [origin.x, origin.y, origin.z],
        directionMm: [direction.x, direction.y, direction.z],
      };
    };

    /** Nearest tagged handle under the pointer, or null. */
    const pickSceneDrag = (e: PointerEvent): SceneDragKind | null => {
      if (handles.handleNodes.size === 0) return null;
      rayForEvent(e);
      const hits = raycaster.intersectObjects(handlesGroup.children, true);
      for (const hit of hits) {
        const kind = hit.object.userData.dragKind as
          | SceneDragKind
          | undefined;
        if (kind !== undefined) return kind;
      }
      return null;
    };

    // ——— Hover feedback: brighten the mark under the pointer and borrow
    // the drag cursor, so the marks read as interactive rather than
    // hardware. Only runs while idle — a live drag owns the visuals. ———

    const HOVER_HEX = 0xd8492b;
    let hoverNode: THREE.Object3D | null = null;

    const tintHandle = (node: THREE.Object3D, on: boolean): void => {
      const mats: (THREE.MeshBasicMaterial | THREE.MeshStandardMaterial)[] = [
        ...((node.userData.hoverMats ?? []) as THREE.MeshBasicMaterial[]),
      ];
      // The existing head-position hit proxy highlights the person.
      if (
        node.userData.dragKind === 'eye-floor' &&
        handles.viewingFigure
      ) {
        mats.push(...handles.viewingFigure.hoverMaterials);
      }
      for (const m of mats) {
        if (typeof m.userData.restHex !== 'number') {
          m.userData.restHex = m.color.getHex();
        }
        m.color.setHex(on ? HOVER_HEX : (m.userData.restHex as number));
      }
    };

    const setHover = (node: THREE.Object3D | null): void => {
      if (node === hoverNode) return;
      if (hoverNode) tintHandle(hoverNode, false);
      hoverNode = node;
      if (hoverNode) {
        tintHandle(hoverNode, true);
        const kind = hoverNode.userData.dragKind as SceneDragKind;
        const cursor = DRAG_CURSORS[kind];
        renderer.domElement.style.cursor =
          cursor === 'grabbing' ? 'grab' : cursor;
      } else {
        renderer.domElement.style.cursor = '';
      }
      // Demand-driven drawing needs a nudge to show the tint.
      handles.invalidate();
    };

    const updateHover = (e: PointerEvent): void => {
      if (handles.drag || e.buttons !== 0) return;
      const kind = pickSceneDrag(e);
      setHover(kind === null ? null : (handles.handleNodes.get(kind) ?? null));
    };

    const onScenePointerLeave = (): void => setHover(null);

    const raycasterRay = (): DragRay => ({
      originMm: [
        raycaster.ray.origin.x,
        raycaster.ray.origin.y,
        raycaster.ray.origin.z,
      ],
      directionMm: [
        raycaster.ray.direction.x,
        raycaster.ray.direction.y,
        raycaster.ray.direction.z,
      ],
    });

    const beginSceneDrag = (
      kind: SceneDragKind,
      e: PointerEvent,
    ): boolean => {
      const corner = cornerEditingRef.current?.corner ?? null;
      const view = viewpointEditingRef.current ?? null;
      const isCorner = isCornerDragKind(kind);
      if (isCorner && !corner) return false;
      if (!isCorner && !view) return false;
      const ray = raycasterRay();
      const ref0 = isCorner
        ? solveCornerDragRaw(kind as CornerDragKind, corner!, ray)
        : solveViewpointDragRaw(
            kind as ViewpointDragKind,
            view!.eyeMm,
            ray,
          );
      // OrbitControls' own bubble-phase pointerdown sees enabled === false
      // for this same event, so no camera move can start.
      controls.enabled = false;
      try {
        renderer.domElement.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic pointers without an active pointer id cannot capture.
      }
      handles.drag = {
        kind,
        pointerId: e.pointerId,
        ref0,
        startCorner: corner,
        startEyeMm: view?.eyeMm ?? null,
        startAimMm: view?.aimHeightMm ?? null,
        latest: null,
        changed: false,
      };
      setHover(null);
      mount.setAttribute('data-drag', kind);
      renderer.domElement.style.cursor = DRAG_CURSORS[kind];
      return true;
    };

    const applyCornerDraft = (
      drag: ActiveSceneDrag,
      kind: CornerDragKind,
      value: number,
    ): void => {
      const start = drag.startCorner!;
      const draft = { ...start, ...cornerDragPatch(kind, start, value) };
      layoutCornerHandles(handles.handleNodes, draft);
      if (handles.ghost) {
        setGhostRect(
          handles.ghost,
          kind === 'panel-a-width' || kind === 'panel-a-height'
            ? ghostCornersA(draft.panelA.widthMm, draft.panelA.heightMm)
            : ghostCornersB(
                draft.panelB.widthMm,
                draft.panelB.heightMm,
                draft.angleDeg,
              ),
        );
      }
      drag.latest = value;
      drag.changed = true;
    };

    const applyViewpointDraft = (
      drag: ActiveSceneDrag,
      patch: { readonly eyeMm?: Vec3; readonly aimHeightMm?: number },
    ): void => {
      const eye = patch.eyeMm ?? drag.startEyeMm!;
      const aim = patch.aimHeightMm ?? drag.startAimMm!;
      layoutViewpointHandles(
        handles.handleNodes,
        handles.viewNodes,
        eye,
        aim,
      );
      if (handles.viewingFigure) positionViewingFigure(handles.viewingFigure, eye, aim);
      drag.latest = patch.eyeMm ?? patch.aimHeightMm ?? null;
      drag.changed = true;
    };

    const onScenePointerMove = (e: PointerEvent): void => {
      const drag = handles.drag;
      if (!drag) {
        updateHover(e);
        return;
      }
      if (e.pointerId !== drag.pointerId) return;
      const ray = rayForEvent(e);
      if (isCornerDragKind(drag.kind)) {
        const kind = drag.kind as CornerDragKind;
        const raw = solveCornerDragRaw(kind, drag.startCorner!, ray);
        if (raw === null) return; // graceful miss: keep the last value
        if (drag.ref0 === null) drag.ref0 = raw;
        applyCornerDraft(
          drag,
          kind,
          resolveCornerDrag(kind, drag.startCorner!, drag.ref0 as number, raw),
        );
      } else {
        const kind = drag.kind as ViewpointDragKind;
        const raw = solveViewpointDragRaw(kind, drag.startEyeMm!, ray);
        if (raw === null) return;
        if (drag.ref0 === null) drag.ref0 = raw;
        applyViewpointDraft(
          drag,
          resolveViewpointDrag(
            kind,
            {
              eyeMm: drag.startEyeMm!,
              aimHeightMm: drag.startAimMm!,
            },
            drag.ref0,
            raw,
          ),
        );
      }
      // Draft visuals only — never a recompile or store commit mid-gesture.
      handles.renderNow();
    };

    const restoreSceneDragVisuals = (drag: ActiveSceneDrag): void => {
      if (isCornerDragKind(drag.kind)) {
        const corner = cornerEditingRef.current?.corner ?? drag.startCorner;
        if (corner) layoutCornerHandles(handles.handleNodes, corner);
      } else {
        const eye = viewpointEditingRef.current?.eyeMm ?? drag.startEyeMm;
        const aim =
          viewpointEditingRef.current?.aimHeightMm ?? drag.startAimMm;
        if (eye && aim !== null) {
          layoutViewpointHandles(
            handles.handleNodes,
            handles.viewNodes,
            eye,
            aim,
          );
          if (handles.viewingFigure) positionViewingFigure(handles.viewingFigure, eye, aim);
        }
      }
    };

    /** One commit per completed gesture, only when the value moved (§12.6). */
    const commitSceneDrag = (drag: ActiveSceneDrag): boolean => {
      if (!drag.changed || drag.latest === null) return false;
      const round1 = (v: number) => Math.round(v * 10) / 10;
      if (isCornerDragKind(drag.kind)) {
        const contract = cornerEditingRef.current;
        const start = drag.startCorner;
        if (!contract || !start) return false;
        const kind = drag.kind as CornerDragKind;
        const value = round1(drag.latest as number);
        if (value === cornerDragStartValue(kind, start)) return false;
        contract.onCommit(cornerDragPatch(kind, start, value));
        return true;
      }
      const contract = viewpointEditingRef.current;
      if (!contract) return false;
      if (drag.kind === 'aim-height') {
        const aim = round1(drag.latest as number);
        if (aim === contract.aimHeightMm) return false;
        contract.onCommit({ aimHeightMm: aim });
        return true;
      }
      const latest = drag.latest as Vec3;
      const eye: Vec3 = [
        round1(latest[0]),
        round1(latest[1]),
        round1(latest[2]),
      ];
      if (
        eye[0] === contract.eyeMm[0] &&
        eye[1] === contract.eyeMm[1] &&
        eye[2] === contract.eyeMm[2]
      ) {
        return false;
      }
      contract.onCommit({ eyeMm: eye });
      return true;
    };

    function finishSceneDrag(commit: boolean): void {
      const drag = handles.drag;
      if (!drag) return;
      handles.drag = null;
      mountRef.current?.removeAttribute('data-drag');
      renderer.domElement.style.cursor = '';
      controls.enabled = modeRef.current === 'orbit';
      if (handles.ghost) handles.ghost.visible = false;
      try {
        if (renderer.domElement.hasPointerCapture(drag.pointerId)) {
          renderer.domElement.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Capture may already be released.
      }
      const committed = commit && commitSceneDrag(drag);
      if (!committed) restoreSceneDragVisuals(drag);
      handles.renderNow();
    }

    const onScenePointerUp = (e: PointerEvent): void => {
      if (handles.drag && e.pointerId === handles.drag.pointerId) {
        finishSceneDrag(true);
      }
    };
    const onScenePointerCancel = (e: PointerEvent): void => {
      if (handles.drag && e.pointerId === handles.drag.pointerId) {
        finishSceneDrag(false);
      }
    };
    const onSceneLostCapture = (e: Event): void => {
      const drag = handles.drag;
      if (drag && (e as PointerEvent).pointerId === drag.pointerId) {
        finishSceneDrag(false);
      }
    };
    const onSceneKeyDown = (e: KeyboardEvent): void => {
      if (handles.drag && e.key === 'Escape') {
        e.preventDefault();
        finishSceneDrag(false);
      }
    };

    renderer.domElement.addEventListener('pointermove', onScenePointerMove);
    renderer.domElement.addEventListener('pointerleave', onScenePointerLeave);
    renderer.domElement.addEventListener('pointerup', onScenePointerUp);
    renderer.domElement.addEventListener(
      'pointercancel',
      onScenePointerCancel,
    );
    renderer.domElement.addEventListener(
      'lostpointercapture',
      onSceneLostCapture,
    );
    window.addEventListener('keydown', onSceneKeyDown);

    handles.resizeObserver.observe(mount);
    handles.updateFraming();

    // Demand-driven drawing (§13): resolved mode draws only on invalidation;
    // Orbit keeps a rAF loop alive only while controls move or damping has
    // not settled.
    const orbitTick = () => {
      handles.orbitRaf = 0;
      if (handles.contextLost || modeRef.current !== 'orbit') return;
      const moving = controls.update();
      handles.renderNow();
      // `controls.update()` may synchronously emit `change`, which calls
      // ensureOrbitLoop. Funnel both paths through that idempotent scheduler;
      // scheduling directly here would create an untracked duplicate branch.
      if (
        orbitNeedsAnotherFrame(
          modeRef.current,
          handles.contextLost,
          moving,
        )
      ) {
        handles.ensureOrbitLoop();
      }
    };
    controls.addEventListener('change', handles.ensureOrbitLoop);

    return () => {
      cancelAnimationFrame(handles.frameRaf);
      cancelAnimationFrame(handles.orbitRaf);
      cancelAnimationFrame(handles.introRaf);
      introCancelRef.current = null;
      handles.resizeObserver.disconnect();
      renderer.domElement.removeEventListener(
        'pointerdown',
        handles.onPointerDownCapture,
        true,
      );
      renderer.domElement.removeEventListener('webglcontextlost', handles.onLost);
      renderer.domElement.removeEventListener(
        'webglcontextrestored',
        handles.onRestored,
      );
      controls.dispose();
      renderer.domElement.removeEventListener(
        'pointermove',
        onScenePointerMove,
      );
      renderer.domElement.removeEventListener(
        'pointerleave',
        onScenePointerLeave,
      );
      renderer.domElement.removeEventListener('pointerup', onScenePointerUp);
      renderer.domElement.removeEventListener(
        'pointercancel',
        onScenePointerCancel,
      );
      renderer.domElement.removeEventListener(
        'lostpointercapture',
        onSceneLostCapture,
      );
      window.removeEventListener('keydown', onSceneKeyDown);
      handles.projector.slots.clear();
      handles.projector.texture?.dispose();
      handles.projector.texture = null;
      handles.projector.blob = null;
      disposeChildren(surfacesGroup);
      disposeChildren(marksGroup);
      disposeChildren(handlesGroup);
      if (handles.archGroup) {
        scene3.remove(handles.archGroup);
        disposeArchitecture(handles.archGroup);
        handles.archGroup = null;
      }
      handles.archMaterials.wall.dispose();
      handles.archMaterials.floor.dispose();
      handles.archMaterials.plaster.dispose();
      handles.archMaterials.gradient.dispose();
      handles.handleNodes.clear();
      for (const entry of handles.textures.values()) entry.texture.dispose();
      handles.textures.clear();
      mount.removeChild(renderer.domElement);
      renderer.dispose();
      handlesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    handles.controls.enabled = mode === 'orbit';
    if (mode === 'orbit') handles.ensureOrbitLoop();
    else handles.invalidate();
  }, [mode]);

  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    const { surfacesGroup } = handles;
    // The meshes are about to be discarded — their draft materials die with
    // them, so only the slot bookkeeping needs clearing (no swaps to undo).
    handles.projector.slots.clear();
    for (const entry of handles.textures.values()) entry.texture.dispose();
    handles.textures.clear();
    disposeChildren(surfacesGroup);
    if (!scene) {
      handles.invalidate();
      return;
    }

    const previewById = new Map(
      (previews ?? []).map((p) => [p.surfaceId, p] as const),
    );
    for (const compiled of scene.surfaces) {
      const preview = previewById.get(compiled.surface.id) ?? null;
      const group = new THREE.Group();
      group.userData.surfaceId = compiled.surface.id;

      // Live-draft mesh: the full panel shape, hidden unless a gesture is
      // mid-flight. Its projector shader discards outside the draft frame
      // so uncovered wall area shows plaster, matching the settled rule.
      const draftGeometry = surfaceGeometry(
        compiled,
        preview,
        compiled.surface.polygonMm,
      );
      const uH = new THREE.Matrix3();
      const draftMaterial = makeProjectorMaterial(uH);
      const draft = new THREE.Mesh(draftGeometry, draftMaterial);
      draft.userData.role = 'draft';
      draft.userData.surfaceId = compiled.surface.id;
      draft.visible = false;
      handles.projector.slots.set(draft, {
        material: draftMaterial,
        uH,
      });
      group.add(draft);

      // Settled proof mesh: clipped to the authoritative printable
      // footprint — no footprint, no substrate, just wall (§A). The proof
      // shader composites raster alpha over paper so transparent source
      // pixels still read as mounted white stock.
      if (compiled.printableFootprintMm.length >= 3) {
        let texture: THREE.CanvasTexture | null = null;
        if (preview) {
          const canvas = previewCanvas(preview);
          texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.flipY = true;
          handles.textures.set(compiled.surface.id, { texture, canvas });
        }
        const proofGeometry = surfaceGeometry(
          compiled,
          preview,
          compiled.printableFootprintMm,
        );
        const proofMaterial = makeProofMaterial();
        proofMaterial.uniforms.uMap!.value = texture;
        proofMaterial.uniforms.uHasMap!.value = texture ? 1 : 0;
        const proof = new THREE.Mesh(proofGeometry, proofMaterial);
        proof.userData.role = 'proof';
        proof.userData.surfaceId = compiled.surface.id;
        proof.castShadow = true;
        group.add(proof);
      }
      surfacesGroup.add(group);
    }
    // A preview/scene rebuild can land mid-gesture (e.g. a queued settled
    // preview): reapply the live draft projection onto the fresh meshes.
    if (artworkDraftRef.current) {
      applyArtworkProjection(
        handles,
        artworkDraftRef.current,
        scene,
        artworkEditingRef.current,
      );
    }
    handles.invalidate();
  }, [scene, previews]);

  // Decorative room shell (§A): rebuilt only when the compiled scene
  // changes. It lives outside surfacesGroup/marksGroup/handlesGroup so it
  // can never enter ray intersection, clipping, fingerprints or exports.
  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    if (handles.archGroup) {
      handles.scene3.remove(handles.archGroup);
      disposeArchitecture(handles.archGroup);
      handles.archGroup = null;
    }
    if (scene) {
      handles.archGroup = buildArchitecture(scene, handles.archMaterials);
      handles.scene3.add(handles.archGroup);
      // A rebuild can land mid-gesture (undo while dragging): the fresh
      // decals default to visible, so re-apply the draft suppression.
      if (artworkDraftRef.current) {
        setMountShadowsVisible(handles.archGroup, false);
      }
    }
    if (mountRef.current) {
      mountRef.current.dataset.mountShadows = artworkDraftRef.current
        ? 'hidden'
        : 'visible';
    }
    handles.invalidate();
  }, [scene]);

  // Diagnostics toggle: drafting grid + surface-letter labels only —
  // the eye mark stays (it is the resolution landmark the viewpoint
  // handles tint, not a drafting aid).
  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    setDiagnosticsVisible(handles, diagnostics);
    handles.invalidate();
  }, [diagnostics]);

  // Decode the artwork blob once per asset so the projector texture is ready
  // before the first pointermove of a gesture — never on the worker path.
  // `projector.blob` doubles as the claim ticket: a stale decode discards
  // itself on resolve, so no effect cleanup is needed (StrictMode-safe).
  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    const blob = artworkEditing?.assetBlob ?? null;
    const projector = handles.projector;
    if (projector.blob === blob) return;
    projector.blob = blob;
    projector.texture?.dispose();
    projector.texture = null;
    if (!blob) return;
    createImageBitmap(blob, { premultiplyAlpha: 'none' })
      .then((bitmap) => {
        if (handlesRef.current !== handles || projector.blob !== blob) {
          bitmap.close();
          return;
        }
        const texture = new THREE.Texture(bitmap);
        texture.colorSpace = THREE.SRGBColorSpace;
        // The homography's t axis counts from the image top (v = 0 is the
        // first row), so the bitmap must upload unflipped.
        texture.flipY = false;
        texture.anisotropy = handles.renderer.capabilities.getMaxAnisotropy();
        texture.needsUpdate = true;
        projector.texture = texture;
        // A gesture may already be waiting on this decode.
        if (artworkDraftRef.current) {
          applyArtworkProjection(
            handles,
            artworkDraftRef.current,
            sceneRef.current,
            artworkEditingRef.current,
          );
        }
        handles.invalidate();
      })
      .catch(() => {
        // Decode failure leaves uHasMap = 0 — the projector draws paper.
      });
  }, [artworkEditing]);

  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    const { marksGroup, resolvedCam, orbitCam, controls } = handles;
    disposeChildren(marksGroup);
    handles.viewingFigure = null;
    if (mountRef.current) delete mountRef.current.dataset.viewerVisible;
    if (!scene) {
      handles.lastCameraKey = null;
      return;
    }

    const cameraKey = [
      ...scene.camera.eyeMm,
      ...scene.camera.targetMm,
    ].join(',');
    // Artwork and surface edits recompile the scene object, but an unchanged
    // design eye should not throw away a user's current Orbit camera pose.
    // A changed eye/aim, or the first scene, still establishes both cameras.
    const resetCameras =
      handles.lastCameraKey !== cameraKey || introCancelRef.current !== null;

    for (const compiled of scene.surfaces) {
      const bounds = compiled.surface.boundsMm;
      const center = new THREE.Vector3(
        compiled.surface.originMm[0] +
          compiled.surface.axisU[0] * (bounds.x + bounds.width / 2) +
          compiled.surface.axisV[0] * (bounds.y + bounds.height / 2),
        compiled.surface.originMm[1] +
          compiled.surface.axisU[1] * (bounds.x + bounds.width / 2) +
          compiled.surface.axisV[1] * (bounds.y + bounds.height / 2),
        compiled.surface.originMm[2] +
          compiled.surface.axisU[2] * (bounds.x + bounds.width / 2) +
          compiled.surface.axisV[2] * (bounds.y + bounds.height / 2),
      );
      const label = makeLabelSprite(compiled.surface.id);
      label.position.copy(center);
      label.userData.diagnostic = true;
      label.visible = diagnosticsRef.current;
      marksGroup.add(label);
    }

    const eye = new THREE.Vector3(...scene.camera.eyeMm);
    const target = new THREE.Vector3(...scene.camera.targetMm);
    const figure = buildViewingFigure(scene.camera.eyeMm, scene.camera.targetMm[1]);
    marksGroup.add(figure.root);
    handles.viewingFigure = figure;

    const grid = new THREE.GridHelper(
      Math.max(scene.sceneExtentMm * 1.6, 500),
      20,
      0xb8b2a2,
      0xd8d2c2,
    );
    grid.position.y = -0.5;
    grid.userData.diagnostic = true;
    grid.visible = diagnosticsRef.current;
    marksGroup.add(grid);

    if (resetCameras) {
      resolvedCam.position.copy(eye);
      resolvedCam.lookAt(target);
    }
    handles.updateFraming();

    if (resetCameras) {
      controls.target.copy(frameViewingFigureInOrbit(orbitCam, scene, figure));
      controls.update();
    }
    handles.lastCameraKey = cameraKey;

    cancelAnimationFrame(handles.introRaf);
    introCancelRef.current = null;
    if (introRevealRef.current && !handles.introDone) {
      handles.introDone = true;
      const reduced =
        typeof matchMedia === 'function' &&
        matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduced) {
        const endPos = resolvedCam.position.clone();
        const endQuat = resolvedCam.quaternion.clone();
        const startOffset = eye.clone().sub(target);
        startOffset.applyAxisAngle(
          new THREE.Vector3(0, 1, 0),
          Math.PI / 7,
        );
        startOffset.y += Math.max(160, scene.sceneExtentMm * 0.18);
        const startPos = target.clone().add(startOffset);
        resolvedCam.position.copy(startPos);
        resolvedCam.lookAt(target);
        const startQuat = resolvedCam.quaternion.clone();
        const startedAt = performance.now();
        const DURATION = 750;
        const finish = () => {
          cancelAnimationFrame(handles.introRaf);
          introCancelRef.current = null;
          resolvedCam.position.copy(endPos);
          resolvedCam.quaternion.copy(endQuat);
          handles.renderNow();
        };
        const tick = (now: number) => {
          if (introCancelRef.current !== finish) return;
          const t = Math.min(1, (now - startedAt) / DURATION);
          const eased = 1 - Math.pow(1 - t, 3);
          resolvedCam.position.lerpVectors(startPos, endPos, eased);
          resolvedCam.quaternion.slerpQuaternions(startQuat, endQuat, eased);
          // The intro mutates the camera outside any draw loop — draw here.
          handles.renderNow();
          if (t < 1) {
            handles.introRaf = requestAnimationFrame(tick);
          } else {
            finish();
          }
        };
        introCancelRef.current = finish;
        handles.introRaf = requestAnimationFrame(tick);
      }
    }
    handles.invalidate();
  }, [scene]);

  // Direct scene editing (§12-style contract): the five corner handles are
  // visible whenever a cornerEditing contract exists — Resolved and Orbit
  // alike — while the viewpoint rig only exists in Orbit, where the camera
  // is not itself the eye. Rebuilding cancels any live drag first so a
  // contract or mode change underneath a gesture cannot commit stale data.
  useEffect(() => {
    const handles = handlesRef.current;
    if (!handles) return;
    handles.cancelSceneDrag();
    disposeChildren(handles.handlesGroup);
    handles.handleNodes.clear();
    handles.ghost = null;
    handles.viewNodes = null;
    if (!scene) {
      handles.invalidate();
      return;
    }
    if (cornerEditing) {
      buildCornerHandles(
        handles.handlesGroup,
        handles.handleNodes,
        cornerEditing.corner,
      );
      const ghost = makeGhost();
      handles.handlesGroup.add(ghost);
      handles.ghost = ghost;
    }
    if (viewpointEditing && mode === 'orbit') {
      handles.viewNodes = buildViewpointHandles(
        handles.handlesGroup,
        handles.handleNodes,
        viewpointEditing.eyeMm,
        viewpointEditing.aimHeightMm,
      );
    }
    handles.invalidate();
  }, [scene, cornerEditing, viewpointEditing, mode]);

  // The overlay streams each mid-gesture draft here (§12.5): the projector
  // re-warps the real artwork across the surface meshes immediately on the
  // demand-driven render path — the worker preview stays untouched until
  // the release commit, and null (release or any cancel) restores the
  // committed materials.
  const onArtworkDraft = (spec: ArtworkSpec | null): void => {
    artworkDraftRef.current = spec;
    const handles = handlesRef.current;
    if (!handles) return;
    applyArtworkProjection(
      handles,
      spec,
      sceneRef.current,
      artworkEditingRef.current,
    );
    if (mountRef.current) {
      mountRef.current.dataset.mountShadows = spec ? 'hidden' : 'visible';
    }
    handles.renderNow();
  };

  if (availability === 'unavailable') {
    return (
      <div className="viewport-fallback" role="note">
        <p>
          Spatial preview is unavailable because WebGL could not start on this
          device. Flat pieces, numeric editing, saving, and project files remain
          fully available.
        </p>
      </div>
    );
  }
  const lost = availability === 'lost';
  return (
    <>
      {lost ? (
        <div className="viewport-fallback" role="alert">
          <p>
            The spatial preview lost its graphics connection and paused.
            Editing, flat pieces, saving, and export are unaffected — switch to
            Flat pieces to keep inspecting while the view recovers.
          </p>
        </div>
      ) : null}
      {/* The mount stays in the DOM while the context is lost so the canvas
          keeps its webglcontextrestored listener and can resume rendering. */}
      <div
        ref={mountRef}
        className="spatial-viewport"
        data-mode={mode}
        data-context={lost ? 'lost' : 'live'}
        hidden={lost}
        role="region"
        aria-label={
          mode === 'orbit'
            ? 'Inspection view around the installation with a person at the viewing position'
            : 'View from the design viewing point'
        }
      >
        {availability === 'ready' && mode === 'resolved' && scene &&
        artworkEditing ? (
          <ArtworkEditOverlay
            contract={artworkEditing}
            scene={scene}
            frame={frame}
            onDraft={onArtworkDraft}
          />
        ) : null}
      </div>
    </>
  );
}
