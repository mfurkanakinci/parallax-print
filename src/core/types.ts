export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];
export type SurfaceId = 'A' | 'B' | 'C';
export type DisplayUnit = 'mm' | 'cm' | 'in';

export interface RectMm {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CornerSpec {
  readonly kind: 'interior-corner';
  readonly panelA: { readonly widthMm: number; readonly heightMm: number };
  readonly panelB: { readonly widthMm: number; readonly heightMm: number };
  readonly angleDeg: number;
  readonly includeBase: boolean;
  readonly angleMeasurement?: {
    readonly method: 'tape-triangle';
    readonly offsetAMm: number;
    readonly offsetBMm: number;
    readonly chordMm: number;
    readonly measurementHeightMm: number;
  };
}

export interface ViewpointSpec {
  readonly eyeMm: Vec3;
  readonly aimHeightMm: number;
}

export interface ArtworkSpec {
  readonly assetId: string;
  readonly centerSlope: Vec2;
  readonly heightSlope: number;
  readonly rotationDeg: number;
}

export interface PrintSpec {
  readonly paper: 'a4' | 'letter' | 'a3';
  readonly orientation: 'portrait' | 'landscape';
  readonly marginMm: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
  readonly overlapMm: number;
  readonly dpi: 150 | 300;
  readonly surfaceIds: readonly SurfaceId[];
}

export interface ProjectV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly displayUnit: DisplayUnit;
  readonly corner: CornerSpec;
  readonly viewpoint: ViewpointSpec;
  readonly artwork: ArtworkSpec | null;
  readonly print: PrintSpec;
}

export interface SurfaceDatum {
  readonly id: string;
  readonly label: string;
  readonly kind: 'point' | 'edge';
  readonly localMm: Vec2;
  readonly localEndMm?: Vec2;
}

export interface Surface {
  readonly id: SurfaceId;
  readonly originMm: Vec3;
  readonly axisU: Vec3;
  readonly axisV: Vec3;
  readonly frontNormal: Vec3;
  readonly polygonMm: readonly Vec2[];
  readonly boundsMm: RectMm;
  readonly datums: readonly SurfaceDatum[];
}

export interface CameraFrame {
  readonly eyeMm: Vec3;
  readonly targetMm: Vec3;
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
}

export interface Ray {
  readonly originMm: Vec3;
  readonly direction: Vec3;
}

export interface SurfaceHit {
  readonly surfaceId: SurfaceId;
  readonly distanceMm: number;
  readonly localMm: Vec2;
  readonly worldMm: Vec3;
}

export interface ArtworkFrame {
  readonly assetId: string;
  readonly centerSlope: Vec2;
  readonly heightSlope: number;
  readonly widthSlope: number;
  readonly rotationDeg: number;
  readonly sourceWidthPx: number;
  readonly sourceHeightPx: number;
  readonly imagePlaneToSource: Mat3;
  readonly sourceToImagePlane: Mat3;
}

export interface CompiledSurface {
  readonly surface: Surface;
  readonly surfaceToSource: Mat3;
  readonly sourceToSurface: Mat3;
  readonly printableFootprintMm: readonly Vec2[];
}

export interface CompiledScene {
  readonly surfaces: readonly CompiledSurface[];
  readonly camera: CameraFrame;
  readonly artwork: ArtworkFrame | null;
  readonly sceneExtentMm: number;
  readonly epsilonMm: number;
  readonly engineVersion: string;
}

export type IssueCode =
  | 'invalid-dimension'
  | 'unsupported-angle'
  | 'invalid-angle-measurement'
  | 'invalid-viewpoint'
  | 'camera-undefined'
  | 'viewer-behind-surface'
  | 'singular-homography'
  | 'no-visible-footprint'
  | 'invalid-print-spec'
  | 'missing-artwork'
  | 'short-measurement-baseline'
  | 'grazing-incidence'
  | 'nonfinite-value';

/**
 * Which fingerprint scope an acknowledgement is compared against (§14.2).
 * Scopes nest — layout embeds the physical hash, physical embeds the corner
 * and viewpoint — so an edit invalidates every scope that contains it.
 */
export type AckScope = 'physical' | 'layout';

export interface Issue {
  readonly code: IssueCode;
  readonly severity: 'blocker' | 'warning' | 'info';
  readonly fieldPath?: string;
  readonly surfaceId?: SurfaceId;
  readonly message: string;
  readonly remedy: string;
  readonly ackId?: string;
  readonly ackScope?: AckScope;
}

export interface CompileResult {
  readonly scene: CompiledScene | null;
  readonly issues: readonly Issue[];
}

export interface AssetMetadata {
  readonly assetId: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly contentHash?: string;
}

export interface AssetRecord extends AssetMetadata {
  readonly normalizedPng: Blob | null;
  readonly pixels: Uint8ClampedArray;
  readonly displayFilename: string;
  readonly thumbnailPx: { readonly width: number; readonly height: number };
}

export interface SourceLevel {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixels: Uint8ClampedArray;
}

export interface SourcePyramid {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly levels: readonly SourceLevel[];
}

export interface RasterBlockRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RasterBlockRequest {
  readonly scene: CompiledScene;
  readonly surfaceId: SurfaceId;
  readonly blockPx: RasterBlockRegion;
  readonly mmPerPixel: number;
  readonly pyramid: SourcePyramid;
  readonly cancellation?: { readonly isCanceled: () => boolean };
  readonly yieldEveryRows?: number;
  readonly yieldControl?: () => Promise<void>;
}

export interface RasterBlockResult {
  readonly status: 'ready' | 'canceled';
  readonly surfaceId: SurfaceId;
  readonly blockPx: RasterBlockRegion;
  readonly pixels: Uint8ClampedArray | null;
}

export interface PreviewSurfaceResult {
  readonly surfaceId: SurfaceId;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly mmPerPixel: number;
  readonly pixels: Uint8ClampedArray;
}

export interface TilePlan {
  readonly id: string;
  readonly surfaceId: SurfaceId;
  readonly row: number;
  readonly column: number;
  readonly regionMm: RectMm;
  readonly overlapNeighbors: readonly string[];
}

export interface PrintPlan {
  readonly tiles: readonly TilePlan[];
  readonly artworkAreaMm: { readonly width: number; readonly height: number };
  readonly stepMm: { readonly x: number; readonly y: number };
}

export interface ExportSnapshot {
  readonly project: ProjectV1;
  readonly asset: AssetMetadata | null;
  readonly scene: CompiledScene;
  readonly print: PrintSpec;
  readonly acknowledgements: readonly string[];
  readonly engineVersion: string;
}

export interface VolumePlan {
  readonly index: number;
  readonly tileIds: readonly string[];
}

export interface CalibrationRecord {
  readonly scopeFingerprint: string;
  readonly settingsFingerprint: string;
  readonly rulerXMm: number | null;
  readonly rulerYMm: number | null;
  readonly declaredProofResult: 'pass' | 'fail' | null;
  readonly recordedAt: string;
}

export interface ProjectSnapshot {
  readonly project: ProjectV1;
  readonly asset: AssetMetadata | null;
  readonly scene: CompiledScene | null;
}

export interface PreflightReport {
  readonly blockers: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly info: readonly Issue[];
}

export interface ExportManifestV1 {
  readonly schemaVersion: 1;
  readonly engineVersion: string;
  readonly projectId: string;
  readonly revisionFingerprint: string;
  readonly createdAt: string;
  readonly units: 'mm';
  readonly files: readonly { readonly path: string; readonly role: string }[];
  readonly warnings: readonly Issue[];
  readonly calibrationStatus: string;
}
