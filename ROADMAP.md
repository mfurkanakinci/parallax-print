# Roadmap

Planned directions for Parallax / Print, roughly in priority order.
Items land as small, reviewable changes; larger geometry work is
developed behind feature flags.

## Testing and tooling

The editor's geometry, projection, raster, and print pipelines are
deterministic and pure, which makes them well suited to known-answer
testing.

- Unit coverage for the geometry core: homography, intersections,
  clipping, angle measurement, and project compilation.
- Known-answer tiling tests at the supported paper sizes (A4, Letter,
  A3), including invalid-budget cases.
- Preflight and resolution-estimation tests.
- Project archive round-trip fixtures covering both schema versions.
- Persistence tests for save, revision-conflict, and recovery paths.
- Worker protocol and lifecycle tests.
- Raster correctness tests for premultiplied sRGB sampling.
- Lint and format checks, then CI running typecheck, tests, lint, and
  the production build.

## Editor experience

- Duplicate an existing project from the projects page.
- Drag-and-drop import of project archives.
- Storage-quota awareness: surface available space and warn before the
  browser might evict stored projects.
- Bundle-size budget enforced in CI.
- Keyboard shortcuts for common editing actions, with a help overlay.
- Snapping artwork to surface centre lines and edges.

## Print and color

- A documented color policy for the print pipeline, which currently
  assumes sRGB throughout.
- Printer profiles (paper size, margins, overlap presets), following
  the color-policy decision.
- Per-edge bleed control for tiled output.

## Geometry expansion

These items extend the supported scene beyond the current two walls
plus floor. They require a surface-representation decision first and
will ship behind feature flags.

- Single-wall mode.
- Optional ceiling plane.
- Curved-wall approximation via faceted surfaces.

## Later

- Project thumbnails in the project list.
- Shareable read-only project links.
- Offline-capable installable shell.
- Accessibility pass across the editor.
- UI string extraction for localization.
