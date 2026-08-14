import { browser } from 'wxt/browser';
import type {
  ArchivedNode,
  BookmarkArchiveRecord,
  BookmarkArchiveStatus,
  BookmarkArchiveStore,
  ImportBookmarkArchiveResult,
} from './model';

export const BOOKMARK_ARCHIVE_STORE_KEY = 'bookmarkArchiveStore';
export const LEGACY_BOOKMARK_ARCHIVE_STATE_KEY = 'bookmarkArchiveState';
const BOOKMARK_ARCHIVE_IMPORT_BACKUP_KEY = 'bookmarkArchiveImportBackup';

interface BookmarkArchiveBackupFile {
  schemaVersion: 1;
  kind: 'bok-bookmark-archive';
  createdAt: string;
  archiveStore: BookmarkArchiveStore;
}

export function emptyBookmarkArchiveStore(): BookmarkArchiveStore {
  return { schemaVersion: 1, revision: 0, archives: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parseArchivedNode(value: unknown): ArchivedNode | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;
  if (node.kind === 'bookmark') {
    return typeof node.title === 'string' && typeof node.url === 'string'
      ? { kind: 'bookmark', title: node.title, url: node.url }
      : null;
  }
  if (node.kind !== 'folder' || typeof node.title !== 'string' || !Array.isArray(node.children)) {
    return null;
  }
  const children: ArchivedNode[] = [];
  for (const child of node.children) {
    const parsed = parseArchivedNode(child);
    if (!parsed) return null;
    children.push(parsed);
  }
  return { kind: 'folder', title: node.title, children };
}

function parseArchiveRecord(value: unknown): BookmarkArchiveRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const source = record.source as Record<string, unknown> | undefined;
  const counts = record.counts as Record<string, unknown> | undefined;
  const root = parseArchivedNode(record.root);
  const validStatus =
    record.status === 'pending-removal' ||
    record.status === 'archived' ||
    record.status === 'pending-restore' ||
    record.status === 'restore-conflict';
  if (
    typeof record.id !== 'string' ||
    typeof record.archivedAt !== 'number' ||
    !Number.isFinite(record.archivedAt) ||
    !validStatus ||
    !source ||
    typeof source.folderId !== 'string' ||
    typeof source.parentId !== 'string' ||
    !isStringArray(source.parentPath) ||
    !(source.index === null ||
      (typeof source.index === 'number' && Number.isInteger(source.index) && source.index >= 0)) ||
    !root ||
    root.kind !== 'folder' ||
    typeof record.fingerprint !== 'string' ||
    !counts ||
    typeof counts.folders !== 'number' ||
    typeof counts.bookmarks !== 'number'
  ) {
    return null;
  }

  const restore = record.restore as Record<string, unknown> | undefined;
  return {
    id: record.id,
    archivedAt: record.archivedAt,
    status: record.status as BookmarkArchiveStatus,
    source: {
      folderId: source.folderId,
      parentId: source.parentId,
      parentPath: source.parentPath as string[],
      index: source.index as number | null,
    },
    root,
    fingerprint: record.fingerprint,
    counts: {
      folders: counts.folders,
      bookmarks: counts.bookmarks,
    },
    ...(restore && typeof restore.targetParentId === 'string'
      ? {
          restore: {
            targetParentId: restore.targetParentId,
            ...(typeof restore.createdRootId === 'string'
              ? { createdRootId: restore.createdRootId }
              : {}),
          },
        }
      : {}),
  };
}

export function parseBookmarkArchiveStore(value: unknown): BookmarkArchiveStore {
  if (!value || typeof value !== 'object') return emptyBookmarkArchiveStore();
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.revision !== 'number' ||
    !Number.isInteger(candidate.revision) ||
    candidate.revision < 0 ||
    !Array.isArray(candidate.archives)
  ) {
    return emptyBookmarkArchiveStore();
  }
  const archives = candidate.archives
    .map(parseArchiveRecord)
    .filter((record): record is BookmarkArchiveRecord => record !== null);
  return { schemaVersion: 1, revision: candidate.revision, archives };
}

export async function readBookmarkArchiveStore(): Promise<BookmarkArchiveStore> {
  const stored = await browser.storage.local.get(BOOKMARK_ARCHIVE_STORE_KEY);
  return parseBookmarkArchiveStore(stored[BOOKMARK_ARCHIVE_STORE_KEY]);
}

export async function writeBookmarkArchiveStore(
  store: BookmarkArchiveStore,
): Promise<void> {
  await browser.storage.local.set({ [BOOKMARK_ARCHIVE_STORE_KEY]: store });
}

export function nextBookmarkArchiveStore(
  store: BookmarkArchiveStore,
  archives: BookmarkArchiveRecord[],
): BookmarkArchiveStore {
  return { schemaVersion: 1, revision: store.revision + 1, archives };
}

export function exportBookmarkArchiveJson(
  store: BookmarkArchiveStore,
  createdAt = Date.now(),
): string {
  const backup: BookmarkArchiveBackupFile = {
    schemaVersion: 1,
    kind: 'bok-bookmark-archive',
    createdAt: new Date(createdAt).toISOString(),
    archiveStore: store,
  };
  return `${JSON.stringify(backup, null, 2)}\n`;
}

function parseBookmarkArchiveBackup(value: unknown): BookmarkArchiveStore {
  if (!value || typeof value !== 'object') {
    throw new Error('导入文件不是 Bok 书签归档备份');
  }
  const backup = value as Record<string, unknown>;
  if (
    backup.schemaVersion !== 1 ||
    backup.kind !== 'bok-bookmark-archive' ||
    typeof backup.createdAt !== 'string' ||
    !backup.archiveStore ||
    typeof backup.archiveStore !== 'object'
  ) {
    throw new Error('导入文件不是 Bok 书签归档备份');
  }
  const rawStore = backup.archiveStore as Record<string, unknown>;
  if (
    rawStore.schemaVersion !== 1 ||
    typeof rawStore.revision !== 'number' ||
    !Number.isInteger(rawStore.revision) ||
    rawStore.revision < 0 ||
    !Array.isArray(rawStore.archives)
  ) {
    throw new Error('书签归档备份格式无效');
  }
  const archives = rawStore.archives.map((record) => {
    const parsed = parseArchiveRecord(record);
    if (!parsed) throw new Error('书签归档备份包含无效记录');
    return parsed;
  });
  if (archives.length === 0) throw new Error('书签归档备份中没有归档记录');
  return { schemaVersion: 1, revision: rawStore.revision, archives };
}

export async function importBookmarkArchiveJson(
  json: string,
): Promise<ImportBookmarkArchiveResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('导入文件不是合法 JSON');
  }
  const importedStore = parseBookmarkArchiveBackup(raw);
  const currentStore = await readBookmarkArchiveStore();
  const importedArchives = importedStore.archives.map(
    (record): BookmarkArchiveRecord => ({
      id: crypto.randomUUID(),
      archivedAt: record.archivedAt,
      status: 'archived',
      source: record.source,
      root: record.root,
      fingerprint: record.fingerprint,
      counts: record.counts,
    }),
  );
  const nextStore = nextBookmarkArchiveStore(currentStore, [
    ...importedArchives,
    ...currentStore.archives,
  ]);
  await browser.storage.local.set({
    [BOOKMARK_ARCHIVE_IMPORT_BACKUP_KEY]: {
      capturedAt: Date.now(),
      value: currentStore,
    },
    [BOOKMARK_ARCHIVE_STORE_KEY]: nextStore,
  });
  return {
    kind: 'bookmark-archive',
    importedArchives: importedArchives.length,
    importedBookmarks: importedArchives.reduce(
      (count, record) => count + record.counts.bookmarks,
      0,
    ),
  };
}
