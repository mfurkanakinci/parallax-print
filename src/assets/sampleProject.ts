import { LIMITS } from '../core/limits';
import type { ProjectV1 } from '../core/types';
import type { StoredAsset } from '../persistence/types';
import { DEFAULT_SAMPLE_LAYOUT, type SampleLayout } from './sampleLayouts';

export const SAMPLE_ASSET_ID = 'bundled-corner-mark';

export interface SampleArtwork {
  readonly path: string;
  /** Small selector thumbnail (avoid eager full-size decode). */
  readonly thumbPath: string;
  readonly fileName: string;
  readonly label: string;
  readonly description: string;
  /** Artist/title/date and license line shown under the picker. */
  readonly credit: string;
}

export const SAMPLE_ARTWORKS: readonly SampleArtwork[] = [
  {
    path: '/samples/sample-wave.jpg',
    thumbPath: '/samples/thumbs/thumb-sample-wave.jpg',
    fileName: 'sample-wave.jpg',
    label: 'Great Wave',
    description: 'a diagonal wave cresting across both panels',
    credit:
      'Katsushika Hokusai, Under the Wave off Kanagawa, 1830/33 — public domain',
  },
  {
    path: '/samples/sample-bedroom.jpg',
    thumbPath: '/samples/thumbs/thumb-sample-bedroom.jpg',
    fileName: 'sample-bedroom.jpg',
    label: 'The Bedroom',
    description: 'a skewed bedroom interior wrapping the corner',
    credit: 'Vincent van Gogh, The Bedroom, 1889 — public domain',
  },
  {
    path: '/samples/sample-jatte.jpg',
    thumbPath: '/samples/thumbs/thumb-sample-jatte.jpg',
    fileName: 'sample-jatte.jpg',
    label: 'La Grande Jatte',
    description: 'a riverside crowd in dotted brushwork',
    credit:
      'Georges Seurat, A Sunday on La Grande Jatte — 1884, 1884/86 — public domain',
  },
  {
    path: '/samples/corner-route.png',
    thumbPath: '/samples/thumbs/thumb-corner-route.png',
    fileName: 'corner-route.png',
    label: 'Route',
    description: 'a diagonal wayfinding ribbon crossing broken rings',
    credit: 'Parallax Print, generated sample artwork — CC0',
  },
  {
    path: '/samples/corner-sun.png',
    thumbPath: '/samples/thumbs/thumb-corner-sun.png',
    fileName: 'corner-sun.png',
    label: 'Sun',
    description: 'an off-center eclipse crossed by a red slash',
    credit: 'Parallax Print, generated sample artwork — CC0',
  },
];

export const SAMPLE_ASSET_PATH = SAMPLE_ARTWORKS[0]!.path;

export function createSampleProject(
  layout: SampleLayout = DEFAULT_SAMPLE_LAYOUT,
): ProjectV1 {
  const now = '2026-09-12T00:00:00.000Z';
  return {
    schemaVersion: 1,
    id: layout.id === 'right-angle' ? 'sample-corner-90' : `sample-${layout.id}`,
    title: `Sample: ${layout.projectTitle}`,
    createdAt: now,
    updatedAt: now,
    displayUnit: 'mm',
    corner: structuredClone(layout.corner),
    viewpoint: structuredClone(layout.viewpoint),
    artwork: {
      assetId: SAMPLE_ASSET_ID,
      ...structuredClone(layout.artwork),
    },
    print: {
      paper: 'a4',
      orientation: 'portrait',
      marginMm: {
        top: LIMITS.marginMm.default,
        right: LIMITS.marginMm.default,
        bottom: LIMITS.marginMm.default,
        left: LIMITS.marginMm.default,
      },
      overlapMm: LIMITS.overlapMm.default,
      dpi: LIMITS.dpi.default,
      surfaceIds: layout.corner.includeBase ? ['A', 'B', 'C'] : ['A', 'B'],
    },
  };
}

export function freshProjectId(): string {
  return crypto.randomUUID();
}

export function createStarterProject(): ProjectV1 {
  const base = createSampleProject();
  const now = new Date().toISOString();
  return {
    ...base,
    id: freshProjectId(),
    title: 'Untitled corner',
    createdAt: now,
    updatedAt: now,
    artwork: null,
  };
}

export function createSampleCopy(
  asset: StoredAsset,
  layout: SampleLayout = DEFAULT_SAMPLE_LAYOUT,
): ProjectV1 {
  const base = createSampleProject(layout);
  const now = new Date().toISOString();
  return {
    ...base,
    id: freshProjectId(),
    title: `${base.title} (copy)`,
    createdAt: now,
    updatedAt: now,
    artwork: base.artwork
      ? { ...base.artwork, assetId: asset.assetId }
      : null,
  };
}

export function cloneProjectAsNew(project: ProjectV1): ProjectV1 {
  const now = new Date().toISOString();
  return {
    ...project,
    id: freshProjectId(),
    createdAt: now,
    updatedAt: now,
  };
}
