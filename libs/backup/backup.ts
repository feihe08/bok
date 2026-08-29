import { browser } from 'wxt/browser';
import JSZip from 'jszip';
import { exportReadingListJson } from '../reading-list/persistence';
import { exportSessionsJson } from '../saved-pages/persistence';
import {
  getSavedPagesAutoArchivePeriod,
  getThemePreference,
} from '../saved-pages/settings';
import { getBookmarkOrganizationAiSettings } from '../bookmarks/organization-ai-settings';
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
export const BACKUP_DEVICE_NAME_KEY = 'backupDeviceName';
export const BACKUP_DEVICE_CLAIM_ID_KEY = 'backupDeviceClaimId';

const DEFAULT_BACKUP_DEVICE_NAME = 'personal';
const BACKUP_DEVICE_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
const BACKUP_DATABASE_NAME = 'bok-bookmark-backup';
const BACKUP_DATABASE_VERSION = 1;
const BACKUP_HANDLE_STORE = 'handles';
const BACKUP_DIRECTORY_KEY = 'directory';
const DEVICES_DIRECTORY_NAME = 'devices';
const SHARED_DIRECTORY_NAME = 'shared';
const HISTORY_DIRECTORY_NAME = 'history';
const DEVICE_CLAIM_FILE_NAME = 'device.json';
const BOOKMARKS_BACKUP_FILE_NAME = 'bok-bookmarks.json';
const SAVED_PAGES_BACKUP_FILE_NAME = 'bok-saved-pages.json';
const READING_LIST_BACKUP_FILE_NAME = 'bok-reading-list.json';
const SETTINGS_BACKUP_FILE_NAME = 'bok-settings.json';
export const BOOKMARK_ARCHIVE_BACKUP_FILE_NAME = 'bok-bookmark-archive.json';
const DEVICE_WEEKLY_BACKUP_PREFIX = 'bok-device-weekly-backup-';
const SHARED_WEEKLY_BACKUP_PREFIX = 'bok-shared-weekly-backup-';
const WEEKLY_BACKUP_LIMIT = 10;

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

interface BackupDeviceIdentity {
  deviceName: string;
  claimId: string;
}

interface BackupDeviceClaimFile {
  schemaVersion: 1;
  kind: 'bok-backup-device-claim';
  deviceName: string;
  claimId: string;
  claimedAt: string;
}

interface ClaimedBackupDirectories extends BackupDeviceIdentity {
  root: BackupDirectoryHandle;
  device: BackupDirectoryHandle;
  shared: BackupDirectoryHandle;
  generation: string;
}

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

interface SettingsBackupFile {
  schemaVersion: 2;
  kind: 'bok-settings-backup';
  createdAt: string;
  settings: {
    savedPagesAutoArchivePeriod: Awaited<
      ReturnType<typeof getSavedPagesAutoArchivePeriod>
    >;
    theme: Awaited<ReturnType<typeof getThemePreference>>;
    bookmarkOrganizationAi: Awaited<
      ReturnType<typeof getBookmarkOrganizationAiSettings>
    >;
  };
}

export class BackupDeviceNameConflictError extends Error {
  readonly code = 'backup-device-name-conflict';

  constructor(deviceName: string) {
    super(`机器名称“${deviceName}”已被其他电脑使用，请换一个名称或明确接管`);
    this.name = 'BackupDeviceNameConflictError';
  }
}

const EMPTY_BACKUP_STATE: BookmarkBackupState = {
  schemaVersion: 1,
  directoryName: null,
  deviceName: DEFAULT_BACKUP_DEVICE_NAME,
  lastSuccessfulBackupAt: null,
  lastSuccessfulBackupDay: null,
  lastBackupFileName: null,
  lastSavedPagesBackupFileName: null,
  lastReadingListBackupFileName: null,
  lastSettingsBackupFileName: null,
  lastArchiveBackupFileName: null,
  lastWeeklyBackupAt: null,
  lastSuccessfulWeeklyBackupWeek: null,
  lastWeeklyBackupFileName: null,
  lastSharedWeeklyBackupAt: null,
  lastSuccessfulSharedWeeklyBackupWeek: null,
  lastSharedWeeklyBackupFileName: null,
  lastAttemptAt: null,
  lastError: null,
};

let backupInFlight: Promise<BookmarkBackupResult> | null = null;
let forcedBackupQueued: Promise<BookmarkBackupResult> | null = null;
let cachedDirectoryHandle: BackupDirectoryHandle | null | undefined;
let archiveBackupWriteQueue = Promise.resolve();

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function normalizeBackupDeviceName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_BACKUP_DEVICE_NAME;
  const normalized = value.trim().toLowerCase();
  return BACKUP_DEVICE_NAME_PATTERN.test(normalized)
    ? normalized
    : DEFAULT_BACKUP_DEVICE_NAME;
}

function validateBackupDeviceName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!BACKUP_DEVICE_NAME_PATTERN.test(normalized)) {
    throw new Error('机器名称只能包含小写字母、数字、- 和 _，长度为 1–32 个字符');
  }
  return normalized;
}

function normalizeBackupState(
  value: unknown,
  currentDeviceName = DEFAULT_BACKUP_DEVICE_NAME,
): BookmarkBackupState {
  if (typeof value !== 'object' || value === null) {
    return { ...EMPTY_BACKUP_STATE, deviceName: currentDeviceName };
  }
  const state = value as Record<string, unknown>;
  if (
    state.schemaVersion !== 1 ||
    !isNullableString(state.directoryName) ||
    !isNullableNumber(state.lastSuccessfulBackupAt) ||
    !isNullableString(state.lastSuccessfulBackupDay) ||
    !isNullableString(state.lastBackupFileName) ||
    !(state.lastSavedPagesBackupFileName === undefined ||
      isNullableString(state.lastSavedPagesBackupFileName)) ||
    !(state.lastReadingListBackupFileName === undefined ||
      isNullableString(state.lastReadingListBackupFileName)) ||
    !(state.lastSettingsBackupFileName === undefined ||
      isNullableString(state.lastSettingsBackupFileName)) ||
    !(state.lastArchiveBackupFileName === undefined ||
      isNullableString(state.lastArchiveBackupFileName)) ||
    !(state.lastWeeklyBackupAt === undefined ||
      isNullableNumber(state.lastWeeklyBackupAt)) ||
    !(state.lastSuccessfulWeeklyBackupWeek === undefined ||
      isNullableString(state.lastSuccessfulWeeklyBackupWeek)) ||
    !(state.lastWeeklyBackupFileName === undefined ||
      isNullableString(state.lastWeeklyBackupFileName)) ||
    !(state.lastSharedWeeklyBackupAt === undefined ||
      isNullableNumber(state.lastSharedWeeklyBackupAt)) ||
    !(state.lastSuccessfulSharedWeeklyBackupWeek === undefined ||
      isNullableString(state.lastSuccessfulSharedWeeklyBackupWeek)) ||
    !(state.lastSharedWeeklyBackupFileName === undefined ||
      isNullableString(state.lastSharedWeeklyBackupFileName)) ||
    !isNullableNumber(state.lastAttemptAt) ||
    !isNullableString(state.lastError)
  ) {
    return { ...EMPTY_BACKUP_STATE, deviceName: currentDeviceName };
  }
  return {
    schemaVersion: 1,
    directoryName: state.directoryName as string | null,
    deviceName:
      typeof state.deviceName === 'string'
        ? normalizeBackupDeviceName(state.deviceName)
        : currentDeviceName,
    lastSuccessfulBackupAt: state.lastSuccessfulBackupAt as number | null,
    lastSuccessfulBackupDay: state.lastSuccessfulBackupDay as string | null,
    lastBackupFileName: state.lastBackupFileName as string | null,
    lastSavedPagesBackupFileName:
      (state.lastSavedPagesBackupFileName as string | null | undefined) ?? null,
    lastReadingListBackupFileName:
      (state.lastReadingListBackupFileName as string | null | undefined) ?? null,
    lastSettingsBackupFileName:
      (state.lastSettingsBackupFileName as string | null | undefined) ?? null,
    lastArchiveBackupFileName:
      (state.lastArchiveBackupFileName as string | null | undefined) ?? null,
    lastWeeklyBackupAt:
      (state.lastWeeklyBackupAt as number | null | undefined) ?? null,
    lastSuccessfulWeeklyBackupWeek:
      (state.lastSuccessfulWeeklyBackupWeek as string | null | undefined) ?? null,
    lastWeeklyBackupFileName:
      (state.lastWeeklyBackupFileName as string | null | undefined) ?? null,
    lastSharedWeeklyBackupAt:
      (state.lastSharedWeeklyBackupAt as number | null | undefined) ?? null,
    lastSuccessfulSharedWeeklyBackupWeek:
      (state.lastSuccessfulSharedWeeklyBackupWeek as string | null | undefined) ??
      null,
    lastSharedWeeklyBackupFileName:
      (state.lastSharedWeeklyBackupFileName as string | null | undefined) ?? null,
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

async function readStoredDeviceIdentity(): Promise<{
  deviceName: string;
  claimId: string | null;
}> {
  const stored = await browser.storage.local.get([
    BACKUP_DEVICE_NAME_KEY,
    BACKUP_DEVICE_CLAIM_ID_KEY,
  ]);
  const claimId = stored[BACKUP_DEVICE_CLAIM_ID_KEY];
  return {
    deviceName: normalizeBackupDeviceName(stored[BACKUP_DEVICE_NAME_KEY]),
    claimId: typeof claimId === 'string' && claimId ? claimId : null,
  };
}

async function ensureStoredDeviceIdentity(): Promise<BackupDeviceIdentity> {
  const stored = await readStoredDeviceIdentity();
  if (stored.claimId) return stored as BackupDeviceIdentity;
  const identity = {
    deviceName: stored.deviceName,
    claimId: crypto.randomUUID(),
  };
  await browser.storage.local.set({
    [BACKUP_DEVICE_NAME_KEY]: identity.deviceName,
    [BACKUP_DEVICE_CLAIM_ID_KEY]: identity.claimId,
  });
  return identity;
}

async function getDirectory(
  parent: BackupDirectoryHandle,
  name: string,
): Promise<BackupDirectoryHandle> {
  return (await parent.getDirectoryHandle(name, {
    create: true,
  })) as BackupDirectoryHandle;
}

async function readDeviceClaim(
  deviceDirectory: BackupDirectoryHandle,
): Promise<BackupDeviceClaimFile | null> {
  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await deviceDirectory.getFileHandle(DEVICE_CLAIM_FILE_NAME);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(await (await fileHandle.getFile()).text());
  } catch {
    return null;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as Record<string, unknown>).schemaVersion !== 1 ||
    (value as Record<string, unknown>).kind !== 'bok-backup-device-claim' ||
    typeof (value as Record<string, unknown>).deviceName !== 'string' ||
    typeof (value as Record<string, unknown>).claimId !== 'string' ||
    typeof (value as Record<string, unknown>).claimedAt !== 'string' ||
    !Number.isFinite(Date.parse((value as Record<string, string>).claimedAt))
  ) {
    return null;
  }
  return value as BackupDeviceClaimFile;
}

async function findDeviceDirectory(
  devices: BackupDirectoryHandle,
  deviceName: string,
): Promise<BackupDirectoryHandle | null> {
  const matches: BackupDirectoryHandle[] = [];
  for await (const [name, handle] of devices.entries()) {
    if (handle.kind === 'directory' && name.toLowerCase() === deviceName) {
      matches.push(handle as BackupDirectoryHandle);
    }
  }
  if (matches.length > 1) {
    throw new Error(
      `devices 中存在多个与“${deviceName}”大小写等价的目录，请先保留一个后重试`,
    );
  }
  return matches[0] ?? null;
}

async function writeDeviceClaim(
  deviceDirectory: BackupDirectoryHandle,
  identity: BackupDeviceIdentity,
  previousClaimedAt?: string,
): Promise<void> {
  const now = Date.now();
  const previousTimestamp = previousClaimedAt
    ? Date.parse(previousClaimedAt)
    : Number.NaN;
  const claim: BackupDeviceClaimFile = {
    schemaVersion: 1,
    kind: 'bok-backup-device-claim',
    deviceName: identity.deviceName,
    claimId: identity.claimId,
    claimedAt: new Date(
      Number.isFinite(previousTimestamp) && previousTimestamp >= now
        ? previousTimestamp + 1
        : now,
    ).toISOString(),
  };
  await writeVerifiedBackupFile(
    deviceDirectory,
    DEVICE_CLAIM_FILE_NAME,
    `${JSON.stringify(claim, null, 2)}\n`,
  );
}

async function claimDeviceDirectory(
  root: BackupDirectoryHandle,
  identity: BackupDeviceIdentity,
  takeOver = false,
): Promise<BackupDirectoryHandle> {
  const devices = await getDirectory(root, DEVICES_DIRECTORY_NAME);
  const device = await findDeviceDirectory(devices, identity.deviceName);
  if (!device) {
    const createdDevice = await getDirectory(devices, identity.deviceName);
    await writeDeviceClaim(createdDevice, identity);
    return createdDevice;
  }

  const existing = await readDeviceClaim(device);
  if (takeOver) {
    await writeDeviceClaim(device, identity, existing?.claimedAt);
    return device;
  }
  if (
    !existing ||
    existing.deviceName !== identity.deviceName ||
    existing.claimId !== identity.claimId
  ) {
    throw new BackupDeviceNameConflictError(identity.deviceName);
  }
  return device;
}

async function requireClaimedBackupDirectories(): Promise<ClaimedBackupDirectories> {
  const root = await requireWritableBackupDirectory();
  const identity = await ensureStoredDeviceIdentity();
  const device = await claimDeviceDirectory(root, identity);
  const claim = await readDeviceClaim(device);
  if (
    !claim ||
    claim.deviceName !== identity.deviceName ||
    claim.claimId !== identity.claimId
  ) {
    throw new BackupDeviceNameConflictError(identity.deviceName);
  }
  const shared = await getDirectory(root, SHARED_DIRECTORY_NAME);
  return {
    root,
    device,
    shared,
    generation: claim.claimedAt.replace(/[^0-9A-Za-z]/g, ''),
    ...identity,
  };
}

async function assertCurrentDeviceClaim(
  root: BackupDirectoryHandle,
  identity: BackupDeviceIdentity,
): Promise<void> {
  const current = await readStoredDeviceIdentity();
  if (
    current.deviceName !== identity.deviceName ||
    current.claimId !== identity.claimId
  ) {
    throw new Error('备份设备名称已在操作期间改变，请重试');
  }
  const devices = await getDirectory(root, DEVICES_DIRECTORY_NAME);
  const device = await findDeviceDirectory(devices, identity.deviceName);
  if (!device) throw new BackupDeviceNameConflictError(identity.deviceName);
  const claim = await readDeviceClaim(device);
  if (
    !claim ||
    claim.deviceName !== identity.deviceName ||
    claim.claimId !== identity.claimId
  ) {
    throw new BackupDeviceNameConflictError(identity.deviceName);
  }
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
  attemptedAt: number,
  error: unknown,
): Promise<BookmarkBackupResult> {
  const latestState = await getBookmarkBackupState();
  const failedState: BookmarkBackupState = {
    ...latestState,
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

async function pruneWeeklyBackups(
  directory: BackupDirectoryHandle,
  pattern: RegExp,
): Promise<void> {
  const backupNames: string[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === 'file' && pattern.test(name)) {
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
  const directories = await requireClaimedBackupDirectories();
  return writeArchiveBackupContents(
    directories.root,
    directories,
    exportBookmarkArchiveJson(store),
  );
}

function writeArchiveBackupContents(
  root: BackupDirectoryHandle,
  identity: BackupDeviceIdentity,
  contents: string,
): Promise<void> {
  const task = archiveBackupWriteQueue.then(async () => {
    await assertCurrentDeviceClaim(root, identity);
    const shared = await getDirectory(root, SHARED_DIRECTORY_NAME);
    await writeVerifiedBackupFile(
      shared,
      BOOKMARK_ARCHIVE_BACKUP_FILE_NAME,
      contents,
    );
  });
  archiveBackupWriteQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function relativeDevicePath(deviceName: string, fileName: string): string {
  return `${DEVICES_DIRECTORY_NAME}/${deviceName}/${fileName}`;
}

function relativeSharedPath(fileName: string): string {
  return `${SHARED_DIRECTORY_NAME}/${fileName}`;
}

function weeklyFileName(
  prefix: string,
  identity: ClaimedBackupDirectories,
  day: string,
): string {
  return `${prefix}${identity.deviceName}-${identity.generation}-${day}.zip`;
}

function weeklyPattern(
  prefix: string,
  identity: ClaimedBackupDirectories,
): RegExp {
  return new RegExp(
    `^${prefix}${identity.deviceName}-${identity.generation}-\\d{4}-\\d{2}-\\d{2}\\.zip$`,
  );
}

async function createSettingsBackupContents(timestamp: number): Promise<string> {
  const [savedPagesAutoArchivePeriod, theme, bookmarkOrganizationAi] = await Promise.all([
    getSavedPagesAutoArchivePeriod(),
    getThemePreference(),
    getBookmarkOrganizationAiSettings(),
  ]);
  const backup: SettingsBackupFile = {
    schemaVersion: 2,
    kind: 'bok-settings-backup',
    createdAt: new Date(timestamp).toISOString(),
    settings: { savedPagesAutoArchivePeriod, theme, bookmarkOrganizationAi },
  };
  return `${JSON.stringify(backup, null, 2)}\n`;
}

async function performBookmarkBackup(force: boolean): Promise<BookmarkBackupResult> {
  const attemptedAt = Date.now();
  const today = localDayKey(attemptedAt);
  const currentWeek = localWeekKey(attemptedAt);
  const state = await getBookmarkBackupState();
  const bookmarksPath = relativeSharedPath(BOOKMARKS_BACKUP_FILE_NAME);
  const readingListPath = relativeSharedPath(READING_LIST_BACKUP_FILE_NAME);
  const archivePath = relativeSharedPath(BOOKMARK_ARCHIVE_BACKUP_FILE_NAME);

  try {
    const directories = await requireClaimedBackupDirectories();
    const savedPagesPath = relativeDevicePath(
      directories.deviceName,
      SAVED_PAGES_BACKUP_FILE_NAME,
    );
    const settingsPath = relativeDevicePath(
      directories.deviceName,
      SETTINGS_BACKUP_FILE_NAME,
    );
    if (
      !force &&
      state.deviceName === directories.deviceName &&
      state.lastSuccessfulBackupDay === today &&
      state.lastBackupFileName === bookmarksPath &&
      state.lastSavedPagesBackupFileName === savedPagesPath &&
      state.lastReadingListBackupFileName === readingListPath &&
      state.lastSettingsBackupFileName === settingsPath &&
      state.lastArchiveBackupFileName === archivePath &&
      state.lastSuccessfulWeeklyBackupWeek === currentWeek &&
      state.lastSuccessfulSharedWeeklyBackupWeek === currentWeek
    ) {
      return { status: 'already-backed-up', state };
    }

    const [savedPagesContents, readingListContents, settingsContents] = await Promise.all([
      exportSessionsJson(),
      exportReadingListJson(),
      createSettingsBackupContents(attemptedAt),
    ]);

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

    await assertCurrentDeviceClaim(directories.root, directories);
    await writeVerifiedBackupFile(
      directories.device,
      SAVED_PAGES_BACKUP_FILE_NAME,
      savedPagesContents,
    );
    await assertCurrentDeviceClaim(directories.root, directories);
    await writeVerifiedBackupFile(
      directories.shared,
      READING_LIST_BACKUP_FILE_NAME,
      readingListContents,
    );
    await assertCurrentDeviceClaim(directories.root, directories);
    await writeVerifiedBackupFile(
      directories.device,
      SETTINGS_BACKUP_FILE_NAME,
      settingsContents,
    );
    await assertCurrentDeviceClaim(directories.root, directories);
    await writeVerifiedBackupFile(
      directories.shared,
      BOOKMARKS_BACKUP_FILE_NAME,
      bookmarksContents,
    );
    await writeArchiveBackupContents(
      directories.root,
      directories,
      archiveContents,
    );

    const deviceHistoryPath = relativeDevicePath(
      directories.deviceName,
      `${HISTORY_DIRECTORY_NAME}/`,
    );
    const sharedHistoryPath = relativeSharedPath(`${HISTORY_DIRECTORY_NAME}/`);
    const readingListBackupPathMatches =
      state.lastReadingListBackupFileName === readingListPath;
    const deviceWeeklyBackupDue =
      state.deviceName !== directories.deviceName ||
      state.lastSuccessfulWeeklyBackupWeek !== currentWeek ||
      !state.lastWeeklyBackupFileName?.startsWith(deviceHistoryPath);
    const sharedWeeklyBackupDue =
      state.deviceName !== directories.deviceName ||
      !readingListBackupPathMatches ||
      state.lastSuccessfulSharedWeeklyBackupWeek !== currentWeek ||
      !state.lastSharedWeeklyBackupFileName?.startsWith(sharedHistoryPath);
    const deviceWeeklyBackupFileName = deviceWeeklyBackupDue
      ? weeklyFileName(
          DEVICE_WEEKLY_BACKUP_PREFIX,
          directories,
          today,
        )
      : state.lastWeeklyBackupFileName!.slice(deviceHistoryPath.length);
    const sharedWeeklyBackupFileName = sharedWeeklyBackupDue
      ? weeklyFileName(
          SHARED_WEEKLY_BACKUP_PREFIX,
          directories,
          today,
        )
      : state.lastSharedWeeklyBackupFileName!.slice(sharedHistoryPath.length);
    if (deviceWeeklyBackupDue) {
      const history = await getDirectory(
        directories.device,
        HISTORY_DIRECTORY_NAME,
      );
      const weeklyZip = await createWeeklyBackupZip({
        [SAVED_PAGES_BACKUP_FILE_NAME]: savedPagesContents,
        [SETTINGS_BACKUP_FILE_NAME]: settingsContents,
      });
      await assertCurrentDeviceClaim(directories.root, directories);
      await writeVerifiedBinaryBackupFile(
        history,
        deviceWeeklyBackupFileName,
        weeklyZip,
      );
      await assertCurrentDeviceClaim(directories.root, directories);
      await pruneWeeklyBackups(
        history,
        weeklyPattern(DEVICE_WEEKLY_BACKUP_PREFIX, directories),
      );
    }
    if (sharedWeeklyBackupDue) {
      const history = await getDirectory(
        directories.shared,
        HISTORY_DIRECTORY_NAME,
      );
      const weeklyZip = await createWeeklyBackupZip({
        [BOOKMARKS_BACKUP_FILE_NAME]: bookmarksContents,
        [READING_LIST_BACKUP_FILE_NAME]: readingListContents,
        [BOOKMARK_ARCHIVE_BACKUP_FILE_NAME]: archiveContents,
      });
      await assertCurrentDeviceClaim(directories.root, directories);
      await writeVerifiedBinaryBackupFile(
        history,
        sharedWeeklyBackupFileName,
        weeklyZip,
      );
      await assertCurrentDeviceClaim(directories.root, directories);
      await pruneWeeklyBackups(
        history,
        weeklyPattern(SHARED_WEEKLY_BACKUP_PREFIX, directories),
      );
    }

    await assertCurrentDeviceClaim(directories.root, directories);
    const successfulState: BookmarkBackupState = {
      schemaVersion: 1,
      directoryName: directories.root.name,
      deviceName: directories.deviceName,
      lastSuccessfulBackupAt: attemptedAt,
      lastSuccessfulBackupDay: today,
      lastBackupFileName: bookmarksPath,
      lastSavedPagesBackupFileName: savedPagesPath,
      lastReadingListBackupFileName: readingListPath,
      lastSettingsBackupFileName: settingsPath,
      lastArchiveBackupFileName: archivePath,
      lastWeeklyBackupAt: deviceWeeklyBackupDue
        ? attemptedAt
        : state.lastWeeklyBackupAt,
      lastSuccessfulWeeklyBackupWeek: deviceWeeklyBackupDue
        ? currentWeek
        : state.lastSuccessfulWeeklyBackupWeek,
      lastWeeklyBackupFileName:
        deviceHistoryPath + deviceWeeklyBackupFileName,
      lastSharedWeeklyBackupAt: sharedWeeklyBackupDue
        ? attemptedAt
        : state.lastSharedWeeklyBackupAt,
      lastSuccessfulSharedWeeklyBackupWeek: sharedWeeklyBackupDue
        ? currentWeek
        : state.lastSuccessfulSharedWeeklyBackupWeek,
      lastSharedWeeklyBackupFileName:
        sharedHistoryPath + sharedWeeklyBackupFileName,
      lastAttemptAt: attemptedAt,
      lastError: null,
    };
    await writeBackupState(successfulState);
    return { status: 'success', state: successfulState };
  } catch (error) {
    return failBackup(attemptedAt, error);
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
  const stored = await browser.storage.local.get([
    BOOKMARK_BACKUP_STATE_KEY,
    BACKUP_DEVICE_NAME_KEY,
  ]);
  return normalizeBackupState(
    stored[BOOKMARK_BACKUP_STATE_KEY],
    normalizeBackupDeviceName(stored[BACKUP_DEVICE_NAME_KEY]),
  );
}

export async function getBackupDeviceName(): Promise<string> {
  return (await readStoredDeviceIdentity()).deviceName;
}

function resetBackupStateForDevice(
  state: BookmarkBackupState,
  deviceName: string,
): BookmarkBackupState {
  return {
    ...EMPTY_BACKUP_STATE,
    directoryName: state.directoryName,
    deviceName,
  };
}

async function storeDeviceIdentity(
  identity: BackupDeviceIdentity,
  state: BookmarkBackupState,
  resetState = true,
): Promise<BookmarkBackupState> {
  await browser.storage.local.set({
    [BACKUP_DEVICE_NAME_KEY]: identity.deviceName,
    [BACKUP_DEVICE_CLAIM_ID_KEY]: identity.claimId,
  });
  const nextState = resetState
    ? resetBackupStateForDevice(state, identity.deviceName)
    : { ...state, deviceName: identity.deviceName, lastError: null };
  await writeBackupState(nextState);
  return nextState;
}

export async function saveBackupDeviceName(
  name: string,
): Promise<BookmarkBackupState> {
  const deviceName = validateBackupDeviceName(name);
  const current = await readStoredDeviceIdentity();
  const state = await getBookmarkBackupState();
  const identity = {
    deviceName,
    claimId:
      deviceName === current.deviceName && current.claimId
        ? current.claimId
        : crypto.randomUUID(),
  };
  const directory = await getBackupDirectoryHandle();
  if (directory) {
    if ((await directory.queryPermission({ mode: 'readwrite' })) === 'granted') {
      await claimDeviceDirectory(directory, identity);
    }
  }
  return storeDeviceIdentity(
    identity,
    state,
    deviceName !== current.deviceName || !current.claimId,
  );
}

export async function takeOverBackupDeviceName(
  name: string,
): Promise<BookmarkBackupState> {
  const deviceName = validateBackupDeviceName(name);
  const directory = await requireWritableBackupDirectory();
  const identity = { deviceName, claimId: crypto.randomUUID() };
  await claimDeviceDirectory(directory, identity, true);
  return storeDeviceIdentity(identity, await getBookmarkBackupState());
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
  if (backupInFlight) {
    if (!force) return backupInFlight;
    if (!forcedBackupQueued) {
      const runForcedBackup = () => {
        forcedBackupQueued = null;
        return runBookmarkBackup(true);
      };
      forcedBackupQueued = backupInFlight.then(runForcedBackup, runForcedBackup);
    }
    return forcedBackupQueued;
  }
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
