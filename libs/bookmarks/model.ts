import type { Browser } from 'wxt/browser';

export type BookmarkFolderType =
  | 'bookmarks-bar'
  | 'other'
  | 'mobile'
  | 'managed';

export type BookmarkNode = Browser.bookmarks.BookmarkTreeNode & {
  folderType?: BookmarkFolderType;
  syncing?: boolean;
  dateLastUsed?: number;
  children?: BookmarkNode[];
};

export type BookmarkArchiveStatus =
  | 'pending-removal'
  | 'archived'
  | 'pending-restore'
  | 'restore-conflict';

export interface ArchivedBookmark {
  kind: 'bookmark';
  title: string;
  url: string;
}

export interface ArchivedFolder {
  kind: 'folder';
  title: string;
  children: ArchivedNode[];
}

export type ArchivedNode = ArchivedBookmark | ArchivedFolder;

export interface BookmarkArchiveSource {
  folderId: string;
  parentId: string;
  parentPath: string[];
  index: number | null;
}

export interface BookmarkArchiveRecord {
  id: string;
  archivedAt: number;
  status: BookmarkArchiveStatus;
  source: BookmarkArchiveSource;
  root: ArchivedFolder;
  fingerprint: string;
  counts: {
    folders: number;
    bookmarks: number;
  };
  restore?: {
    targetParentId: string;
    createdRootId?: string;
  };
}

export interface BookmarkArchiveStore {
  schemaVersion: 1;
  revision: number;
  archives: BookmarkArchiveRecord[];
}

export interface ImportBookmarkArchiveResult {
  kind: 'bookmark-archive';
  importedArchives: number;
  importedBookmarks: number;
}
