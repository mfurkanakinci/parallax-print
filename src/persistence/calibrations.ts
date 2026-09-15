import type { IDBPDatabase } from 'idb';
import type { CalibrationRecord } from '../core/types';
import { openDatabase } from './database';

interface CalibrationRow {
  readonly projectId: string;
  readonly record: CalibrationRecord;
}

function validRecord(value: unknown): value is CalibrationRecord {
  const r = value as CalibrationRecord | null;
  return (
    !!r &&
    typeof r.scopeFingerprint === 'string' &&
    typeof r.settingsFingerprint === 'string' &&
    (r.rulerXMm === null || typeof r.rulerXMm === 'number') &&
    (r.rulerYMm === null || typeof r.rulerYMm === 'number') &&
    (r.declaredProofResult === 'pass' ||
      r.declaredProofResult === 'fail' ||
      r.declaredProofResult === null) &&
    typeof r.recordedAt === 'string'
  );
}

export async function saveCalibration(
  projectId: string,
  record: CalibrationRecord,
  db?: IDBPDatabase,
): Promise<void> {
  const database = db ?? (await openDatabase());
  const row: CalibrationRow = { projectId, record };
  await database.put('calibrations', row, projectId);
}

export async function loadCalibration(
  projectId: string,
  db?: IDBPDatabase,
): Promise<CalibrationRecord | null> {
  const database = db ?? (await openDatabase());
  const row = (await database.get('calibrations', projectId)) as
    | CalibrationRow
    | undefined;
  return row && validRecord(row.record) ? row.record : null;
}
