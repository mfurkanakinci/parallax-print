import type { IDBPDatabase } from 'idb';
import { parseProject } from '../core/schema';
import { LIMITS } from '../core/limits';
import { sha256Hex } from '../assets/contentHash';
import { parseImageHeader, type ImageHeaderInfo } from '../assets/imageHeaders';
import { parsePhotoRegistration } from '../core/photo/registration';
import {
  openDatabase,
  type StoredPhotoRecord,
  type StoredProjectRecord,
} from './database';
import {
  ConflictError,
  type EditorDocument,
  type SavedProject,
  type StoredAsset,
  type StoredPhoto,
} from './types';

export { ConflictError };

interface PendingEntry {
  readonly document: EditorDocument;
  readonly persistedRevision: number;
}

export type PendingAdmissionReason = 'document-count' | 'asset-bytes';

export type PendingAdmission =
  | { readonly status: 'retained' }
  | {
      readonly status: 'blocked';
      readonly reason: PendingAdmissionReason;
      readonly limit: number;
      readonly current: number;
    };

/**
 * Raised through the save-queue error callback when a failed save cannot be
 * retained for recovery because the global pending budget is full. The
 * document is still live in the editor; the caller should retry the save,
 * download a copy, or discard other pending projects.
 */
export class PendingRetentionError extends Error {
  readonly reason: PendingAdmissionReason;
  readonly limit: number;

  constructor(
    admission: Extract<PendingAdmission, { status: 'blocked' }>,
    options?: { cause?: unknown },
  ) {
    super(
      admission.reason === 'document-count'
        ? `The recovery budget already holds ${admission.limit} unsaved projects. Retry the save, download a copy, or discard another unsaved project.`
        : `Unsaved recovery data exceeds the ${Math.round(
            admission.limit / (1024 * 1024),
          )} MiB budget. Retry the save, download a copy, or discard another unsaved project.`,
      options,
    );
    this.name = 'PendingRetentionError';
    this.reason = admission.reason;
    this.limit = admission.limit;
  }
}

const PHOTO_BYTES_CACHE = new WeakMap<Blob, Promise<{
  hash: string;
  header: ImageHeaderInfo;
}>>();

function inspectPhotoBlob(blob: Blob) {
  const cached = PHOTO_BYTES_CACHE.get(blob);
  if (cached) return cached;
  const pending = blob
    .arrayBuffer()
    .then(async (bytes) => ({
      hash: await sha256Hex(bytes),
      header: parseImageHeader(new Uint8Array(bytes), {
        maxCompressedBytes: LIMITS.photo.maxNormalizedBytes,
      }),
    }));
  PHOTO_BYTES_CACHE.set(blob, pending);
  return pending;
}

/** Catalog-safe checks: do not read or hash every project's image bytes. */
function validatePhotoMetadata(photo: StoredPhoto): void {
  if (photo.schemaVersion !== 1) {
    throw new Error('Stored reference photo uses an unsupported schema version.');
  }
  const asset = photo.asset;
  if (
    !(asset.normalizedPng instanceof Blob) ||
    asset.normalizedPng.size > LIMITS.photo.maxNormalizedBytes ||
    !/^[0-9a-f]{64}$/.test(asset.contentHash) ||
    asset.assetId !== asset.contentHash ||
    !Number.isSafeInteger(asset.widthPx) ||
    !Number.isSafeInteger(asset.heightPx) ||
    asset.widthPx < 1 ||
    asset.heightPx < 1 ||
    asset.widthPx > LIMITS.photo.maxSidePx ||
    asset.heightPx > LIMITS.photo.maxSidePx ||
    asset.widthPx * asset.heightPx > LIMITS.photo.maxPixels ||
    typeof asset.displayFilename !== 'string' ||
    asset.displayFilename.length < 1 ||
    asset.displayFilename.length > 255
  ) {
    throw new Error('Stored reference photo asset is invalid or exceeds its budget.');
  }
  const registration = parsePhotoRegistration(photo.registration);
  if (
    registration.image.contentHash !== asset.contentHash ||
    registration.image.widthPx !== asset.widthPx ||
    registration.image.heightPx !== asset.heightPx
  ) {
    throw new Error('Photo registration does not match its stored image.');
  }
}

/** Validate and bind a persisted reference photo without touching ProjectV1. */
export async function validateStoredPhoto(photo: StoredPhoto): Promise<void> {
  validatePhotoMetadata(photo);
  const asset = photo.asset;
  const { hash, header } = await inspectPhotoBlob(asset.normalizedPng);
  if (hash !== asset.contentHash) {
    throw new Error('Stored reference photo hash does not match its bytes.');
  }
  if (
    header.format !== 'png' ||
    header.bitDepth !== 8 ||
    header.orientation !== 1 ||
    header.widthPx !== asset.widthPx ||
    header.heightPx !== asset.heightPx
  ) {
    throw new Error('Stored reference photo PNG does not match its metadata.');
  }
}

const pendingDocuments = new Map<string, PendingEntry>();
// Unique-asset accounting: several pending documents may reference the same
// assetId, so retained bytes are ref-counted per asset rather than summed
// per document.
const pendingAssetRefs = new Map<string, { bytes: number; refs: number }>();
let pendingAssetBytes = 0;

function pendingAssetKeys(
  document: EditorDocument,
): readonly { id: string; bytes: number }[] {
  const keys: { id: string; bytes: number }[] = [];
  if (document.asset) {
    keys.push({
      // Content hashes are the ref-count key so one byte-identical Blob used
      // as both artwork and reference material is retained only once.
      id: document.asset.contentHash,
      bytes: document.asset.normalizedPng.size,
    });
  }
  if (document.photo) {
    keys.push({
      id: document.photo.asset.contentHash,
      bytes: document.photo.asset.normalizedPng.size,
    });
  }
  return [...new Map(keys.map((key) => [key.id, key])).values()];
}

function acquirePendingAssetRef(assetId: string, bytes: number): void {
  const tracked = pendingAssetRefs.get(assetId);
  if (tracked) {
    tracked.refs += 1;
    return;
  }
  pendingAssetRefs.set(assetId, { bytes, refs: 1 });
  pendingAssetBytes += bytes;
}

function releasePendingAssetRef(assetId: string): void {
  const tracked = pendingAssetRefs.get(assetId);
  if (!tracked) return;
  tracked.refs -= 1;
  if (tracked.refs <= 0) {
    pendingAssetRefs.delete(assetId);
    pendingAssetBytes -= tracked.bytes;
  }
}

function releasePendingEntry(id: string): void {
  const entry = pendingDocuments.get(id);
  if (!entry) return;
  pendingDocuments.delete(id);
  for (const key of pendingAssetKeys(entry.document)) {
    releasePendingAssetRef(key.id);
  }
}

/**
 * Retains an unsaved document for recovery, subject to the global pending
 * budget (document count and unique-asset bytes). When the budget is full the
 * document is NOT retained — no existing entry is evicted — and the caller
 * receives a 'blocked' result so it can offer an explicit save / download /
 * discard decision instead of losing the work silently.
 */
export function putPendingDocument(
  document: EditorDocument,
  persistedRevision = 0,
): PendingAdmission {
  const id = document.project.id;
  const existing = pendingDocuments.get(id);
  if (!existing && pendingDocuments.size >= LIMITS.maxPendingDocuments) {
    return {
      status: 'blocked',
      reason: 'document-count',
      limit: LIMITS.maxPendingDocuments,
      current: pendingDocuments.size,
    };
  }
  const next = pendingAssetKeys(document);
  const prev = existing ? pendingAssetKeys(existing.document) : [];
  const prevIds = new Set(prev.map((key) => key.id));
  const nextIds = new Set(next.map((key) => key.id));
  // Net unique-byte change if this document replaced the current entry.
  let added = 0;
  for (const key of next) {
    if (prevIds.has(key.id)) continue;
    const tracked = pendingAssetRefs.get(key.id);
    if (!tracked) added += key.bytes;
  }
  let removed = 0;
  for (const key of prev) {
    if (nextIds.has(key.id)) continue;
    const tracked = pendingAssetRefs.get(key.id);
    if (tracked && tracked.refs <= 1) removed += tracked.bytes;
  }
  const nextBytes = pendingAssetBytes + added - removed;
  if (nextBytes > LIMITS.maxPendingAssetBytes) {
    return {
      status: 'blocked',
      reason: 'asset-bytes',
      limit: LIMITS.maxPendingAssetBytes,
      current: pendingAssetBytes,
    };
  }
  for (const key of prev) {
    if (!nextIds.has(key.id)) releasePendingAssetRef(key.id);
  }
  for (const key of next) {
    if (!prevIds.has(key.id)) acquirePendingAssetRef(key.id, key.bytes);
  }
  pendingDocuments.set(id, { document, persistedRevision });
  return { status: 'retained' };
}

export function getPendingDocument(
  id: string,
): { document: EditorDocument; persistedRevision: number } | null {
  return pendingDocuments.get(id) ?? null;
}

export function dropPendingDocument(id: string): void {
  releasePendingEntry(id);
}

export interface PendingDocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly persistedRevision: number;
  readonly assetId: string | null;
  readonly assetBytes: number;
  readonly photoAssetId: string | null;
  readonly photoAssetBytes: number;
}

/** Recovery surface: every document currently held for unsaved recovery. */
export function listPendingDocuments(): PendingDocumentSummary[] {
  return [...pendingDocuments.entries()].map(([id, entry]) => ({
    id,
    title: entry.document.project.title,
    persistedRevision: entry.persistedRevision,
    assetId: entry.document.asset?.assetId ?? null,
    assetBytes: entry.document.asset?.normalizedPng.size ?? 0,
    photoAssetId: entry.document.photo?.asset.assetId ?? null,
    photoAssetBytes: entry.document.photo?.asset.normalizedPng.size ?? 0,
  }));
}

export interface PendingBudget {
  readonly documents: number;
  readonly maxDocuments: number;
  readonly assetBytes: number;
  readonly maxAssetBytes: number;
}

export function getPendingBudget(): PendingBudget {
  return {
    documents: pendingDocuments.size,
    maxDocuments: LIMITS.maxPendingDocuments,
    assetBytes: pendingAssetBytes,
    maxAssetBytes: LIMITS.maxPendingAssetBytes,
  };
}

export interface ProjectList {
  readonly projects: SavedProject[];
  readonly corruptIds: string[];
}

export async function listProjects(
  db?: IDBPDatabase,
): Promise<ProjectList> {
  const database = db ?? (await openDatabase());
  const records = (await database.getAll('projects')) as StoredProjectRecord[];
  const projects: SavedProject[] = [];
  const corruptIds: string[] = [];
  for (const record of records) {
    if (!record || typeof record.revision !== 'number' || !record.project) {
      corruptIds.push('unreadable record');
      continue;
    }
    const parsed = parseProject(record.project);
    if (!parsed.ok) {
      corruptIds.push(
        typeof record.project.id === 'string'
          ? record.project.id
          : 'unreadable record',
      );
      continue;
    }
    try {
      await readPhotoRecord(database, parsed.project.id, false);
    } catch {
      corruptIds.push(parsed.project.id);
      continue;
    }
    projects.push({ project: parsed.project, revision: record.revision });
  }
  projects.sort((a, b) =>
    b.project.updatedAt.localeCompare(a.project.updatedAt),
  );
  return { projects, corruptIds };
}

function hasPhotoStore(database: IDBPDatabase): boolean {
  return database.objectStoreNames.contains('photos');
}

async function readPhotoRecord(
  database: IDBPDatabase,
  projectId: string,
  verifyBytes = true,
): Promise<StoredPhoto | undefined> {
  if (!hasPhotoStore(database)) return undefined;
  const record = (await database.get('photos', projectId)) as
    | StoredPhotoRecord
    | undefined;
  if (record === undefined) return undefined;
  try {
    if (verifyBytes) await validateStoredPhoto(record);
    else validatePhotoMetadata(record);
  } catch (error) {
    throw new Error(
      `The stored reference photo is corrupted: ${
        error instanceof Error ? error.message : 'invalid photo data'
      }`,
      { cause: error },
    );
  }
  return record;
}

function withOptionalPhoto(
  project: EditorDocument['project'],
  asset: StoredAsset | null,
  photo: StoredPhoto | undefined,
): EditorDocument {
  return photo === undefined ? { project, asset } : { project, asset, photo };
}

export async function loadProject(
  id: string,
  db?: IDBPDatabase,
): Promise<{ document: EditorDocument; revision: number } | null> {
  const pending = pendingDocuments.get(id);
  if (pending) {
    return {
      document: pending.document,
      revision: pending.persistedRevision,
    };
  }
  const database = db ?? (await openDatabase());
  const record = (await database.get('projects', id)) as
    | StoredProjectRecord
    | undefined;
  if (!record) return null;
  const parsed = parseProject(record.project);
  if (!parsed.ok) {
    throw new Error(
      `The stored copy of this project is corrupted: ${parsed.message}`,
    );
  }
  const project = parsed.project;
  let asset: StoredAsset | null = null;
  const assetId = project.artwork?.assetId;
  if (assetId) {
    const stored = (await database.get('assets', assetId)) as
      | StoredAsset
      | undefined;
    if (stored && stored.normalizedPng instanceof Blob) {
      asset = stored;
    }
  }
  const photo = await readPhotoRecord(database, id);
  return {
    document: withOptionalPhoto(project, asset, photo),
    revision: record.revision,
  };
}

export async function saveProject(
  document: EditorDocument,
  expectedRevision: number,
  db?: IDBPDatabase,
): Promise<number> {
  const database = db ?? (await openDatabase());
  const photoStore = hasPhotoStore(database);
  if (document.photo && !photoStore) {
    throw new Error('This database does not support reference-photo persistence.');
  }
  if (document.photo) await validateStoredPhoto(document.photo);
  const tx = database.transaction(
    photoStore ? ['projects', 'assets', 'photos'] : ['projects', 'assets'],
    'readwrite',
  );
  const projects = tx.objectStore('projects');
  const stored = (await projects.get(document.project.id)) as
    | StoredProjectRecord
    | undefined;
  const storedRevision = stored?.revision ?? 0;
  if (storedRevision !== expectedRevision) {
    throw new ConflictError(
      `Stored revision ${storedRevision} does not match expected ${expectedRevision}.`,
    );
  }
  const nextRevision = expectedRevision + 1;
  if (document.asset) {
    await tx
      .objectStore('assets')
      .put(document.asset, document.asset.assetId);
  }
  if (photoStore && document.photo !== undefined) {
    const photos = tx.objectStore('photos');
    if (document.photo) await photos.put(document.photo, document.project.id);
    else await photos.delete(document.project.id);
  }
  const record: StoredProjectRecord = {
    project: document.project,
    revision: nextRevision,
  };
  await projects.put(record, document.project.id);
  await tx.done;
  const pending = pendingDocuments.get(document.project.id);
  if (pending && pending.document === document) {
    releasePendingEntry(document.project.id);
  }
  return nextRevision;
}

async function readStoredProject(
  id: string,
): Promise<{ document: EditorDocument; revision: number } | null> {
  const database = await openDatabase();
  const record = (await database.get('projects', id)) as
    | StoredProjectRecord
    | undefined;
  if (!record) return null;
  const parsed = parseProject(record.project);
  if (!parsed.ok) return null;
  let asset: StoredAsset | null = null;
  const assetId = parsed.project.artwork?.assetId;
  if (assetId) {
    const stored = (await database.get('assets', assetId)) as
      | StoredAsset
      | undefined;
    if (stored && stored.normalizedPng instanceof Blob) asset = stored;
  }
  const photo = await readPhotoRecord(database, id);
  return {
    document: withOptionalPhoto(parsed.project, asset, photo),
    revision: record.revision,
  };
}

function sameStoredContent(a: EditorDocument, b: EditorDocument): boolean {
  return (
    JSON.stringify(a.project) === JSON.stringify(b.project) &&
    (a.asset?.contentHash ?? null) === (b.asset?.contentHash ?? null) &&
    (a.photo?.asset.contentHash ?? null) === (b.photo?.asset.contentHash ?? null) &&
    (a.photo?.asset.widthPx ?? null) === (b.photo?.asset.widthPx ?? null) &&
    (a.photo?.asset.heightPx ?? null) === (b.photo?.asset.heightPx ?? null) &&
    (a.photo?.asset.displayFilename ?? null) ===
      (b.photo?.asset.displayFilename ?? null) &&
    JSON.stringify(a.photo?.registration ?? null) ===
      JSON.stringify(b.photo?.registration ?? null)
  );
}

export interface SaveCallbacks {
  onSaving?(editorRevision: number): void;
  onSaved(revision: number, editorRevision: number): void;
  onError(error: unknown, editorRevision: number): void;
}

interface PendingSave {
  document: EditorDocument;
  editorRevision: number;
}

export class ProjectSaveQueue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: PendingSave | null = null;
  private persistedRevision: number;
  private running = false;
  private disposed = false;

  constructor(
    private readonly callbacks: SaveCallbacks,
    private readonly debounceMs = 400,
    initialRevision = 0,
  ) {
    this.persistedRevision = initialRevision;
  }

  setPersistedRevision(revision: number): void {
    this.persistedRevision = revision;
  }

  enqueue(document: EditorDocument, editorRevision: number): void {
    if (this.disposed) return;
    this.latest = { document, editorRevision };
    putPendingDocument(document, this.persistedRevision);
    if (!this.running && this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.run();
      }, this.debounceMs);
    }
  }

  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      void this.run();
    }
    while (this.running || this.latest) {
      await this.idle();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.latest = null;
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (!this.running && !this.latest) {
          resolve();
          return;
        }
        setTimeout(check, 5);
      };
      check();
    });
  }

  private async run(): Promise<void> {
    if (this.running) return;
    const job = this.latest;
    if (!job || this.disposed) return;
    this.running = true;
    this.latest = null;
    const pendingNow = pendingDocuments.get(job.document.project.id);
    if (pendingNow?.document === job.document) {
      putPendingDocument(job.document, this.persistedRevision);
    }
    this.callbacks.onSaving?.(job.editorRevision);
    try {
      const revision = await saveProject(job.document, this.persistedRevision);
      this.persistedRevision = revision;
      this.callbacks.onSaved(revision, job.editorRevision);
    } catch (e) {
      let recovered = false;
      if (e instanceof ConflictError) {
        try {
          const stored = await readStoredProject(job.document.project.id);
          if (
            stored &&
            sameStoredContent(stored.document, job.document)
          ) {
            this.persistedRevision = stored.revision;
            const pending = pendingDocuments.get(job.document.project.id);
            if (pending?.document === job.document) {
              releasePendingEntry(job.document.project.id);
            }
            this.callbacks.onSaved(stored.revision, job.editorRevision);
            recovered = true;
          }
        } catch {
          recovered = false;
        }
      }
      if (!recovered) {
        const pendingLatest = this.latest as PendingSave | null;
        const admission = putPendingDocument(
          pendingLatest?.document ?? job.document,
          this.persistedRevision,
        );
        // If the recovery budget rejected retention, surface that explicitly:
        // the document is still live in the editor but is no longer held for
        // crash recovery, so the user must retry, download, or discard.
        this.callbacks.onError(
          admission.status === 'blocked'
            ? new PendingRetentionError(admission, { cause: e })
            : e,
          job.editorRevision,
        );
      }
    } finally {
      this.running = false;
    }
    if (this.latest && !this.disposed) {
      void this.run();
    }
  }
}

export type LockResult =
  | { readonly status: 'held'; readonly release: () => void }
  | { readonly status: 'unavailable' }
  | { readonly status: 'unsupported' };

interface NavigatorWithLocks {
  locks?: {
    request<T>(
      name: string,
      options: { ifAvailable?: boolean; mode?: 'exclusive' | 'shared' },
      callback: (lock: { name: string; mode: string } | null) => Promise<T> | T,
    ): Promise<T>;
  };
}

export async function acquireProjectLock(
  projectId: string,
  nav: NavigatorWithLocks | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as NavigatorWithLocks),
  retryDelayMs = 150,
): Promise<LockResult> {
  const locks = nav?.locks;
  if (!locks) return { status: 'unsupported' };
  const attempt = (): Promise<LockResult> =>
    new Promise((resolve) => {
      let releaseFn: (() => void) | null = null;
      const acquired = new Promise<'held' | 'unavailable'>((resolveInner) => {
        void locks
          .request(
            `parallax:${projectId}`,
            { ifAvailable: true, mode: 'exclusive' },
            (lock) => {
              if (!lock) {
                resolveInner('unavailable');
                return;
              }
              resolveInner('held');
              return new Promise<void>((done) => {
                releaseFn = done;
              });
            },
          )
          .catch(() => {
            resolveInner('unavailable');
          });
      });
      void acquired.then((status) => {
        if (status === 'held') {
          resolve({
            status: 'held',
            release: () => {
              releaseFn?.();
            },
          });
        } else {
          resolve({ status: 'unavailable' });
        }
      });
    });
  const first = await attempt();
  if (first.status !== 'unavailable') return first;
  await new Promise((r) => setTimeout(r, retryDelayMs));
  return attempt();
}
