import { importArtworkFile } from '../../assets/importArtwork';
import { useProjectStore } from '../../state/projectStore';
import type { StoredAsset } from '../../persistence/types';

/**
 * Normalize an image file and attach it to the open project in a single
 * commit — one undo step (§12.6). A project with no artwork spec gets the
 * default placement (centered, 0.4 height slope, no rotation); an existing
 * spec keeps its placement and only re-points at the new asset.
 *
 * Shared by the Artwork panel, the stage drop zone, and the stage browse
 * affordance so every entry point attaches artwork identically and cannot
 * drift. `commit` itself refuses in read-only, so callers only need to gate
 * their UI affordances.
 *
 * Returns the stored asset, or null when the store no longer holds the
 * expected project (e.g. the user navigated away mid-import).
 */
export async function importAndAttach(
  file: Blob,
  displayFilename: string,
  projectId?: string,
): Promise<StoredAsset | null> {
  const imported = await importArtworkFile(file, displayFilename);
  const state = useProjectStore.getState();
  if (
    !state.document ||
    (projectId !== undefined && state.document.project.id !== projectId)
  ) {
    return null;
  }
  state.commit((doc) => ({
    ...doc,
    asset: imported,
    project: {
      ...doc.project,
      artwork: doc.project.artwork
        ? { ...doc.project.artwork, assetId: imported.assetId }
        : {
            assetId: imported.assetId,
            centerSlope: [0, 0],
            heightSlope: 0.4,
            rotationDeg: 0,
          },
    },
  }));
  return imported;
}
