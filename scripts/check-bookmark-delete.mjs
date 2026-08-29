import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;

const { deleteBookmarkNode, moveBookmarkNode } = await import('../libs/bookmarks/api.ts');

const bookmark = {
  id: 'bookmark-to-delete',
  parentId: 'folder',
  index: 0,
  title: 'Delete me',
  url: 'https://example.test/delete-me',
};

let current = structuredClone(bookmark);
fakeBrowser.bookmarks.getSubTree = async (id) =>
  current?.id === id ? [structuredClone(current)] : [];
fakeBrowser.bookmarks.getTree = async () => [
  {
    id: '0',
    title: '',
    children:
      current == null
        ? []
        : [
            {
              id: 'folder',
              parentId: '0',
              title: 'Folder',
              children: [structuredClone(current)],
            },
          ],
  },
];
fakeBrowser.bookmarks.remove = async (id) => {
  assert.equal(id, bookmark.id);
  current = null;
};

assert.equal(await deleteBookmarkNode(bookmark), true);
assert.equal(current, null);
assert.deepEqual((await fakeBrowser.storage.session.get('bookmarkUndo')).bookmarkUndo, {
  schemaVersion: 1,
  type: 'delete',
  parentId: bookmark.parentId,
  index: bookmark.index,
  node: {
    title: bookmark.title,
    url: bookmark.url,
  },
});

current = structuredClone(bookmark);
fakeBrowser.bookmarks.remove = async () => undefined;
await assert.rejects(deleteBookmarkNode(bookmark), /Chrome 未删除该书签/);
assert.equal(
  (await fakeBrowser.storage.session.get('bookmarkUndo')).bookmarkUndo,
  undefined,
);

current = structuredClone(bookmark);
fakeBrowser.bookmarks.remove = async () => undefined;
const removeSessionStorage = fakeBrowser.storage.session.remove.bind(
  fakeBrowser.storage.session,
);
fakeBrowser.storage.session.remove = async () => {
  throw new Error('Session storage cleanup unavailable');
};
await assert.rejects(deleteBookmarkNode(bookmark), /Chrome 未删除该书签/);
fakeBrowser.storage.session.remove = removeSessionStorage;

current = structuredClone(bookmark);
fakeBrowser.bookmarks.remove = async () => {
  current = null;
};
fakeBrowser.bookmarks.getTree = async () => {
  throw new Error('Bookmarks API unavailable');
};
assert.equal(await deleteBookmarkNode(bookmark), true);
assert.deepEqual((await fakeBrowser.storage.session.get('bookmarkUndo')).bookmarkUndo, {
  schemaVersion: 1,
  type: 'delete',
  parentId: bookmark.parentId,
  index: bookmark.index,
  node: {
    title: bookmark.title,
    url: bookmark.url,
  },
});

await fakeBrowser.storage.session.remove('bookmarkUndo');
current = structuredClone(bookmark);
fakeBrowser.bookmarks.get = async (id) =>
  current?.id === id ? [structuredClone(current)] : [];
fakeBrowser.bookmarks.move = async (id, destination) => {
  assert.equal(id, bookmark.id);
  current = {
    ...current,
    parentId: destination.parentId,
    index: destination.index ?? 0,
  };
  return structuredClone(current);
};
assert.equal(
  await moveBookmarkNode(bookmark, { parentId: 'destination', index: 2 }),
  true,
);
assert.equal(current.parentId, 'destination');
assert.deepEqual((await fakeBrowser.storage.session.get('bookmarkUndo')).bookmarkUndo, {
  schemaVersion: 1,
  type: 'move',
  nodeId: bookmark.id,
  parentId: bookmark.parentId,
  index: bookmark.index,
  currentParentId: 'destination',
  currentIndex: 2,
});

await fakeBrowser.storage.session.remove('bookmarkUndo');
current = structuredClone(bookmark);
const setSessionStorage = fakeBrowser.storage.session.set.bind(
  fakeBrowser.storage.session,
);
let storageWrites = 0;
fakeBrowser.storage.session.set = async (value) => {
  storageWrites += 1;
  if (storageWrites === 2) throw new Error('Session storage unavailable');
  return setSessionStorage(value);
};
assert.equal(
  await moveBookmarkNode(bookmark, { parentId: 'destination', index: 1 }),
  false,
);
assert.equal(current.parentId, 'destination');
assert.equal(
  (await fakeBrowser.storage.session.get('bookmarkUndo')).bookmarkUndo,
  undefined,
);

await fakeBrowser.storage.session.remove('bookmarkUndo');
current = structuredClone(bookmark);
storageWrites = 0;
fakeBrowser.storage.session.remove = async () => {
  throw new Error('Session storage cleanup unavailable');
};
assert.equal(
  await moveBookmarkNode(bookmark, { parentId: 'destination', index: 1 }),
  false,
);
assert.equal(current.parentId, 'destination');
fakeBrowser.storage.session.remove = removeSessionStorage;

console.log('bookmark mutation checks passed');
