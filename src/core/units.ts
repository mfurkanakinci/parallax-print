import type { DisplayUnit } from './types';

export const MM_PER_INCH = 25.4;
export const MM_PER_CM = 10;

export const mmToPt = (mm: number): number => (mm * 72) / 25.4;

export const mmPerPixel = (dpi: number): number => 25.4 / dpi;

export const geometryEpsilon = (sceneExtentMm: number): number =>
  Math.max(1e-6, 1e-9 * sceneExtentMm);

export function mmToDisplay(mm: number, unit: DisplayUnit): number {
  switch (unit) {
    case 'mm':
      return mm;
    case 'cm':
      return mm / MM_PER_CM;
    case 'in':
      return mm / MM_PER_INCH;
  }
}

export function displayToMm(value: number, unit: DisplayUnit): number {
  switch (unit) {
    case 'mm':
      return value;
    case 'cm':
      return value * MM_PER_CM;
    case 'in':
      return value * MM_PER_INCH;
  }
}

export function formatMm(mm: number, unit: DisplayUnit, digits?: number): string {
  const value = mmToDisplay(mm, unit);
  const decimals =
    digits ?? (unit === 'mm' ? 1 : unit === 'cm' ? 2 : 3);
  return `${value.toFixed(decimals)} ${unit}`;
}
