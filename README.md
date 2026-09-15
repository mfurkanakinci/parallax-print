# Parallax / Print

A browser-local editor for anamorphic print installations. An image is projected onto two joined vertical surfaces and an optional floor, then exported as printable pieces that align from one chosen viewpoint.

## Run locally

Requires Node.js 22.12 or newer and npm. The current snapshot is verified with Node.js 26.5.

```sh
npm ci
npm run dev
```

Open the local address printed by Vite. No account, backend, API key or cloud service is required.

```sh
npm run typecheck
npm run build
npm run preview
```

The production build is written to `dist/`. Serve it over HTTPS or localhost; do not open the HTML through `file://`. The app uses hash-based routes and inlined workers, so it can run on an ordinary static host without a server-side router.

## Workflow

1. Create a corner or open an editable sample. Enter the wall dimensions and corner angle; include the floor if needed.
2. Position the viewing point, then import a PNG or JPEG and compose it in the 3D view.
3. Inspect the printable pieces and check the warnings. An optional room photo can be registered as a visual preview.
4. Export tiled PDFs, calibration material and an assembly guide. Project archives let you transfer or back up editable work; SVG and proof exports are also available.

Artwork and projects are processed locally. Projects are stored in the browser's IndexedDB, not uploaded to a server. Browser data can be cleared or evicted, so keep exported project backups.

**Digital alpha:** the supported geometry is two joined vertical walls, optionally with their floor—not an arbitrary 3D mesh. Verify measurements, printer scaling, seams and the actual viewing position before installing anything. Browser previews and successful exports do not establish physical print accuracy or device qualification.

## Source layout

- `src/core/` — deterministic geometry, projection, raster and print calculations; lengths are in millimetres.
- `src/viewport/` — interactive Three.js scene and editing controls.
- `src/features/` — editor, project management, photo preview and installation views.
- `src/assets/`, `src/workers/` — local image handling and background processing.
- `src/export/`, `src/persistence/`, `src/state/` — output generation, browser storage and editor state.
- `public/` — the app's required fonts, icons and sample artwork.

This is a minimal application-source release. Production hosting configuration, the promotional website content and videos, internal plans, recording scripts, generated evidence, and test suites are intentionally not included.

## License and credits

The application source is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for the project copyright notice. Bundled fonts, icons and sample artwork keep their own licenses and attributions; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
