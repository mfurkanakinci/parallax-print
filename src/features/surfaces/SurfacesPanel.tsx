import { useState } from 'react';
import { Disclosure } from '../../components/Disclosure';
import { MeasurementField, NumberField } from '../../components/MeasurementField';
import {
  SurfaceDiagram,
  type DiagramFocus,
} from '../../components/SurfaceDiagram';
import { LIMITS } from '../../core/limits';
import { deriveAngleFromTriangle } from '../../core/geometry/angleMeasurement';
import type { CornerSpec, DisplayUnit, Issue, ProjectV1 } from '../../core/types';
import type { StoredPhoto } from '../../persistence/types';
import { useProjectStore } from '../../state/projectStore';
import { IssueList } from '../../components/IssueList';
import { Icon } from '../../components/Icon';
import { isCornerIssue } from '../editor/stepStatus';
import { PhotoWorkflow } from '../photo/PhotoWorkflow';

export function SurfacesPanel({
  project,
  issues,
  readOnly,
  photo = null,
}: {
  readonly project: ProjectV1;
  readonly issues: readonly Issue[];
  readonly readOnly: boolean;
  readonly photo?: StoredPhoto | null;
}) {
  const commit = useProjectStore((s) => s.commit);
  const [focused, setFocused] = useState<DiagramFocus>(null);
  const [tapeError, setTapeError] = useState<string | null>(null);
  const [tape, setTape] = useState({ a: 400, b: 400, chord: 565.685, height: 300 });
  const cornerIssues = issues.filter(isCornerIssue);
  const corner = project.corner;
  const unit = project.displayUnit;

  const setCorner = (next: CornerSpec) =>
    commit((doc) => ({
      ...doc,
      project: { ...doc.project, corner: next },
    }));

  const applyTape = () => {
    try {
      const angleDeg = deriveAngleFromTriangle(tape.a, tape.b, tape.chord);
      setTapeError(null);
      setCorner({
        ...corner,
        angleDeg,
        angleMeasurement: {
          method: 'tape-triangle',
          offsetAMm: tape.a,
          offsetBMm: tape.b,
          chordMm: tape.chord,
          measurementHeightMm: tape.height,
        },
      });
    } catch (e) {
      setTapeError(e instanceof Error ? e.message : 'Impossible triangle.');
    }
  };

  const recenter = () => {
    const distance =
      Math.max(corner.panelA.widthMm, corner.panelB.widthMm) * 1.5;
    const half = (corner.angleDeg * Math.PI) / 360;
    commit((doc) => ({
      ...doc,
      project: {
        ...doc.project,
        viewpoint: {
          ...doc.project.viewpoint,
          eyeMm: [
            distance * Math.cos(half),
            doc.project.viewpoint.eyeMm[1],
            distance * Math.sin(half),
          ],
        },
      },
    }));
  };

  return (
    <div className="panel">
      <h2>Corner</h2>
      <p className="panel-note">
        Enter the measured dimensions of the two walls that meet at the
        corner — the print pieces are built to fit them exactly.
      </p>
      <div className="panel-note example-notice" role="note">
        <Icon name="warning" size={16} />
        <span>
          <strong>Example measurements</strong>
          <span>
            New projects start with example values. Replace every dimension,
            angle, and eye position with measurements from the real
            installation before production export.
          </span>
        </span>
      </div>
      <SurfaceDiagram corner={corner} focused={focused} />
      <fieldset className="field-group dimension-group" disabled={readOnly}>
        <legend>
          <span className="surface-key" aria-hidden="true">
            A
          </span>
          <span className="dimension-legend-text">
            <strong>Panel A</strong>
            <span>+X wall</span>
          </span>
        </legend>
        <div className="dimension-grid">
          <MeasurementField
            id="panel-a-width"
            label="Width"
            accessibleLabel="Panel A width"
            valueMm={corner.panelA.widthMm}
            unit={unit}
            minMm={LIMITS.panelMm.min}
            maxMm={LIMITS.panelMm.max}
            onFocusChange={(f) => setFocused(f ? 'panelA' : null)}
            onCommit={(mm) =>
              setCorner({
                ...corner,
                panelA: { ...corner.panelA, widthMm: mm },
              })
            }
          />
          <MeasurementField
            id="panel-a-height"
            label="Height"
            accessibleLabel="Panel A height"
            valueMm={corner.panelA.heightMm}
            unit={unit}
            minMm={LIMITS.panelMm.min}
            maxMm={LIMITS.panelMm.max}
            onFocusChange={(f) => setFocused(f ? 'panelA' : null)}
            onCommit={(mm) =>
              setCorner({
                ...corner,
                panelA: { ...corner.panelA, heightMm: mm },
              })
            }
          />
        </div>
      </fieldset>
      <fieldset className="field-group dimension-group" disabled={readOnly}>
        <legend>
          <span className="surface-key" aria-hidden="true">
            B
          </span>
          <span className="dimension-legend-text">
            <strong>Panel B</strong>
            <span>Angled wall</span>
          </span>
        </legend>
        <div className="dimension-grid">
          <MeasurementField
            id="panel-b-width"
            label="Width"
            accessibleLabel="Panel B width"
            valueMm={corner.panelB.widthMm}
            unit={unit}
            minMm={LIMITS.panelMm.min}
            maxMm={LIMITS.panelMm.max}
            onFocusChange={(f) => setFocused(f ? 'panelB' : null)}
            onCommit={(mm) =>
              setCorner({
                ...corner,
                panelB: { ...corner.panelB, widthMm: mm },
              })
            }
          />
          <MeasurementField
            id="panel-b-height"
            label="Height"
            accessibleLabel="Panel B height"
            valueMm={corner.panelB.heightMm}
            unit={unit}
            minMm={LIMITS.panelMm.min}
            maxMm={LIMITS.panelMm.max}
            onFocusChange={(f) => setFocused(f ? 'panelB' : null)}
            onCommit={(mm) =>
              setCorner({
                ...corner,
                panelB: { ...corner.panelB, heightMm: mm },
              })
            }
          />
        </div>
      </fieldset>
      <fieldset className="field-group corner-shape-group" disabled={readOnly}>
        <legend>Corner shape</legend>
        <NumberField
          id="corner-angle"
          label="Interior angle"
          value={corner.angleDeg}
          suffix="°"
          min={LIMITS.angleDeg.min}
          max={LIMITS.angleDeg.max}
          description={`Supported range ${LIMITS.angleDeg.min}–${LIMITS.angleDeg.max}°. Direct entry clears the tape measurement.`}
          onCommit={(v) => {
            const { angleMeasurement: _drop, ...rest } = corner;
            setCorner({ ...rest, angleDeg: v });
          }}
        />
        <label className="check-row toggle-row">
          <input
            type="checkbox"
            checked={corner.includeBase}
            onChange={(e) => {
              const includeBase = e.target.checked;
              commit((doc) => ({
                ...doc,
                project: {
                  ...doc.project,
                  corner: { ...doc.project.corner, includeBase },
                  print: {
                    ...doc.project.print,
                    surfaceIds: includeBase
                      ? [...doc.project.print.surfaceIds, 'C']
                      : doc.project.print.surfaceIds.filter((s) => s !== 'C'),
                  },
                },
              }));
            }}
          />
          Include horizontal base (surface C)
        </label>
      </fieldset>
      {corner.angleMeasurement ? (
        <p className="panel-note">
          Angle derived from a tape triangle at{' '}
          {corner.angleMeasurement.measurementHeightMm} mm height. Editing the
          angle directly clears this record.
        </p>
      ) : null}
      {cornerIssues.length > 0 ? <IssueList issues={cornerIssues} /> : null}
      <Disclosure
        id="tape-measure"
        title="Measure the angle with a tape"
        description="Derive the corner angle from three physical measurements."
      >
        <ol className="tape-steps">
          <li>Pick a measurement height above the floor.</li>
          <li>Mark a known offset along each wall from the seam.</li>
          <li>Measure the chord between the two marks.</li>
          <li>Enter the four values below and apply the measured angle.</li>
        </ol>
        <MeasurementField
          id="tape-offset-a"
          label="Offset along panel A"
          valueMm={tape.a}
          unit={unit}
          minMm={1}
          onCommit={(mm) => setTape((t) => ({ ...t, a: mm }))}
        />
        <MeasurementField
          id="tape-offset-b"
          label="Offset along panel B"
          valueMm={tape.b}
          unit={unit}
          minMm={1}
          onCommit={(mm) => setTape((t) => ({ ...t, b: mm }))}
        />
        <MeasurementField
          id="tape-chord"
          label="Chord between marks"
          valueMm={tape.chord}
          unit={unit}
          minMm={1}
          onCommit={(mm) => setTape((t) => ({ ...t, chord: mm }))}
        />
        <MeasurementField
          id="tape-height"
          label="Measurement height above floor"
          valueMm={tape.height}
          unit={unit}
          minMm={1}
          onCommit={(mm) => setTape((t) => ({ ...t, height: mm }))}
        />
        <button
          type="button"
          className="button-quiet"
          disabled={readOnly}
          onClick={applyTape}
        >
          Apply measured angle
        </button>
        {tapeError ? (
          <p className="field-error" role="alert">
            {tapeError}
          </p>
        ) : null}
        <p className="panel-note">
          A tape triangle verifies the angle only — not that walls are
          vertical, flat, or share a straight seam.
        </p>
      </Disclosure>
      <Disclosure
        title="Surface tools"
        description="Units and automatic viewpoint placement."
      >
        <label className="select-row">
          Display units
          <select
            value={unit}
            disabled={readOnly}
            onChange={(e) => {
              const displayUnit = e.target.value as DisplayUnit;
              commit((doc) => ({
                ...doc,
                project: { ...doc.project, displayUnit },
              }));
            }}
            aria-label="Display units"
          >
            <option value="mm">mm</option>
            <option value="cm">cm</option>
            <option value="in">in</option>
          </select>
        </label>
        <button
          type="button"
          className="button-quiet"
          disabled={readOnly}
          onClick={recenter}
        >
          Recenter viewpoint on the corner bisector
        </button>
      </Disclosure>
      <PhotoWorkflow project={project} photo={photo} readOnly={readOnly} />
    </div>
  );
}
