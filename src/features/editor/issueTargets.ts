import type { Issue } from '../../core/types';
import type { EditorStep } from '../../persistence/types';
import { useProjectStore } from '../../state/projectStore';

export interface IssueTarget {
  readonly step: EditorStep;
  readonly fieldId: string;
  readonly disclosureId?: string;
}

const VIEWPOINT_CODES: ReadonlySet<Issue['code']> = new Set([
  'invalid-viewpoint',
  'camera-undefined',
  'viewer-behind-surface',
]);

/**
 * Maps a compile/preflight issue to the editor field responsible for it.
 * First match wins — `missing-artwork` precedes the bare `artwork` fieldPath
 * rule because it also carries `fieldPath: 'artwork'` but must land on the
 * image chooser, not the placement controls.
 */
export function resolveIssueTarget(issue: Issue): IssueTarget | null {
  const path = issue.fieldPath;
  if (issue.code === 'missing-artwork') {
    return { step: 'artwork', fieldId: 'choose-artwork' };
  }
  if (path === 'artwork.assetId') {
    return { step: 'artwork', fieldId: 'choose-artwork' };
  }
  if (path?.startsWith('corner.angleMeasurement')) {
    return {
      step: 'surfaces',
      fieldId: 'tape-offset-a',
      disclosureId: 'tape-measure',
    };
  }
  if (path === 'corner.panelA') {
    return { step: 'surfaces', fieldId: 'panel-a-width' };
  }
  if (path === 'corner.panelB') {
    return { step: 'surfaces', fieldId: 'panel-b-width' };
  }
  if (path === 'corner.angleDeg') {
    return { step: 'surfaces', fieldId: 'corner-angle' };
  }
  if (path === 'viewpoint.eyeMm') {
    return { step: 'viewpoint', fieldId: 'eye-x' };
  }
  if (path === 'artwork') {
    return { step: 'artwork', fieldId: 'art-center-x' };
  }
  if (VIEWPOINT_CODES.has(issue.code)) {
    return { step: 'viewpoint', fieldId: 'eye-x' };
  }
  if (issue.code === 'invalid-print-spec') {
    return { step: 'print', fieldId: 'print-paper' };
  }
  if (issue.code === 'no-visible-footprint') {
    return { step: 'artwork', fieldId: 'art-center-x' };
  }
  return null;
}

function waitForElement(id: string, timeoutMs = 2_000): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      const el = document.getElementById(id);
      if (el) {
        resolve(el);
      } else if (Date.now() - started > timeoutMs) {
        resolve(null);
      } else {
        requestAnimationFrame(poll);
      }
    };
    poll();
  });
}

/**
 * The fix-action sequence: select the step, open the disclosure that hides
 * the field, wait for the field to mount, then scroll it into view and focus
 * it. Scroll honors prefers-reduced-motion.
 */
export async function applyIssueTarget(target: IssueTarget): Promise<boolean> {
  useProjectStore.getState().setStep(target.step);
  // Let React commit the new step's panel before touching the DOM.
  await new Promise((r) => requestAnimationFrame(r));
  if (target.disclosureId) {
    const details = document.getElementById(target.disclosureId);
    if (details instanceof HTMLDetailsElement && !details.open) {
      details.querySelector('summary')?.click();
    }
    await new Promise((r) => requestAnimationFrame(r));
  }
  const field = await waitForElement(target.fieldId);
  if (!field) return false;
  const reduce =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;
  field.scrollIntoView({
    behavior: reduce ? 'auto' : 'smooth',
    block: 'nearest',
    inline: 'nearest',
  });
  field.focus({ preventScroll: true });
  return true;
}
