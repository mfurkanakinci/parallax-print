import { useState } from 'react';
import { Disclosure } from '../../components/Disclosure';
import { MeasurementField } from '../../components/MeasurementField';
import { ElevationDiagram, SurfaceDiagram, type DiagramFocus } from '../../components/SurfaceDiagram';
import { LIMITS } from '../../core/limits';
import type { Issue, ProjectV1 } from '../../core/types';
import { useProjectStore } from '../../state/projectStore';
import { IssueList } from '../../components/IssueList';
import { isViewpointIssue } from '../editor/stepStatus';

export function ViewpointPanel({
  project,
  issues,
  readOnly,
}: {
  readonly project: ProjectV1;
  readonly issues: readonly Issue[];
  readonly readOnly: boolean;
}) {
  const commit = useProjectStore((s) => s.commit);
  const [focused, setFocused] = useState<DiagramFocus>(null);
  const { eyeMm, aimHeightMm } = project.viewpoint;
  const unit = project.displayUnit;
  const corner = project.corner;

  const setEye = (x: number, y: number, z: number) =>
    commit((doc) => ({
      ...doc,
      project: {
        ...doc.project,
        viewpoint: { ...doc.project.viewpoint, eyeMm: [x, y, z] },
      },
    }));

  const recenter = () => {
    const distance =
      Math.max(corner.panelA.widthMm, corner.panelB.widthMm) * 1.5;
    const half = (corner.angleDeg * Math.PI) / 360;
    setEye(distance * Math.cos(half), eyeMm[1], distance * Math.sin(half));
  };

  const viewpointIssues = issues.filter(isViewpointIssue);

  return (
    <div className="panel">
      <h2>Viewpoint</h2>
      <p className="panel-note">
        The viewing point is where the camera lens — not your feet — sits.
        Mark its floor plumb point at the printed coordinates, then raise to
        eye height.
      </p>
      <SurfaceDiagram
        corner={corner}
        eyeMm={eyeMm}
        focused={focused}
        onEyeCommit={
          readOnly
            ? undefined
            : (x, z) =>
                setEye(
                  Math.round(x * 10) / 10,
                  eyeMm[1],
                  Math.round(z * 10) / 10,
                )
        }
      />
      <fieldset className="field-group" disabled={readOnly}>
        <legend>Floor position of the eye point</legend>
        <MeasurementField
          id="eye-x"
          label="Distance along wall A"
          valueMm={eyeMm[0]}
          unit={unit}
          minMm={-LIMITS.viewer.coordAbsMaxMm}
          maxMm={LIMITS.viewer.coordAbsMaxMm}
          description="The X coordinate — positive is along panel A away from corner O."
          onFocusChange={(f) => setFocused(f ? 'eye' : null)}
          onCommit={(mm) => setEye(mm, eyeMm[1], eyeMm[2])}
        />
        <MeasurementField
          id="eye-z"
          label="Distance out from the corner"
          valueMm={eyeMm[2]}
          unit={unit}
          minMm={-LIMITS.viewer.coordAbsMaxMm}
          maxMm={LIMITS.viewer.coordAbsMaxMm}
          description="The Z coordinate — negative places the eye behind panel A's face, which blocks the projection."
          onFocusChange={(f) => setFocused(f ? 'eye' : null)}
          onCommit={(mm) => setEye(eyeMm[0], eyeMm[1], mm)}
        />
      </fieldset>
      <fieldset className="field-group viewpoint-height-group" disabled={readOnly}>
        <legend>Height and aim</legend>
        <MeasurementField
          id="eye-y"
          label="Lens height above floor"
          valueMm={eyeMm[1]}
          unit={unit}
          minMm={LIMITS.viewer.eyeHeightMinMm}
          maxMm={LIMITS.viewer.eyeHeightMaxMm}
          onFocusChange={(f) => setFocused(f ? 'eye' : null)}
          onCommit={(mm) => setEye(eyeMm[0], mm, eyeMm[2])}
        />
        <MeasurementField
          id="aim-height"
          label="Aim height on seam"
          valueMm={aimHeightMm}
          unit={unit}
          minMm={0}
          maxMm={LIMITS.panelMm.max}
          description="The point on the shared seam the lens centers on."
          onFocusChange={(f) => setFocused(f ? 'aim' : null)}
          onCommit={(mm) =>
            commit((doc) => ({
              ...doc,
              project: {
                ...doc.project,
                viewpoint: { ...doc.project.viewpoint, aimHeightMm: mm },
              },
            }))
          }
        />
      </fieldset>
      {viewpointIssues.length > 0 ? (
        <IssueList issues={viewpointIssues} />
      ) : null}
      <Disclosure
        title="Viewpoint tools"
        description="Inspect elevation and reset to the corner bisector."
      >
        <ElevationDiagram
          corner={corner}
          eyeMm={eyeMm}
          aimHeightMm={aimHeightMm}
          focused={focused}
        />
        <button
          type="button"
          className="button-quiet"
          disabled={readOnly}
          onClick={recenter}
        >
          Recenter on the corner bisector
        </button>
      </Disclosure>
    </div>
  );
}
