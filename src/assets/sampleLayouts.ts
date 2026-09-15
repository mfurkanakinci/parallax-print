import type { ArtworkSpec, CornerSpec, ViewpointSpec } from '../core/types';

export interface SampleLayout {
  readonly id: string;
  readonly label: string;
  readonly projectTitle: string;
  readonly description: string;
  readonly corner: CornerSpec;
  readonly viewpoint: ViewpointSpec;
  readonly artwork: Omit<ArtworkSpec, 'assetId'>;
}

/**
 * Editable, measured examples using the production corner model. These are
 * two joined vertical walls, optionally with a printable floor — not a
 * decorative approximation of unsupported freestanding/multi-wall geometry.
 * Each layout carries a deliberate viewing position and artwork placement.
 */
export const SAMPLE_LAYOUTS: readonly SampleLayout[] = [
  {
    id: 'right-angle',
    label: 'Right angle',
    projectTitle: 'right-angle corner',
    description: 'The original study: equal walls meeting at 90°, with a floor.',
    corner: {
      kind: 'interior-corner',
      panelA: { widthMm: 600, heightMm: 600 },
      panelB: { widthMm: 600, heightMm: 600 },
      angleDeg: 90,
      includeBase: true,
    },
    viewpoint: { eyeMm: [900, 350, 900], aimHeightMm: 300 },
    artwork: { centerSlope: [0, 0], heightSlope: 0.4, rotationDeg: 0 },
  },
  {
    id: 'acute-fold',
    label: 'Acute fold',
    projectTitle: 'acute fold',
    description: 'A tight 60° fold, unequal wall widths, and an off-centre eye.',
    corner: {
      kind: 'interior-corner',
      panelA: { widthMm: 630, heightMm: 735 },
      panelB: { widthMm: 490, heightMm: 700 },
      angleDeg: 60,
      includeBase: false,
    },
    viewpoint: { eyeMm: [1155, 630, 700], aimHeightMm: 392 },
    artwork: { centerSlope: [0, 0], heightSlope: 0.3, rotationDeg: 0 },
  },
  {
    id: 'wide-return',
    label: 'Wide return',
    projectTitle: 'wide return',
    description: 'A shallow 135° corner with a shorter return wall.',
    corner: {
      kind: 'interior-corner',
      panelA: { widthMm: 1000, heightMm: 900 },
      panelB: { widthMm: 800, heightMm: 650 },
      angleDeg: 135,
      includeBase: false,
    },
    viewpoint: { eyeMm: [550, 650, 1350], aimHeightMm: 330 },
    artwork: { centerSlope: [0, 0], heightSlope: 0.38, rotationDeg: 0 },
  },
  {
    id: 'stepped-walls',
    label: 'Stepped walls',
    projectTitle: 'stepped walls',
    description: 'A tall, narrow wall meets a low, wide wall at 105°.',
    corner: {
      kind: 'interior-corner',
      panelA: { widthMm: 650, heightMm: 1400 },
      panelB: { widthMm: 1050, heightMm: 750 },
      angleDeg: 105,
      includeBase: false,
    },
    viewpoint: { eyeMm: [1300, 1050, 1450], aimHeightMm: 420 },
    artwork: { centerSlope: [0, 0], heightSlope: 0.24, rotationDeg: 0 },
  },
  {
    id: 'floor-wrap',
    label: 'Floor wrap',
    projectTitle: 'three-surface floor wrap',
    description: 'The image turns a 110° corner and continues onto the floor.',
    corner: {
      kind: 'interior-corner',
      panelA: { widthMm: 450, heightMm: 525 },
      panelB: { widthMm: 500, heightMm: 425 },
      angleDeg: 110,
      includeBase: true,
    },
    viewpoint: { eyeMm: [500, 500, 675], aimHeightMm: 45 },
    artwork: { centerSlope: [0, 0], heightSlope: 0.5, rotationDeg: 0 },
  },
];

export const DEFAULT_SAMPLE_LAYOUT = SAMPLE_LAYOUTS[0]!;
