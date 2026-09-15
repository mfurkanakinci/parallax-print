import { create } from 'zustand';
import type { CalibrationRecord, ProjectV1 } from '../core/types';
import { reconcilePhotoRegistration } from '../core/photo/registration';
import type {
  EditorDocument,
  EditorStep,
  SaveStatus,
  ViewMode,
} from '../persistence/types';
import { pushHistory } from './history';

/**
 * An unresolved in-progress edit in a text field, kept at editor level so it
 * survives the field's unmount/remount when the user switches inspector steps.
 * `error` is the validation message from the last failed commit attempt, or
 * null while the text has not been rejected. A draft is only valid while its
 * `displayValue` still matches the field's committed display value — a commit,
 * undo, or display-unit change underneath it makes it stale.
 */
export interface FieldDraft {
  readonly text: string;
  readonly displayValue: string;
  readonly error: string | null;
}

export interface ProjectStoreState {
  readonly document: EditorDocument | null;
  readonly editorRevision: number;
  readonly persistedRevision: number;
  readonly past: readonly EditorDocument[];
  readonly future: readonly EditorDocument[];
  readonly step: EditorStep;
  readonly viewMode: ViewMode;
  readonly saveStatus: SaveStatus;
  readonly draftErrors: Readonly<Record<string, string>>;
  readonly drafts: Readonly<Record<string, FieldDraft>>;
  readonly readOnly: boolean;
  readonly missingAsset: boolean;
  readonly acknowledgements: Readonly<Record<string, string>>;
  readonly calibration: CalibrationRecord | null;
  loadDocument(
    document: EditorDocument,
    persistedRevision: number,
    options?: { missingAsset?: boolean; readOnly?: boolean },
  ): void;
  commit(update: (doc: EditorDocument) => EditorDocument): void;
  undo(): void;
  redo(): void;
  setStep(step: EditorStep): void;
  setViewMode(mode: ViewMode): void;
  setSaveStatus(status: SaveStatus): void;
  setPersistedRevision(revision: number): void;
  setReadOnly(readOnly: boolean): void;
  setDraftError(id: string, message: string | null): void;
  setFieldDraft(id: string, draft: FieldDraft | null): void;
  acknowledge(ackId: string, fingerprint: string): void;
  setCalibration(record: CalibrationRecord | null): void;
  reset(): void;
}

const initialState = {
  document: null,
  editorRevision: 0,
  persistedRevision: 0,
  past: [] as readonly EditorDocument[],
  future: [] as readonly EditorDocument[],
  step: 'surfaces' as EditorStep,
  viewMode: 'resolved' as ViewMode,
  saveStatus: 'unsaved' as SaveStatus,
  draftErrors: {} as Readonly<Record<string, string>>,
  drafts: {} as Readonly<Record<string, FieldDraft>>,
  readOnly: false,
  missingAsset: false,
  acknowledgements: {} as Readonly<Record<string, string>>,
  calibration: null as CalibrationRecord | null,
};

export const useProjectStore = create<ProjectStoreState>()((set, get) => ({
  ...initialState,

  loadDocument(document, persistedRevision, options) {
    set({
      document: document.photo
        ? {
            ...document,
            photo: {
              ...document.photo,
              registration: reconcilePhotoRegistration(
                document.photo.registration,
                document.project.corner,
              ),
            },
          }
        : document,
      persistedRevision,
      editorRevision: 0,
      past: [],
      future: [],
      draftErrors: {},
      drafts: {},
      saveStatus: persistedRevision > 0 ? 'saved' : 'unsaved',
      step: 'surfaces',
      viewMode: 'resolved',
      missingAsset: options?.missingAsset ?? false,
      readOnly: options?.readOnly ?? false,
      acknowledgements: {},
      calibration: null,
    });
  },

  commit(update) {
    const { document, past, editorRevision, readOnly } = get();
    if (!document || readOnly) return;
    const updated = update(document);
    const reconciled = updated.photo
      ? {
          ...updated,
          photo: {
            ...updated.photo,
            registration: reconcilePhotoRegistration(
              updated.photo.registration,
              updated.project.corner,
            ),
          },
        }
      : updated;
    const next: EditorDocument = {
      ...reconciled,
      project: {
        ...updated.project,
        updatedAt: new Date().toISOString(),
      },
    };
    set({
      document: next,
      past: pushHistory(past, document, next),
      future: [],
      editorRevision: editorRevision + 1,
      saveStatus: 'unsaved',
      missingAsset: !!next.project.artwork && !next.asset,
    });
  },

  undo() {
    const { document, past, future, editorRevision, readOnly } = get();
    if (!document || past.length === 0 || readOnly) return;
    const previous = past[past.length - 1]!;
    const restored: EditorDocument = {
      ...previous,
      project: {
        ...previous.project,
        updatedAt: new Date().toISOString(),
      },
    };
    set({
      document: restored,
      past: past.slice(0, -1),
      future: [document, ...future],
      editorRevision: editorRevision + 1,
      saveStatus: 'unsaved',
      missingAsset: !!restored.project.artwork && !restored.asset,
    });
  },

  redo() {
    const { document, past, future, editorRevision, readOnly } = get();
    if (!document || future.length === 0 || readOnly) return;
    const [next, ...rest] = future;
    const restored: EditorDocument = {
      ...next!,
      project: {
        ...next!.project,
        updatedAt: new Date().toISOString(),
      },
    };
    set({
      document: restored,
      past: [...past, document],
      future: rest,
      editorRevision: editorRevision + 1,
      saveStatus: 'unsaved',
      missingAsset: !!restored.project.artwork && !restored.asset,
    });
  },

  setStep(step) {
    set({ step });
  },

  setViewMode(viewMode) {
    set({ viewMode });
  },

  setSaveStatus(saveStatus) {
    set({ saveStatus });
  },

  setPersistedRevision(persistedRevision) {
    set({ persistedRevision });
  },

  setReadOnly(readOnly) {
    set({ readOnly });
  },

  setDraftError(id, message) {
    set((state) => {
      const next = { ...state.draftErrors };
      if (message === null) {
        delete next[id];
      } else {
        next[id] = message;
      }
      return { draftErrors: next };
    });
  },

  setFieldDraft(id, draft) {
    // draftErrors is maintained as a derived view of drafts: a draft carrying
    // a validation error keeps its blocker entry even while the field that
    // owns it is unmounted, and clearing the draft clears the entry.
    set((state) => {
      const drafts = { ...state.drafts };
      const draftErrors = { ...state.draftErrors };
      if (draft === null) {
        delete drafts[id];
        delete draftErrors[id];
      } else {
        drafts[id] = draft;
        if (draft.error === null) delete draftErrors[id];
        else draftErrors[id] = draft.error;
      }
      return { drafts, draftErrors };
    });
  },

  acknowledge(ackId, fingerprint) {
    set((state) => ({
      acknowledgements: { ...state.acknowledgements, [ackId]: fingerprint },
    }));
  },

  setCalibration(calibration) {
    set({ calibration });
  },

  reset() {
    set({ ...initialState, past: [], future: [], draftErrors: {}, drafts: {} });
  },
}));

export function updateProject(
  doc: EditorDocument,
  project: Partial<ProjectV1>,
): EditorDocument {
  return { ...doc, project: { ...doc.project, ...project } };
}

export function hasDraftErrors(
  draftErrors: Readonly<Record<string, string>>,
): boolean {
  return Object.keys(draftErrors).length > 0;
}
