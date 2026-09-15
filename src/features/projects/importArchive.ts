import { navigate } from '../../app/navigation';
import { loadBundledSampleAsset } from '../../assets/importArtwork';
import type { SampleLayout } from '../../assets/sampleLayouts';
import {
  cloneProjectAsNew,
  createSampleCopy,
  type SampleArtwork,
} from '../../assets/sampleProject';
import { importProjectArchive } from '../../persistence/projectArchive';
import {
  PendingRetentionError,
  putPendingDocument,
  saveProject,
} from '../../persistence/projectRepository';
import type { EditorDocument } from '../../persistence/types';

export async function openSampleProject(
  artwork: SampleArtwork,
  layout?: SampleLayout,
): Promise<void> {
  const asset = await loadBundledSampleAsset(artwork);
  const document: EditorDocument = {
    project: createSampleCopy(asset, layout),
    asset,
  };
  try {
    await saveProject(document, 0);
  } catch (cause) {
    const admission = putPendingDocument(document);
    if (admission.status === 'blocked') {
      throw new PendingRetentionError(admission, { cause });
    }
  }
  navigate({ name: 'editor', id: document.project.id });
}

export async function openProjectArchive(file: File): Promise<void> {
  const document = await importProjectArchive(file);
  const copy = cloneImportedDocument(document);
  try {
    await saveProject(copy, 0);
  } catch (cause) {
    const admission = putPendingDocument(copy);
    if (admission.status === 'blocked') {
      throw new PendingRetentionError(admission, { cause });
    }
  }
  navigate({ name: 'editor', id: copy.project.id });
}

export function cloneImportedDocument(document: EditorDocument): EditorDocument {
  return document.photo === undefined
    ? {
        project: cloneProjectAsNew(document.project),
        asset: document.asset,
      }
    : {
        project: cloneProjectAsNew(document.project),
        asset: document.asset,
        photo: document.photo,
      };
}
