import { describe, expect, it } from 'vitest';
import {
  applyMat3,
  identity3,
  invertMat3,
  mat3IsFinite,
  mat3ResidualMm,
  mulMat3,
} from './matrix3';
import type { Mat3 } from '../types';

const translation = (tx: number, ty: number): Mat3 => [1, 0, tx, 0, 1, ty, 0, 0, 1];
const scale = (sx: number, sy: number): Mat3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1];

describe('matrix3', () => {
  it('identity leaves points unchanged', () => {
    expect(applyMat3(identity3(), [12.5, -7.25])).toEqual([12.5, -7.25]);
  });

  it('multiplies translations by composition order', () => {
    const m = mulMat3(translation(10, 0), translation(0, 20));
    expect(applyMat3(m, [1, 1])).toEqual([11, 21]);
  });

  it('applies scale and translation to a point', () => {
    const m = mulMat3(translation(100, 50), scale(2, 4));
    expect(applyMat3(m, [10, 10])).toEqual([120, 90]);
  });

  it('inverts a rigid transform and round-trips points', () => {
    const m = mulMat3(translation(400, -250), scale(3, 0.5));
    const inv = invertMat3(m);
    expect(inv).not.toBeNull();
    const residual = mat3ResidualMm(m, inv!, [
      [0, 0],
      [1000, 2000],
      [-333.3, 41.7],
    ]);
    expect(residual).toBeLessThan(1e-6);
  });

  it('returns null for a singular matrix', () => {
    expect(invertMat3([1, 2, 3, 2, 4, 6, 7, 8, 9])).toBeNull();
    expect(invertMat3([0, 0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
  });

  it('detects non-finite matrices', () => {
    expect(mat3IsFinite(identity3())).toBe(true);
    expect(mat3IsFinite([1, 0, 0, 0, 1, 0, 0, 0, Number.NaN])).toBe(false);
    expect(mat3IsFinite([1, 0, 0, 0, 1, 0, 0, 0, Number.POSITIVE_INFINITY])).toBe(false);
  });
});
