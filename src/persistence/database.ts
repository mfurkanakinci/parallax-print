import { openDB, type IDBPDatabase } from 'idb';
import type { ProjectV1 } from '../core/types';
import type { StoredAsset, StoredPhoto } from './types';

export interface StoredProjectRecord {
  readonly project: ProjectV1;
  readonly revision: number;
}

export type StoredPhotoRecord = StoredPhoto;

export const DB_NAME = 'parallax-press';
export const DB_VERSION = 2;

let cachedDatabase: Promise<IDBPDatabase> | null = null;

export function openDatabase(): Promise<IDBPDatabase> {
  if (!cachedDatabase) {
    cachedDatabase = new Promise((resolve, reject) => {
      let abandoned = false;
      const opening = openDB(DB_NAME, DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('projects')) {
            db.createObjectStore('projects');
          }
          if (!db.objectStoreNames.contains('assets')) {
            db.createObjectStore('assets');
          }
          if (!db.objectStoreNames.contains('calibrations')) {
            db.createObjectStore('calibrations');
          }
          if (!db.objectStoreNames.contains('photos')) {
            db.createObjectStore('photos');
          }
        },
        blocked() {
          abandoned = true;
          reject(new Error('Close older Parallax Print tabs, then reload to upgrade local storage. Your saved projects have not been removed.'));
        },
        blocking() {
          // Let a newer app version upgrade instead of holding its open
          // request indefinitely. Existing documents remain in editor memory.
          void opening.then((database) => database.close());
          cachedDatabase = null;
        },
        terminated() {
          cachedDatabase = null;
        },
      });
      void opening.then((database) => {
        if (abandoned) database.close();
        else resolve(database);
      }, reject);
    });
    cachedDatabase.catch(() => {
      cachedDatabase = null;
    });
  }
  return cachedDatabase;
}

export async function readAssetRecord(
  db: IDBPDatabase,
  assetId: string,
): Promise<StoredAsset | null> {
  const record = (await db.get('assets', assetId)) as StoredAsset | undefined;
  return record ?? null;
}
