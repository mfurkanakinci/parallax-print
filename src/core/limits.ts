export const LIMITS = {
  angleDeg: { min: 45, max: 150, default: 90 },
  panelMm: { min: 100, max: 3000 },
  baseMaxMm: 3000,
  viewer: {
    coordAbsMaxMm: 20_000,
    eyeHeightMinMm: 100,
    eyeHeightMaxMm: 5_000,
  },
  nearPlaneMm: 1,
  source: {
    maxCompressedBytes: 20 * 1024 * 1024,
    maxMegapixels: 16,
    maxSidePx: 8_192,
    maxNormalizedBytes: 72 * 1024 * 1024,
  },
  // Reference photos are visual registration aids, not production artwork.
  // Keep their decoded buffers and archive contribution separately bounded.
  photo: {
    maxPixels: 8_000_000,
    maxSidePx: 4_096,
    maxNormalizedBytes: 32 * 1024 * 1024,
    maxSeamErrorRatio: 0.005,
    previewMaxEdgePx: 1_600,
  },
  dpi: { default: 150 as const, allowed: [150, 300] as const },
  paperMm: {
    a4: { width: 210, height: 297 },
    letter: { width: 215.9, height: 279.4 },
    a3: { width: 297, height: 420 },
  },
  marginMm: { default: 10, min: 5, max: 30 },
  guideGutterMm: 5,
  overlapMm: { default: 10, min: 5, max: 20 },
  rasterBlockMaxPx: 2_048,
  pdfVolume: { maxArtworkPages: 8, maxArtworkPixels: 24_000_000 },
  exportMaxPages: 240,
  masterMaxPixels: 24_000_000,
  bundleMaxBytes: 96 * 1024 * 1024,
  /**
   * Pre-flight size estimate for embedded tile raster (bytes/pixel).
   * Measured photographic output is ~1.2 B/px; 3 keeps ~2.5× headroom
   * for realistic content and container overhead. High-entropy noise
   * measures ~3.4 B/px through the browser encoder, so this is NOT a
   * guaranteed upper bound for adversarial content — the hard cap on
   * real bytes at zip time remains the guard when an estimate
   * under-predicts. See src/export/estimate.test.ts and
   * tests/e2e/export-estimate.spec.ts for substantiation.
   */
  exportBytesPerPixelEstimate: 3,
  archive: {
    maxBytes: 96 * 1024 * 1024,
    maxInflatedBytes: 80 * 1024 * 1024,
  },
  bulkBufferTargetBytes: 384 * 1024 * 1024,
  preview: {
    duringChangeMaxEdgePx: 256,
    settledMaxEdgePx: 1_024,
  },
  parallelDenominatorEps: 1e-8,
  grazingDotWarn: 0.1,
  // Apparent-plane artwork placement: centre offsets and frame height in
  // slope units (fraction of viewing distance). Shared by the inspector
  // controls and the direct-manipulation gesture so they cannot disagree.
  artworkSlope: { centerAbsMax: 4, heightMin: 0.02, heightMax: 4 },
  // Unsaved-recovery retention: pending documents are held in memory for
  // crash recovery. Bound the map by count and by unique-asset bytes
  // (2× the 72 MiB normalized-asset budget) so failed saves cannot grow
  // retention without limit.
  maxPendingDocuments: 16,
  maxPendingAssetBytes: 144 * 1024 * 1024,

  // Text budgets for generated documents (independent of raster pixels):
  // titles are capped so they cannot push guide content off the page, and
  // guide documents (calibration sheet, assembly guide, placement-recipe
  // continuation pages) are capped in page count.
  titleMaxLength: 200,
  guideMaxPages: 32,
} as const;

export type PaperKind = keyof typeof LIMITS.paperMm;
