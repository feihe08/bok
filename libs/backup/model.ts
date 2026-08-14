import type { ImportBookmarkArchiveResult } from '../bookmarks/model';
import type { ImportSessionsResult } from '../saved-pages/persistence';

export interface BookmarkBackupState {
  schemaVersion: 1;
  directoryName: string | null;
  lastSuccessfulBackupAt: number | null;
  lastSuccessfulBackupDay: string | null;
  lastBackupFileName: string | null;
  lastSavedPagesBackupFileName: string | null;
  lastArchiveBackupFileName: string | null;
  lastWeeklyBackupAt: number | null;
  lastSuccessfulWeeklyBackupWeek: string | null;
  lastWeeklyBackupFileName: string | null;
  lastAttemptAt: number | null;
  lastError: string | null;
}

export interface BookmarkBackupResult {
  status: 'success' | 'already-backed-up' | 'failed';
  state: BookmarkBackupState;
}

export type BookmarkBackupCommand = {
  type: 'bok/bookmark-backup';
  force?: boolean;
};

export type BookmarkBackupResponse =
  | { ok: true; result: BookmarkBackupResult }
  | { ok: false; error: string };

export type ImportDataCommand = {
  type: 'bok/import-data';
  json: string;
};

export type ImportDataResult =
  | ImportSessionsResult
  | ImportBookmarkArchiveResult;

export type ImportDataResponse =
  | { ok: true; result: ImportDataResult }
  | { ok: false; error: string };
