import { useEffect, useRef } from 'react';
import { useProjectStore, type FieldDraft } from '../state/projectStore';
import { displayToMm, mmToDisplay } from '../core/units';
import type { DisplayUnit } from '../core/types';

export function formatFieldNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.abs(value) >= 100 ? Number(value.toFixed(1)) : Number(value.toFixed(3));
  return String(rounded);
}

export function parseDraftNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (trimmed.includes(',') && trimmed.includes('.')) return null;
  const normalized = trimmed.replace(/,/g, '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * The single commit/discard decision shared by the blur and Enter paths.
 * Returns the draft text to commit, or null when there is nothing to commit
 * (no draft, a stale draft whose base value changed underneath it, or text
 * identical to the committed display value). Callers must pass the draft read
 * synchronously from the store — not a render-closure copy — so a blur fired
 * programmatically right after Enter/Escape observes the already-cleared
 * draft and cannot commit (or discard) twice.
 */
export function resolvePendingDraft(
  draft: FieldDraft | undefined,
  displayValue: string,
): string | null {
  if (!draft || draft.displayValue !== displayValue) return null;
  if (draft.text === displayValue) return null;
  return draft.text;
}

interface DraftInputProps {
  readonly id: string;
  readonly label: string;
  readonly accessibleLabel?: string | undefined;
  readonly displayValue: string;
  readonly suffix?: string | undefined;
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly commit: (text: string) => string | null;
  readonly onFocusChange?: ((focused: boolean) => void) | undefined;
}

export function DraftInput({
  id,
  label,
  accessibleLabel,
  displayValue,
  suffix,
  description,
  disabled,
  commit,
  onFocusChange,
}: DraftInputProps) {
  // The draft lives in the editor-level store, keyed by field id, so an
  // unresolved (e.g. invalid) value survives unmount/remount when the user
  // switches inspector steps instead of being silently dropped along with
  // its blocker entry in draftErrors.
  const fieldDraft = useProjectStore((s) => s.drafts[id]);
  const setFieldDraft = useProjectStore((s) => s.setFieldDraft);
  const storeError = useProjectStore((s) => s.draftErrors[id]);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = `${id}-error`;
  const descId = `${id}-desc`;

  const draft =
    fieldDraft && fieldDraft.displayValue === displayValue
      ? fieldDraft.text
      : null;

  // Drop a stored draft once the committed display value it was based on no
  // longer matches (external commit, undo/redo, or a display-unit change).
  useEffect(() => {
    if (fieldDraft && fieldDraft.displayValue !== displayValue) {
      setFieldDraft(id, null);
    }
  }, [fieldDraft, displayValue, id, setFieldDraft]);

  const pendingText = () =>
    resolvePendingDraft(useProjectStore.getState().drafts[id], displayValue);

  const tryCommit = (text: string) => {
    const error = commit(text);
    if (error === null) {
      setFieldDraft(id, null);
    } else {
      setFieldDraft(id, { text, displayValue, error });
    }
    return error === null;
  };

  const shown = draft ?? displayValue;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="field-input-row">
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className="field-input"
          value={shown}
          disabled={disabled}
          aria-label={accessibleLabel}
          aria-invalid={storeError ? true : undefined}
          aria-describedby={
            [description ? descId : null, storeError ? errorId : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          onFocus={() => {
            // Arm a draft only if none exists — a restored unresolved draft
            // must keep its text and error when the field regains focus.
            if (!useProjectStore.getState().drafts[id]) {
              setFieldDraft(id, {
                text: displayValue,
                displayValue,
                error: null,
              });
            }
            onFocusChange?.(true);
          }}
          onChange={(e) => {
            const prev = useProjectStore.getState().drafts[id];
            setFieldDraft(id, {
              text: e.target.value,
              displayValue,
              error:
                prev && prev.displayValue === displayValue ? prev.error : null,
            });
          }}
          onBlur={() => {
            onFocusChange?.(false);
            const text = pendingText();
            if (text === null) {
              setFieldDraft(id, null);
              return;
            }
            tryCommit(text);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const text = pendingText();
              if (text !== null) {
                if (tryCommit(text)) inputRef.current?.blur();
              } else {
                setFieldDraft(id, null);
                inputRef.current?.blur();
              }
            } else if (e.key === 'Escape') {
              e.preventDefault();
              // Discard synchronously: the programmatic blur below resolves
              // against the store and finds nothing to commit.
              setFieldDraft(id, null);
              inputRef.current?.blur();
            }
          }}
        />
        {suffix ? <span className="field-suffix">{suffix}</span> : null}
      </div>
      {description ? (
        <p className="field-desc" id={descId}>
          {description}
        </p>
      ) : null}
      {storeError ? (
        <p className="field-error" id={errorId} role="alert">
          {storeError}
        </p>
      ) : null}
    </div>
  );
}

export interface MeasurementFieldProps {
  readonly id: string;
  readonly label: string;
  /** Optional group-qualified name when a visible label is intentionally short. */
  readonly accessibleLabel?: string | undefined;
  readonly valueMm: number;
  readonly unit: DisplayUnit;
  readonly onCommit: (mm: number) => void;
  readonly minMm?: number;
  readonly maxMm?: number;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly onFocusChange?: (focused: boolean) => void;
}

export function MeasurementField({
  id,
  label,
  accessibleLabel,
  valueMm,
  unit,
  onCommit,
  minMm,
  maxMm,
  description,
  disabled,
  onFocusChange,
}: MeasurementFieldProps) {
  const displayValue = formatFieldNumber(mmToDisplay(valueMm, unit));
  const minDisplay = minMm !== undefined ? mmToDisplay(minMm, unit) : undefined;
  const maxDisplay = maxMm !== undefined ? mmToDisplay(maxMm, unit) : undefined;
  return (
    <DraftInput
      id={id}
      label={label}
      accessibleLabel={accessibleLabel}
      displayValue={displayValue}
      suffix={unit}
      description={description}
      disabled={disabled}
      onFocusChange={onFocusChange}
      commit={(text) => {
        const parsed = parseDraftNumber(text);
        if (parsed === null) return 'Enter a finite number.';
        const mm = displayToMm(parsed, unit);
        if (minMm !== undefined && mm < minMm - 1e-9) {
          return `Must be at least ${formatFieldNumber(minDisplay!)} ${unit}.`;
        }
        if (maxMm !== undefined && mm > maxMm + 1e-9) {
          return `Must be at most ${formatFieldNumber(maxDisplay!)} ${unit}.`;
        }
        onCommit(mm);
        return null;
      }}
    />
  );
}

export interface NumberFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly onCommit: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly suffix?: string;
  readonly description?: string;
  readonly disabled?: boolean;
  readonly digits?: number;
}

export function NumberField({
  id,
  label,
  value,
  onCommit,
  min,
  max,
  suffix,
  description,
  disabled,
  digits,
}: NumberFieldProps) {
  const displayValue =
    digits === undefined ? formatFieldNumber(value) : String(Number(value.toFixed(digits)));
  return (
    <DraftInput
      id={id}
      label={label}
      displayValue={displayValue}
      suffix={suffix}
      description={description}
      disabled={disabled}
      commit={(text) => {
        const parsed = parseDraftNumber(text);
        if (parsed === null) return 'Enter a finite number.';
        if (min !== undefined && parsed < min - 1e-9) {
          return `Must be at least ${formatFieldNumber(min)}.`;
        }
        if (max !== undefined && parsed > max + 1e-9) {
          return `Must be at most ${formatFieldNumber(max)}.`;
        }
        onCommit(parsed);
        return null;
      }}
    />
  );
}
