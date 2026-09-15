import type { Issue } from '../../core/types';
import type { EditorStep } from '../../persistence/types';

export type StepState = 'current' | 'valid' | 'attention' | 'not-ready';

export interface StepStatusInput {
  readonly currentStep: EditorStep;
  readonly issues: readonly Issue[];
  readonly hasArtwork: boolean;
  readonly invalidDraftFieldIds: readonly string[];
  readonly layoutReady: boolean;
}

export const STEP_LABELS: Record<EditorStep, string> = {
  surfaces: 'Corner',
  viewpoint: 'Viewpoint',
  artwork: 'Artwork',
  proof: 'Check',
  print: 'Print',
};

export const STEP_ORDER: readonly EditorStep[] = [
  'surfaces',
  'viewpoint',
  'artwork',
  'proof',
  'print',
];

// Editor-level draft errors are keyed by the DOM id of the field that owns
// them (see DraftInput), so each id maps back to the step that renders it.
const STEP_FIELD_IDS: Record<EditorStep, readonly string[]> = {
  surfaces: [
    'panel-a-width',
    'panel-a-height',
    'panel-b-width',
    'panel-b-height',
    'corner-angle',
    'tape-offset-a',
    'tape-offset-b',
    'tape-chord',
    'tape-height',
  ],
  viewpoint: ['eye-x', 'eye-y', 'eye-z', 'aim-height'],
  artwork: ['art-center-x', 'art-center-y', 'art-height', 'art-rotation'],
  proof: [],
  print: [
    'print-paper',
    'print-orientation',
    'print-dpi',
    'margin-top',
    'margin-right',
    'margin-bottom',
    'margin-left',
    'print-overlap',
  ],
};

const VIEWPOINT_CODES: ReadonlySet<Issue['code']> = new Set([
  'invalid-viewpoint',
  'camera-undefined',
  'viewer-behind-surface',
]);

const ARTWORK_CODES: ReadonlySet<Issue['code']> = new Set([
  'missing-artwork',
  'no-visible-footprint',
]);

// Ownership predicates are shared with the panels' IssueLists so the rail
// count and the visible list can never disagree.
export function isCornerIssue(issue: Issue): boolean {
  return (
    issue.fieldPath?.startsWith('corner.') === true ||
    (issue.code === 'invalid-dimension' && issue.surfaceId !== undefined)
  );
}

export function isViewpointIssue(issue: Issue): boolean {
  return (
    VIEWPOINT_CODES.has(issue.code) ||
    issue.fieldPath === 'viewpoint.eyeMm'
  );
}

export function isArtworkIssue(issue: Issue): boolean {
  return (
    ARTWORK_CODES.has(issue.code) ||
    issue.fieldPath === 'artwork' ||
    issue.fieldPath?.startsWith('artwork.') === true
  );
}

function draftCount(step: EditorStep, ids: readonly string[]): number {
  const owned = STEP_FIELD_IDS[step];
  return ids.filter((id) => owned.includes(id)).length;
}

export function stepAttentionCount(
  step: EditorStep,
  input: StepStatusInput,
): number {
  const drafts = draftCount(step, input.invalidDraftFieldIds);
  switch (step) {
    case 'surfaces':
      return input.issues.filter(isCornerIssue).length + drafts;
    case 'viewpoint':
      return input.issues.filter(isViewpointIssue).length + drafts;
    case 'artwork':
      return input.issues.filter(isArtworkIssue).length + drafts;
    case 'proof':
      return input.issues.filter((i) => i.severity === 'blocker').length;
    case 'print':
      return (
        input.issues.filter(
          (i) => i.code === 'invalid-print-spec' && i.severity === 'blocker',
        ).length + (input.layoutReady ? 0 : 1)
      );
  }
}

function baseState(
  step: EditorStep,
  input: StepStatusInput,
): Exclude<StepState, 'current'> {
  switch (step) {
    case 'artwork':
      if (!input.hasArtwork) return 'not-ready';
      return stepAttentionCount(step, input) > 0 ? 'attention' : 'valid';
    case 'surfaces':
    case 'viewpoint':
    case 'proof':
    case 'print':
      return stepAttentionCount(step, input) > 0 ? 'attention' : 'valid';
  }
}

/**
 * Validity is intentionally separate from the current position.  The rail
 * can therefore announce that the active task still needs attention without
 * replacing its `aria-current="step"` marker.
 */
export function deriveStepValidity(
  step: EditorStep,
  input: StepStatusInput,
): Exclude<StepState, 'current'> {
  return baseState(step, input);
}

export function deriveStepStates(
  input: StepStatusInput,
): Record<EditorStep, StepState> {
  const states = {} as Record<EditorStep, StepState>;
  for (const step of STEP_ORDER) {
    states[step] = step === input.currentStep ? 'current' : baseState(step, input);
  }
  return states;
}
