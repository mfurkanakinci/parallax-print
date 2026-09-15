import { LIMITS } from '../core/limits';
import type { EditorDocument } from '../persistence/types';

export const HISTORY_LIMIT = 50;

export function uniqueAssetBytes(
  documents: readonly EditorDocument[],
): number {
  const seen = new Set<Blob>();
  let total = 0;
  for (const doc of documents) {
    const blobs = [doc.asset?.normalizedPng, doc.photo?.asset.normalizedPng];
    for (const blob of blobs) {
      if (blob && !seen.has(blob)) {
        seen.add(blob);
        total += blob.size;
      }
    }
  }
  return total;
}

export function historyAssetByteLimit(
  documents: readonly EditorDocument[],
): number {
  return documents.some((doc) => doc.photo)
    ? LIMITS.source.maxNormalizedBytes + LIMITS.photo.maxNormalizedBytes
    : LIMITS.source.maxNormalizedBytes;
}

export function pushHistory(
  past: readonly EditorDocument[],
  current: EditorDocument,
  next: EditorDocument,
): EditorDocument[] {
  const kept = [...past, current];
  while (kept.length > HISTORY_LIMIT) kept.shift();
  while (kept.length > 0) {
    const candidate = [...kept, next];
    if (uniqueAssetBytes(candidate) <= historyAssetByteLimit(candidate)) break;
    kept.shift();
  }
  return kept;
}
