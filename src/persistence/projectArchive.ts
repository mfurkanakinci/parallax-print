import { Unzip, UnzipInflate, UnzipPassThrough, zipSync } from 'fflate';
import { z } from 'zod';
import { LIMITS } from '../core/limits';
import { parseProject } from '../core/schema';
import type { ProjectV1 } from '../core/types';
import { parseImageHeader } from '../assets/imageHeaders';
import { sha256Hex } from '../assets/contentHash';
import { parsePhotoRegistration } from '../core/photo/registration';
import {
  browserImageDecoder,
  type DecodedImageData,
  type ImageDecoder,
} from '../assets/normalizeArtwork';
import type { EditorDocument, StoredAsset, StoredPhoto } from './types';

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export interface ArchiveBudgets {
  readonly maxInputBytes: number;
  readonly maxInflatedBytes: number;
  readonly maxJsonBytes: number;
  readonly maxThumbnailBytes: number;
  readonly maxEntries: number;
}

const DEFAULT_BUDGETS: ArchiveBudgets = {
  maxInputBytes: LIMITS.archive.maxBytes,
  maxInflatedBytes: LIMITS.archive.maxInflatedBytes,
  maxJsonBytes: 1024 * 1024,
  maxThumbnailBytes: 1024 * 1024,
  maxEntries: 4,
};

const PROJECT_ENTRY = 'project.json';
const SOURCE_ENTRY = 'assets/source.png';
const PHOTO_ENTRY = 'photo/reference.png';
const THUMBNAIL_ENTRY = 'assets/thumbnail.png';
const ALLOWED_ENTRIES = new Set([
  PROJECT_ENTRY,
  SOURCE_ENTRY,
  PHOTO_ENTRY,
  THUMBNAIL_ENTRY,
]);

const archiveEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  project: z.unknown(),
  asset: z
    .object({
      assetId: z.string().min(1),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
      widthPx: z.number().int().positive(),
      heightPx: z.number().int().positive(),
      displayFilename: z.string(),
    })
    .nullable(),
}).strict();

const assetMetadataSchema = z.object({
  assetId: z.string().min(1),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  displayFilename: z.string(),
}).strict();

const archivePhotoSchema = z.object({
  schemaVersion: z.literal(1),
  asset: assetMetadataSchema.extend({ displayFilename: z.string().min(1).max(255) }),
  registration: z.unknown(),
}).strict();

const archiveEnvelopeV2Schema = z.object({
  schemaVersion: z.literal(2),
  project: z.unknown(),
  asset: assetMetadataSchema.nullable(),
  photo: archivePhotoSchema,
}).strict();

export async function exportProjectArchive(
  document: EditorDocument,
  decode: ImageDecoder = browserImageDecoder,
): Promise<Blob> {
  const asset = document.asset;
  const photo = document.photo ?? null;
  const metadata = (value: StoredAsset) => ({
    assetId: value.assetId,
    contentHash: value.contentHash,
    widthPx: value.widthPx,
    heightPx: value.heightPx,
    displayFilename: value.displayFilename,
  });
  if (photo) {
    if (typeof photo.asset.displayFilename !== 'string' || photo.asset.displayFilename.length < 1 || photo.asset.displayFilename.length > 255) {
      throw new ArchiveError('Reference photo filename must contain 1 to 255 characters.');
    }
    if (photo.schemaVersion !== 1) {
      throw new ArchiveError('Reference photo uses an unsupported schema version.');
    }
    try {
      parsePhotoRegistration(photo.registration);
    } catch (error) {
      throw new ArchiveError(
        `Reference photo registration is invalid: ${
          error instanceof Error ? error.message : 'unsupported data'
        }`,
      );
    }
    if (
      photo.asset.assetId !== photo.asset.contentHash ||
      photo.registration.image.contentHash !== photo.asset.contentHash ||
      photo.registration.image.widthPx !== photo.asset.widthPx ||
      photo.registration.image.heightPx !== photo.asset.heightPx
    ) {
      throw new ArchiveError('Reference photo metadata does not match its registration.');
    }
    if (photo.asset.normalizedPng.size > LIMITS.photo.maxNormalizedBytes) {
      throw new ArchiveError('Reference photo exceeds the archive byte limit.');
    }
  }
  const envelope = photo
    ? {
        schemaVersion: 2 as const,
        project: document.project,
        asset: asset ? metadata(asset) : null,
        photo: {
          schemaVersion: 1 as const,
          asset: metadata(photo.asset),
          registration: photo.registration,
        },
      }
    : {
        schemaVersion: 1 as const,
        project: document.project,
        asset: asset ? metadata(asset) : null,
      };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (jsonBytes.length > DEFAULT_BUDGETS.maxJsonBytes) {
    throw new ArchiveError('Project metadata exceeds the archive limit.');
  }
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {
    [PROJECT_ENTRY]: [jsonBytes, { level: 6 }],
  };
  let total = jsonBytes.length;
  if (asset) {
    const png = new Uint8Array(await asset.normalizedPng.arrayBuffer());
    if (png.length > LIMITS.source.maxNormalizedBytes) {
      throw new ArchiveError('Artwork source exceeds the archive byte limit.');
    }
    total += png.length;
    if (total > DEFAULT_BUDGETS.maxInputBytes) {
      throw new ArchiveError('Project archive exceeds the 96 MiB limit.');
    }
    entries[SOURCE_ENTRY] = [png, { level: 0 }];
  }
  if (photo) {
    const png = new Uint8Array(await photo.asset.normalizedPng.arrayBuffer());
    if ((await sha256Hex(png)) !== photo.asset.contentHash) {
      throw new ArchiveError('Reference photo hash does not match its bytes.');
    }
    const header = parseImageHeader(png, {
      maxCompressedBytes: LIMITS.photo.maxNormalizedBytes,
    });
    if (
      header.format !== 'png' ||
      header.bitDepth !== 8 ||
      header.orientation !== 1 ||
      header.widthPx !== photo.asset.widthPx ||
      header.heightPx !== photo.asset.heightPx
    ) {
      throw new ArchiveError('Reference photo PNG does not match its metadata.');
    }
    let decoded: DecodedImageData;
    try {
      decoded = await decode(png, 'png');
    } catch (error) {
      throw new ArchiveError(
        `Reference photo could not be decoded: ${
          error instanceof Error ? error.message : 'decode failed'
        }`,
      );
    }
    if (
      decoded.widthPx !== photo.asset.widthPx ||
      decoded.heightPx !== photo.asset.heightPx ||
      decoded.data.length !== decoded.widthPx * decoded.heightPx * 4
    ) {
      throw new ArchiveError('Decoded reference photo does not match its metadata.');
    }
    total += png.length;
    if (
      total > DEFAULT_BUDGETS.maxInputBytes ||
      total > DEFAULT_BUDGETS.maxInflatedBytes
    ) {
      throw new ArchiveError(
        'Project archive exceeds the importer byte budget for reference imagery.',
      );
    }
    entries[PHOTO_ENTRY] = [png, { level: 0 }];
  }
  if (total > DEFAULT_BUDGETS.maxInflatedBytes) {
    throw new ArchiveError('Project archive exceeds the decompressed size limit.');
  }
  const zipped = zipSync(entries, { level: 0 });
  if (zipped.length > DEFAULT_BUDGETS.maxInputBytes) {
    throw new ArchiveError('Project archive exceeds the 96 MiB limit.');
  }
  return new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
}

interface CollectedFile {
  readonly chunks: Uint8Array[];
  length: number;
  complete: boolean;
}

const PUSH_CHUNK_BYTES = 1024;

function validateEocd(bytes: Uint8Array, maxEntries: number): void {
  if (bytes.length < 22) {
    throw new ArchiveError('Archive is too small to be a ZIP file.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanStart = Math.max(0, bytes.length - (22 + 0xffff));
  let eocd = -1;
  for (let i = bytes.length - 22; i >= scanStart; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ArchiveError(
      'Archive is missing its end-of-central-directory record.',
    );
  }
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const commentLength = view.getUint16(eocd + 20, true);
  if (eocd + 22 + commentLength !== bytes.length) {
    throw new ArchiveError('Archive has trailing data after its directory.');
  }
  if (disk !== 0 || cdDisk !== 0) {
    throw new ArchiveError('Multi-disk archives are not supported.');
  }
  if (
    entries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new ArchiveError('ZIP64 archives are not supported.');
  }
  if (entriesOnDisk !== entries) {
    throw new ArchiveError('Archive directory entry counts disagree.');
  }
  if (entries === 0) {
    throw new ArchiveError('Archive contains no entries.');
  }
  if (entries > maxEntries) {
    throw new ArchiveError('Archive declares too many entries.');
  }
  if (cdOffset + cdSize > eocd) {
    throw new ArchiveError('Archive central directory is truncated.');
  }
  let count = 0;
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    if (p + 46 > cdEnd || view.getUint32(p, true) !== 0x02014b50) {
      throw new ArchiveError('Archive central directory is malformed.');
    }
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const fileComment = view.getUint16(p + 32, true);
    p += 46 + nameLength + extraLength + fileComment;
    count += 1;
  }
  if (p !== cdEnd || count !== entries) {
    throw new ArchiveError(
      'Archive entry count does not match its directory.',
    );
  }
}

function collectEntries(
  bytes: Uint8Array,
  budgets: ArchiveBudgets,
): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    try {
      validateEocd(bytes, budgets.maxEntries);
    } catch (e) {
      reject(e);
      return;
    }
    const collected = new Map<string, CollectedFile>();
    const seen = new Set<string>();
    let totalInflated = 0;
    let entryCount = 0;
    let failed: Error | null = null;

    const unzip = new Unzip();
    unzip.register(UnzipPassThrough);
    unzip.register(UnzipInflate);

    const fail = (e: Error) => {
      if (!failed) {
        failed = e;
        reject(e);
      }
    };

    unzip.onfile = (file) => {
      if (failed) return;
      entryCount += 1;
      if (entryCount > budgets.maxEntries) {
        fail(new ArchiveError('Archive has too many entries.'));
        return;
      }
      if (!ALLOWED_ENTRIES.has(file.name)) {
        fail(new ArchiveError(`Archive entry is not allowed: ${file.name}`));
        return;
      }
      if (seen.has(file.name)) {
        fail(new ArchiveError(`Duplicate archive entry: ${file.name}`));
        return;
      }
      seen.add(file.name);
      const perFileBudget =
        file.name === PROJECT_ENTRY ||
        file.name === THUMBNAIL_ENTRY ||
        file.name === PHOTO_ENTRY
          ? file.name === PROJECT_ENTRY
            ? budgets.maxJsonBytes
            : file.name === PHOTO_ENTRY
              ? LIMITS.photo.maxNormalizedBytes
              : budgets.maxThumbnailBytes
          : budgets.maxInflatedBytes;
      if ((file.originalSize ?? 0) > perFileBudget) {
        fail(
          new ArchiveError(
            `Archive entry ${file.name} declares ${file.originalSize} bytes, over the limit.`,
          ),
        );
        return;
      }
      const state: CollectedFile = { chunks: [], length: 0, complete: false };
      collected.set(file.name, state);
      file.ondata = (err, chunk, final) => {
        if (failed) return;
        if (err) {
          fail(err instanceof Error ? err : new ArchiveError('Archive decompression failed.'));
          return;
        }
        const next = state.length + chunk.length;
        if (
          next > perFileBudget ||
          totalInflated + chunk.length > budgets.maxInflatedBytes
        ) {
          file.terminate();
          fail(new ArchiveError('Archive exceeds the decompressed size limit.'));
          return;
        }
        state.chunks.push(chunk);
        state.length = next;
        totalInflated += chunk.length;
        if (final) {
          const out = new Uint8Array(state.length);
          let offset = 0;
          for (const c of state.chunks) {
            out.set(c, offset);
            offset += c.length;
          }
          state.chunks.length = 0;
          state.chunks.push(out);
          state.complete = true;
        }
      };
      try {
        file.start();
      } catch (e) {
        fail(e instanceof Error ? e : new ArchiveError('Archive entry cannot be decoded.'));
      }
    };

    try {
      for (let offset = 0; offset < bytes.length && !failed; offset += PUSH_CHUNK_BYTES) {
        const end = Math.min(offset + PUSH_CHUNK_BYTES, bytes.length);
        unzip.push(bytes.subarray(offset, end), end >= bytes.length);
      }
      if (bytes.length === 0) {
        unzip.push(new Uint8Array(0), true);
      }
    } catch (e) {
      fail(e instanceof Error ? e : new ArchiveError('Not a readable ZIP archive.'));
      return;
    }
    if (failed) return;
    const result = new Map<string, Uint8Array>();
    for (const [name, state] of collected) {
      if (!state.complete) {
        reject(
          new ArchiveError(`Archive entry ${name} is incomplete or truncated.`),
        );
        return;
      }
      result.set(name, state.chunks[0] ?? new Uint8Array(0));
    }
    resolve(result);
  });
}

export async function importProjectArchive(
  file: Blob,
  budgets: ArchiveBudgets = DEFAULT_BUDGETS,
  decode: ImageDecoder = browserImageDecoder,
): Promise<EditorDocument> {
  if (file.size > budgets.maxInputBytes) {
    throw new ArchiveError('Archive exceeds the 96 MiB input limit.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await collectEntries(bytes, budgets);

  const jsonBytes = entries.get(PROJECT_ENTRY);
  if (!jsonBytes) {
    throw new ArchiveError('Archive is missing project.json.');
  }
  let envelopeRaw: unknown;
  try {
    envelopeRaw = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw new ArchiveError('project.json is not valid JSON.');
  }
  const envelopeV1 = archiveEnvelopeSchema.safeParse(envelopeRaw);
  const envelopeV2 = archiveEnvelopeV2Schema.safeParse(envelopeRaw);
  if (!envelopeV1.success && !envelopeV2.success) {
    throw new ArchiveError('Archive envelope is not a supported schema.');
  }
  if (envelopeV1.success && entries.has(PHOTO_ENTRY)) {
    throw new ArchiveError('Photo entries require archive schema version 2.');
  }
  if (envelopeV2.success && !entries.has(PHOTO_ENTRY)) {
    throw new ArchiveError('Schema version 2 archive is missing photo/reference.png.');
  }
  const envelope = envelopeV2.success
    ? envelopeV2.data
    : envelopeV1.success
      ? envelopeV1.data
      : null;
  if (!envelope) throw new ArchiveError('Archive envelope is not a supported schema.');
  const parsed = parseProject(envelope.project);
  if (!parsed.ok) {
    throw new ArchiveError(`project.json is invalid: ${parsed.message}`);
  }
  const project: ProjectV1 = parsed.project;
  const assetMeta = envelope.asset;

  if (!project.artwork && assetMeta) {
    throw new ArchiveError('Archive declares an asset the project does not use.');
  }
  if (project.artwork && !assetMeta) {
    throw new ArchiveError('Archive is missing required asset metadata.');
  }

  let asset: StoredAsset | null = null;
  if (project.artwork && assetMeta) {
    if (project.artwork.assetId !== assetMeta.assetId) {
      throw new ArchiveError('Asset metadata does not match the project artwork.');
    }
    if (assetMeta.contentHash !== assetMeta.assetId) {
      throw new ArchiveError('Asset content hash does not match its identity.');
    }
    const png = entries.get(SOURCE_ENTRY);
    if (!png) {
      throw new ArchiveError('Archive is missing assets/source.png.');
    }
    const header = parseImageHeader(png, {
      maxCompressedBytes: LIMITS.source.maxNormalizedBytes,
    });
    if (header.format !== 'png') {
      throw new ArchiveError('Archived source must be a PNG.');
    }
    if (header.bitDepth !== 8 || header.orientation !== 1) {
      throw new ArchiveError('Archived source must be a normalized 8-bit PNG.');
    }
    if (
      header.widthPx !== assetMeta.widthPx ||
      header.heightPx !== assetMeta.heightPx
    ) {
      throw new ArchiveError('Archived source dimensions do not match metadata.');
    }
    const hash = await sha256Hex(png);
    if (hash !== assetMeta.contentHash) {
      throw new ArchiveError('Archived source hash does not match metadata.');
    }
    // The hash proves the bytes are the declared ones, not that they decode.
    // A header-only or corrupt PNG would otherwise reach persistence, so the
    // archived source is decoded here — bounded by the header/size checks
    // above — before this function returns a document eligible for saving.
    let decoded: DecodedImageData;
    try {
      decoded = await decode(png, 'png');
    } catch (e) {
      throw new ArchiveError(
        `Archived source could not be decoded: ${
          e instanceof Error ? e.message : 'decode failed'
        }`,
      );
    }
    if (
      !decoded ||
      !Number.isInteger(decoded.widthPx) ||
      !Number.isInteger(decoded.heightPx) ||
      decoded.widthPx !== assetMeta.widthPx ||
      decoded.heightPx !== assetMeta.heightPx ||
      decoded.data.length !== decoded.widthPx * decoded.heightPx * 4
    ) {
      throw new ArchiveError(
        'Decoded archive source does not match its declared dimensions.',
      );
    }
    asset = {
      assetId: assetMeta.assetId,
      contentHash: assetMeta.contentHash,
      widthPx: assetMeta.widthPx,
      heightPx: assetMeta.heightPx,
      displayFilename: assetMeta.displayFilename,
      normalizedPng: new Blob([png.buffer as ArrayBuffer], { type: 'image/png' }),
    };
  } else if (entries.has(SOURCE_ENTRY)) {
    throw new ArchiveError('Archive carries a source the project does not use.');
  }
  let photo: StoredPhoto | undefined;
  if (envelopeV2.success) {
    const photoMeta = envelopeV2.data.photo;
    const registration = (() => {
      try {
        return parsePhotoRegistration(photoMeta.registration);
      } catch (error) {
        throw new ArchiveError(
          `Reference photo registration is invalid: ${
            error instanceof Error ? error.message : 'unsupported data'
          }`,
        );
      }
    })();
    const png = entries.get(PHOTO_ENTRY);
    if (!png) {
      throw new ArchiveError('Archive is missing photo/reference.png.');
    }
    if (photoMeta.asset.contentHash !== photoMeta.asset.assetId) {
      throw new ArchiveError('Reference photo metadata hash does not match its identity.');
    }
    const header = parseImageHeader(png, {
      maxCompressedBytes: LIMITS.photo.maxNormalizedBytes,
    });
    if (
      header.format !== 'png' ||
      header.bitDepth !== 8 ||
      header.orientation !== 1 ||
      header.widthPx !== photoMeta.asset.widthPx ||
      header.heightPx !== photoMeta.asset.heightPx
    ) {
      throw new ArchiveError('Archived reference photo dimensions or PNG format do not match metadata.');
    }
    if (
      registration.image.contentHash !== photoMeta.asset.contentHash ||
      registration.image.widthPx !== photoMeta.asset.widthPx ||
      registration.image.heightPx !== photoMeta.asset.heightPx
    ) {
      throw new ArchiveError('Photo registration does not match its archived image.');
    }
    const hash = await sha256Hex(png);
    if (hash !== photoMeta.asset.contentHash) {
      throw new ArchiveError('Archived reference photo hash does not match metadata.');
    }
    let decoded: DecodedImageData;
    try {
      decoded = await decode(png, 'png');
    } catch (error) {
      throw new ArchiveError(
        `Archived reference photo could not be decoded: ${
          error instanceof Error ? error.message : 'decode failed'
        }`,
      );
    }
    if (
      decoded.widthPx !== photoMeta.asset.widthPx ||
      decoded.heightPx !== photoMeta.asset.heightPx ||
      decoded.data.length !== decoded.widthPx * decoded.heightPx * 4
    ) {
      throw new ArchiveError('Decoded reference photo dimensions do not match metadata.');
    }
    photo = {
      schemaVersion: 1,
      asset: {
        assetId: photoMeta.asset.assetId,
        contentHash: photoMeta.asset.contentHash,
        widthPx: photoMeta.asset.widthPx,
        heightPx: photoMeta.asset.heightPx,
        displayFilename: photoMeta.asset.displayFilename,
        normalizedPng: new Blob([png.buffer as ArrayBuffer], { type: 'image/png' }),
      },
      registration,
    };
  } else if (entries.has(PHOTO_ENTRY)) {
    throw new ArchiveError('Photo entries require archive schema version 2.');
  }
  return photo ? { project, asset, photo } : { project, asset };
}
