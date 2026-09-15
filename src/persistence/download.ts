import { exportProjectArchive } from './projectArchive';
import type { EditorDocument } from './types';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function archiveFilename(title: string): string {
  const base =
    title
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'parallax';
  return `${base}.parallax`;
}

export async function downloadProjectCopy(
  document: EditorDocument,
): Promise<'full' | 'geometry-only'> {
  const geometryOnly = !!document.project.artwork && !document.asset;
  const copy: EditorDocument = geometryOnly
    ? document.photo === undefined
      ? { project: { ...document.project, artwork: null }, asset: null }
      : {
          project: { ...document.project, artwork: null },
          asset: null,
          photo: document.photo,
        }
    : document;
  const blob = await exportProjectArchive(copy);
  downloadBlob(blob, archiveFilename(copy.project.title));
  return geometryOnly ? 'geometry-only' : 'full';
}
