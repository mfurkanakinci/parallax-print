import { LIMITS } from '../limits';
import type { CornerSpec, Issue, IssueCode } from '../types';

export class GeometryInputError extends Error {
  readonly code: IssueCode | 'invalid-input';

  constructor(code: IssueCode | 'invalid-input', message: string) {
    super(message);
    this.name = 'GeometryInputError';
    this.code = code;
  }
}

const COS_SLACK = 1e-9;
const ANGLE_TOLERANCE_DEG = 1e-6;
const SHORT_BASELINE_MM = 100;

export function deriveAngleFromTriangle(
  aMm: number,
  bMm: number,
  chordMm: number,
): number {
  for (const [name, v] of [
    ['offsetAMm', aMm],
    ['offsetBMm', bMm],
    ['chordMm', chordMm],
  ] as const) {
    if (!Number.isFinite(v) || v <= 0) {
      throw new GeometryInputError(
        'invalid-angle-measurement',
        `${name} must be a positive finite length`,
      );
    }
  }
  const scale = Math.max(aMm, bMm, chordMm);
  const a = aMm / scale;
  const b = bMm / scale;
  const c = chordMm / scale;
  if (!(c < a + b && c > Math.abs(a - b))) {
    throw new GeometryInputError(
      'invalid-angle-measurement',
      'tape triangle violates the triangle inequality',
    );
  }
  const cos = (a * a + b * b - c * c) / (2 * a * b);
  if (cos < -1 - COS_SLACK || cos > 1 + COS_SLACK) {
    throw new GeometryInputError(
      'invalid-angle-measurement',
      'tape triangle violates the triangle inequality',
    );
  }
  const clamped = Math.min(1, Math.max(-1, cos));
  const angleDeg = (Math.acos(clamped) * 180) / Math.PI;
  if (Math.abs(angleDeg - LIMITS.angleDeg.min) <= ANGLE_TOLERANCE_DEG) {
    return LIMITS.angleDeg.min;
  }
  if (Math.abs(angleDeg - LIMITS.angleDeg.max) <= ANGLE_TOLERANCE_DEG) {
    return LIMITS.angleDeg.max;
  }
  if (
    angleDeg < LIMITS.angleDeg.min ||
    angleDeg > LIMITS.angleDeg.max
  ) {
    throw new GeometryInputError(
      'unsupported-angle',
      `measured angle ${angleDeg.toFixed(2)}° is outside ${LIMITS.angleDeg.min}°–${LIMITS.angleDeg.max}°`,
    );
  }
  return angleDeg;
}

export function validateAngleMeasurement(corner: CornerSpec): Issue[] {
  const m = corner.angleMeasurement;
  if (!m) return [];
  const issues: Issue[] = [];
  let derivedDeg: number;
  try {
    derivedDeg = deriveAngleFromTriangle(m.offsetAMm, m.offsetBMm, m.chordMm);
  } catch (e) {
    issues.push({
      code: e instanceof GeometryInputError && e.code !== 'invalid-input'
        ? e.code
        : 'invalid-angle-measurement',
      severity: 'blocker',
      fieldPath: 'corner.angleMeasurement',
      message: `Impossible tape triangle: ${e instanceof Error ? e.message : 'invalid measurement'}`,
      remedy: 'Re-measure the two offsets and the chord on the printable faces.',
    });
    return issues;
  }
  if (
    !Number.isFinite(corner.angleDeg) ||
    Math.abs(derivedDeg - corner.angleDeg) > ANGLE_TOLERANCE_DEG
  ) {
    issues.push({
      code: 'invalid-angle-measurement',
      severity: 'blocker',
      fieldPath: 'corner.angleDeg',
      message: 'Stored corner angle does not match the tape measurement.',
      remedy: 'Re-measure the tape triangle or update the corner angle consistently.',
    });
  }
  if (
    m.offsetAMm > corner.panelA.widthMm ||
    m.offsetBMm > corner.panelB.widthMm
  ) {
    issues.push({
      code: 'invalid-angle-measurement',
      severity: 'blocker',
      fieldPath: 'corner.angleMeasurement',
      message: 'Tape offsets exceed the panel width they were measured on.',
      remedy: 'Choose offsets inside each panel width.',
    });
  }
  if (
    !Number.isFinite(m.measurementHeightMm) ||
    m.measurementHeightMm <= 0 ||
    m.measurementHeightMm > corner.panelA.heightMm ||
    m.measurementHeightMm > corner.panelB.heightMm
  ) {
    issues.push({
      code: 'invalid-angle-measurement',
      severity: 'blocker',
      fieldPath: 'corner.angleMeasurement.measurementHeightMm',
      message: 'Measurement height must lie on both panels.',
      remedy: 'Measure at an equal height inside both panel heights.',
    });
  }
  if (m.offsetAMm < SHORT_BASELINE_MM || m.offsetBMm < SHORT_BASELINE_MM) {
    issues.push({
      code: 'short-measurement-baseline',
      severity: 'warning',
      fieldPath: 'corner.angleMeasurement',
      message: 'Short tape offsets amplify angle error.',
      remedy: 'Prefer the longest offsets the panels allow.',
    });
  }
  return issues;
}
