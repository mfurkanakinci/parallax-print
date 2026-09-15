import { LIMITS } from '../limits';
import { geometryEpsilon } from '../units';
import { invertMat3, mat3IsFinite, mat3ResidualMm } from '../math/matrix3';
import { add3, dot3, isFiniteVec3, normalize3, scale3, sub3 } from '../math/vector';
import { GeometryInputError, validateAngleMeasurement } from './angleMeasurement';
import { buildCamera } from './camera';
import { clipPrintableFootprint } from './clipping';
import { buildArtworkFrame, buildSurfaceHomography } from './homography';
import { buildSurfaces } from './surfaces';
import type {
  ArtworkFrame,
  AssetMetadata,
  CompiledScene,
  CompiledSurface,
  CompileResult,
  Issue,
  ProjectV1,
  Surface,
  Vec3,
} from '../types';

export const ENGINE_VERSION = 'parallax-press-m2';

const INVERSE_RESIDUAL_TOLERANCE_MM = 1e-3;

const blocker = (
  code: Issue['code'],
  message: string,
  remedy: string,
  extra?: Partial<Issue>,
): Issue => ({ code, severity: 'blocker', message, remedy, ...extra });

function worldVertex(surface: Surface, local: readonly [number, number]): Vec3 {
  return add3(
    surface.originMm,
    add3(scale3(surface.axisU, local[0]), scale3(surface.axisV, local[1])),
  );
}

function validPanelSize(widthMm: number, heightMm: number): boolean {
  return (
    Number.isFinite(widthMm) &&
    Number.isFinite(heightMm) &&
    widthMm >= LIMITS.panelMm.min &&
    widthMm <= LIMITS.panelMm.max &&
    heightMm >= LIMITS.panelMm.min &&
    heightMm <= LIMITS.panelMm.max
  );
}

export function compileProject(
  project: ProjectV1,
  asset: AssetMetadata | null,
): CompileResult {
  const issues: Issue[] = [];
  const { corner } = project;

  let geometryValid = true;
  for (const [name, panel] of [
    ['panelA', corner.panelA],
    ['panelB', corner.panelB],
  ] as const) {
    if (!validPanelSize(panel.widthMm, panel.heightMm)) {
      issues.push(
        blocker(
          'invalid-dimension',
          `${name} dimensions must be finite and within ${LIMITS.panelMm.min}–${LIMITS.panelMm.max} mm.`,
          'Correct the measured panel size.',
          { fieldPath: `corner.${name}` },
        ),
      );
      geometryValid = false;
    }
  }
  if (
    !Number.isFinite(corner.angleDeg) ||
    corner.angleDeg < LIMITS.angleDeg.min ||
    corner.angleDeg > LIMITS.angleDeg.max
  ) {
    issues.push(
      blocker(
        'unsupported-angle',
        `Interior angle must be between ${LIMITS.angleDeg.min}° and ${LIMITS.angleDeg.max}°.`,
        'Adjust the measured or entered angle.',
        { fieldPath: 'corner.angleDeg' },
      ),
    );
    geometryValid = false;
  }
  if (!geometryValid) {
    return { scene: null, issues };
  }

  const surfaces = buildSurfaces(corner);
  for (const surface of surfaces) {
    if (
      surface.boundsMm.width > LIMITS.baseMaxMm ||
      surface.boundsMm.height > LIMITS.baseMaxMm
    ) {
      issues.push(
        blocker(
          'invalid-dimension',
          `Surface ${surface.id} exceeds the ${LIMITS.baseMaxMm} mm bound.`,
          'Reduce panel dimensions or disable the base.',
          { surfaceId: surface.id },
        ),
      );
      return { scene: null, issues };
    }
  }

  issues.push(...validateAngleMeasurement(corner));

  const { eyeMm, aimHeightMm } = project.viewpoint;
  let camera;
  try {
    camera = buildCamera(project.viewpoint);
  } catch (e) {
    issues.push(
      blocker(
        e instanceof GeometryInputError && e.code !== 'invalid-input'
          ? e.code
          : 'camera-undefined',
        `The viewing position cannot define a camera: ${e instanceof Error ? e.message : 'invalid'}`,
        'Move the eye position or aim height.',
      ),
    );
    return { scene: null, issues };
  }

  if (
    !isFiniteVec3(eyeMm) ||
    Math.abs(eyeMm[0]) > LIMITS.viewer.coordAbsMaxMm ||
    Math.abs(eyeMm[2]) > LIMITS.viewer.coordAbsMaxMm ||
    eyeMm[1] < LIMITS.viewer.eyeHeightMinMm ||
    eyeMm[1] > LIMITS.viewer.eyeHeightMaxMm ||
    !Number.isFinite(aimHeightMm)
  ) {
    issues.push(
      blocker(
        'invalid-viewpoint',
        'Eye position is outside the supported coordinate envelope.',
        `Keep X/Z within ±${LIMITS.viewer.coordAbsMaxMm} mm and eye height ${LIMITS.viewer.eyeHeightMinMm}–${LIMITS.viewer.eyeHeightMaxMm} mm.`,
        { fieldPath: 'viewpoint.eyeMm' },
      ),
    );
  }

  for (const surface of surfaces) {
    const side = dot3(sub3(eyeMm, surface.originMm), surface.frontNormal);
    if (!Number.isFinite(side) || side <= LIMITS.nearPlaneMm) {
      issues.push(
        blocker(
          'viewer-behind-surface',
          `The eye is on or behind the printable face of surface ${surface.id}.`,
          'Move the viewing point in front of that surface, away from the corner interior line.',
          { surfaceId: surface.id, fieldPath: 'viewpoint.eyeMm' },
        ),
      );
    }
  }

  let artwork: ArtworkFrame | null = null;
  if (project.artwork) {
    if (
      !Number.isFinite(project.artwork.heightSlope) ||
      project.artwork.heightSlope <= 0 ||
      !Number.isFinite(project.artwork.rotationDeg) ||
      !Number.isFinite(project.artwork.centerSlope[0]) ||
      !Number.isFinite(project.artwork.centerSlope[1])
    ) {
      issues.push(
        blocker(
          'invalid-dimension',
          'Artwork placement is not finite.',
          'Reset the artwork position and scale.',
          { fieldPath: 'artwork' },
        ),
      );
    } else if (!asset || asset.assetId !== project.artwork.assetId) {
      issues.push(
        blocker(
          'missing-artwork',
          'The referenced artwork asset is not loaded.',
          'Import the source image again.',
          { fieldPath: 'artwork.assetId' },
        ),
      );
    } else if (
      !Number.isSafeInteger(asset.widthPx) ||
      !Number.isSafeInteger(asset.heightPx) ||
      asset.widthPx < 1 ||
      asset.heightPx < 1 ||
      asset.widthPx > LIMITS.source.maxSidePx ||
      asset.heightPx > LIMITS.source.maxSidePx ||
      asset.widthPx * asset.heightPx > LIMITS.source.maxMegapixels * 1_000_000
    ) {
      issues.push(
        blocker(
          'invalid-dimension',
          'Artwork asset metadata is outside the supported pixel budget.',
          'Re-import the source image.',
          { fieldPath: 'artwork.assetId' },
        ),
      );
    } else {
      artwork = buildArtworkFrame(project.artwork, asset);
    }
  }

  const compiled: CompiledSurface[] = [];
  let singular = false;
  for (const surface of surfaces) {
    if (!artwork) {
      compiled.push({
        surface,
        surfaceToSource: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        sourceToSurface: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        printableFootprintMm: [],
      });
      continue;
    }
    const surfaceToSource = buildSurfaceHomography(surface, camera, artwork);
    if (!mat3IsFinite(surfaceToSource)) {
      singular = true;
      break;
    }
    const sourceToSurface = invertMat3(surfaceToSource);
    if (!sourceToSurface) {
      singular = true;
      break;
    }
    const residual = mat3ResidualMm(surfaceToSource, sourceToSurface, surface.polygonMm);
    if (!Number.isFinite(residual) || residual > INVERSE_RESIDUAL_TOLERANCE_MM) {
      singular = true;
      break;
    }
    const footprint = clipPrintableFootprint(surface, surfaceToSource, camera);
    compiled.push({
      surface,
      surfaceToSource,
      sourceToSurface,
      printableFootprintMm: footprint,
    });
  }
  if (singular) {
    issues.push(
      blocker(
        'singular-homography',
        'The surface projection is singular for this viewpoint.',
        'Move the eye away from grazing alignment with the surfaces.',
      ),
    );
    return { scene: null, issues };
  }

  if (artwork) {
    const anyFootprint = compiled.some((s) => s.printableFootprintMm.length >= 3);
    if (!anyFootprint) {
      issues.push(
        blocker(
          'no-visible-footprint',
          'The artwork frame covers no part of the selected surfaces from this viewpoint.',
          'Move or enlarge the artwork frame, or adjust the viewpoint.',
          { fieldPath: 'artwork' },
        ),
      );
    }
    for (const surface of surfaces) {
      const centerWorld = worldVertex(surface, [
        surface.boundsMm.width / 2,
        surface.boundsMm.height / 2,
      ]);
      const dir = normalize3(sub3(centerWorld, eyeMm));
      if (dir) {
        const incidence = Math.abs(dot3(dir, surface.frontNormal));
        if (incidence < LIMITS.grazingDotWarn) {
          issues.push({
            code: 'grazing-incidence',
            severity: 'warning',
            surfaceId: surface.id,
            message: `Surface ${surface.id} is viewed at a grazing angle; stretching will be severe.`,
            remedy: 'Move the eye to face the surface more directly.',
          });
        }
      }
    }
  }

  let extent = 0;
  const points: Vec3[] = [eyeMm];
  for (const surface of surfaces) {
    for (const p of surface.polygonMm) {
      points.push(worldVertex(surface, p));
    }
  }
  for (const p of points) {
    for (const q of points) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (d > extent) extent = d;
    }
  }
  const epsilonMm = geometryEpsilon(extent);

  const scene: CompiledScene = {
    surfaces: compiled,
    camera,
    artwork,
    sceneExtentMm: extent,
    epsilonMm,
    engineVersion: ENGINE_VERSION,
  };
  const hasBlocker = issues.some((issue) => issue.severity === 'blocker');
  return { scene: hasBlocker ? null : scene, issues };
}
