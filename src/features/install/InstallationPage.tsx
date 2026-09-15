import { useEffect, useState } from 'react';
import { navigate, navigateToEditorStep } from '../../app/navigation';
import { BrandLockup } from '../../components/Brand';
import { MissingProjectRecovery } from '../../components/MissingProjectRecovery';
import { RecoveryState } from '../../components/RecoveryState';
import { SurfaceDiagram } from '../../components/SurfaceDiagram';
import { compileProject } from '../../core/geometry/compileProject';
import { planTiles, type PrintLayout } from '../../core/print/tiling';
import { formatMm } from '../../core/units';
import type { ProjectV1 } from '../../core/types';
import type { StoredAsset } from '../../persistence/types';
import { loadProject } from '../../persistence/projectRepository';

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | {
      status: 'ready';
      project: ProjectV1;
      asset: StoredAsset | null;
      revision: number;
    }
  | { status: 'error'; message: string };

/**
 * The guide is a read-only companion to the editor. Navigating back must land
 * on the Print task, not the editor's initial Corner task. The navigation
 * intent is consumed by EditorPage only after the real document loads.
 */
function openPrintStep(projectId: string): void {
  navigateToEditorStep(projectId, 'print');
}

function formatRevisionDate(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'current local revision';
  const day = new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  return `${day} · ${time}`;
}

function planFor(
  project: ProjectV1,
  asset: StoredAsset | null,
): { scene: ReturnType<typeof compileProject>['scene']; layout: PrintLayout | null } {
  const compiled = compileProject(project, asset);
  if (!compiled.scene) return { scene: null, layout: null };
  try {
    return {
      scene: compiled.scene,
      layout: planTiles(compiled.scene, project.print),
    };
  } catch {
    return { scene: compiled.scene, layout: null };
  }
}

export function InstallationPage({ projectId }: { projectId: string }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    loadProject(projectId)
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) {
          setLoad({ status: 'missing' });
        } else {
          setLoad({
            status: 'ready',
            project: loaded.document.project,
            asset: loaded.document.asset,
            revision: loaded.revision,
          });
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setLoad({
            status: 'error',
            message:
              e instanceof Error ? e.message : 'Could not open the project.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (load.status === 'loading') {
    return (
      <main className="page-loading">
        <p>Loading installation guide…</p>
      </main>
    );
  }
  if (load.status === 'missing') {
    return <MissingProjectRecovery />;
  }
  if (load.status === 'error') {
    return (
      <RecoveryState
        heading="This project could not be opened."
        actions={
          <button
            type="button"
            className="button-quiet"
            onClick={() => navigate({ name: 'projects' })}
          >
            Back to projects
          </button>
        }
      >
        <p role="alert">{load.message}</p>
      </RecoveryState>
    );
  }

  const { project, asset, revision } = load;
  const { layout } = planFor(project, asset);
  const unit = project.displayUnit;
  const { corner, viewpoint, print } = project;
  const [eyeX, eyeY, eyeZ] = viewpoint.eyeMm;
  const printPlan = layout
    ? `${layout.tiles.length} page${layout.tiles.length === 1 ? '' : 's'} / ${layout.volumes.length} volume${layout.volumes.length === 1 ? '' : 's'}`
    : 'Page plan unavailable';

  return (
    <main className="page-install field-guide m4-field-guide">
      <p className="print-title">{project.title} — field guide</p>
      <header
        className="site-header m4-guide-toolbar"
        aria-label="Field guide actions"
      >
        <a
          className="m4-guide-brand"
          href="#/projects"
          aria-label="Back to Projects"
          onClick={(event) => {
            event.preventDefault();
            navigate({ name: 'projects' });
          }}
        >
          <BrandLockup compact />
        </a>
        <div className="m4-guide-actions guide-actions">
          <button
            type="button"
            className="button-quiet"
            onClick={() => openPrintStep(project.id)}
          >
            Back to editor
          </button>
          <button
            type="button"
            className="button-primary"
            onClick={() => window.print()}
          >
            Print field guide
          </button>
        </div>
      </header>
      <article className="m4-guide-sheet">
        <header className="m4-guide-head">
          <div>
            <p className="m4-guide-kicker">Installation field guide</p>
            <h1>{project.title}</h1>
          </div>
          <p className="m4-guide-revision" data-revision={String(revision)}>
            Revision {formatRevisionDate(project.updatedAt)}
          </p>
        </header>
        <p className="m4-guide-warning m4-physical-note" role="note">
          <strong>Physical calibration is unverified</strong>
          Measure and mark the real installation before fixing anything
          permanently.
        </p>
        <section aria-label="Project specification" className="m4-guide-spec">
          <h2>Project specification</h2>
          <dl className="m4-guide-spec-grid">
            <div>
              <dt>Panel A</dt>
              <dd>
                {formatMm(corner.panelA.widthMm, unit)} ×{' '}
                {formatMm(corner.panelA.heightMm, unit)}
              </dd>
            </div>
            <div>
              <dt>Panel B</dt>
              <dd>
                {formatMm(corner.panelB.widthMm, unit)} ×{' '}
                {formatMm(corner.panelB.heightMm, unit)} · {corner.angleDeg}°
              </dd>
            </div>
            <div>
              <dt>Floor C</dt>
              <dd>{corner.includeBase ? 'Included' : 'Not included'}</dd>
            </div>
            <div>
              <dt>Design eye</dt>
              <dd>
                {formatMm(eyeX, unit)} × {formatMm(eyeY, unit)} ×{' '}
                {formatMm(eyeZ, unit)}
              </dd>
            </div>
            <div>
              <dt>Aim height</dt>
              <dd>{formatMm(viewpoint.aimHeightMm, unit)}</dd>
            </div>
            <div>
              <dt>Print</dt>
              <dd>
                {print.paper.toUpperCase()} {print.orientation} · {print.dpi}{' '}
                DPI · {printPlan}
              </dd>
            </div>
          </dl>
        </section>
        <section aria-label="Plan and design eye" className="m4-guide-plan">
          <div>
            <h2>Mark the design eye</h2>
            <p>
              Measure from the inside corner datum. The lens—not the viewer’s
              feet—returns to this point.
            </p>
            <ul className="m4-guide-plan-list">
              <li>
                Mark {formatMm(eyeX, unit)} along panel A’s datum and{' '}
                {formatMm(eyeZ, unit)} into the corner.
              </li>
              <li>Hold the lens at {formatMm(eyeY, unit)} above the floor.</li>
              <li>
                Aim at the seam at {formatMm(viewpoint.aimHeightMm, unit)}.
              </li>
            </ul>
          </div>
          <SurfaceDiagram corner={corner} eyeMm={viewpoint.eyeMm} />
        </section>
        <ol className="m4-guide-procedures" aria-label="Installation sequence">
          <li className="m4-guide-step guide-step">
            <span className="m4-guide-step-number" aria-hidden="true">
              01
            </span>
            <div>
              <p className="m4-guide-step-kicker">Print checks</p>
              <h2>Print at actual size</h2>
              <p>
                Turn off “Fit to page”. Measure the 100 mm ruler on the first
                sheet before continuing.
              </p>
            </div>
            <span className="m4-guide-step-check" aria-hidden="true">
              □
            </span>
          </li>
          <li className="m4-guide-step guide-step">
            <span className="m4-guide-step-number" aria-hidden="true">
              02
            </span>
            <div>
              <p className="m4-guide-step-kicker">Assembly</p>
              <h2>Join the numbered sheets</h2>
              <p>
                Match each surface letter and row-column label. Preserve the
                registration marks at every join.
              </p>
            </div>
            <span className="m4-guide-step-check" aria-hidden="true">
              □
            </span>
          </li>
          <li className="m4-guide-step guide-step">
            <span className="m4-guide-step-number" aria-hidden="true">
              03
            </span>
            <div>
              <p className="m4-guide-step-kicker">Mounting order</p>
              <h2>Mount from the corner seam</h2>
              <p>
                Mount surface A first with its U=0 edge flush against the
                inside corner seam (datum O). Mount surface B second with its
                U={formatMm(corner.panelB.widthMm, unit)} edge at the seam.
                {corner.includeBase
                  ? ' Then align floor C to the marked datum vertex at O.'
                  : ''}
              </p>
            </div>
            <span className="m4-guide-step-check" aria-hidden="true">
              □
            </span>
          </li>
          <li className="m4-guide-step guide-step">
            <span className="m4-guide-step-number" aria-hidden="true">
              04
            </span>
            <div>
              <p className="m4-guide-step-kicker">Final verification</p>
              <h2>Meet the eye level</h2>
              <p>
                Stand at the marked floor point with the lens at{' '}
                {formatMm(eyeY, unit)} and compare the reconstruction. If the
                seams do not align, re-check scale and mounting order before
                adjusting the artwork.
              </p>
            </div>
            <span className="m4-guide-step-check" aria-hidden="true">
              □
            </span>
          </li>
        </ol>
        <footer className="m4-guide-folio">
          <span>Parallax Print · Field guide</span>
          <span>{project.title}</span>
          <span>1 / 1</span>
        </footer>
      </article>
    </main>
  );
}
