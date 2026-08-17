import { browser } from 'wxt/browser';
import { readBookmarksBar } from './api';
import type { BookmarkNode } from './model';

export const DEFAULT_BOOKMARK_FOLDER_ID_KEY = 'defaultBookmarkFolderId';

const DEFAULT_BOOKMARK_FOLDER_TITLE = 'Inbox';
const DEFAULT_FOLDER_MARKER_TITLE = 'Bok Inbox marker';
const DEFAULT_FOLDER_MARKER_HASH = '#bok-inbox-default-folder-marker';

export interface DefaultBookmarkFolderOption {
  id: string;
  label: string;
}

export interface DefaultBookmarkFolderSettings {
  configuredFolderId: string | null;
  selectedFolderId: string | null;
  missingConfiguredFolder: boolean;
  options: DefaultBookmarkFolderOption[];
}

function getMarkerUrl(): string {
  return browser.runtime.getURL(
    `/bookmark-manager.html${DEFAULT_FOLDER_MARKER_HASH}`,
  );
}

export function isDefaultFolderMarker(node: BookmarkNode): boolean {
  return (
    node.title === DEFAULT_FOLDER_MARKER_TITLE && node.url === getMarkerUrl()
  );
}

function getConfiguredFolderId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function readConfiguredFolderId(): Promise<string | null> {
  const stored = await browser.storage.local.get(
    DEFAULT_BOOKMARK_FOLDER_ID_KEY,
  );
  return getConfiguredFolderId(stored[DEFAULT_BOOKMARK_FOLDER_ID_KEY]);
}

function findTopLevelFolder(
  bookmarksBar: BookmarkNode,
  folderId: string,
): BookmarkNode | null {
  return (
    bookmarksBar.children?.find(
      (node) => node.url == null && node.id === folderId,
    ) ?? null
  );
}

function collectMarkerIds(node: BookmarkNode, markerIds: string[]): void {
  if (isDefaultFolderMarker(node)) markerIds.push(node.id);
  for (const child of node.children ?? []) {
    collectMarkerIds(child, markerIds);
  }
}

async function removeMarker(markerId: string): Promise<void> {
  try {
    await browser.bookmarks.remove(markerId);
  } catch {
    await browser.bookmarks.remove(markerId);
  }
}

export async function getDefaultBookmarkFolderSettings(): Promise<
  DefaultBookmarkFolderSettings
> {
  const [bookmarksBar, configuredFolderId] = await Promise.all([
    readBookmarksBar(),
    readConfiguredFolderId(),
  ]);
  const options = (bookmarksBar.children ?? [])
    .filter((node) => node.url == null)
    .map((node) => ({ id: node.id, label: `书签栏 / ${node.title}` }));
  const configuredFolder = configuredFolderId
    ? findTopLevelFolder(bookmarksBar, configuredFolderId)
    : null;
  const legacyInbox = bookmarksBar.children?.find(
    (node) => node.url == null && node.title === DEFAULT_BOOKMARK_FOLDER_TITLE,
  );

  return {
    configuredFolderId,
    selectedFolderId:
      configuredFolder?.id ?? (configuredFolderId ? null : legacyInbox?.id ?? null),
    missingConfiguredFolder:
      configuredFolderId != null && configuredFolder == null,
    options,
  };
}

export async function setDefaultBookmarkFolderId(
  folderId: string,
): Promise<void> {
  const bookmarksBar = await readBookmarksBar();
  if (!findTopLevelFolder(bookmarksBar, folderId)) {
    throw new Error('默认书签目录必须是书签栏一级文件夹，请重新选择');
  }
  await browser.storage.local.set({
    [DEFAULT_BOOKMARK_FOLDER_ID_KEY]: folderId,
  });
}

export async function cleanupDefaultBookmarkFolderMarkers(): Promise<number> {
  const bookmarksBar = await readBookmarksBar();
  const markerIds: string[] = [];
  collectMarkerIds(bookmarksBar, markerIds);
  for (const markerId of markerIds) await removeMarker(markerId);
  return markerIds.length;
}

export async function markDefaultBookmarkFolderAsMostRecentlyModified(): Promise<
  boolean
> {
  const [bookmarksBar, configuredFolderId] = await Promise.all([
    readBookmarksBar(),
    readConfiguredFolderId(),
  ]);
  const targetFolder = configuredFolderId
    ? findTopLevelFolder(bookmarksBar, configuredFolderId)
    : bookmarksBar.children?.find(
        (node) => node.url == null && node.title === DEFAULT_BOOKMARK_FOLDER_TITLE,
      );
  if (!targetFolder) return false;

  for (const child of targetFolder.children ?? []) {
    if (isDefaultFolderMarker(child)) await removeMarker(child.id);
  }

  const marker = (await browser.bookmarks.create({
    parentId: targetFolder.id,
    title: DEFAULT_FOLDER_MARKER_TITLE,
    url: getMarkerUrl(),
  })) as BookmarkNode;
  await removeMarker(marker.id);
  return true;
}
