import { browser } from 'wxt/browser';
import { readBookmarksBar } from './api';
import {
  LEGACY_BOOKMARK_ARCHIVE_STATE_KEY,
  nextBookmarkArchiveStore,
  readBookmarkArchiveStore,
  writeBookmarkArchiveStore,
} from './archive-storage';
import { writeBookmarkArchiveBackup } from '../backup/backup';
import type {
  ArchivedFolder,
  ArchivedNode,
  BookmarkArchiveRecord,
  BookmarkArchiveStore,
  BookmarkNode,
} from './model';

export const LEGACY_BOOKMARK_ARCHIVE_FOLDER_TITLE = 'Bok 归档';

interface LegacyArchiveEntry {
  originalParentId: string;
  originalIndex?: number;
  archivedAt: number;
}

interface LegacyArchiveState {
  archiveRootId: string;
  entries: Record<string, LegacyArchiveEntry>;
}

export interface LegacyArchiveMigrationInfo {
  archiveRootId: string;
  folderCount: number;
  bookmarkCount: number;
}

export interface BookmarkArchiveOperationResult {
  record: BookmarkArchiveRecord;
  backupWarning?: string;
}

function toArchivedNode(node: BookmarkNode): ArchivedNode {
  if (node.url != null) {
    return { kind: 'bookmark', title: node.title, url: node.url };
  }
  return {
    kind: 'folder',
    title: node.title,
    children: (node.children ?? []).map(toArchivedNode),
  };
}

function countArchivedFolder(root: ArchivedFolder): {
  folders: number;
  bookmarks: number;
} {
  let folders = 0;
  let bookmarks = 0;
  for (const child of root.children) {
    if (child.kind === 'folder') {
      folders += 1;
      const nested = countArchivedFolder(child);
      folders += nested.folders;
      bookmarks += nested.bookmarks;
    } else {
      bookmarks += 1;
    }
  }
  return { folders, bookmarks };
}

export function fingerprintArchivedFolder(root: ArchivedFolder): string {
  const input = JSON.stringify(root);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function findNode(root: BookmarkNode, nodeId: string): BookmarkNode | null {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const match = findNode(child, nodeId);
    if (match) return match;
  }
  return null;
}

function buildFolderPath(root: BookmarkNode, folderId: string): string[] {
  function walk(node: BookmarkNode, path: string[]): string[] | null {
    if (node.id === folderId) return path;
    for (const child of node.children ?? []) {
      if (child.url != null) continue;
      const match = walk(child, [...path, child.title]);
      if (match) return match;
    }
    return null;
  }
  return walk(root, []) ?? [];
}

async function readSubTreeIfPresent(nodeId: string): Promise<BookmarkNode | null> {
  try {
    const [node] = (await browser.bookmarks.getSubTree(nodeId)) as BookmarkNode[];
    return node ?? null;
  } catch {
    return null;
  }
}

async function createArchivedNode(
  node: ArchivedNode,
  parentId: string,
  index?: number,
): Promise<BookmarkNode> {
  const created = (await browser.bookmarks.create({
    parentId,
    ...(index == null ? {} : { index }),
    title: node.title,
    ...(node.kind === 'bookmark' ? { url: node.url } : {}),
  })) as BookmarkNode;
  if (node.kind === 'folder') {
    for (const child of node.children) {
      await createArchivedNode(child, created.id);
    }
  }
  return created;
}

function makeArchiveRecord(
  node: BookmarkNode,
  bookmarksBar: BookmarkNode,
  originalParentId = node.parentId ?? bookmarksBar.id,
  originalIndex = node.index ?? null,
  archivedAt = Date.now(),
): BookmarkArchiveRecord {
  const root = toArchivedNode(node);
  if (root.kind !== 'folder') throw new Error('只能归档书签文件夹');
  return {
    id: crypto.randomUUID(),
    archivedAt,
    status: 'pending-removal',
    source: {
      folderId: node.id,
      parentId: originalParentId,
      parentPath: buildFolderPath(bookmarksBar, originalParentId),
      index: originalIndex,
    },
    root,
    fingerprint: fingerprintArchivedFolder(root),
    counts: countArchivedFolder(root),
  };
}

async function restoreStoreAfterFailure(store: BookmarkArchiveStore): Promise<void> {
  await writeBookmarkArchiveStore(store);
  await writeBookmarkArchiveBackup(store).catch(() => undefined);
}

export async function archiveBookmarkFolder(
  node: BookmarkNode,
  bookmarksBar: BookmarkNode,
): Promise<BookmarkArchiveOperationResult> {
  if (
    node.url != null ||
    node.parentId == null ||
    node.id === bookmarksBar.id ||
    node.unmodifiable
  ) {
    throw new Error('只能归档普通书签文件夹');
  }

  const [current] = (await browser.bookmarks.getSubTree(node.id)) as BookmarkNode[];
  if (
    !current ||
    current.url != null ||
    current.parentId !== node.parentId ||
    current.index !== node.index
  ) {
    throw new Error('此文件夹已在 Chrome 中发生变化，请刷新后重试');
  }

  const store = await readBookmarkArchiveStore();
  if (
    store.archives.some(
      (record) =>
        record.source.folderId === node.id && record.status !== 'restore-conflict',
    )
  ) {
    throw new Error('这个文件夹已有待处理的归档记录，请刷新后重试');
  }
  const record = makeArchiveRecord(current, bookmarksBar);
  const pendingStore = nextBookmarkArchiveStore(store, [record, ...store.archives]);
  await writeBookmarkArchiveStore(pendingStore);
  try {
    await writeBookmarkArchiveBackup(pendingStore);
  } catch (error) {
    await restoreStoreAfterFailure(store);
    throw error;
  }

  const latest = await readSubTreeIfPresent(node.id);
  if (
    !latest ||
    latest.url != null ||
    latest.parentId !== current.parentId ||
    latest.index !== current.index ||
    fingerprintArchivedFolder(toArchivedNode(latest) as ArchivedFolder) !== record.fingerprint
  ) {
    await restoreStoreAfterFailure(store);
    throw new Error('归档前文件夹内容发生了变化，Chrome 中的内容没有删除');
  }

  try {
    await browser.bookmarks.removeTree(current.id);
  } catch (error) {
    await restoreStoreAfterFailure(store);
    throw error;
  }

  const archivedRecord: BookmarkArchiveRecord = {
    ...record,
    status: 'archived',
  };
  const archivedStore = nextBookmarkArchiveStore(
    pendingStore,
    pendingStore.archives.map((item) =>
      item.id === record.id ? archivedRecord : item,
    ),
  );
  await writeBookmarkArchiveStore(archivedStore);
  try {
    await writeBookmarkArchiveBackup(archivedStore);
    return { record: archivedRecord };
  } catch (error) {
    return {
      record: archivedRecord,
      backupWarning:
        error instanceof Error
          ? error.message
          : '归档已完成，但归档备份文件未能更新',
    };
  }
}

export async function restoreArchivedBookmarkFolder(
  archiveId: string,
  targetParentId: string,
): Promise<BookmarkArchiveOperationResult> {
  const store = await readBookmarkArchiveStore();
  const record = store.archives.find((item) => item.id === archiveId);
  if (!record || record.status !== 'archived') {
    throw new Error('这个归档已经发生变化，请刷新后重试');
  }

  const [target] = (await browser.bookmarks.get(targetParentId)) as BookmarkNode[];
  if (!target || target.url != null || target.unmodifiable) {
    throw new Error('目标文件夹不可用，请重新选择');
  }

  let pendingRecord: BookmarkArchiveRecord = {
    ...record,
    status: 'pending-restore',
    restore: { targetParentId },
  };
  let pendingStore = nextBookmarkArchiveStore(
    store,
    store.archives.map((item) => (item.id === archiveId ? pendingRecord : item)),
  );
  await writeBookmarkArchiveStore(pendingStore);
  await writeBookmarkArchiveBackup(pendingStore).catch(async (error) => {
    await writeBookmarkArchiveStore(store);
    throw error;
  });

  let createdRoot: BookmarkNode | null = null;
  try {
    const destinationChildren = (await browser.bookmarks.getChildren(
      targetParentId,
    )) as BookmarkNode[];
    const restoreIndex =
      targetParentId === record.source.parentId && record.source.index != null
        ? Math.min(record.source.index, destinationChildren.length)
        : undefined;
    createdRoot = await createArchivedNode(record.root, targetParentId, restoreIndex);
    pendingRecord = {
      ...pendingRecord,
      restore: { targetParentId, createdRootId: createdRoot.id },
    };
    pendingStore = nextBookmarkArchiveStore(
      pendingStore,
      pendingStore.archives.map((item) =>
        item.id === archiveId ? pendingRecord : item,
      ),
    );
    await writeBookmarkArchiveStore(pendingStore);
    await writeBookmarkArchiveBackup(pendingStore);

    const restoredTree = await readSubTreeIfPresent(createdRoot.id);
    if (
      !restoredTree ||
      restoredTree.url != null ||
      fingerprintArchivedFolder(toArchivedNode(restoredTree) as ArchivedFolder) !==
        record.fingerprint
    ) {
      throw new Error('恢复后的书签内容校验失败');
    }

    const completedStore = nextBookmarkArchiveStore(
      pendingStore,
      pendingStore.archives.filter((item) => item.id !== archiveId),
    );
    await writeBookmarkArchiveBackup(completedStore);
    await writeBookmarkArchiveStore(completedStore);
    return { record };
  } catch (error) {
    let cleanupSucceeded = true;
    if (createdRoot) {
      try {
        await browser.bookmarks.removeTree(createdRoot.id);
      } catch {
        cleanupSucceeded = false;
      }
    }
    if (cleanupSucceeded) {
      await restoreStoreAfterFailure(store);
    } else {
      const conflictRecord: BookmarkArchiveRecord = {
        ...pendingRecord,
        status: 'restore-conflict',
      };
      const conflictStore = nextBookmarkArchiveStore(
        pendingStore,
        pendingStore.archives.map((item) =>
          item.id === archiveId ? conflictRecord : item,
        ),
      );
      await writeBookmarkArchiveStore(conflictStore);
      await writeBookmarkArchiveBackup(conflictStore).catch(() => undefined);
    }
    throw error;
  }
}

function parseLegacyArchiveState(value: unknown): LegacyArchiveState | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.archiveRootId !== 'string' ||
    !candidate.entries ||
    typeof candidate.entries !== 'object'
  ) {
    return null;
  }
  const entries: Record<string, LegacyArchiveEntry> = {};
  for (const [nodeId, value] of Object.entries(candidate.entries)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.originalParentId !== 'string' ||
      typeof entry.archivedAt !== 'number'
    ) {
      continue;
    }
    entries[nodeId] = {
      originalParentId: entry.originalParentId,
      ...(typeof entry.originalIndex === 'number'
        ? { originalIndex: entry.originalIndex }
        : {}),
      archivedAt: entry.archivedAt,
    };
  }
  return { archiveRootId: candidate.archiveRootId, entries };
}

async function readLegacyArchiveState(): Promise<LegacyArchiveState | null> {
  const stored = await browser.storage.local.get(LEGACY_BOOKMARK_ARCHIVE_STATE_KEY);
  return parseLegacyArchiveState(stored[LEGACY_BOOKMARK_ARCHIVE_STATE_KEY]);
}

export async function inspectLegacyBookmarkArchive(
  bookmarksBar: BookmarkNode,
): Promise<LegacyArchiveMigrationInfo | null> {
  const state = await readLegacyArchiveState();
  if (!state) return null;
  const root = findNode(bookmarksBar, state.archiveRootId);
  if (!root || root.url != null) return null;
  return {
    archiveRootId: root.id,
    folderCount: (root.children ?? []).filter((child) => child.url == null).length,
    bookmarkCount: (root.children ?? []).filter((child) => child.url != null).length,
  };
}

export async function migrateLegacyBookmarkArchive(): Promise<{
  migratedFolders: number;
  remainingBookmarks: number;
}> {
  const [bookmarksBar, legacyState, store] = await Promise.all([
    readBookmarksBar(),
    readLegacyArchiveState(),
    readBookmarkArchiveStore(),
  ]);
  if (!legacyState) throw new Error('没有需要迁移的旧归档');
  const legacyRoot = findNode(bookmarksBar, legacyState.archiveRootId);
  if (!legacyRoot || legacyRoot.url != null) {
    throw new Error('Chrome 中没有找到旧的 Bok 归档文件夹');
  }

  const folders = (legacyRoot.children ?? []).filter((child) => child.url == null);
  const remainingBookmarks = (legacyRoot.children ?? []).filter(
    (child) => child.url != null,
  ).length;
  const existingSourceIds = new Set(store.archives.map((record) => record.source.folderId));
  const records = folders
    .filter((folder) => !existingSourceIds.has(folder.id))
    .map((folder) => {
      const legacyEntry = legacyState.entries[folder.id];
      return makeArchiveRecord(
        folder,
        bookmarksBar,
        legacyEntry?.originalParentId ?? bookmarksBar.id,
        legacyEntry?.originalIndex ?? folder.index ?? null,
        legacyEntry?.archivedAt ?? Date.now(),
      );
    });
  let nextStore = nextBookmarkArchiveStore(store, [...records, ...store.archives]);
  await writeBookmarkArchiveStore(nextStore);
  try {
    await writeBookmarkArchiveBackup(nextStore);
  } catch (error) {
    await writeBookmarkArchiveStore(store);
    throw error;
  }

  try {
    for (const record of records) {
      await browser.bookmarks.removeTree(record.source.folderId);
      const archivedRecord: BookmarkArchiveRecord = {
        ...record,
        status: 'archived',
      };
      nextStore = nextBookmarkArchiveStore(
        nextStore,
        nextStore.archives.map((item) =>
          item.id === record.id ? archivedRecord : item,
        ),
      );
      await writeBookmarkArchiveStore(nextStore);
    }
    await writeBookmarkArchiveBackup(nextStore);

    const remaining = (await browser.bookmarks.getChildren(legacyRoot.id)) as BookmarkNode[];
    if (remaining.length === 0) await browser.bookmarks.remove(legacyRoot.id);
    await browser.storage.local.remove(LEGACY_BOOKMARK_ARCHIVE_STATE_KEY);
    return { migratedFolders: records.length, remainingBookmarks };
  } catch (error) {
    await writeBookmarkArchiveBackup(nextStore).catch(() => undefined);
    throw error;
  }
}

export async function reconcileBookmarkArchiveStore(): Promise<BookmarkArchiveStore> {
  let store = await readBookmarkArchiveStore();
  for (const record of [...store.archives]) {
    if (record.status === 'pending-removal') {
      const source = await readSubTreeIfPresent(record.source.folderId);
      const archives = source
        ? store.archives.filter((item) => item.id !== record.id)
        : store.archives.map((item) =>
            item.id === record.id ? { ...item, status: 'archived' as const } : item,
          );
      store = nextBookmarkArchiveStore(store, archives);
      await writeBookmarkArchiveStore(store);
      continue;
    }
    if (record.status !== 'pending-restore') continue;
    const createdRootId = record.restore?.createdRootId;
    const createdRoot = createdRootId
      ? await readSubTreeIfPresent(createdRootId)
      : null;
    if (!createdRoot) {
      store = nextBookmarkArchiveStore(
        store,
        store.archives.map((item) =>
          item.id === record.id
            ? { ...item, status: 'archived' as const, restore: undefined }
            : item,
        ),
      );
      await writeBookmarkArchiveStore(store);
      continue;
    }
    const restoredSnapshot = toArchivedNode(createdRoot);
    if (
      restoredSnapshot.kind === 'folder' &&
      fingerprintArchivedFolder(restoredSnapshot) === record.fingerprint
    ) {
      const completedStore = nextBookmarkArchiveStore(
        store,
        store.archives.filter((item) => item.id !== record.id),
      );
      try {
        await writeBookmarkArchiveBackup(completedStore);
        await writeBookmarkArchiveStore(completedStore);
        store = completedStore;
      } catch {
        // Keep the pending record until the backup directory is writable again.
      }
      continue;
    }
    store = nextBookmarkArchiveStore(
      store,
      store.archives.map((item) =>
        item.id === record.id
          ? { ...item, status: 'restore-conflict' as const }
          : item,
      ),
    );
    await writeBookmarkArchiveStore(store);
  }
  return store;
}
