import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import {
  consumeInitialEditorStep,
  navigate,
  type Route,
} from '../../app/navigation';
import { compileProject } from '../../core/geometry/compileProject';
import { planTiles } from '../../core/print/tiling';
import type { CompiledScene, Issue } from '../../core/types';
import { cloneProjectAsNew } from '../../assets/sampleProject';
import {
  acquireProjectLock,
  ConflictError,
  loadProject,
  getPendingDocument,
  ProjectSaveQueue,
  putPendingDocument,
  saveProject,
} from '../../persistence/projectRepository';
import { downloadProjectCopy } from '../../persistence/download';
import { loadCalibration } from '../../persistence/calibrations';
import type {
  EditorDocument,
  EditorStep,
  ViewMode,
} from '../../persistence/types';
import { useExportController } from '../../state/exportController';
import {
  RenderJobController,
  usePreviewQueue,
  type PreviewStatus,
} from '../../state/jobController';
import { useProjectStore } from '../../state/projectStore';
import { Icon } from '../../components/Icon';
import { MissingProjectRecovery } from '../../components/MissingProjectRecovery';
import { OpenProjectFileButton } from '../../components/OpenProjectFileButton';
import { RecoveryState } from '../../components/RecoveryState';
import { ViewModeSwitch } from '../../components/ViewModeSwitch';
import { PreviewStatusLine } from '../../components/ProgressPanel';
import { SpatialViewport } from '../../viewport/SpatialViewport';
import type { ArtworkEditContract } from '../../viewport/ArtworkEditOverlay';
import type {
  CornerEditContract,
  ViewpointEditContract,
} from '../../viewport/sceneHandles';
import { FlatPieces } from '../../viewport/FlatPieces';
import { EditorHeader } from './EditorHeader';
import { StepNavigation } from './StepNavigation';
import {
  STEP_LABELS,
  STEP_ORDER,
  type StepStatusInput,
} from './stepStatus';
import { SurfacesPanel } from '../surfaces/SurfacesPanel';
import { ViewpointPanel } from '../viewpoint/ViewpointPanel';
import { ArtworkPanel } from '../artwork/ArtworkPanel';
import { importAndAttach } from '../artwork/artworkImport';
import { ProofPanel } from '../proof/ProofPanel';
import { PrintPanel } from '../print/PrintPanel';
import { PhotoPreview } from '../photo/PhotoPreview';
import '../../styles/editor-workspace.css';
import '../../styles/photo-workflow.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

const VIEW_HINTS: Record<EditorViewMode, string> = {
  resolved: 'As seen from the design eye.',
  orbit: 'Orbit the installation — the image breaks.',
  pieces: 'Printable piece shapes in surface coordinates.',
  photo: 'Review the captured room with the computed print pieces.',
};

const STEP_FLOW = STEP_ORDER.map((id) => ({
  id,
  label: STEP_LABELS[id],
}));

const MODE_LABEL: Record<EditorViewMode, string> = {
  resolved: 'Resolved',
  orbit: 'Orbit',
  pieces: 'Pieces',
  photo: 'Photo',
};

const PREVIEW_LABEL: Record<PreviewStatus, string> = {
  idle: 'No preview',
  updating: 'Updating preview',
  ready: 'Preview up to date',
  error: 'Preview failed',
};

type EditorViewMode = ViewMode | 'photo';

export function EditorPage({ projectId }: { projectId: string }) {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [lockState, setLockState] = useState<
    'held' | 'unavailable' | 'unsupported'
  >('held');
  const reset = useProjectStore((s) => s.reset);
  const loadDocument = useProjectStore((s) => s.loadDocument);
  const setCalibration = useProjectStore((s) => s.setCalibration);

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    const lockPromise = acquireProjectLock(projectId);
    void (async () => {
      const lock = await lockPromise;
      const loaded = await loadProject(projectId);
      if (cancelled) {
        if (lock.status === 'held') lock.release();
        return;
      }
      if (!loaded) {
        if (lock.status === 'held') lock.release();
        setLoad({ status: 'missing' });
        return;
      }
      const missingAsset =
        !!loaded.document.project.artwork && !loaded.document.asset;
      loadDocument(loaded.document, loaded.revision, {
        missingAsset,
        readOnly: lock.status === 'unavailable',
      });
      const initialStep = consumeInitialEditorStep(projectId);
      if (initialStep) useProjectStore.getState().setStep(initialStep);
      if (getPendingDocument(projectId)?.document === loaded.document) {
        useProjectStore.getState().setSaveStatus('unsaved');
      }
      void loadCalibration(projectId)
        .then((record) => {
          if (!cancelled && record) setCalibration(record);
        })
        .catch(() => undefined);
      if (lock.status === 'held') release = lock.release;
      setLockState(lock.status);
      setLoad({ status: 'ready' });
    })().catch((e: unknown) => {
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
      void lockPromise.then((lock) => {
        if (lock.status === 'held') lock.release();
      });
      release?.();
      reset();
    };
  }, [projectId, loadDocument, reset, setCalibration]);

  if (load.status === 'loading') {
    return (
      <main className="page-loading">
        <p>Opening project…</p>
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
          <>
            <button
              type="button"
              className="button-primary"
              onClick={() => navigate({ name: 'projects' })}
            >
              Back to projects
            </button>
            <OpenProjectFileButton
              className="button-quiet"
              onError={() => undefined}
            />
          </>
        }
        colophon="Parallax Print · Digital alpha · Local to this browser"
      >
        <p role="alert">{load.message}</p>
      </RecoveryState>
    );
  }
  return <EditorShell lockState={lockState} />;
}

function EditorShell({
  lockState,
}: {
  readonly lockState: 'held' | 'unavailable' | 'unsupported';
}) {
  const document = useProjectStore((s) => s.document);
  const editorRevision = useProjectStore((s) => s.editorRevision);
  const readOnly = useProjectStore((s) => s.readOnly);
  const missingAsset = useProjectStore((s) => s.missingAsset);
  const step = useProjectStore((s) => s.step);
  const viewMode = useProjectStore((s) => s.viewMode) as EditorViewMode;
  const setStep = useProjectStore((s) => s.setStep);
  const setViewMode = useProjectStore((s) => s.setViewMode) as (
    mode: EditorViewMode,
  ) => void;
  const commit = useProjectStore((s) => s.commit);
  const saveStatus = useProjectStore((s) => s.saveStatus);
  const draftErrors = useProjectStore((s) => s.draftErrors);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const calibration = useProjectStore((s) => s.calibration);

  const [controller] = useState(() => new RenderJobController());
  const exportCtl = useExportController(controller);
  const [actionError, setActionError] = useState<string | null>(null);
  const queueRef = useRef<ProjectSaveQueue | null>(null);
  // The dock is one stable DOM slot.  ExportSection can portal its
  // authoritative production action into it without the shell taking a
  // second readiness decision.  Keep the callback ref stable so mounting
  // and step changes do not create duplicate portal destinations.
  const commandDockTargetRef = useRef<HTMLDivElement | null>(null);
  const [commandDockTarget, setCommandDockTarget] =
    useState<HTMLElement | null>(null);
  const setCommandDockRef = useCallback((node: HTMLDivElement | null) => {
    commandDockTargetRef.current = node;
    setCommandDockTarget(node);
  }, []);
  const [previewHidden, setPreviewHidden] = useState(false);
  // The collapse control only exists below 768px; gating on the media query
  // keeps the `hidden` attribute honest — it is only ever present when the
  // preview is genuinely hidden, and a resize to desktop always restores it.
  const [collapseCapable, setCollapseCapable] = useState(
    () =>
      typeof matchMedia === 'function' &&
      matchMedia('(max-width: 767px)').matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia('(max-width: 767px)');
    const onChange = () => setCollapseCapable(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const previewCollapsed = collapseCapable && previewHidden;
  // Session-only drafting overlay: the grid + surface labels stay hidden
  // unless explicitly requested (AMENDMENTS.md §A). Never persisted.
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  // Session-only placement lock shared by the inspector and the stage
  // overlay (§12.6) — never persisted to the document or archives.
  const [placementLocked, setPlacementLocked] = useState(false);
  // Stage drop zone: counts nested dragenter/dragleave pairs so the veil
  // tracks whether the pointer is genuinely over the preview column.
  const [stageDragActive, setStageDragActive] = useState(false);
  const stageDragDepth = useRef(0);
  const stageFileRef = useRef<HTMLInputElement>(null);
  // Session-only preview-mode memory (§10.2): first entry to Artwork selects
  // Resolved and first entry to Print selects Pieces — until the user picks a
  // mode explicitly, which disables auto-selection for the session. Never
  // persisted to the document or archives.
  const modeMemory = useRef<{
    autoSelected: Set<EditorStep>;
    userPicked: boolean;
  }>({ autoSelected: new Set(), userPicked: false });

  const project = document?.project ?? null;
  const asset = document?.asset ?? null;
  const photo = document?.photo ?? null;

  const compiled = useMemo(() => {
    if (!project) return { scene: null, issues: [] as Issue[] };
    try {
      return compileProject(project, asset);
    } catch {
      return {
        scene: null,
        issues: [
          {
            code: 'nonfinite-value',
            severity: 'blocker',
            message: 'The project could not be compiled.',
            remedy: 'Review the surfaces and viewpoint values.',
          } satisfies Issue,
        ],
      };
    }
  }, [project, asset]);
  const scene: CompiledScene | null = compiled.scene;
  // `issues` is pure compile output so the panels that run preflight (Check,
  // Print) can pass it as `compileIssues`.
  const issues = compiled.issues;

  const layout = useMemo(() => {
    if (!scene || !project) return null;
    try {
      return planTiles(scene, project.print);
    } catch {
      return null;
    }
  }, [scene, project]);

  const preview = usePreviewQueue(controller, scene, asset, editorRevision);
  const photoModeAvailable =
    !!photo &&
    (photo.registration.status !== 'draft' || viewMode === 'photo');

  useEffect(() => {
    if (viewMode === 'photo' && !photo) setViewMode('resolved');
  }, [photo, setViewMode, viewMode]);

  // §12.1: the direct-manipulation overlay is available on every step — the
  // artwork frame belongs to the resolved view, not to the inspector — given
  // a valid spec, a normalized asset, and an editable project. It still only
  // mounts while the stage shows the resolved view (SpatialViewport). One
  // completed gesture commits once through the store — one undo step, one
  // editor revision (§12.6).
  const artworkEditing = useMemo<ArtworkEditContract | undefined>(() => {
    if (!project?.artwork || !asset || readOnly) {
      return undefined;
    }
    const artwork = project.artwork;
    return {
      enabled: !placementLocked,
      artwork,
      sourceAspect: asset.widthPx / asset.heightPx,
      assetBlob: asset.normalizedPng,
      previewStatus: preview.status,
      onCommit: (next) =>
        commit((doc) =>
          doc.project.artwork
            ? {
                ...doc,
                project: {
                  ...doc.project,
                  artwork: { ...doc.project.artwork, ...next },
                },
              }
            : doc,
        ),
    };
  }, [
    project,
    asset,
    readOnly,
    placementLocked,
    preview.status,
    commit,
  ]);

  // §12-style direct manipulation for the physical setup: on the Corner step
  // the stage shows five handles (A/B width and height, interior angle) in
  // both camera modes; on the Viewpoint step the eye/aim rig is draggable in
  // Orbit — in Resolved the camera IS the eye. Each completed drag commits
  // once through the store: one undo step, one editor revision. The
  // inspector's numeric fields remain the complete, accessible keyboard
  // path — the 3D handles are a supplementary pointer affordance.
  const cornerEditing = useMemo<CornerEditContract | undefined>(() => {
    if (!project || readOnly || step !== 'surfaces') return undefined;
    const corner = project.corner;
    return {
      corner,
      onCommit: (patch) =>
        commit((doc) => {
          let next = doc.project.corner;
          if (patch.angleDeg !== undefined) {
            // A direct angle edit clears the tape-triangle record, matching
            // the numeric field's behaviour.
            const { angleMeasurement: _drop, ...rest } = next;
            next = { ...rest, ...patch };
          } else {
            next = { ...next, ...patch };
          }
          return { ...doc, project: { ...doc.project, corner: next } };
        }),
    };
  }, [project, readOnly, step, commit]);

  const viewpointEditing = useMemo<ViewpointEditContract | undefined>(() => {
    if (!project || readOnly || step !== 'viewpoint') return undefined;
    const { eyeMm, aimHeightMm } = project.viewpoint;
    return {
      eyeMm,
      aimHeightMm,
      onCommit: (patch) =>
        commit((doc) => ({
          ...doc,
          project: {
            ...doc.project,
            viewpoint: { ...doc.project.viewpoint, ...patch },
          },
        })),
    };
  }, [project, readOnly, step, commit]);

  useEffect(() => {
    if (controller.isDisposed()) controller.recreate();
    return () => controller.dispose();
  }, [controller]);

  const projectId = document?.project.id ?? null;

  useEffect(() => {
    if (!projectId || readOnly) return;
    const id = projectId;
    const queue = new ProjectSaveQueue(
      {
        onSaving: () => {
          const s = useProjectStore.getState();
          if (s.document?.project.id !== id) return;
          if (s.saveStatus !== 'conflict' && s.saveStatus !== 'error') {
            s.setSaveStatus('saving');
          }
        },
        onSaved: (revision, editedRevision) => {
          const s = useProjectStore.getState();
          if (s.document?.project.id !== id) return;
          s.setPersistedRevision(revision);
          queue.setPersistedRevision(revision);
          if (s.editorRevision === editedRevision) {
            s.setSaveStatus('saved');
          }
        },
        onError: (error) => {
          const s = useProjectStore.getState();
          if (s.document?.project.id !== id) return;
          s.setSaveStatus(
            error instanceof ConflictError ? 'conflict' : 'error',
          );
        },
      },
      400,
      useProjectStore.getState().persistedRevision,
    );
    queueRef.current = queue;
    return () => {
      queueRef.current = null;
      void queue
        .flush()
        .catch(() => undefined)
        .finally(() => queue.dispose());
    };
  }, [projectId, readOnly]);

  useEffect(() => {
    if (!document || readOnly) return;
    queueRef.current?.enqueue(document, editorRevision);
  }, [document, editorRevision, readOnly]);

  useEffect(() => {
    if (modeMemory.current.userPicked) return;
    if (step !== 'artwork' && step !== 'print') return;
    if (modeMemory.current.autoSelected.has(step)) return;
    modeMemory.current.autoSelected.add(step);
    const want: ViewMode = step === 'artwork' ? 'resolved' : 'pieces';
    if (viewMode !== want) setViewMode(want);
  }, [step, viewMode, setViewMode]);

  const onUserViewMode = (mode: EditorViewMode) => {
    modeMemory.current.userPicked = true;
    setViewMode(mode);
  };

  useEffect(() => {
    if (saveStatus === 'saved') return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [saveStatus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  if (!document || !project) return null;

  const draftErrorCount = Object.keys(draftErrors).length;
  const statusInput: StepStatusInput = {
    currentStep: step,
    issues,
    hasArtwork: !!asset,
    invalidDraftFieldIds: Object.keys(draftErrors),
    layoutReady: layout !== null,
  };
  const stepIndex = STEP_FLOW.findIndex((s) => s.id === step);
  const previousStep = stepIndex > 0 ? STEP_FLOW[stepIndex - 1] : undefined;

  const openArtworkChooser = () => {
    setStep('artwork');
    const chooser = globalThis.document?.getElementById('choose-artwork');
    if (chooser instanceof HTMLButtonElement) chooser.click();
  };

  const photoMode = viewMode === 'photo' && photo !== null;
  const spatialMode = viewMode === 'orbit' ? 'orbit' : 'resolved';
  const reviewPhoto = () => {
    setStep('surfaces');
    requestAnimationFrame(() => {
      const workflow = globalThis.document?.getElementById('photo-workflow');
      workflow?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      workflow
        ?.querySelector<HTMLButtonElement>('.photo-open-workspace')
        ?.click();
    });
  };

  // The editor owns task navigation copy only.  Print's slot is intentionally
  // empty here: ExportSection portals its authoritative action and context
  // into the same dock when that step is active.
  const command =
    step === 'surfaces'
      ? {
          context: 'Corner dimensions',
          reason: 'Enter the measurements of the real corner.',
          primaryLabel: 'Set viewpoint',
          primaryDisabled: false,
          onPrimary: () => setStep('viewpoint'),
        }
      : step === 'viewpoint'
        ? {
            context: 'Viewpoint',
            reason: 'Place the lens position where the image should resolve.',
            primaryLabel: 'Place artwork',
            primaryDisabled: false,
            onPrimary: () => setStep('artwork'),
          }
        : step === 'artwork'
          ? project.artwork
            ? {
                context: 'Artwork placement',
                reason: 'Place and size the image from the design eye.',
                primaryLabel: 'Check project',
                primaryDisabled: false,
                onPrimary: () => setStep('proof'),
              }
            : {
                context: readOnly ? 'Artwork · read-only' : 'Artwork',
                reason: readOnly
                  ? 'Read-only — open a copy to choose an image.'
                  : 'Choose an image before checking the projection.',
                primaryLabel: 'Choose image',
                primaryDisabled: readOnly,
                onPrimary: openArtworkChooser,
              }
          : {
              context: 'Project checks',
              reason:
                issues.some((issue) => issue.severity === 'blocker')
                  ? 'Print setup remains available; blockers still disable production output.'
                  : 'The digital checks are ready to review.',
              primaryLabel: 'Set up print',
              primaryDisabled: false,
              onPrimary: () => setStep('print'),
            };

  const retrySave = () => {
    useProjectStore.getState().setSaveStatus('unsaved');
    queueRef.current?.enqueue(document, editorRevision);
  };

  // Stage artwork import — shares the Artwork panel's attach logic so a
  // drop or browse lands identically to choosing the file on the Artwork
  // step. Failures surface through the shell's action banner.
  const importArtworkToStage = async (file: File) => {
    setActionError(null);
    try {
      await importAndAttach(file, file.name, project.id);
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : 'Could not import that image.',
      );
    }
  };

  const hasDraggedFiles = (e: DragEvent<HTMLElement>) =>
    [...e.dataTransfer.types].includes('Files');

  const onStageDragEnter = (e: DragEvent<HTMLElement>) => {
    if (readOnly || !hasDraggedFiles(e)) return;
    e.preventDefault();
    stageDragDepth.current += 1;
    setStageDragActive(true);
  };

  const onStageDragOver = (e: DragEvent<HTMLElement>) => {
    if (readOnly || !hasDraggedFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onStageDragLeave = () => {
    if (readOnly) return;
    stageDragDepth.current = Math.max(0, stageDragDepth.current - 1);
    if (stageDragDepth.current === 0) setStageDragActive(false);
  };

  const onStageDrop = (e: DragEvent<HTMLElement>) => {
    if (readOnly) return;
    e.preventDefault();
    stageDragDepth.current = 0;
    setStageDragActive(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
      setActionError('Only PNG or JPEG images can be placed as artwork.');
      return;
    }
    void importArtworkToStage(file);
  };

  const downloadCopy = async () => {
    setActionError(null);
    try {
      const kind = await downloadProjectCopy(document);
      if (kind === 'geometry-only') {
        setActionError(
          'The artwork file is missing, so the copy contains geometry only — re-import the artwork after opening it.',
        );
      }
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : 'Could not prepare the project file.',
      );
    }
  };

  const openCopy = async () => {
    setActionError(null);
    const copy: EditorDocument = {
      project: cloneProjectAsNew(document.project),
      asset: document.asset,
      ...(document.photo === undefined ? {} : { photo: document.photo }),
    };
    try {
      await saveProject(copy, 0);
    } catch {
      const admission = putPendingDocument(copy);
      if (admission.status === 'blocked') {
        setActionError(
          'The copy could not be retained for recovery. Retry the save or download a project copy before leaving.',
        );
        return;
      }
    }
    navigate({ name: 'editor', id: copy.project.id });
  };

  const flushAndNavigate = (route: Route) => {
    const queue = queueRef.current;
    if (!queue) {
      navigate(route);
      return;
    }
    void queue
      .flush()
      .then(() => {
        const s = useProjectStore.getState();
        if (s.saveStatus === 'error' || s.saveStatus === 'conflict') {
          setActionError(
            'The latest changes could not be saved locally. Retry the save or download a copy before leaving.',
          );
          return;
        }
        navigate(route);
      })
      .catch(() => {
        setActionError(
          'The latest changes could not be saved locally. Retry the save or download a copy before leaving.',
        );
      });
  };

  const panel = (() => {
    switch (step) {
      case 'surfaces':
        return (
          <SurfacesPanel
            project={project}
            issues={issues}
            readOnly={readOnly}
            photo={photo}
          />
        );
      case 'viewpoint':
        return (
          <ViewpointPanel
            project={project}
            issues={issues}
            readOnly={readOnly}
          />
        );
      case 'artwork':
        return (
          <ArtworkPanel
            project={project}
            asset={asset}
            issues={issues}
            missingAsset={missingAsset}
            readOnly={readOnly}
            locked={placementLocked}
            onLockedChange={setPlacementLocked}
          />
        );
      case 'proof':
        return (
          <ProofPanel
            project={project}
            scene={scene}
            asset={asset}
            layout={layout}
            issues={issues}
            previewStatus={preview.status}
            calibration={calibration}
            exportJob={exportCtl.job}
            readyFile={exportCtl.readyFile}
            onStartExport={exportCtl.start}
            onCancelExport={exportCtl.cancel}
            onDownloadExport={exportCtl.downloadReady}
            onClearExport={exportCtl.clearReady}
          />
        );
      case 'print':
        return (
          <PrintPanel
            project={project}
            scene={scene}
            issues={issues}
            readOnly={readOnly}
            asset={asset}
            calibration={calibration}
            exportJob={exportCtl.job}
            readyFile={exportCtl.readyFile}
            onStartExport={exportCtl.start}
            onCancelExport={exportCtl.cancel}
            onDownloadExport={exportCtl.downloadReady}
            onClearExport={exportCtl.clearReady}
            commandDockTarget={commandDockTarget}
            photo={photo}
          />
        );
    }
  })();

  return (
    <main
      className="editor-shell"
      data-editor-revision={editorRevision}
      data-current-step={step}
      data-lock-state={lockState}
      data-preview-collapsed={previewCollapsed ? 'true' : 'false'}
    >
      <EditorHeader onNavigate={flushAndNavigate} />
      <div className="editor-notices" role="region" aria-label="Project notices">
        {lockState === 'unavailable' ? (
          <div className="readonly-banner readonly-banner--readonly" role="alert">
            <Icon name="lock" size={18} />
            <span className="readonly-banner-copy">
              <strong>This project is open in another tab or window.</strong>
              <span>This copy is read-only so it cannot overwrite your work.</span>
            </span>
            <button type="button" className="button-quiet" onClick={() => void openCopy()}>
              Open a copy
            </button>
          </div>
        ) : null}
        {lockState === 'unsupported' ? (
          <div className="readonly-banner readonly-banner--info" role="note">
            <Icon name="lock" size={18} />
            <span className="readonly-banner-copy">
              <strong>Multi-tab protection is unavailable in this browser.</strong>
              <span>Revision checks still prevent silent overwrites.</span>
            </span>
          </div>
        ) : null}
        {saveStatus === 'conflict' ? (
          <div className="readonly-banner readonly-banner--conflict" role="alert">
            <Icon name="warning" size={18} />
            <span className="readonly-banner-copy">
              <strong>The stored copy changed elsewhere.</strong>
              <span>Your edits are kept in memory.</span>
            </span>
            <div className="readonly-banner-actions">
              <button
                type="button"
                className="button-quiet"
                onClick={() => void downloadCopy()}
              >
                Download copy
              </button>
              <button
                type="button"
                className="button-quiet"
                onClick={() => void openCopy()}
              >
                Open a copy
              </button>
            </div>
          </div>
        ) : null}
        {saveStatus === 'error' ? (
          <div className="readonly-banner readonly-banner--error" role="alert">
            <Icon name="warning" size={18} />
            <span className="readonly-banner-copy">
              <strong>Saving to this device failed.</strong>
              <span>Your work is still in memory.</span>
            </span>
            <div className="readonly-banner-actions">
              <button type="button" className="button-quiet" onClick={retrySave}>
                Retry local save
              </button>
              <button
                type="button"
                className="button-quiet"
                onClick={() => void downloadCopy()}
              >
                Download copy
              </button>
            </div>
          </div>
        ) : null}
        {actionError ? (
          <div className="readonly-banner readonly-banner--error" role="alert">
            <Icon name="warning" size={18} />
            <span className="readonly-banner-copy">{actionError}</span>
          </div>
        ) : null}
      </div>
      <StepNavigation
        step={step}
        onChange={setStep}
        statusInput={statusInput}
      />
      <div className="editor-main">
        <section
          className="studio-stage"
          aria-label="Installation preview"
          onDragEnter={onStageDragEnter}
          onDragOver={onStageDragOver}
          onDragLeave={onStageDragLeave}
          onDrop={onStageDrop}
        >
          <div className="stage-chrome stage-chrome--top">
            <div className="stage-status-cluster">
              <span className="stage-mode-label">{MODE_LABEL[viewMode]}</span>
              <span className="stage-status-separator" aria-hidden="true">
                ·
              </span>
              <PreviewStatusLine
                status={preview.status}
                error={preview.error}
                onRetry={preview.retry}
              />
            </div>
            <div className="stage-top-actions">
              <button
                type="button"
                className="button-quiet stage-preview-toggle"
                aria-expanded={!previewCollapsed}
                aria-controls="stage-preview"
                onClick={() => setPreviewHidden((h) => !h)}
              >
                {previewCollapsed ? 'Show preview' : 'Hide preview'}
              </button>
              <button
                type="button"
                className="button-quiet stage-diagnostics-toggle"
                aria-pressed={showDiagnostics}
                onClick={() => setShowDiagnostics((d) => !d)}
              >
                Diagnostics
              </button>
            </div>
          </div>
          <div className="stage-preview" id="stage-preview" hidden={previewCollapsed}>
            {viewMode === 'pieces' ? (
              <FlatPieces
                scene={scene}
                previews={preview.surfaces}
                layout={layout}
                unit={project.displayUnit}
              />
            ) : null}
            {photoMode ? (
              <PhotoPreview
                photo={photo}
                corner={project.corner}
                scene={scene}
                previews={preview.surfaces}
                previewStatus={preview.status}
                onReviewPhoto={reviewPhoto}
              />
            ) : null}
            {viewMode !== 'pieces' || photoMode ? (
              <div
                className={`stage-spatial-layer${photoMode ? ' stage-spatial-layer--hidden' : ''}`}
                aria-hidden={photoMode}
              >
                <SpatialViewport
                  scene={scene}
                  previews={preview.surfaces}
                  mode={spatialMode}
                  artworkEditing={photoMode ? undefined : artworkEditing}
                  cornerEditing={photoMode ? undefined : cornerEditing}
                  viewpointEditing={photoMode ? undefined : viewpointEditing}
                  diagnostics={showDiagnostics}
                />
              </div>
            ) : null}
            {artworkEditing && viewMode !== 'resolved' && !photoMode ? (
              <p className="artwork-edit-hint" role="note">
                Return to Resolved to edit the artwork frame.
              </p>
            ) : null}
            {!project.artwork && viewMode === 'resolved' && !readOnly ? (
              <>
                <button
                  type="button"
                  className="stage-artwork-cta"
                  onClick={() => stageFileRef.current?.click()}
                >
                  <Icon name="upload" size={16} />
                  Drop an image here — or browse
                </button>
                <input
                  ref={stageFileRef}
                  type="file"
                  accept="image/png,image/jpeg"
                  className="visually-hidden"
                  aria-label="Browse for artwork image"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void importArtworkToStage(file);
                    e.target.value = '';
                  }}
                />
              </>
            ) : null}
            {!asset && scene ? (
              <p className="stage-empty" role="note">
                No artwork yet — the room shows bare walls. Choose an image
                in the Artwork step.
              </p>
            ) : null}
          </div>
          {previewCollapsed ? (
            <p className="stage-summary">
              <span className="stage-summary-mode">{MODE_LABEL[viewMode]}</span>
              <span className="stage-summary-status">{PREVIEW_LABEL[preview.status]}</span>
            </p>
          ) : null}
          <ViewModeSwitch
            value={viewMode}
            onChange={onUserViewMode}
            photoAvailable={photoModeAvailable}
          />
          <p className="stage-helper" role="note">
            {VIEW_HINTS[viewMode]}
          </p>
          <p className="surface-legend">
            {scene
              ? scene.surfaces.map((s) => `Surface ${s.surface.id}`).join(' · ')
              : 'No valid scene'}
          </p>
          {!readOnly && stageDragActive ? (
            <div className="stage-drop-veil" aria-hidden="true">
              <p>Drop artwork to place it</p>
            </div>
          ) : null}
        </section>
        <aside className="studio-inspector" aria-label="Inspector">
          <div className="inspector-scroll">
            {step === 'print' &&
            issues.some((issue) => issue.severity === 'blocker') ? (
              <p className="editor-blocker-reminder" role="status">
                Blockers need attention — see Check.
              </p>
            ) : null}
            {draftErrorCount > 0 ? (
              <p className="field-error editor-draft-notice" role="alert">
                {draftErrorCount} field{draftErrorCount === 1 ? '' : 's'} need
                correcting before the values apply.
              </p>
            ) : null}
            <div className="panel-transition" key={step}>
              {panel}
            </div>
          </div>
          <footer
            className={`editor-command-dock editor-command-dock--${step}`}
            aria-label="Step controls"
          >
            {step !== 'print' ? (
              <div className="editor-command-context">
                <strong>{command.context}</strong>
                    <span
                      className={`editor-command-reason${
                        command.primaryDisabled
                          ? ' editor-command-disabled-reason'
                          : ''
                      }`}
                    >
                      {command.reason}
                    </span>
              </div>
            ) : null}
            {previousStep ? (
              <button
                type="button"
                className="button-quiet editor-command-back"
                aria-label={`Back to ${previousStep.label}`}
                onClick={() => setStep(previousStep.id)}
              >
                <Icon name="chevron" size={16} className="icon-back" />
                Back
              </button>
            ) : null}
            <div className="editor-command-slot" ref={setCommandDockRef}>
              {step !== 'print' ? (
                <button
                  type="button"
                  className="button-primary editor-command-primary"
                  disabled={command.primaryDisabled}
                  onClick={command.onPrimary}
                >
                  {command.primaryLabel}
                  {step !== 'artwork' || project.artwork ? (
                    <Icon name="arrow-right" size={16} />
                  ) : null}
                </button>
              ) : null}
            </div>
          </footer>
        </aside>
      </div>
    </main>
  );
}
