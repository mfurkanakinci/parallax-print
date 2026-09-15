import * as THREE from 'three';
import { setMountShadowsVisible } from './architecture';

/** The scene groups the draft/proof visibility switch touches. */
export interface DraftVisibilityHost {
  readonly surfacesGroup: THREE.Group;
  readonly archGroup: THREE.Object3D | null;
}

/**
 * Restores or replaces the settled presentation: proof (footprint)
 * meshes visible and draft (projector) meshes hidden, or the reverse
 * while a gesture is live. The mount-shadow decals mark the *committed*
 * mount — while a draft runs they would stay pinned at the old footprint
 * as a stale dark rectangle, so they hide with the proof meshes and
 * return with them. Junction AO stays: the walls do not move during an
 * artwork drag. The draft meshes keep their own permanent material, so
 * there is no material swapping to unwind on any cancel path.
 */
export function setDraftProjectionVisible(
  host: DraftVisibilityHost,
  on: boolean,
): void {
  for (const group of host.surfacesGroup.children) {
    for (const mesh of group.children as THREE.Mesh[]) {
      if (!mesh.isMesh) continue;
      if (mesh.userData.role === 'proof') mesh.visible = !on;
      else if (mesh.userData.role === 'draft') mesh.visible = on;
    }
  }
  setMountShadowsVisible(host.archGroup, !on);
}
