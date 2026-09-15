import { sha256Hex } from '../assets/contentHash';
import type {
  AckScope,
  ArtworkSpec,
  CornerSpec,
  PrintSpec,
  ProjectV1,
  ViewpointSpec,
} from './types';

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`)
    .join(',')}}`;
}

export async function fingerprintPayload(payload: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalize(payload)));
}

export interface PhysicalFingerprintInput {
  readonly engineVersion: string;
  readonly corner: CornerSpec;
  readonly viewpoint: ViewpointSpec;
  readonly artwork: ArtworkSpec | null;
  readonly asset: {
    readonly contentHash: string;
    readonly widthPx: number;
    readonly heightPx: number;
  } | null;
}

/**
 * The corner subset hashed by the physical fingerprint (§14.2).
 * `angleMeasurement` is deliberately excluded — it is a capture aid, not a
 * measured value of the room.
 */
function cornerFingerprintSubset(corner: CornerSpec): unknown {
  return {
    kind: corner.kind,
    panelA: corner.panelA,
    panelB: corner.panelB,
    angleDeg: corner.angleDeg,
    includeBase: corner.includeBase,
  };
}

export function physicalFingerprintPayload(
  input: PhysicalFingerprintInput,
): unknown {
  return {
    engineVersion: input.engineVersion,
    corner: cornerFingerprintSubset(input.corner),
    viewpoint: input.viewpoint,
    artwork: input.artwork,
    asset: input.asset
      ? {
          contentHash: input.asset.contentHash,
          widthPx: input.asset.widthPx,
          heightPx: input.asset.heightPx,
        }
      : null,
  };
}

export function physicalFingerprint(
  input: PhysicalFingerprintInput,
): Promise<string> {
  return fingerprintPayload(physicalFingerprintPayload(input));
}

export function layoutFingerprintPayload(
  physicalHash: string,
  print: PrintSpec,
): unknown {
  return {
    physicalHash,
    print: {
      ...print,
      surfaceIds: [...print.surfaceIds].sort(),
    },
  };
}

export function layoutFingerprint(
  physicalHash: string,
  print: PrintSpec,
): Promise<string> {
  return fingerprintPayload(layoutFingerprintPayload(physicalHash, print));
}

export function exportFingerprintPayload(input: {
  readonly layoutHash: string;
  readonly title: string;
  readonly selectedTileIds: readonly string[];
  readonly acknowledgements: readonly string[];
}): unknown {
  return {
    layoutHash: input.layoutHash,
    title: input.title,
    selectedTileIds: [...input.selectedTileIds].sort(),
    acknowledgements: [...input.acknowledgements].sort(),
  };
}

export function exportFingerprint(input: {
  readonly layoutHash: string;
  readonly title: string;
  readonly selectedTileIds: readonly string[];
  readonly acknowledgements: readonly string[];
}): Promise<string> {
  return fingerprintPayload(exportFingerprintPayload(input));
}

/**
 * The two fingerprints an acknowledgement can be checked against (§14.2).
 * They nest: physical ⊂ layout, so the invalidation matrix falls out of the
 * payloads rather than from hand-written rules.
 */
export interface AckFingerprints {
  readonly physical: string;
  readonly layout: string;
}

/**
 * The fingerprint an acknowledgement is compared against. An unknown or
 * missing scope falls back to `layout`, the widest scope, so a new warning
 * can never be validated by a stale narrow fingerprint.
 */
export function fingerprintForAckScope(
  scope: AckScope | undefined,
  fingerprints: AckFingerprints,
): string {
  switch (scope) {
    case 'physical':
      return fingerprints.physical;
    default:
      return fingerprints.layout;
  }
}

export async function revisionFingerprint(
  project: ProjectV1,
  asset: { contentHash: string; widthPx: number; heightPx: number } | null,
  engineVersion: string,
): Promise<string> {
  return fingerprintPayload({
    projectId: project.id,
    updatedAt: project.updatedAt,
    physical: physicalFingerprintPayload({
      engineVersion,
      corner: project.corner,
      viewpoint: project.viewpoint,
      artwork: project.artwork,
      asset,
    }),
    print: project.print,
    title: project.title,
  });
}
