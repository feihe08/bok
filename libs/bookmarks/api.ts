import { browser } from 'wxt/browser';
import type { BookmarkNode } from './model';

export interface BookmarkSnapshot {
  title: string;
  url?: string;
  children?: BookmarkSnapshot[];
}

interface BookmarkDeleteUndo {
  schemaVersion: 1;
  type: 'delete';
  parentId: string;
  index?: number;
  node: BookmarkSnapshot;
}

interface BookmarkMoveUndo {
  schemaVersion: 1;
  type: 'move';
  nodeId: string;
  parentId: string;
  index?: number;
  currentParentId?: string;
  currentIndex?: number;
}

type BookmarkUndo = BookmarkDeleteUndo | BookmarkMoveUndo;

export interface BookmarkUndoResult {
  type: BookmarkUndo['type'];
  nodeId: string;
}

const ROOT_NODE_ID = '0';
const BOOKMARK_UNDO_KEY = 'bookmarkUndo';

function toSnapshot(node: BookmarkNode): BookmarkSnapshot {
  return {
    title: node.title,
    ...(node.url == null ? {} : { url: node.url }),
    ...(node.children == null
      ? {}
      : { children: node.children.map(toSnapshot) }),
  };
}

async function createSnapshot(
  snapshot: BookmarkSnapshot,
  parentId: string,
  index?: number,
): Promise<BookmarkNode> {
  const created = (await browser.bookmarks.create({
    parentId,
    ...(index == null ? {} : { index }),
    title: snapshot.title,
    ...(snapshot.url == null ? {} : { url: snapshot.url }),
  })) as BookmarkNode;

  if (snapshot.url == null) {
    for (const child of snapshot.children ?? []) {
      await createSnapshot(child, created.id);
    }
  }

  return created;
}

export async function readBookmarksBar(): Promise<BookmarkNode> {
  const rootChildren = (await browser.bookmarks.getChildren(
    ROOT_NODE_ID,
  )) as BookmarkNode[];
  const bookmarksBar =
    rootChildren.find((node) => node.folderType === 'bookmarks-bar') ??
    rootChildren.find((node) => node.id === '1') ??
    rootChildren[0];

  if (!bookmarksBar) {
    throw new Error('Chrome 没有返回书签栏');
  }

  const [subtree] = (await browser.bookmarks.getSubTree(
    bookmarksBar.id,
  )) as BookmarkNode[];
  if (!subtree) {
    throw new Error('无法读取 Chrome 书签栏');
  }

  return subtree;
}

export async function moveBookmarkNode(
  node: BookmarkNode,
  destination: { parentId: string; index?: number },
): Promise<void> {
  const [current] = (await browser.bookmarks.get(node.id)) as BookmarkNode[];
  if (
    !current ||
    current.parentId == null ||
    current.parentId !== node.parentId ||
    current.index !== node.index
  ) {
    throw new Error('此项目已在 Chrome 中移动，请刷新后重试');
  }

  const undo: BookmarkMoveUndo = {
    schemaVersion: 1,
    type: 'move',
    nodeId: current.id,
    parentId: current.parentId,
    ...(current.index == null ? {} : { index: current.index }),
  };
  await browser.storage.session.set({ [BOOKMARK_UNDO_KEY]: undo });

  try {
    const moved = (await browser.bookmarks.move(
      node.id,
      destination,
    )) as BookmarkNode;
    await browser.storage.session.set({
      [BOOKMARK_UNDO_KEY]: {
        ...undo,
        currentParentId: moved.parentId,
        ...(moved.index == null ? {} : { currentIndex: moved.index }),
      } satisfies BookmarkMoveUndo,
    });
  } catch (error) {
    await browser.storage.session.remove(BOOKMARK_UNDO_KEY);
    throw error;
  }
}

export async function deleteBookmarkNode(node: BookmarkNode): Promise<void> {
  const [current] = (await browser.bookmarks.getSubTree(
    node.id,
  )) as BookmarkNode[];
  if (
    !current ||
    current.parentId == null ||
    current.parentId !== node.parentId ||
    current.index !== node.index
  ) {
    throw new Error('此项目已在 Chrome 中发生变化，请刷新后重试');
  }

  const undo: BookmarkDeleteUndo = {
    schemaVersion: 1,
    type: 'delete',
    parentId: current.parentId,
    ...(current.index == null ? {} : { index: current.index }),
    node: toSnapshot(current),
  };

  await browser.storage.session.set({ [BOOKMARK_UNDO_KEY]: undo });

  try {
    if (current.url == null && (current.children?.length ?? 0) > 0) {
      await browser.bookmarks.removeTree(current.id);
    } else {
      await browser.bookmarks.remove(current.id);
    }
  } catch (error) {
    await browser.storage.session.remove(BOOKMARK_UNDO_KEY);
    throw error;
  }
}

export async function restoreLastBookmarkOperation(): Promise<BookmarkUndoResult | null> {
  const stored = await browser.storage.session.get(BOOKMARK_UNDO_KEY);
  const undo = stored[BOOKMARK_UNDO_KEY] as BookmarkUndo | undefined;
  if (
    !undo ||
    undo.schemaVersion !== 1 ||
    typeof undo.parentId !== 'string'
  ) {
    return null;
  }

  if (undo.type === 'move') {
    if (typeof undo.nodeId !== 'string') return null;
    const [current] = (await browser.bookmarks.get(undo.nodeId)) as BookmarkNode[];
    if (
      !current ||
      (undo.currentParentId != null && current.parentId !== undo.currentParentId) ||
      (undo.currentIndex != null && current.index !== undo.currentIndex)
    ) {
      throw new Error('书签位置已再次发生变化');
    }

    const restored = (await browser.bookmarks.move(undo.nodeId, {
      parentId: undo.parentId,
      ...(undo.index == null ? {} : { index: undo.index }),
    })) as BookmarkNode;
    await browser.storage.session.remove(BOOKMARK_UNDO_KEY);
    return { type: 'move', nodeId: restored.id };
  }

  if (undo.type !== 'delete' || !undo.node) return null;
  const restored = await createSnapshot(undo.node, undo.parentId, undo.index);
  await browser.storage.session.remove(BOOKMARK_UNDO_KEY);
  return { type: 'delete', nodeId: restored.id };
}
