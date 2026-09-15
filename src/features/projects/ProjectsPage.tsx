import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { navigate } from '../../app/navigation';
import { compileProject } from '../../core/geometry/compileProject';
import { BrandLockup, ParallaxMark } from '../../components/Brand';
import { OpenProjectFileButton } from '../../components/OpenProjectFileButton';
import { ViewModeSwitch } from '../../components/ViewModeSwitch';
import { SpatialViewport } from '../../viewport/SpatialViewport';
import { FlatPieces } from '../../viewport/FlatPieces';
import {
  RenderJobController,
  usePreviewQueue,
} from '../../state/jobController';
import {
  createSampleCopy,
  createStarterProject,
  SAMPLE_ARTWORKS,
  type SampleArtwork,
} from '../../assets/sampleProject';
import { DEFAULT_SAMPLE_LAYOUT, type SampleLayout } from '../../assets/sampleLayouts';
import { SampleLayoutPicker } from './SampleLayoutPicker';
import { openSampleProject } from './importArchive';
import { loadBundledSampleAsset } from '../../assets/importArtwork';
import {
  listProjects,
  PendingRetentionError,
  putPendingDocument,
  saveProject,
} from '../../persistence/projectRepository';
import type {
  EditorDocument,
  SavedProject,
  StoredAsset,
  ViewMode,
} from '../../persistence/types';

function scrollToSection(id: string) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const target = document.getElementById(id);
    if (!target) return;
    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({
      behavior: reduced ? 'auto' : 'smooth',
      block: 'start',
    });
  };
}

function SampleHero({ artwork, layout, mode, onModeChange }: {
  readonly artwork: SampleArtwork;
  readonly layout: SampleLayout;
  readonly mode: Exclude<ViewMode, 'photo'>;
  readonly onModeChange: (mode: Exclude<ViewMode, 'photo'>) => void;
}) {
  const [asset, setAsset] = useState<StoredAsset | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [controller] = useState(() => new RenderJobController());

  useEffect(() => {
    if (controller.isDisposed()) controller.recreate();
    return () => controller.dispose();
  }, [controller]);

  // Keyed by both artwork and layout: stale geometry/rasters cannot remain
  // under a new selection while its asset is loading.
  useEffect(() => {
    let live = true;
    loadBundledSampleAsset(artwork)
      .then((a) => {
        if (live) {
          setAsset(a);
          setFailed(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (live) {
          setAsset(null);
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [artwork, retryToken]);

  const project = useMemo(
    () => (asset ? createSampleCopy(asset, layout) : null),
    [asset, layout],
  );
  const scene = useMemo(() => {
    if (!asset || !project) return null;
    try {
      return compileProject(project, asset).scene;
    } catch {
      return null;
    }
  }, [asset, project]);
  const preview = usePreviewQueue(controller, scene, asset, 0);

  if (loading) {
    return (
      <div className="hero-3d">
        <div className="hero-viewport hero-viewport--loading" role="status" aria-live="polite">
          <div className="hero-poster" aria-hidden="true">
            <ParallaxMark />
          </div>
          <p className="panel-note">Loading sample artwork…</p>
        </div>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="hero-3d">
        <div className="hero-viewport hero-viewport--error" role="alert">
          <div className="hero-poster" aria-hidden="true">
            <ParallaxMark />
          </div>
          <p className="panel-note">
            This sample could not be loaded.
          </p>
          <button
            type="button"
            className="button-quiet"
            onClick={() => {
              setAsset(null);
              setFailed(false);
              setLoading(true);
              setRetryToken((t) => t + 1);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="hero-3d" data-sample-layout={layout.id}>
      <div className="hero-stage">
        {mode === 'pieces' ? (
          <FlatPieces
            scene={scene}
            previews={preview.surfaces}
            unit={project?.displayUnit ?? 'mm'}
          />
        ) : (
          <div className="hero-viewport">
            <SpatialViewport
              scene={scene}
              previews={preview.surfaces}
              mode={mode}
              introReveal={mode === 'resolved'}
              onUserOrbitIntent={() => onModeChange('orbit')}
            />
          </div>
        )}
        {mode !== 'resolved' ? (
          <button
            type="button"
            className="button-quiet hero-return"
            onClick={() => onModeChange('resolved')}
          >
            Meet the eye level
          </button>
        ) : null}
      </div>
      <ViewModeSwitch value={mode} onChange={onModeChange} />
      <p className="panel-note" role="status">
        {preview.status === 'ready'
          ? 'Preview up to date'
          : preview.status === 'error'
            ? 'Preview failed'
            : 'Preview pending'}
        {preview.status === 'error' ? (
          <>
            {' '}
            <button
              type="button"
              className="button-quiet"
              onClick={preview.retry}
            >
              Retry preview
            </button>
          </>
        ) : null}
      </p>
    </div>
  );
}

function geometrySummary(project: SavedProject['project']): string {
  const c = project.corner;
  const base = c.includeBase ? ' + base' : '';
  return `${c.panelA.widthMm}×${c.panelA.heightMm} / ${c.panelB.widthMm}×${c.panelB.heightMm} mm @ ${c.angleDeg}°${base}`;
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<SavedProject[] | null>(null);
  const [corruptIds, setCorruptIds] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleIndex, setSampleIndex] = useState(0);
  const sample = SAMPLE_ARTWORKS[sampleIndex] ?? SAMPLE_ARTWORKS[0]!;
  const [layout, setLayout] = useState(DEFAULT_SAMPLE_LAYOUT);
  const [sampleMode, setSampleMode] = useState<Exclude<ViewMode, 'photo'>>('resolved');

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list.projects);
        setCorruptIds([...list.corruptIds]);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setListError(
          e instanceof Error
            ? e.message
            : 'Saved projects could not be read from this device.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openFresh = async (document: EditorDocument, action: string) => {
    setBusy(action);
    setError(null);
    try {
      await saveProject(document, 0);
    } catch (cause) {
      const admission = putPendingDocument(document);
      if (admission.status === 'blocked') {
        setError(new PendingRetentionError(admission, { cause }).message);
        setBusy(null);
        return;
      }
    }
    navigate({ name: 'editor', id: document.project.id });
  };

  const startMeasured = () => {
    void openFresh(
      { project: createStarterProject(), asset: null },
      'start',
    );
  };

  const trySample = () => {
    void (async () => {
      setBusy('sample');
      setError(null);
      try {
        await openSampleProject(sample, layout);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : 'Could not load the sample.',
        );
        setBusy(null);
      }
    })();
  };

  return (
    <main className="page-projects">
      <section className="public-hero">
        <header className="public-header">
          <BrandLockup compact />
          <nav className="public-header__nav" aria-label="Page sections">
            <a href="#projects" onClick={scrollToSection('projects')}>
              Your projects
            </a>
          </nav>
          <span className="local-cue">Local to this browser</span>
          <OpenProjectFileButton
            className="button-quiet open-file-btn"
            onError={setError}
          />
        </header>

        <div className="hero-grid">
          <div className="hero-copy">
            <p className="hero-kicker">Anamorphic printmaking in your browser</p>
            <h1>
              A point of view, <em>made physical.</em>
            </h1>
            <p className="hero-lede">
              Turn an image into printable pieces that come together across a
              real corner, from one chosen viewpoint.
            </p>
            <div className="hero-actions">
              <button
                type="button"
                className="button-primary"
                onClick={startMeasured}
                disabled={busy !== null}
              >
                {busy === 'start' ? 'Creating…' : 'Create a corner'}
              </button>
              <button
                type="button"
                className="button-quiet"
                onClick={trySample}
                disabled={busy !== null}
              >
                {busy === 'sample' ? 'Preparing sample…' : 'Try a sample'}
              </button>
            </div>
            {error ? (
              <p role="alert" className="field-error" style={{ color: 'rgba(255,255,255,0.9)' }}>
                {error}
              </p>
            ) : null}
            <p className="hero-privacy">Your artwork stays on this device.</p>
          </div>

          <div className="hero-exhibit">
            <div
              className="sample-gallery"
              role="group"
              aria-label="Sample artwork"
            >
              <div className="sample-gallery__buttons">
                {SAMPLE_ARTWORKS.map((a, i) => (
                  <button
                    key={a.path}
                    type="button"
                    className="sample-choice"
                    aria-pressed={i === sampleIndex}
                    aria-label={`Select ${a.label}`}
                    title={a.description}
                    disabled={busy !== null}
                    onClick={() => setSampleIndex(i)}
                  >
                    <img src={a.thumbPath} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
              <p className="sample-gallery__credit">{sample.credit}</p>
            </div>
            <SampleHero
              key={`${sample.path}:${layout.id}`}
              artwork={sample}
              layout={layout}
              mode={sampleMode}
              onModeChange={setSampleMode}
            />
            <div className="hero-toolstrip">
              <span className="hero-caption">Drag to leave the design eye</span>
            </div>
            <SampleLayoutPicker
              value={layout}
              disabled={busy !== null}
              onChange={(next) => {
                if (next.id === layout.id) return;
                setLayout(next);
                setSampleMode('orbit');
              }}
            />
          </div>
        </div>
      </section>

      <section
        className="public-section project-section"
        id="projects"
        aria-label="Your projects"
      >
        <div className="ledger-head">
          <h2>Your projects</h2>
          <p>Saved locally in this browser</p>
        </div>
        {listError ? (
          <div className="ledger-recovery" role="alert">
            <strong>Saved projects could not be read from this device.</strong>
            <p>
              The local ledger is unavailable. Existing project files have not
              been changed.
            </p>
            <div>
              <button
                type="button"
                className="button-primary"
                onClick={() => {
                  setListError(null);
                  setProjects(null);
                  listProjects()
                    .then((list) => {
                      setProjects(list.projects);
                      setCorruptIds([...list.corruptIds]);
                    })
                    .catch((e: unknown) => {
                      setListError(
                        e instanceof Error
                          ? e.message
                          : 'Saved projects could not be read from this device.',
                      );
                    });
                }}
              >
                Retry
              </button>
              <OpenProjectFileButton
                className="button-quiet"
                onError={setError}
              />
            </div>
          </div>
        ) : null}
        {corruptIds.length > 0 ? (
          <div className="ledger-recovery" role="alert">
            <strong>
              {corruptIds.length} stored project
              {corruptIds.length === 1 ? '' : 's'} could not be read and may be
              corrupted. Other projects are unaffected.
            </strong>
            <div>
              <OpenProjectFileButton
                className="button-quiet"
                onError={setError}
              />
            </div>
          </div>
        ) : null}
        {projects === null && !listError ? (
          <div className="ledger-loading" role="status">
            <span>Loading projects on this device…</span>
          </div>
        ) : projects !== null && projects.length === 0 && !listError ? (
          <div className="ledger-empty">
            <ParallaxMark />
            <h3>Your first corner starts here.</h3>
            <p>
              Create a project or open a project file saved on another device.
            </p>
            <div>
              <button
                type="button"
                className="button-primary"
                onClick={startMeasured}
                disabled={busy !== null}
              >
                {busy === 'start' ? 'Creating…' : 'Create a corner'}
              </button>
              <OpenProjectFileButton
                className="button-quiet"
                onError={setError}
              />
            </div>
          </div>
        ) : projects !== null && projects.length > 0 ? (
          <ul className="project-ledger">
            {projects.map((entry) => (
              <li key={entry.project.id}>
                <button
                  type="button"
                  className="project-row"
                  onClick={() =>
                    navigate({ name: 'editor', id: entry.project.id })
                  }
                >
                  <span className="project-thumb project-thumb--corner">
                    <ParallaxMark />
                  </span>
                  <span>
                    <strong className="project-name">
                      {entry.project.title}
                    </strong>
                    <span className="project-meta">
                      {geometrySummary(entry.project)} · saved{' '}
                      {new Date(entry.project.updatedAt).toLocaleString()}
                    </span>
                    {entry.project.artwork === null ? (
                      <span className="project-state">No artwork yet</span>
                    ) : null}
                  </span>
                  <span className="project-arrow">→</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <footer className="public-footer">
        <div className="footer-content">
          <h2>Make the image belong to the space.</h2>
          <div className="footer-meta">
            <strong>Make</strong>
            <div className="footer-links">
              <button
                type="button"
                className="footer-link-button"
                onClick={startMeasured}
                disabled={busy !== null}
              >
                {busy === 'start' ? 'Creating…' : 'Create a corner'}
              </button>
              <button
                type="button"
                className="footer-link-button"
                onClick={trySample}
                disabled={busy !== null}
              >
                {busy === 'sample' ? 'Preparing sample…' : 'Try a sample'}
              </button>
              <a href="#projects" onClick={scrollToSection('projects')}>
                Your projects
              </a>
            </div>
          </div>
          <div className="footer-meta">
            <strong>Made on your device</strong>
            <p>
              Artwork and project files remain local. PNG and JPEG input; PDF,
              SVG, and project archive output. Physical calibration remains
              yours to verify.
            </p>
            <div className="footer-links">
              <OpenProjectFileButton
                className="footer-link-button open-file-btn"
                onError={setError}
              >
                Open project file
              </OpenProjectFileButton>
            </div>
          </div>
          {error ? (
            <p role="alert" className="footer-error">
              {error}
            </p>
          ) : null}
          <p className="footer-credit">
            Sample artworks: Hokusai, Van Gogh, and Seurat works are public
            domain. Route and Sun are Parallax Print generated samples, CC0. ·
            Digital alpha
          </p>
        </div>
      </footer>
    </main>
  );
}
