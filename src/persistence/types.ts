import type { AssetMetadata, ProjectV1 } from '../core/types';
import type { PhotoRegistrationV1 } from '../core/photo/registration';

export interface StoredAsset extends AssetMetadata {
  readonly contentHash: string;
  readonly normalizedPng: Blob;
  readonly displayFilename: string;
}

export interface EditorDocument {
  readonly project: ProjectV1;
  readonly asset: StoredAsset | null;
  /** Versioned reference imagery is separate from the authoritative ProjectV1. */
  readonly photo?: StoredPhoto | null;
}

export interface StoredPhoto {
  readonly schemaVersion: 1;
  readonly asset: StoredAsset;
  readonly registration: PhotoRegistrationV1;
}

export interface SavedProject {
  readonly project: ProjectV1;
  readonly revision: number;
}

export type EditorStep = 'surfaces' | 'viewpoint' | 'artwork' | 'proof' | 'print';

export type ViewMode = 'resolved' | 'orbit' | 'pieces' | 'photo';

export type SaveStatus = 'unsaved' | 'saving' | 'saved' | 'error' | 'conflict';

export class ConflictError extends Error {
  constructor(message = 'The stored project was changed elsewhere.') {
    super(message);
    this.name = 'ConflictError';
  }
}
