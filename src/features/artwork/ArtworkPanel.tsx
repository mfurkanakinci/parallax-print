import { useEffect, useMemo, useRef, useState } from 'react';
import { Disclosure } from '../../components/Disclosure';
import { Icon } from '../../components/Icon';
import { NumberField } from '../../components/MeasurementField';
import { importAndAttach } from './artworkImport';
import { LIMITS } from '../../core/limits';
import { useProjectStore } from '../../state/projectStore';
import type { Issue, ProjectV1 } from '../../core/types';
import type { StoredAsset } from '../../persistence/types';
import { IssueList } from '../../components/IssueList';
import { isArtworkIssue } from '../editor/stepStatus';
import {
  clampCenterSlope,
  clampHeightSlope,
  wrapRotationDeg,
} from '../../viewport/artworkGesture';

export function ArtworkPanel({
  project,
  asset,
  issues,
  missingAsset,
  readOnly,
  locked,
  onLockedChange,
}: {
  readonly project: ProjectV1;
  readonly asset: StoredAsset | null;
  readonly issues: readonly Issue[];
  readonly missingAsset: boolean;
  readonly readOnly: boolean;
  /** Session-only placement lock, lifted to EditorPage so the resolved-view
      overlay and these controls share it (§12.6). */
  readonly locked: boolean;
  readonly onLockedChange: (locked: boolean) => void;
}) {
  const commit = useProjectStore((s) => s.commit);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );
  const assetUrl = useMemo(() => {
    if (!asset || typeof URL.createObjectURL !== 'function') return null;
    return URL.createObjectURL(asset.normalizedPng);
  }, [asset]);
  useEffect(
    () => () => {
      if (assetUrl) URL.revokeObjectURL(assetUrl);
    },
    [assetUrl],
  );
  const artworkIssues = issues.filter(isArtworkIssue);
  const artwork = project.artwork;

  const importFile = async (file: File | Blob, name: string) => {
    const generation = ++generationRef.current;
    setBusy(true);
    setError(null);
    try {
      // The shared helper commits the attach-or-update; it returns null if
      // this project is no longer the open document.
      await importAndAttach(file, name, project.id);
    } catch (e) {
      if (generation === generationRef.current) {
        setError(e instanceof Error ? e.message : 'Could not import that image.');
      }
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const setArtwork = (patch: Partial<NonNullable<ProjectV1['artwork']>>) => {
    if (!artwork) return;
    commit((doc) => ({
      ...doc,
      project: {
        ...doc.project,
        artwork: doc.project.artwork
          ? { ...doc.project.artwork, ...patch }
          : doc.project.artwork,
      },
    }));
  };

  return (
    <div className="panel">
      <h2>Artwork</h2>
      <p className="panel-note">
        Choose the image the installation reconstructs, then place it on the
        apparent plane the design eye sees.
      </p>
      {missingAsset ? (
        <p className="field-error" role="alert">
          This project references an image that is no longer stored locally.
          Relink it by choosing the file again below — geometry and placement
          are preserved.
        </p>
      ) : null}
      {asset ? (
        <div
          className="artwork-asset-row"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && !readOnly && !busy) void importFile(file, file.name);
          }}
        >
          {assetUrl ? (
            <img
              className="artwork-asset-thumb"
              src={assetUrl}
              alt="Selected artwork thumbnail"
            />
          ) : (
            <span className="artwork-asset-thumb" aria-hidden="true">
              <Icon name="artwork" size={20} />
            </span>
          )}
          <span className="artwork-asset-meta">
            <strong title={asset.displayFilename}>{asset.displayFilename}</strong>
            <span>
              {asset.widthPx}×{asset.heightPx} px · normalized PNG
            </span>
          </span>
          <button
            type="button"
            id="choose-artwork"
            className="button-quiet"
            disabled={readOnly || busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Importing…' : 'Replace'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="visually-hidden"
            aria-label="Choose artwork image"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file, file.name);
              e.target.value = '';
            }}
          />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file && !readOnly && !busy) void importFile(file, file.name);
          }}
        >
          <Icon name="upload" size={22} />
          <p>
            No artwork yet. Choose a PNG or JPEG; it is normalized and stored
            only on this device.
          </p>
          <button
            type="button"
            id="choose-artwork"
            className="button-quiet"
            disabled={readOnly || busy}
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'Importing…' : 'Choose image'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            className="visually-hidden"
            aria-label="Choose artwork image"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importFile(file, file.name);
              e.target.value = '';
            }}
          />
          {error ? (
            <p className="field-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
      {artworkIssues.length > 0 ? <IssueList issues={artworkIssues} /> : null}
      {artwork ? (
        <>
          <fieldset className="field-group" disabled={readOnly || locked}>
            <legend>Placement on the apparent image plane</legend>
            <NumberField
              id="art-center-x"
              label="Horizontal position"
              value={artwork.centerSlope[0]}
              onCommit={(v) =>
                setArtwork({
                  centerSlope: [
                    clampCenterSlope(v),
                    artwork.centerSlope[1],
                  ],
                })
              }
              min={-LIMITS.artworkSlope.centerAbsMax}
              max={LIMITS.artworkSlope.centerAbsMax}
            />
            <NumberField
              id="art-center-y"
              label="Vertical position"
              value={artwork.centerSlope[1]}
              onCommit={(v) =>
                setArtwork({
                  centerSlope: [
                    artwork.centerSlope[0],
                    clampCenterSlope(v),
                  ],
                })
              }
              min={-LIMITS.artworkSlope.centerAbsMax}
              max={LIMITS.artworkSlope.centerAbsMax}
            />
            <NumberField
              id="art-height"
              label="Apparent size"
              value={artwork.heightSlope}
              min={LIMITS.artworkSlope.heightMin}
              max={LIMITS.artworkSlope.heightMax}
              onCommit={(v) =>
                setArtwork({ heightSlope: clampHeightSlope(v) })
              }
            />
            <NumberField
              id="art-rotation"
              label="Rotation"
              value={artwork.rotationDeg}
              suffix="°"
              min={-180}
              max={180}
              onCommit={(v) =>
                setArtwork({ rotationDeg: wrapRotationDeg(v) })
              }
            />
          </fieldset>
          <label className="check-row toggle-row">
            <input
              type="checkbox"
              checked={locked}
              disabled={readOnly}
              onChange={(e) => onLockedChange(e.target.checked)}
            />
            Lock placement (numeric controls and direct editing)
          </label>
          <button
            type="button"
            className="button-quiet"
            disabled={readOnly || locked || !artwork}
            onClick={() =>
              setArtwork({
                centerSlope: [0, 0],
                rotationDeg: 0,
                heightSlope: 0.4,
              })
            }
          >
            Reset artwork placement
          </button>
          <Disclosure
            title="Technical placement values"
            description="Fine-tune placement with the raw slope units behind the controls."
          >
            <p className="panel-note">
              Slopes are apparent position from the eye, not millimetres. A
              slope of 0.1 means the artwork edge sits one tenth of the viewing
              distance off the aim axis. Drag the frame directly in the
              Resolved preview to move, resize, or rotate it — the numeric
              fields above are the keyboard-accessible equivalent.
            </p>
          </Disclosure>
        </>
      ) : null}
    </div>
  );
}
