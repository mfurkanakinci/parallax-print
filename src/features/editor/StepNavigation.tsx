import { useEffect, useRef } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import type { EditorStep } from '../../persistence/types';
import {
  STEP_LABELS,
  STEP_ORDER,
  type StepState,
  type StepStatusInput,
  stepAttentionCount,
  deriveStepValidity,
  deriveStepStates,
} from './stepStatus';

const STEP_ICONS: Record<EditorStep, IconName> = {
  surfaces: 'surfaces',
  viewpoint: 'eye',
  artwork: 'artwork',
  proof: 'check',
  print: 'print',
};

const STEP_HINTS: Record<EditorStep, string> = {
  surfaces: 'Measure',
  viewpoint: 'Eye',
  artwork: 'Image',
  proof: 'Checks',
  print: 'Output',
};

const STATE_TEXT: Record<Exclude<StepState, 'current'>, string> = {
  valid: 'done',
  attention: 'needs attention',
  'not-ready': 'not ready',
};

function stepStateText(
  step: EditorStep,
  state: StepState,
  input: StepStatusInput,
  validity: Exclude<StepState, 'current'>,
): string | null {
  if (state === 'current') {
    if (validity === 'attention') {
      const count = stepAttentionCount(step, input);
      return `Current step; ${
        count === 1 ? '1 issue needs attention' : `${count} issues need attention`
      }`;
    }
    return `Current step; ${validity === 'valid' ? 'ready' : 'not ready'}`;
  }
  if (state === 'attention') {
    const count = stepAttentionCount(step, input);
    return count === 1 ? '1 issue needs attention' : `${count} issues need attention`;
  }
  return STATE_TEXT[state];
}

export function StepNavigation({
  step,
  onChange,
  statusInput,
}: {
  readonly step: EditorStep;
  readonly onChange: (step: EditorStep) => void;
  readonly statusInput: StepStatusInput;
}) {
  const states = deriveStepStates(statusInput);
  const navRef = useRef<HTMLElement>(null);
  const hasBlocker = statusInput.issues.some((i) => i.severity === 'blocker');

  // On narrow screens the rail scrolls horizontally — keep the active step
  // visible whenever it changes.
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>(
      '.step-button[aria-current="step"]',
    );
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [step]);

  return (
    <nav className="step-nav" aria-label="Editor steps" ref={navRef}>
      <ol>
        {STEP_ORDER.map((id, i) => {
          const state = states[id];
          const validity = deriveStepValidity(id, statusInput);
          const stateText = stepStateText(id, state, statusInput, validity);
          return (
            <li key={id}>
              <button
                type="button"
                className={`step-button step-${state} step-validity-${validity}`}
                aria-label={STEP_LABELS[id]}
                aria-pressed={step === id}
                aria-current={step === id ? 'step' : undefined}
                data-validity={validity}
                aria-describedby={stateText ? `step-state-${id}` : undefined}
                onClick={() => onChange(id)}
              >
                <span className="step-number" aria-hidden="true">
                  {state === 'valid' ? (
                    <Icon name="check" size={13} />
                  ) : state === 'attention' ? (
                    <Icon name="warning" size={13} />
                  ) : (
                    i + 1
                  )}
                </span>
                <Icon name={STEP_ICONS[id]} size={16} />
                <span className="step-text">
                  <span className="step-label">{STEP_LABELS[id]}</span>
                  <span className="step-hint" aria-hidden="true">
                    {STEP_HINTS[id]}
                  </span>
                </span>
                {state === 'attention' || validity === 'attention' ? (
                  <span className="step-count" aria-hidden="true">
                    {stepAttentionCount(id, statusInput)}
                  </span>
                ) : null}
                {stateText ? (
                  <span className="visually-hidden" id={`step-state-${id}`}>
                    {stateText}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ol>
      {hasBlocker ? (
        <p className="step-nav-note" role="status">
          <Icon name="warning" size={14} />
          Blockers need attention — see Check.
        </p>
      ) : null}
    </nav>
  );
}
