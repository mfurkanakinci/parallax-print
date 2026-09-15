import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { importReferencePhoto } from '../../assets/importReferencePhoto';
import { Disclosure } from '../../components/Disclosure';
import { Icon } from '../../components/Icon';
import {
  formatFieldNumber,
  parseDraftNumber,
} from '../../components/MeasurementField';
import {
  confirmPhotoRegistration,
  createPhotoRegistration,
  isPhotoRegistrationCurrent,
  photoCornerLabels,
  solvePhotoPlanes,
  type PhotoPlaneRegistration,
  type PhotoRegistrationV1,
  type SolvedPhotoPlane,
} from '../../core/photo/registration';
import { buildSurfaces } from '../../core/geometry/surfaces';
import type { CornerSpec, ProjectV1, Surface, SurfaceId, Vec2 } from '../../core/types';
import type { StoredPhoto } from '../../persistence/types';
import { useProjectStore } from '../../state/projectStore';
import {
  clampPhotoPoint,
  clonePhotoPlanes,
  completeSharedPhotoPrefixes,
  PHOTO_SURFACE_ORDER,
  photoPlaneFor,
  photoPlanesReviewable,
  pointFromClient,
  replacePhotoRegistration,
  reuseSharedPhotoAnchors,
  updateSharedPhotoPoint,
  upsertPhotoPlane,
} from './photoHelpers';
import { PhotoCalibrationGrid, PhotoGridLegend } from './PhotoPreview';

export interface PhotoWorkflowProps {
  readonly project: ProjectV1;
  readonly photo: StoredPhoto | null;
  readonly readOnly: boolean;
}

interface PhotoGesture {
  readonly pointerId: number;
  readonly surfaceId: SurfaceId;
  readonly pointIndex: number;
  readonly planes: readonly PhotoPlaneRegistration[];
}

function photoIdentity(photo: StoredPhoto) {
  return {
    contentHash: photo.asset.contentHash,
    widthPx: photo.asset.widthPx,
    heightPx: photo.asset.heightPx,
  };
}

function photoStatusLabel(photo: StoredPhoto, corner: CornerSpec): {
  readonly tone: 'draft' | 'current' | 'stale';
  readonly label: string;
} {
  if (photo.registration.status === 'draft') {
    return {
      tone: 'draft',
      label: 'Draft — mark the measured planes, then review the grid.',
    };
  }
  const stale =
    photo.registration.status === 'stale' ||
    !isPhotoRegistrationCurrent(photo.registration, corner, photoIdentity(photo));
  return stale
    ? {
        tone: 'stale',
        label: 'Needs review — the photo is preserved while the measured geometry is updated.',
      }
    : {
        tone: 'current',
        label: 'Calibrated — visual review recorded; no accuracy claim is made.',
      };
}

function registrationWithPlanes(
  registration: PhotoRegistrationV1,
  planes: readonly PhotoPlaneRegistration[],
): PhotoRegistrationV1 {
  return {
    ...registration,
    planes: clonePhotoPlanes(planes),
    status: 'draft',
    reviewedAt: null,
    reviewMethod: 'visual',
  };
}

function PhotoAssetRow({
  photo,
  busy,
  readOnly,
  onReplace,
  onRemove,
}: {
  readonly photo: StoredPhoto;
  readonly busy: boolean;
  readonly readOnly: boolean;
  readonly onReplace: () => void;
  readonly onRemove: () => void;
}) {
  const thumbUrl = useMemo(() => {
    if (typeof URL.createObjectURL !== 'function') return null;
    return URL.createObjectURL(photo.asset.normalizedPng);
  }, [photo.asset.normalizedPng]);
  // A small image URL is presentation-only; the PNG remains owned by the
  // document and is never uploaded or modified by this component.
  useEffect(
    () => () => {
      if (thumbUrl) URL.revokeObjectURL(thumbUrl);
    },
    [thumbUrl],
  );
  return (
    <div className="photo-asset-row">
      {thumbUrl ? (
        <img src={thumbUrl} alt="Room photo thumbnail" />
      ) : (
        <span className="photo-asset-placeholder" aria-hidden="true">
          <Icon name="artwork" size={18} />
        </span>
      )}
      <span className="photo-asset-meta">
        <strong title={photo.asset.displayFilename}>{photo.asset.displayFilename}</strong>
        <span>
          {photo.asset.widthPx} × {photo.asset.heightPx} px · normalized PNG
        </span>
      </span>
      <div className="photo-asset-actions">
        <button
          type="button"
          className="button-quiet"
          disabled={busy || readOnly}
          onClick={onReplace}
        >
          {busy ? 'Importing…' : 'Replace'}
        </button>
        <button
          type="button"
          className="button-link"
          disabled={busy || readOnly}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function PlaneTabs({
  surfaces,
  selected,
  planes,
  onSelect,
}: {
  readonly surfaces: readonly Surface[];
  readonly selected: SurfaceId;
  readonly planes: readonly PhotoPlaneRegistration[];
  readonly onSelect: (surfaceId: SurfaceId) => void;
}) {
  const visibleTabs = surfaces.map((surface) => surface.id);
  const selectAndFocus = (surfaceId: SurfaceId) => {
    onSelect(surfaceId);
    requestAnimationFrame(() => {
      globalThis.document?.getElementById(`photo-tab-${surfaceId}`)?.focus();
    });
  };
  const moveTab = (current: SurfaceId, offset: number) => {
    const currentIndex = visibleTabs.indexOf(current);
    if (currentIndex < 0 || visibleTabs.length === 0) return;
    const nextIndex = (currentIndex + offset + visibleTabs.length) % visibleTabs.length;
    const next = visibleTabs[nextIndex];
    if (!next) return;
    selectAndFocus(next);
  };
  return (
    <div
      className="photo-plane-tabs"
      role="tablist"
      aria-label="Measured photo planes"
      aria-orientation="horizontal"
    >
      {PHOTO_SURFACE_ORDER.map((surfaceId) => {
        const surface = surfaces.find((item) => item.id === surfaceId);
        if (!surface) return null;
        const count = photoPlaneFor(planes, surfaceId).corners.length;
        return (
          <button
            key={surfaceId}
            id={`photo-tab-${surfaceId}`}
            type="button"
            role="tab"
            aria-selected={selected === surfaceId}
            tabIndex={selected === surfaceId ? 0 : -1}
            className={`photo-plane-tab${selected === surfaceId ? ' is-selected' : ''}`}
            onClick={() => onSelect(surfaceId)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                moveTab(surfaceId, 1);
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                moveTab(surfaceId, -1);
              } else if (event.key === 'Home') {
                event.preventDefault();
                const first = visibleTabs[0];
                if (first) selectAndFocus(first);
              } else if (event.key === 'End') {
                event.preventDefault();
                const last = visibleTabs[visibleTabs.length - 1];
                if (last) selectAndFocus(last);
              }
            }}
          >
            <strong>Surface {surfaceId}</strong>
            <span>{count}/4 corners</span>
          </button>
        );
      })}
    </div>
  );
}

function PhotoMarkingCanvas({
  photo,
  surface,
  planes,
  readOnly,
  onBeginPoint,
  onBeginMark,
  onPointNudge,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: {
  readonly photo: StoredPhoto;
  readonly surface: Surface;
  readonly planes: readonly PhotoPlaneRegistration[];
  readonly readOnly: boolean;
  readonly onBeginPoint: (event: ReactPointerEvent<HTMLButtonElement>, index: number) => void;
  readonly onBeginMark: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointNudge: (index: number, point: Vec2) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const photoUrl = useMemo(() => {
    if (typeof URL.createObjectURL !== 'function') return null;
    return URL.createObjectURL(photo.asset.normalizedPng);
  }, [photo.asset.normalizedPng]);
  useEffect(
    () => () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    },
    [photoUrl],
  );
  const plane = photoPlaneFor(planes, surface.id);
  const labels = photoCornerLabels(surface);
  return (
    <div
      id={`photo-plane-panel-${surface.id}`}
      className={`photo-marking-canvas photo-marking-canvas--${surface.id}`}
      style={{
        aspectRatio: `${photo.asset.widthPx} / ${photo.asset.heightPx}`,
        '--photo-aspect': photo.asset.widthPx / photo.asset.heightPx,
      } as CSSProperties}
      role="tabpanel"
      aria-label={`Mark Surface ${surface.id} corners`}
      aria-labelledby={`photo-tab-${surface.id}`}
      onPointerDown={onBeginMark}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      {photoUrl ? (
        <img src={photoUrl} alt="Room photo for measured plane marking" draggable={false} />
      ) : (
        <div className="photo-missing-image" role="alert">
          The local photo preview could not be prepared.
        </div>
      )}
      <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
        {plane.corners.length > 1 ? (
          <polyline
            points={plane.corners.map(([x, y]) => `${x},${y}`).join(' ')}
            className="photo-plane-line"
          />
        ) : null}
      </svg>
      {plane.corners.map(([x, y], index) => (
        <button
          key={`${surface.id}-${index}`}
          id={`photo-${surface.id}-point-${index + 1}`}
          type="button"
          className="photo-point"
          style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
          aria-label={`${labels[index] ?? `Surface ${surface.id} corner ${index + 1}`} at ${(x * 100).toFixed(1)}% across, ${(y * 100).toFixed(1)}% down`}
          disabled={readOnly}
          onPointerDown={(event) => onBeginPoint(event, index)}
          onKeyDown={(event) => {
            if (readOnly) return;
            const delta: Vec2 =
              event.key === 'ArrowLeft'
                ? [-0.005, 0]
                : event.key === 'ArrowRight'
                  ? [0.005, 0]
                  : event.key === 'ArrowUp'
                    ? [0, -0.005]
                    : event.key === 'ArrowDown'
                      ? [0, 0.005]
                      : [0, 0];
            if (delta[0] === 0 && delta[1] === 0) return;
            event.preventDefault();
            const next = clampPhotoPoint([x + delta[0], y + delta[1]]);
            onPointNudge(index, next);
          }}
        >
          <span aria-hidden="true">{index + 1}</span>
        </button>
      ))}
      <span className="photo-marking-hint">
        {plane.corners.length < 4
          ? `Click to mark ${labels[plane.corners.length] ?? `corner ${plane.corners.length + 1}`}.`
          : 'Select a numbered point to edit it with the fields below.'}
      </span>
    </div>
  );
}

function formatPhotoNumber(value: number, digits?: number): string {
  return digits === undefined
    ? formatFieldNumber(value)
    : String(Number(value.toFixed(digits)));
}

/** Local numeric draft: invalid masks/points never become production drafts. */
function PhotoNumberField({
  id,
  label,
  value,
  min,
  max,
  digits,
  disabled = false,
  onCommit,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly digits?: number;
  readonly disabled?: boolean;
  readonly onCommit: (value: number) => void;
}) {
  const committed = formatPhotoNumber(value, digits);
  const [text, setText] = useState(committed);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurRef = useRef(false);
  const discardOnBlurRef = useRef(false);
  const errorId = `${id}-error`;
  const commitDraft = () => {
    if (text.trim() === committed.trim()) {
      setError(null);
      return true;
    }
    const parsed = parseDraftNumber(text);
    if (parsed === null) {
      setError('Enter a finite number.');
      return false;
    }
    if (min !== undefined && parsed < min - 1e-9) {
      setError(`Must be at least ${formatPhotoNumber(min, digits)}.`);
      return false;
    }
    if (max !== undefined && parsed > max + 1e-9) {
      setError(`Must be at most ${formatPhotoNumber(max, digits)}.`);
      return false;
    }
    setError(null);
    onCommit(parsed);
    return true;
  };
  return (
    <div className="field photo-number-field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={text}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onBlur={() => {
          if (discardOnBlurRef.current) {
            discardOnBlurRef.current = false;
            setText(committed);
            setError(null);
            return;
          }
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            return;
          }
          void commitDraft();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (commitDraft()) {
              skipBlurRef.current = true;
              inputRef.current?.blur();
            }
          } else if (event.key === 'Escape') {
            event.preventDefault();
            discardOnBlurRef.current = true;
            setText(committed);
            setError(null);
            inputRef.current?.blur();
          }
        }}
      />
      {error ? <p className="field-error" id={errorId} role="alert">{error}</p> : null}
    </div>
  );
}

function PhotoPointFields({
  surface,
  planes,
  readOnly,
  onChange,
}: {
  readonly surface: Surface;
  readonly planes: readonly PhotoPlaneRegistration[];
  readonly readOnly: boolean;
  readonly onChange: (index: number, point: Vec2) => void;
}) {
  const plane = photoPlaneFor(planes, surface.id);
  const labels = photoCornerLabels(surface);
  return (
    <div className="photo-point-fields">
      {plane.corners.map(([x, y], index) => (
        <fieldset key={`${surface.id}-point-fields-${index}`} disabled={readOnly}>
          <legend>
            <span className="photo-point-index">{index + 1}</span>
            {labels[index] ?? `Surface ${surface.id} corner ${index + 1}`}
          </legend>
          <div className="photo-normalized-grid">
            <PhotoNumberField
              key={`${surface.id}-${index + 1}-x-${x}`}
              id={`photo-${surface.id}-point-${index + 1}-x`}
              label="X across photo"
              value={x}
              min={0}
              max={1}
              digits={3}
              onCommit={(next) => onChange(index, [next, y])}
            />
            <PhotoNumberField
              key={`${surface.id}-${index + 1}-y-${y}`}
              id={`photo-${surface.id}-point-${index + 1}-y`}
              label="Y down photo"
              value={y}
              min={0}
              max={1}
              digits={3}
              onCommit={(next) => onChange(index, [x, next])}
            />
          </div>
        </fieldset>
      ))}
    </div>
  );
}

function PhotoReview({
  photo,
  solved,
  readOnly,
  onConfirm,
}: {
  readonly photo: StoredPhoto;
  readonly solved: readonly SolvedPhotoPlane[];
  readonly readOnly: boolean;
  readonly onConfirm: () => void;
}) {
  const photoUrl = useMemo(() => {
    if (typeof URL.createObjectURL !== 'function') return null;
    return URL.createObjectURL(photo.asset.normalizedPng);
  }, [photo.asset.normalizedPng]);
  useEffect(
    () => () => {
      if (photoUrl) URL.revokeObjectURL(photoUrl);
    },
    [photoUrl],
  );
  const [confirmed, setConfirmed] = useState(false);
  if (!photoUrl) return null;
  return (
    <section className="photo-review" aria-label="Review photo calibration grid">
      <div className="photo-review-heading">
        <div>
          <h4>Review the calibration grid</h4>
          <p>
            Inspect the computed piece shapes against the captured room and
            confirm only what you can see. This visual check does not measure
            the installation or certify fit.
          </p>
        </div>
        <span className="photo-review-badge">Visual review</span>
      </div>
      <PhotoCalibrationGrid
        photoUrl={photoUrl}
        widthPx={photo.asset.widthPx}
        heightPx={photo.asset.heightPx}
        solved={solved}
      />
      <PhotoGridLegend solved={solved} />
      <label className="photo-confirm-row">
        <input
          id="photo-review-confirm"
          type="checkbox"
          checked={confirmed}
          disabled={readOnly}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I reviewed the grid against the room photo.
      </label>
      <button
        type="button"
        className="button-primary"
        disabled={!confirmed || readOnly}
        onClick={onConfirm}
      >
        Confirm visual review
      </button>
      <p className="photo-review-note">
        Photo calibration uses the marked correspondences only. It does not
        infer camera position, scale, or wall accuracy.
      </p>
    </section>
  );
}

export function PhotoWorkflow({ project, photo, readOnly }: PhotoWorkflowProps) {
  const commit = useProjectStore((state) => state.commit);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSurface, setSelectedSurface] = useState<SurfaceId>('A');
  const [gesture, setGesture] = useState<PhotoGesture | null>(null);
  const [review, setReview] = useState<readonly SolvedPhotoPlane[] | null>(null);
  const [reviewSignature, setReviewSignature] = useState<string | null>(null);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const calibrationDialogRef = useRef<HTMLDialogElement>(null);
  const calibrationTriggerRef = useRef<HTMLButtonElement>(null);
  const surfaces = useMemo(() => buildSurfaces(project.corner), [project.corner]);
  const visibleSurface =
    surfaces.find((surface) => surface.id === selectedSurface) ?? surfaces[0]!;
  const currentPlanes = gesture?.planes ?? photo?.registration.planes ?? [];
  const activePlanes = currentPlanes.filter((plane) =>
    surfaces.some((surface) => surface.id === plane.surfaceId),
  );
  const status = photo ? photoStatusLabel(photo, project.corner) : null;
  const currentSignature = photo
    ? JSON.stringify({ corner: project.corner, planes: currentPlanes })
    : null;

  const closeCalibration = () => {
    setGesture(null);
    setCalibrationOpen(false);
    requestAnimationFrame(() => calibrationTriggerRef.current?.focus());
  };

  useEffect(() => {
    const dialog = calibrationDialogRef.current;
    if (!dialog) return;
    if (calibrationOpen) {
      if (!dialog.open) dialog.showModal();
      requestAnimationFrame(() => {
        dialog.querySelector<HTMLElement>('[data-photo-dialog-heading]')?.focus();
      });
    } else if (dialog.open) {
      dialog.close();
    }
  }, [calibrationOpen]);

  useEffect(() => {
    if (!gesture) return;
    const cancel = () => setGesture(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancel);
    };
  }, [gesture]);

  const updatePhoto = (registration: PhotoRegistrationV1) => {
    if (!photo || readOnly) return;
    commit((document) =>
      document.photo
        ? {
            ...document,
            photo: { ...document.photo, registration },
          }
        : document,
    );
  };

  const commitPlanes = (
    planes: readonly PhotoPlaneRegistration[],
    options?: { readonly completeShared?: boolean },
  ) => {
    if (!photo || readOnly) return;
    const nextPlanes = options?.completeShared === false
      ? clonePhotoPlanes(planes)
      : completeSharedPhotoPrefixes(planes, project.corner);
    updatePhoto(registrationWithPlanes(photo.registration, nextPlanes));
    setReview(null);
    setReviewSignature(null);
  };

  const selectSurface = (surfaceId: SurfaceId) => {
    setSelectedSurface(surfaceId);
    if (readOnly || !photo) return;
    const started = upsertPhotoPlane(currentPlanes, {
      surfaceId,
      corners: photoPlaneFor(currentPlanes, surfaceId).corners,
    });
    const next = completeSharedPhotoPrefixes(started, project.corner);
    if (JSON.stringify(next) !== JSON.stringify(currentPlanes)) {
      commitPlanes(next);
    }
  };

  const importPhoto = async (file: File) => {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const asset = await importReferencePhoto(file, file.name);
      const image = {
        contentHash: asset.contentHash!,
        widthPx: asset.widthPx,
        heightPx: asset.heightPx,
      };
      const registration = photo
        ? replacePhotoRegistration(photo.registration, image, project.corner)
        : {
            registration: createPhotoRegistration(image, project.corner),
            needsNewMarking: false,
          };
      const nextPhoto: StoredPhoto = {
        schemaVersion: 1,
        asset,
        registration: registration.registration,
      };
      commit((document) => ({ ...document, photo: nextPhoto }));
      setSelectedSurface('A');
      setReview(null);
      setReviewSignature(null);
      if (registration.needsNewMarking) {
        setError(
          'The replacement needs new marking because the previous points did not define a safe plane.',
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The room photo could not be imported.',
      );
    } finally {
      setBusy(false);
    }
  };

  const beginGesture = (
    event: ReactPointerEvent<HTMLElement>,
    surfaceId: SurfaceId,
    pointIndex: number,
  ) => {
    if (readOnly || !photo) return;
    event.preventDefault();
    event.stopPropagation();
    const base = clonePhotoPlanes(currentPlanes);
    setGesture({
      pointerId: event.pointerId,
      surfaceId,
      pointIndex,
      planes: base,
    });
    const captureTarget = event.currentTarget.closest<HTMLElement>(
      '.photo-marking-canvas',
    );
    captureTarget?.setPointerCapture?.(event.pointerId);
  };

  const beginMark = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (readOnly || !photo || event.button !== 0) return;
    const plane = photoPlaneFor(currentPlanes, visibleSurface.id);
    if (plane.corners.length >= 4) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const point = pointFromClient(rect, event.clientX, event.clientY);
    const base = upsertPhotoPlane(currentPlanes, {
      surfaceId: visibleSurface.id,
      corners: [...plane.corners, point],
    });
    setGesture({
      pointerId: event.pointerId,
      surfaceId: visibleSurface.id,
      pointIndex: plane.corners.length,
      planes: base,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointerId !== event.pointerId || !photo) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = pointFromClient(rect, event.clientX, event.clientY);
    setGesture({
      ...gesture,
      planes: updateSharedPhotoPoint(
        gesture.planes,
        project.corner,
        gesture.surfaceId,
        gesture.pointIndex,
        point,
      ),
    });
  };

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const finished = gesture.planes;
    setGesture(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    commitPlanes(finished);
  };

  const cancelGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    setGesture(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const nudgePoint = (index: number, point: Vec2) => {
    const plane = photoPlaneFor(currentPlanes, visibleSurface.id);
    if (!plane.corners[index]) return;
    commitPlanes(
      updateSharedPhotoPoint(
        currentPlanes,
        project.corner,
        visibleSurface.id,
        index,
        clampPhotoPoint(point),
      ),
    );
  };

  const addNextCorner = () => {
    const plane = photoPlaneFor(currentPlanes, visibleSurface.id);
    if (!photo || readOnly || plane.corners.length >= 4) return;
    const index = plane.corners.length;
    commitPlanes(
      upsertPhotoPlane(currentPlanes, {
        surfaceId: visibleSurface.id,
        corners: [...plane.corners, [0.5, 0.5]],
      }),
    );
    requestAnimationFrame(() => {
      globalThis.document
        ?.getElementById(`photo-${visibleSurface.id}-point-${index + 1}`)
        ?.focus();
    });
  };

  const removeLast = () => {
    const plane = photoPlaneFor(currentPlanes, visibleSurface.id);
    if (plane.corners.length === 0) return;
    commitPlanes(upsertPhotoPlane(currentPlanes, {
      surfaceId: visibleSurface.id,
      corners: plane.corners.slice(0, -1),
    }), { completeShared: false });
  };

  const saveDraft = () => {
    if (!photo || readOnly) return;
    if (photo.registration.status !== 'draft') {
      updatePhoto(registrationWithPlanes(photo.registration, currentPlanes));
    }
    setError(null);
  };

  const reviewGrid = () => {
    if (!photo) return;
    setError(null);
    if (inactiveFloorRegistration) {
      setError('Remove the inactive floor registration before reviewing the remaining planes.');
      return;
    }
    const invalid = globalThis.document?.querySelector<HTMLInputElement>(
      '#photo-calibration-dialog [aria-invalid="true"]',
    );
    if (invalid) {
      setError('Correct the highlighted normalized photo coordinates before review.');
      invalid.focus();
      return;
    }
    try {
      const solved = solvePhotoPlanes(activePlanes, project.corner, photoIdentity(photo));
      setReview(solved);
      setReviewSignature(currentSignature);
    } catch (cause) {
      setReview(null);
      setReviewSignature(null);
      setError(
        cause instanceof Error
          ? cause.message
          : 'The marked planes need another review.',
      );
    }
  };

  const confirmReview = () => {
    if (!photo || readOnly || !review || reviewSignature !== currentSignature) return;
    if (inactiveFloorRegistration) {
      setError('Remove the inactive floor registration before confirming review.');
      return;
    }
    const invalid = globalThis.document?.querySelector<HTMLInputElement>(
      '#photo-calibration-dialog [aria-invalid="true"]',
    );
    if (invalid) {
      setError('Correct the highlighted normalized photo coordinates before confirming review.');
      invalid.focus();
      return;
    }
    try {
      updatePhoto(
        confirmPhotoRegistration(
          { ...photo.registration, planes: activePlanes },
          project.corner,
          new Date().toISOString(),
        ),
      );
      setReview(null);
      setReviewSignature(null);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The marked planes need another review.',
      );
    }
  };

  const addOcclusion = () => {
    if (!photo || readOnly) return;
    const rects = photo.registration.occlusionRects ?? [];
    if (rects.length >= 16) return;
    updatePhoto({
      ...photo.registration,
      occlusionRects: [
        ...rects,
        { x: 0.4, y: 0.4, width: 0.1, height: 0.1 },
      ],
    });
  };

  const setOcclusion = (
    index: number,
    patch: Partial<NonNullable<PhotoRegistrationV1['occlusionRects']>[number]>,
  ) => {
    if (!photo || readOnly) return;
    const rects = [...(photo.registration.occlusionRects ?? [])];
    const current = rects[index];
    if (!current) return;
    rects[index] = { ...current, ...patch };
    updatePhoto({ ...photo.registration, occlusionRects: rects });
  };

  const removeOcclusion = (index: number) => {
    if (!photo || readOnly) return;
    const rects = (photo.registration.occlusionRects ?? []).filter((_, i) => i !== index);
    updatePhoto({ ...photo.registration, occlusionRects: rects.length ? rects : undefined });
  };

  const inactiveFloorRegistration =
    !project.corner.includeBase &&
    photo?.registration.planes.some((plane) => plane.surfaceId === 'C');

  const removeInactiveFloorRegistration = () => {
    if (!photo || readOnly || !inactiveFloorRegistration) return;
    updatePhoto({
      ...photo.registration,
      planes: photo.registration.planes.filter((plane) => plane.surfaceId !== 'C'),
      status: 'draft',
      reviewedAt: null,
    });
    setReview(null);
    setReviewSignature(null);
    setError(null);
  };

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (gesture) {
        setGesture(null);
        return;
      }
      closeCalibration();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && event.target === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && event.target === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!photo) {
    return (
      <Disclosure
        id="photo-workflow"
        key="photo-empty"
        title="Use a room photo"
        description="Optionally review computed pieces against a captured room."
      >
        <div className="photo-workflow-body">
          <p className="photo-intro">
            Add a local room photo to mark the measured wall planes and inspect
            the actual computed print pieces in context. A photo does not infer
            measurements, scale, or the design eye.
          </p>
          <button
            type="button"
            id="choose-room-photo"
            className="button-quiet"
            disabled={readOnly || busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Importing…' : 'Choose room photo'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="visually-hidden"
            aria-label="Choose room photo"
            disabled={readOnly || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importPhoto(file);
              event.target.value = '';
            }}
          />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
          {readOnly ? (
            <p className="photo-readonly-note">
              This project is read-only. Open a copy to add or change a room photo.
            </p>
          ) : null}
        </div>
      </Disclosure>
    );
  }

  return (
    <Disclosure
      id="photo-workflow"
      key="photo-present"
      title="Use a room photo"
      description="Mark measured planes and review the computed pieces in context."
      defaultOpen
    >
      <div className="photo-workflow-body">
        <p className="photo-intro">
          The photo is a local visual reference. Wall dimensions and the design
          eye stay in the controls above and in Viewpoint; nothing is inferred
          from pixels.
        </p>
        <PhotoAssetRow
          photo={photo}
          busy={busy}
          readOnly={readOnly}
          onReplace={() => fileRef.current?.click()}
          onRemove={() => {
            commit((document) => ({ ...document, photo: null }));
            setReview(null);
            setReviewSignature(null);
          }}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          className="visually-hidden"
          aria-label="Replace room photo"
          disabled={readOnly || busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importPhoto(file);
            event.target.value = '';
          }}
        />
        {status ? (
          <p className={`photo-status photo-status--${status.tone}`} role="status">
            <strong>{status.tone === 'current' ? 'Calibrated' : status.tone === 'stale' ? 'Needs review' : 'Draft'}</strong>
            <span>{status.label}</span>
          </p>
        ) : null}
        {error && !calibrationOpen ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="photo-measurement-reminder">
          Enter or review real wall dimensions above. The photo registration
          keeps its measured geometry separate from the design-eye values in
          Viewpoint.
        </p>
        {inactiveFloorRegistration ? (
          <div className="photo-inactive-floor-note" role="note">
            <strong>Floor C is no longer included.</strong>
            <span>
              Its prior photo marking is preserved until you explicitly remove
              this inactive registration before reviewing the remaining planes.
            </span>
            <button
              type="button"
              className="button-quiet"
              disabled={readOnly}
              onClick={removeInactiveFloorRegistration}
            >
              Remove inactive floor registration
            </button>
          </div>
        ) : null}
        <button
          ref={calibrationTriggerRef}
          type="button"
          className="button-primary photo-open-workspace"
          onClick={() => setCalibrationOpen(true)}
        >
          {status?.tone === 'stale' ? 'Review photo calibration' : 'Open calibration workspace'}
        </button>
        <dialog
          ref={calibrationDialogRef}
          id="photo-calibration-dialog"
          className="photo-calibration-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="photo-calibration-heading"
          onCancel={(event) => {
            event.preventDefault();
            closeCalibration();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) closeCalibration();
          }}
          onKeyDown={onDialogKeyDown}
        >
          <div className="photo-dialog-shell">
            <div className="photo-dialog-heading">
              <div>
                <p className="photo-dialog-eyebrow">Local calibration workspace</p>
                <h3 id="photo-calibration-heading" data-photo-dialog-heading tabIndex={-1}>
                  Mark the measured planes
                </h3>
                <p>
                  Use the captured room only as a visual reference. Mark each
                  visible plane in the numbered order shown for that surface.
                </p>
              </div>
              <button
                type="button"
                className="button-quiet photo-dialog-close"
                onClick={closeCalibration}
              >
                Close workspace
              </button>
            </div>
            <div className="photo-dialog-body">
              {error ? <p className="field-error" role="alert">{error}</p> : null}
              <PlaneTabs
                surfaces={surfaces}
          selected={visibleSurface.id}
          planes={currentPlanes}
          onSelect={selectSurface}
              />
              <p className="photo-plane-instructions">
                Surface {visibleSurface.id}: mark{' '}
                {photoPlaneFor(currentPlanes, visibleSurface.id).corners.length < 4
                  ? `${photoCornerLabels(visibleSurface)[photoPlaneFor(currentPlanes, visibleSurface.id).corners.length] ?? 'the next corner'}.`
                  : 'all four corners are marked; refine them with the keyboard fields below.'}
              </p>
              <button
                type="button"
                className="button-quiet photo-add-point"
                disabled={
                  readOnly ||
                  photoPlaneFor(currentPlanes, visibleSurface.id).corners.length >= 4
                }
                onClick={addNextCorner}
              >
                Add next corner at center
              </button>
              <PhotoMarkingCanvas
                photo={photo}
                surface={visibleSurface}
                planes={currentPlanes}
                readOnly={readOnly}
                onBeginPoint={(event, index) =>
                  beginGesture(event, visibleSurface.id, index)
                }
                onBeginMark={beginMark}
                onPointNudge={nudgePoint}
                onPointerMove={moveGesture}
                onPointerUp={endGesture}
                onPointerCancel={cancelGesture}
                onLostPointerCapture={cancelGesture}
              />
              <PhotoPointFields
                surface={visibleSurface}
                planes={currentPlanes}
                readOnly={readOnly}
                onChange={nudgePoint}
              />
              <div className="photo-marking-actions">
                <button
                  type="button"
                  className="button-quiet"
                  disabled={readOnly || photoPlaneFor(currentPlanes, visibleSurface.id).corners.length === 0}
                  onClick={removeLast}
                >
                  Remove last corner
                </button>
                <button
                  type="button"
                  className="button-quiet"
                  disabled={readOnly || currentPlanes.length < 2}
                  onClick={() =>
                    commitPlanes(reuseSharedPhotoAnchors(currentPlanes, project.corner))
                  }
                >
                  Reuse shared seam anchors
                </button>
                <button
                  type="button"
                  className="button-quiet"
                  disabled={readOnly}
                  onClick={saveDraft}
                >
                  Save draft
                </button>
                <button
                  type="button"
                  className="button-primary"
                  disabled={
                    readOnly ||
                    inactiveFloorRegistration ||
                    !photoPlanesReviewable(activePlanes)
                  }
                  onClick={reviewGrid}
                >
                  Review grid
                </button>
              </div>
              {review && reviewSignature === currentSignature ? (
                <PhotoReview
                  photo={photo}
                  solved={review}
                  readOnly={readOnly}
                  onConfirm={confirmReview}
                />
              ) : null}
            </div>
          </div>
        </dialog>
        <section className="photo-occlusions" aria-label="Photo-only occlusion masks">
          <div className="photo-subsection-heading">
            <h4>Photo-only occlusion masks</h4>
            <p>Hide known obstructions in Photo view without changing print geometry.</p>
          </div>
          {(photo.registration.occlusionRects ?? []).map((rect, index) => (
            <fieldset key={`photo-occlusion-${index}`} className="photo-occlusion-row" disabled={readOnly}>
              <legend>Mask {index + 1}</legend>
              <div className="photo-normalized-grid photo-occlusion-grid">
                <PhotoNumberField
                  key={`photo-occlusion-${index}-x-${rect.x}`}
                  id={`photo-occlusion-${index}-x`}
                  label="X"
                  value={rect.x}
                  min={0}
                  max={Math.max(0, 1 - rect.width)}
                  digits={3}
                  onCommit={(value) => setOcclusion(index, { x: value })}
                />
                <PhotoNumberField
                  key={`photo-occlusion-${index}-y-${rect.y}`}
                  id={`photo-occlusion-${index}-y`}
                  label="Y"
                  value={rect.y}
                  min={0}
                  max={Math.max(0, 1 - rect.height)}
                  digits={3}
                  onCommit={(value) => setOcclusion(index, { y: value })}
                />
                <PhotoNumberField
                  key={`photo-occlusion-${index}-width-${rect.width}`}
                  id={`photo-occlusion-${index}-width`}
                  label="Width"
                  value={rect.width}
                  min={0.001}
                  max={Math.max(0.001, 1 - rect.x)}
                  digits={3}
                  onCommit={(value) => setOcclusion(index, { width: value })}
                />
                <PhotoNumberField
                  key={`photo-occlusion-${index}-height-${rect.height}`}
                  id={`photo-occlusion-${index}-height`}
                  label="Height"
                  value={rect.height}
                  min={0.001}
                  max={Math.max(0.001, 1 - rect.y)}
                  digits={3}
                  onCommit={(value) => setOcclusion(index, { height: value })}
                />
              </div>
              <button
                type="button"
                className="button-link"
                disabled={readOnly}
                onClick={() => removeOcclusion(index)}
              >
                Remove mask
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="button-quiet"
            disabled={readOnly || (photo.registration.occlusionRects?.length ?? 0) >= 16}
            onClick={addOcclusion}
          >
            Add occlusion mask
          </button>
          <p className="photo-occlusion-note">
            Masks are normalized photo rectangles only. They never alter the
            measured planes, print pieces, tiling, or export.
          </p>
        </section>
      </div>
    </Disclosure>
  );
}
