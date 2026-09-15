import { useEffect, useRef, useState } from 'react';
import { browserImageDecoder } from '../../assets/normalizeArtwork';
import { compositePhotoPreview, type PhotoComposite } from '../../core/photo/composite';
import {
  isPhotoRegistrationCurrent,
  type PhotoImageIdentity,
  type PhotoRegistrationV1,
  type SolvedPhotoPlane,
} from '../../core/photo/registration';
import type {
  CompiledScene,
  CornerSpec,
  PreviewSurfaceResult,
  Surface,
  Vec2,
} from '../../core/types';
import type { StoredPhoto } from '../../persistence/types';
import type { PreviewStatus } from '../../state/jobController';
import { applyMat3 } from '../../core/math/matrix3';
import { photoCornerLabels } from '../../core/photo/registration';

export interface PhotoPreviewProps {
  readonly photo: StoredPhoto;
  readonly corner: CornerSpec;
  readonly scene: CompiledScene | null;
  readonly previews: readonly PreviewSurfaceResult[] | null;
  readonly previewStatus: PreviewStatus;
  readonly onReviewPhoto: () => void;
}

type PhotoRenderState = 'loading' | 'ready' | 'error';

interface DecodedPhoto {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixels: Uint8ClampedArray;
}

let activePhotoDecode: { blob: Blob; promise: Promise<DecodedPhoto> } | null = null;

function decodePhoto(blob: Blob): Promise<DecodedPhoto> {
  if (activePhotoDecode?.blob === blob) return activePhotoDecode.promise;
  // Decode the bounded, normalized PNG once per immutable Blob identity.
  const decoded = blob
    .arrayBuffer()
    .then((bytes) =>
      browserImageDecoder(new Uint8Array(bytes), 'png'),
    )
    .then((image) => ({
      widthPx: image.widthPx,
      heightPx: image.heightPx,
      pixels: image.data,
    }));
  activePhotoDecode = { blob, promise: decoded };
  void decoded.catch(() => {
    if (activePhotoDecode?.promise === decoded) activePhotoDecode = null;
  });
  return decoded;
}

function drawComposite(
  canvas: HTMLCanvasElement | null,
  composite: PhotoComposite | null,
): void {
  if (!canvas) return;
  if (!composite) {
    canvas.width = 1;
    canvas.height = 1;
    canvas.getContext('2d')?.clearRect(0, 0, 1, 1);
    return;
  }
  canvas.width = composite.widthPx;
  canvas.height = composite.heightPx;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(composite.pixels),
      composite.widthPx,
      composite.heightPx,
    ),
    0,
    0,
  );
}

function photoStatus(
  registration: PhotoRegistrationV1,
  corner: CornerSpec,
  image: PhotoImageIdentity,
): { label: string; stale: boolean } {
  if (registration.status === 'draft') {
    return { label: 'Draft — review the marked planes before using Photo view.', stale: true };
  }
  const stale =
    registration.status === 'stale' ||
    !isPhotoRegistrationCurrent(registration, corner, image);
  return stale
    ? {
        label: 'Needs review — the photo is preserved, but its piece overlay is withheld.',
        stale: true,
      }
    : {
        label: 'Visual review recorded — this is a captured-room reference, not a measurement claim.',
        stale: false,
      };
}

export function PhotoPreview({
  photo,
  corner,
  scene,
  previews,
  previewStatus,
  onReviewPhoto,
}: PhotoPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [decodedPhoto, setDecodedPhoto] = useState<{
    key: string;
    raster: DecodedPhoto;
  } | null>(null);
  const [decodeError, setDecodeError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const lastComposite = useRef<{
    key: string;
    composite: PhotoComposite;
  } | null>(null);
  const [compositeState, setCompositeState] = useState<{
    key: string;
    composite: PhotoComposite;
  } | null>(null);
  const [compositeError, setCompositeError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const registrationStatus = photoStatus(photo.registration, corner, photo.asset);
  const current = isPhotoRegistrationCurrent(photo.registration, corner, photo.asset);
  const photoKey = `${photo.asset.contentHash}:${photo.asset.widthPx}x${photo.asset.heightPx}`;
  const renderKey = JSON.stringify({
    photo: photoKey,
    registration: photo.registration,
    corner,
  });
  const displayComposite = compositeState?.key === renderKey
    ? compositeState.composite
    : null;
  const renderError =
    decodeError?.key === photoKey
      ? decodeError.message
      : compositeError?.key === renderKey
        ? compositeError.message
        : null;
  const state: PhotoRenderState =
    renderError
      ? 'error'
      : decodedPhoto?.key === photoKey && displayComposite
        ? 'ready'
        : 'loading';

  useEffect(() => {
    let active = true;
    // The output cache is deliberately NOT an input dependency. Otherwise a
    // new composite updates the cache, recomputes itself, and renders forever.
    queueMicrotask(() => {
      if (!active || decodedPhoto?.key !== photoKey) return;
      if (previewStatus === 'updating' && current
          && lastComposite.current?.key === renderKey
          && lastComposite.current.composite.appliedSurfaces.length > 0) return;
      try {
        const next = compositePhotoPreview({
          reference: decodedPhoto.raster,
          image: photo.asset,
          registration: photo.registration,
          corner,
          scene,
          previews,
        });
        const cached = { key: renderKey, composite: next };
        lastComposite.current = cached;
        setCompositeState(cached);
        setCompositeError(null);
      } catch (cause) {
        lastComposite.current = null;
        setCompositeState(null);
        setCompositeError({
          key: renderKey,
          message: cause instanceof Error
            ? cause.message
            : 'The computed pieces could not be composited over the photo.',
        });
      }
    });
    return () => { active = false; };
  }, [decodedPhoto, photoKey, renderKey, photo.asset, photo.registration, corner, scene, previews, previewStatus, current]);

  useEffect(() => {
    let cancelled = false;
    void decodePhoto(photo.asset.normalizedPng)
      .then((raster) => {
        if (cancelled) return;
        setDecodedPhoto({ key: photoKey, raster });
        setDecodeError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setDecodeError({
          key: photoKey,
          message:
            cause instanceof Error
              ? cause.message
              : 'The captured room photo could not be decoded.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    photo.asset.normalizedPng,
    photoKey,
    retry,
  ]);

  useEffect(() => {
    drawComposite(canvasRef.current, displayComposite);
  }, [displayComposite]);

  return (
    <div
      className="photo-preview"
      data-photo-status={registrationStatus.stale ? 'stale' : 'current'}
      data-applied-surfaces={displayComposite?.appliedSurfaces.join(',') ?? ''}
    >
      <canvas
        ref={canvasRef}
        className="photo-preview-canvas"
        role="img"
        aria-label="Reference photo with reviewed computed print pieces"
      />
      <div className="photo-preview-chrome">
        <strong>Photo view</strong>
        <span>{registrationStatus.label}</span>
        {state === 'loading' ? (
          <span role="status">Preparing the local photo view…</span>
        ) : null}
        {state === 'error' ? (
          <span className="photo-preview-error" role="alert">
            Photo preview failed: {renderError}
            <button
              type="button"
              className="button-quiet"
              onClick={() => setRetry((value) => value + 1)}
            >
              Retry photo preview
            </button>
          </span>
        ) : null}
        {displayComposite && displayComposite.appliedSurfaces.length > 0 && !registrationStatus.stale ? (
          <span>
            Computed pieces shown on {displayComposite.appliedSurfaces.join(' and ')}.
          </span>
        ) : null}
        {displayComposite &&
        displayComposite.appliedSurfaces.length === 0 &&
        !registrationStatus.stale &&
        state === 'ready' ? (
          <span>No current computed pieces are available for the marked planes.</span>
        ) : null}
        {registrationStatus.stale ? (
          <button type="button" className="button-quiet" onClick={onReviewPhoto}>
            Review photo calibration
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface PhotoGridProps {
  readonly photoUrl: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly solved: readonly SolvedPhotoPlane[];
}

function mappedPoint(plane: SolvedPhotoPlane, point: Vec2): Vec2 {
  return applyMat3(plane.surfaceToPhoto, point);
}

function gridLines(surface: Surface, plane: SolvedPhotoPlane): readonly string[] {
  const { x, y, width, height } = surface.boundsMm;
  const lines: string[] = [];
  const fractions = [0, 0.25, 0.5, 0.75, 1];
  for (const fraction of fractions) {
    const horizontal = [
      mappedPoint(plane, [x, y + height * fraction]),
      mappedPoint(plane, [x + width, y + height * fraction]),
    ];
    const vertical = [
      mappedPoint(plane, [x + width * fraction, y]),
      mappedPoint(plane, [x + width * fraction, y + height]),
    ];
    lines.push(
      `${horizontal[0]![0]},${horizontal[0]![1]} ${horizontal[1]![0]},${horizontal[1]![1]}`,
      `${vertical[0]![0]},${vertical[0]![1]} ${vertical[1]![0]},${vertical[1]![1]}`,
    );
  }
  return lines;
}

/** Large, exact-aspect review surface used before the visual confirmation. */
export function PhotoCalibrationGrid({
  photoUrl,
  widthPx,
  heightPx,
  solved,
}: PhotoGridProps) {
  return (
    <div
      className="photo-grid-canvas"
      style={{ aspectRatio: `${widthPx} / ${heightPx}` }}
    >
      <img
        src={photoUrl}
        alt="Reference room photo"
        draggable={false}
      />
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        {solved.map((plane) => (
          <g key={plane.surface.id} className={`photo-grid-surface photo-grid-surface--${plane.surface.id}`}>
            <defs>
              <clipPath
                id={`photo-grid-clip-${plane.surface.id}`}
                clipPathUnits="userSpaceOnUse"
              >
                <polygon
                  points={plane.corners.map(([x, y]) => `${x},${y}`).join(' ')}
                />
              </clipPath>
            </defs>
            <g clipPath={`url(#photo-grid-clip-${plane.surface.id})`}>
            {gridLines(plane.surface, plane).map((points, index) => (
              <polyline key={`${plane.surface.id}-${index}`} points={points} />
            ))}
            </g>
            <polygon
              points={plane.corners.map(([x, y]) => `${x},${y}`).join(' ')}
              className="photo-grid-outline"
            />
          </g>
        ))}
      </svg>
      {solved.map((plane) => (
        <span
          key={plane.surface.id}
          className="photo-grid-label"
          aria-hidden="true"
          style={{
            left: `${plane.corners.reduce((sum, point) => sum + point[0], 0) * 25}%`,
            top: `${plane.corners.reduce((sum, point) => sum + point[1], 0) * 25}%`,
          }}
        >
          Surface {plane.surface.id}
        </span>
      ))}
    </div>
  );
}

export function PhotoGridLegend({ solved }: { readonly solved: readonly SolvedPhotoPlane[] }) {
  return (
    <ul className="photo-grid-legend" aria-label="Reviewed photo planes">
      {solved.map((plane) => (
        <li key={plane.surface.id}>
          <strong>Surface {plane.surface.id}</strong>
          <span>{photoCornerLabels(plane.surface).join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}
