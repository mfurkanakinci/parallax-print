import { describe, expect, it } from 'vitest';
import {
  MM_PER_CM,
  MM_PER_INCH,
  displayToMm,
  formatMm,
  geometryEpsilon,
  mmPerPixel,
  mmToDisplay,
  mmToPt,
} from './units';

describe('units', () => {
  it('converts millimetres to points at 72pt per inch', () => {
    expect(mmToPt(MM_PER_INCH)).toBeCloseTo(72, 10);
    expect(mmToPt(0)).toBe(0);
  });

  it('converts dpi to millimetres per pixel', () => {
    expect(mmPerPixel(1)).toBeCloseTo(MM_PER_INCH, 10);
    expect(mmPerPixel(300)).toBeCloseTo(25.4 / 300, 12);
  });

  it('round-trips display units', () => {
    for (const unit of ['mm', 'cm', 'in'] as const) {
      expect(displayToMm(mmToDisplay(123.4, unit), unit)).toBeCloseTo(123.4, 10);
    }
    expect(mmToDisplay(10, 'cm')).toBeCloseTo(1, 10);
    expect(displayToMm(1, 'in')).toBeCloseTo(MM_PER_INCH, 10);
    expect(MM_PER_CM).toBe(10);
  });

  it('formats with unit-appropriate default precision', () => {
    expect(formatMm(12.34, 'mm')).toBe('12.3 mm');
    expect(formatMm(12.34, 'cm')).toBe('1.23 cm');
    expect(formatMm(12.34, 'in')).toBe('0.486 in');
    expect(formatMm(12.34, 'mm', 3)).toBe('12.340 mm');
  });

  it('scales the geometry epsilon with scene extent but never below 1e-6', () => {
    expect(geometryEpsilon(1)).toBe(1e-6);
    expect(geometryEpsilon(1e9)).toBe(1);
    expect(geometryEpsilon(5e6)).toBeCloseTo(5e-3, 12);
  });
});
