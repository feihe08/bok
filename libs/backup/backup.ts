import { browser } from 'wxt/browser';
import JSZip from 'jszip';
import { exportSessionsJson } from '../saved-pages/persistence';
import { readBookmarksBar } from '../bookmarks/api';
import {
  exportBookmarkArchiveJson,
  readBookmarkArchiveStore,
} from '../bookmarks/archive-storage';
import type { BookmarkArchiveStore, BookmarkNode } from '../bookmarks/model';
import type {
  BookmarkBackupCommand,
  BookmarkBackupResult,
  BookmarkBackupState,
} from './model';

export const BOOKMARK_BACKUP_STATE_KEY = 'bookmarkBackupState';

const BACKUP_DATABASE_NAME = 'bok-bookmark-backup';
const BACKUP_DATABASE_VERSION = 1;
const BACKUP_HANDLE_STORE = 'handles';
const BACKUP_DIRECTORY_KEY = 'directory';
const BOOKMARKS_BACKUP_FILE_NAME = 'bok-bookmarks.json';
const SAVED_PAGES_BACKUP_FILE_NAME = 'bok-saved-pages.json';
export const BOOKMARK_ARCHIVE_BACKUP_FILE_NAME = 'bok-bookmark-archive.json';
const WEEKLY_BACKUP_PREFIX = 'bok-weekly-backup-';
const WEEKLY_BACKUP_LIMIT = 10;
const WEEKLY_BACKUP_PATTERN = /^bok-weekly-backup-\d{4}-\d{2}-\d{2}\.zip$/;

type BackupPermissionState = 'granted' | 'denied' | 'prompt';
type BackupDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(options: { mode: 'readwrite' }): Promise<BackupPermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<BackupPermissionState>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  removeEntry(name: string): Promise<void>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: FileSystemDirectoryHandle;
  }) => Promise<FileSystemDirectoryHandle>;
};

interface BookmarkBackupNode {
  title: string;
  url?: string;
  dateAdded?: number;
  dateGroupModified?: number;
  dateLastUsed?: number;
  children?: BookmarkBackupNode[];
}

interface BookmarkBackupFile {
  schemaVersion: 1;
  kind: 'bok-bookmarks-backup';
  createdAt: string;
  source: 'bookmarks-bar';
  counts: {
    folders: number;
    bookmarks: number;
  };
  bookmarksBar: BookmarkBackupNode;
}

const EMPTY_BACKUP_STATE: BookmarkBackupState = {
  schemaVersion: 1,
  directoryName: null,
  lastSuccessfulBackupAt: null,
  lastSuccessfulBackupDay: null,
  lastBackupFileName: null,
  lastSavedPagesBackupFileName: null,
  lastArchiveBackupFileName: null,
  lastWeeklyBackupAt: null,
  lastSuccessfulWeeklyBackupWeek: null,
  lastWeeklyBackupFileName: null,
  lastAttemptAt: null,
  lastError: null,
};

let backupInFlight: Promise<BookmarkBackupResult> | null = null;
let cachedDirectoryHandle: BackupDirectoryHandle | null | undefined;
let archiveBackupWriteQueue = Promise.resolve();

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function normalizeBackupState(value: unknown): BookmarkBackupState {
  if (typeof value !== 'object' || value === null) return EMPTY_BACKUP_STATE;
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    !isNullableString(state.directoryName) ||
    !isNullableNumber(state.lastSuccessfulBackupAt) ||
    !isNullableString(state.lastSuccessfulBackupDay) ||
    !isNullableString(state.lastBackupFileName) ||
    !(state.lastSavedPagesBackupFileName === undefined ||
      isNullableString(state.lastSavedPagesBackupFileName)) ||
    !(state.lastArchiveBackupFileName === undefined ||
      isNullableString(state.lastArchiveBackupFileName)) ||
    !(state.lastWeeklyBackupAt === undefined ||
      isNullableNumber(state.lastWeeklyBackupAt)) ||
    !(state.lastSuccessfulWeeklyBackupWeek === undefined ||
      isNullableString(state.lastSuccessfulWeeklyBackupWeek)) ||
    !(state.lastWeeklyBackupFileName === undefined ||
      isNullableString(state.lastWeeklyBackupFileName)) ||
    !isNullableNumber(state.lastAttemptAt) ||
    !isNullableString(state.lastError)
  ) {
    return EMPTY_BACKUP_STATE;
  }
  return {
    schemaVersion: 1,
    directoryName: state.directoryName as string | null,
    lastSuccessfulBackupAt: state.lastSuccessfulBackupAt as number | null,
    lastSuccessfulBackupDay: state.lastSuccessfulBackupDay as string | null,
    lastBackupFileName: state.lastBackupFileName as string | null,
    lastSavedPagesBackupFileName:
      (state.lastSavedPagesBackupFileName as string | null | undefined) ?? null,
    lastArchiveBackupFileName:
      (state.lastArchiveBackupFileName as string | null | undefined) ?? null,
    lastWeeklyBackupAt:
      (state.lastWeeklyBackupAt as number | null | undefined) ?? null,
    lastSuccessfulWeeklyBackupWeek:
      (state.lastSuccessfulWeeklyBackupWeek as string | null | undefined) ?? null,
    lastWeeklyBackupFileName:
      (state.lastWeeklyBackupFileName as string | null | undefined) ?? null,
    lastAttemptAt: state.lastAttemptAt as number | null,
    lastError: state.lastError as string | null,
  };
}

function openBackupDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKUP_DATABASE_NAME, BACKUP_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BACKUP_HANDLE_STORE)) {
        database.createObjectStore(BACKUP_HANDLE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('无法打开备份设置'));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('无法保存备份设置'));
    transaction.onabort = () => reject(transaction.error ?? new Error('备份设置写入已取消'));
  });
}

async function getBackupDirectoryHandle(): Promise<BackupDirectoryHandle | null> {
  const database = await openBackupDatabase();
  try {
    const transaction = database.transaction(BACKUP_HANDLE_STORE, 'readonly');
    const request = transaction.objectStore(BACKUP_HANDLE_STORE).get(BACKUP_DIRECTORY_KEY);
    const handle = await new Promise<unknown>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('无法读取备份文件夹'));
    });
    await waitForTransaction(transaction);
    return handle && typeof handle === 'object'
      ? (handle as BackupDirectoryHandle)
      : null;
  } finally {
    database.close();
  }
}

async function getCachedBackupDirectoryHandle(): Promise<BackupDirectoryHandle | null> {
  if (cachedDirectoryHandle !== undefined) return cachedDirectoryHandle;
  cachedDirectoryHandle = await getBackupDirectoryHandle();
  return cachedDirectoryHandle;
}

async function storeBackupDirectoryHandle(handle: BackupDirectoryHandle): Promise<void> {
  const database = await openBackupDatabase();
  try {
    const transaction = database.transaction(BACKUP_HANDLE_STORE, 'readwrite');
    transaction.objectStore(BACKUP_HANDLE_STORE).put(handle, BACKUP_DIRECTORY_KEY);
    await waitForTransaction(transaction);
    cachedDirectoryHandle = handle;
  } finally {
    database.close();
  }
}

async function writeBackupState(state: BookmarkBackupState): Promise<void> {
  await browser.storage.local.set({ [BOOKMARK_BACKUP_STATE_KEY]: state });
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localWeekKey(timestamp: number): string {
  const date = new Date(timestamp);
  date.setHours(12, 0, 0, 0);
  const daysSinceMonday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - daysSinceMonday);
  return localDayKey(date.getTime());
}

function toBackupNode(node: BookmarkNode): BookmarkBackupNode {
  return {
    title: node.title,
    ...(node.url == null ? {} : { url: node.url }),
    ...(node.dateAdded == null ? {} : { dateAdded: node.dateAdded }),
    ...(node.dateGroupModified == null
      ? {}
      : { dateGroupModified: node.dateGroupModified }),
    ...(node.dateLastUsed == null ? {} : { dateLastUsed: node.dateLastUsed }),
    ...(node.children == null
      ? {}
      : { children: node.children.map(toBackupNode) }),
  };
}

function countBackupNodes(node: BookmarkNode): { folders: number; bookmarks: number } {
  let folders = 0;
  let bookmarks = 0;
  for (const child of node.children ?? []) {
    if (child.url == null) {
      folders += 1;
      const nested = countBackupNodes(child);
      folders += nested.folders;
      bookmarks += nested.bookmarks;
    } else {
      bookmarks += 1;
    }
  }
  return { folders, bookmarks };
}

function backupErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return '备份文件夹需要重新授权，请打开设置并允许访问';
    }
    if (error.name === 'NotFoundError') {
      return '备份文件夹已不可用，请在设置中重新选择';
    }
    if (error.name === 'QuotaExceededError') {
      return '备份文件夹空间不足';
    }
  }
  return error instanceof Error ? error.message : '备份失败，请稍后重试';
}

async function failBackup(
  state: BookmarkBackupState,
  attemptedAt: number,
  error: unknown,
): Promise<BookmarkBackupResult> {
  const failedState: BookmarkBackupState = {
    ...state,
    lastAttemptAt: attemptedAt,
    lastError: backupErrorMessage(error),
  };
  await writeBackupState(failedState);
  return { status: 'failed', state: failedState };
}

async function writeVerifiedBackupFile(
  directory: BackupDirectoryHandle,
  fileName: string,
  contents: string,
): Promise<void> {
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(contents);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }

  const writtenFile = await fileHandle.getFile();
  if ((await writtenFile.text()) !== contents) {
    throw new Error(`备份文件 ${fileName} 写入后校验失败`);
  }
}

async function writeVerifiedBinaryBackupFile(
  directory: BackupDirectoryHandle,
  fileName: string,
  contents: Uint8Array,
): Promise<void> {
  const bytes = new Uint8Array(contents.length);
  bytes.set(contents);
  const fileHandle = await directory.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(bytes.buffer);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }

  const written = new Uint8Array(await (await fileHandle.getFile()).arrayBuffer());
  if (
    written.length !== bytes.length ||
    written.some((byte, index) => byte !== bytes[index])
  ) {
    throw new Error(`备份文件 ${fileName} 写入后校验失败`);
  }
}

async function createWeeklyBackupZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [fileName, contents] of Object.entries(files)) {
    zip.file(fileName, contents);
  }
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

async function pruneWeeklyBackups(directory: BackupDirectoryHandle): Promise<void> {
  const backupNames: string[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === 'file' && WEEKLY_BACKUP_PATTERN.test(name)) {
      backupNames.push(name);
    }
  }
  backupNames.sort().reverse();
  for (const name of backupNames.slice(WEEKLY_BACKUP_LIMIT)) {
    await directory.removeEntry(name);
  }
}

async function requireWritableBackupDirectory(): Promise<BackupDirectoryHandle> {
  const directory = await getBackupDirectoryHandle();
  if (!directory) throw new Error('请先在设置中选择备份文件夹');
  if ((await directory.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    throw new DOMException('Folder permission is required', 'NotAllowedError');
  }
  return directory;
}

export async function writeBookmarkArchiveBackup(
  store: BookmarkArchiveStore,
): Promise<void> {
  const directory = await requireWritableBackupDirectory();
  return writeArchiveBackupContents(directory, exportBookmarkArchiveJson(store));
}

function writeArchiveBackupContents(
  directory: BackupDirectoryHandle,
  contents: string,
): Promise<void> {
  const task = archiveBackupWriteQueue.then(() =>
    writeVerifiedBackupFile(
      directory,
      BOOKMARK_ARCHIVE_BACKUP_FILE_NAME,
      contents,
    ),
  );
  archiveBackupWriteQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function performBookmarkBackup(force: boolean): Promise<BookmarkBackupResult> {
  const attemptedAt = Date.now();
  const today = localDayKey(attemptedAt);
  const currentWeek = localWeekKey(attemptedAt);
  const state = await getBookmarkBackupState();
  if (
    !force &&
    state.lastSuccessfulBackupDay === today &&
    state.lastBackupFileName === BOOKMARKS_BACKUP_FILE_NAME &&
    state.lastSavedPagesBackupFileName === SAVED_PAGES_BACKUP_FILE_NAME &&
    state.lastArchiveBackupFileName === BOOKMARK_ARCHIVE_BACKUP_FILE_NAME &&
    state.lastSuccessfulWeeklyBackupWeek === currentWeek
  ) {
    return { status: 'already-backed-up', state };
  }

  try {
    const directory = await requireWritableBackupDirectory();

    const savedPagesContents = await exportSessionsJson();

    if (!(await browser.permissions.contains({ permissions: ['bookmarks'] }))) {
      throw new Error('需要先允许 Bok 读取 Chrome 书签');
    }

    const bookmarksBar = await readBookmarksBar();
    const backup: BookmarkBackupFile = {
      schemaVersion: 1,
      kind: 'bok-bookmarks-backup',
      createdAt: new Date(attemptedAt).toISOString(),
      source: 'bookmarks-bar',
      counts: countBackupNodes(bookmarksBar),
      bookmarksBar: toBackupNode(bookmarksBar),
    };
    const bookmarksContents = `${JSON.stringify(backup, null, 2)}\n`;
    const archiveStore = await readBookmarkArchiveStore();
    const archiveContents = exportBookmarkArchiveJson(archiveStore, attemptedAt);

    await writeVerifiedBackupFile(
      directory,
      SAVED_PAGES_BACKUP_FILE_NAME,
      savedPagesContents,
    );
    await writeVerifiedBackupFile(
      directory,
      BOOKMARKS_BACKUP_FILE_NAME,
      bookmarksContents,
    );
    await writeArchiveBackupContents(directory, archiveContents);

    const weeklyBackupDue = state.lastSuccessfulWeeklyBackupWeek !== currentWeek;
    const weeklyBackupFileName = weeklyBackupDue
      ? `${WEEKLY_BACKUP_PREFIX}${today}.zip`
      : state.lastWeeklyBackupFileName;
    if (weeklyBackupDue) {
      const weeklyZip = await createWeeklyBackupZip({
        [BOOKMARKS_BACKUP_FILE_NAME]: bookmarksContents,
        [SAVED_PAGES_BACKUP_FILE_NAME]: savedPagesContents,
        [BOOKMARK_ARCHIVE_BACKUP_FILE_NAME]: archiveContents,
      });
      await writeVerifiedBinaryBackupFile(directory, weeklyBackupFileName!, weeklyZip);
      await pruneWeeklyBackups(directory);
    }

    const successfulState: BookmarkBackupState = {
      schemaVersion: 1,
      directoryName: directory.name,
      lastSuccessfulBackupAt: attemptedAt,
      lastSuccessfulBackupDay: today,
      lastBackupFileName: BOOKMARKS_BACKUP_FILE_NAME,
      lastSavedPagesBackupFileName: SAVED_PAGES_BACKUP_FILE_NAME,
      lastArchiveBackupFileName: BOOKMARK_ARCHIVE_BACKUP_FILE_NAME,
      lastWeeklyBackupAt: weeklyBackupDue
        ? attemptedAt
        : state.lastWeeklyBackupAt,
      lastSuccessfulWeeklyBackupWeek: weeklyBackupDue
        ? currentWeek
        : state.lastSuccessfulWeeklyBackupWeek,
      lastWeeklyBackupFileName: weeklyBackupFileName,
      lastAttemptAt: attemptedAt,
      lastError: null,
    };
    await writeBackupState(successfulState);
    return { status: 'success', state: successfulState };
  } catch (error) {
    return failBackup(state, attemptedAt, error);
  }
}

export function isBookmarkBackupCommand(value: unknown): value is BookmarkBackupCommand {
  if (typeof value !== 'object' || value === null) return false;
  const command = value as Record<string, unknown>;
  return (
    command.type === 'bok/bookmark-backup' &&
    (command.force === undefined || typeof command.force === 'boolean')
  );
}

export async function getBookmarkBackupState(): Promise<BookmarkBackupState> {
  const stored = await browser.storage.local.get(BOOKMARK_BACKUP_STATE_KEY);
  return normalizeBackupState(stored[BOOKMARK_BACKUP_STATE_KEY]);
}

export async function getBookmarkBackupDirectoryPermission(): Promise<
  BackupPermissionState | 'missing'
> {
  const directory = await getCachedBackupDirectoryHandle();
  if (!directory) return 'missing';
  return directory.queryPermission({ mode: 'readwrite' });
}

export async function requestBookmarkBackupDirectoryPermission(): Promise<
  BackupPermissionState | 'missing'
> {
  const directory = await getCachedBackupDirectoryHandle();
  if (!directory) return 'missing';
  return directory.requestPermission({ mode: 'readwrite' });
}

export async function chooseBookmarkBackupDirectory(): Promise<BookmarkBackupState> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error('当前 Chrome 不支持选择备份文件夹');

  const previousDirectory = await getCachedBackupDirectoryHandle();
  const selected = (await picker.call(window, {
    id: 'bok-bookmark-backup',
    mode: 'readwrite',
    ...(previousDirectory ? { startIn: previousDirectory } : {}),
  })) as BackupDirectoryHandle;
  await storeBackupDirectoryHandle(selected);

  const state = await getBookmarkBackupState();
  const nextState: BookmarkBackupState = {
    ...state,
    directoryName: selected.name,
    lastError: null,
  };
  await writeBackupState(nextState);
  return nextState;
}

export function runBookmarkBackup(force = false): Promise<BookmarkBackupResult> {
  if (backupInFlight) return backupInFlight;
  const task = performBookmarkBackup(force);
  backupInFlight = task;
  void task.then(
    () => {
      if (backupInFlight === task) backupInFlight = null;
    },
    () => {
      if (backupInFlight === task) backupInFlight = null;
    },
  );
  return task;
}
