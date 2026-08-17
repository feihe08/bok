import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;

fakeBrowser.runtime.getURL = (path) => `chrome-extension://bok${path}`;
fakeBrowser.bookmarks.getChildren = async () => [
  { id: '1', title: 'Bookmarks Bar', folderType: 'bookmarks-bar' },
];

const removedIds = [];
const removeAttempts = new Map();
let createdDetails;
fakeBrowser.bookmarks.create = async (details) => {
  createdDetails = details;
  return { id: 'marker-new', ...details };
};
fakeBrowser.bookmarks.remove = async (id) => {
  removeAttempts.set(id, (removeAttempts.get(id) ?? 0) + 1);
  if (id === 'marker-retry' && removeAttempts.get(id) === 1) {
    throw new Error('temporary remove failure');
  }
  removedIds.push(id);
};

const {
  DEFAULT_BOOKMARK_FOLDER_ID_KEY,
  cleanupDefaultBookmarkFolderMarkers,
  getDefaultBookmarkFolderSettings,
  isDefaultFolderMarker,
  markDefaultBookmarkFolderAsMostRecentlyModified,
  setDefaultBookmarkFolderId,
} = await import('../libs/bookmarks/default-folder.ts');

const marker = {
  id: 'marker-old',
  title: 'Bok Inbox marker',
  url: 'chrome-extension://bok/bookmark-manager.html#bok-inbox-default-folder-marker',
};
fakeBrowser.bookmarks.getSubTree = async () => [
  {
    id: '1',
    title: 'Bookmarks Bar',
    children: [
      { id: '5', title: 'Inbox', children: [marker] },
      {
        id: '6',
        title: 'Projects',
        children: [{ id: '7', title: 'Bok', children: [] }],
      },
    ],
  },
];

assert.equal(isDefaultFolderMarker(marker), true);
assert.deepEqual(await getDefaultBookmarkFolderSettings(), {
  configuredFolderId: null,
  selectedFolderId: '5',
  missingConfiguredFolder: false,
  options: [
    { id: '5', label: '书签栏 / Inbox' },
    { id: '6', label: '书签栏 / Projects' },
  ],
});
assert.equal(await markDefaultBookmarkFolderAsMostRecentlyModified(), true);
assert.deepEqual(createdDetails, {
  parentId: '5',
  title: 'Bok Inbox marker',
  url: 'chrome-extension://bok/bookmark-manager.html#bok-inbox-default-folder-marker',
});
assert.deepEqual(removedIds, ['marker-old', 'marker-new']);

fakeBrowser.bookmarks.getSubTree = async () => [
  {
    id: '1',
    title: 'Bookmarks Bar',
    children: [
      {
        id: '6',
        title: 'Projects',
        children: [
          {
            id: 'marker-retry',
            title: 'Bok Inbox marker',
            url: 'chrome-extension://bok/bookmark-manager.html#bok-inbox-default-folder-marker',
          },
        ],
      },
    ],
  },
];
removedIds.length = 0;

assert.equal(await cleanupDefaultBookmarkFolderMarkers(), 1);
assert.deepEqual(removedIds, ['marker-retry']);
assert.equal(removeAttempts.get('marker-retry'), 2);

fakeBrowser.bookmarks.getSubTree = async () => [
  {
    id: '1',
    title: 'Bookmarks Bar',
    children: [
      { id: '5', title: 'Inbox', children: [] },
      {
        id: '6',
        title: 'Projects',
        children: [{ id: '7', title: 'Bok', children: [] }],
      },
    ],
  },
];

await assert.rejects(
  setDefaultBookmarkFolderId('7'),
  /默认书签目录必须是书签栏一级文件夹/,
);
await setDefaultBookmarkFolderId('6');
assert.deepEqual(
  await fakeBrowser.storage.local.get(DEFAULT_BOOKMARK_FOLDER_ID_KEY),
  { [DEFAULT_BOOKMARK_FOLDER_ID_KEY]: '6' },
);
createdDetails = undefined;
removedIds.length = 0;

assert.equal(await markDefaultBookmarkFolderAsMostRecentlyModified(), true);
assert.deepEqual(createdDetails, {
  parentId: '6',
  title: 'Bok Inbox marker',
  url: 'chrome-extension://bok/bookmark-manager.html#bok-inbox-default-folder-marker',
});
assert.deepEqual(removedIds, ['marker-new']);

fakeBrowser.bookmarks.getSubTree = async () => [
  {
    id: '1',
    title: 'Bookmarks Bar',
    children: [{ id: '8', title: 'Temp', children: [] }],
  },
];
createdDetails = undefined;
removedIds.length = 0;

assert.deepEqual(await getDefaultBookmarkFolderSettings(), {
  configuredFolderId: '6',
  selectedFolderId: null,
  missingConfiguredFolder: true,
  options: [{ id: '8', label: '书签栏 / Temp' }],
});
assert.equal(await markDefaultBookmarkFolderAsMostRecentlyModified(), false);
assert.equal(createdDetails, undefined);
assert.deepEqual(removedIds, []);
await assert.rejects(
  setDefaultBookmarkFolderId('missing-folder'),
  /默认书签目录必须是书签栏一级文件夹/,
);

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    hasListeners() {
      return listeners.size > 0;
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

const bookmarkCreated = createEvent();
const bookmarkMoved = createEvent();
fakeBrowser.bookmarks.onCreated = bookmarkCreated;
fakeBrowser.bookmarks.onMoved = bookmarkMoved;
fakeBrowser.runtime.onInstalled = createEvent();
fakeBrowser.runtime.onMessage = createEvent();
fakeBrowser.storage.onChanged = createEvent();
fakeBrowser.alarms.onAlarm = createEvent();
fakeBrowser.tabs.onUpdated = createEvent();
fakeBrowser.tabs.onActivated = createEvent();
fakeBrowser.tabs.onMoved = createEvent();
fakeBrowser.tabs.onRemoved = createEvent();
fakeBrowser.permissions.onAdded = createEvent();
fakeBrowser.permissions.onRemoved = createEvent();
fakeBrowser.windows.onFocusChanged = createEvent();
fakeBrowser.tabGroups = {
  query: async () => [],
  update: async () => undefined,
  onUpdated: createEvent(),
  onCreated: createEvent(),
  onMoved: createEvent(),
  onRemoved: createEvent(),
};
fakeBrowser.action.onClicked = createEvent();
fakeBrowser.contextMenus.onClicked = createEvent();
fakeBrowser.bookmarks.get = async (id) => [
  { id, title: 'Moved bookmark', url: 'https://moved.example' },
];
fakeBrowser.bookmarks.getSubTree = async () => [
  {
    id: '1',
    title: 'Bookmarks Bar',
    children: [
      { id: '5', title: 'Inbox', children: [] },
      {
        id: '6',
        title: 'Projects',
        children: [{ id: '7', title: 'Bok', children: [] }],
      },
    ],
  },
];

let bookmarksPermissionGranted = false;
fakeBrowser.permissions.contains = async () => bookmarksPermissionGranted;
let backgroundSetup;
globalThis.defineBackground = (setup) => {
  backgroundSetup = setup;
  return { main: setup };
};
const {
  recoverDefaultBookmarkFolderMarkers,
  registerBookmarkDefaultFolderListeners,
  unregisterBookmarkDefaultFolderListeners,
} = await import('../entrypoints/background.ts');

const bookmarksApi = fakeBrowser.bookmarks;
fakeBrowser.bookmarks = undefined;
assert.doesNotThrow(() => backgroundSetup());
await new Promise((resolve) => setTimeout(resolve, 0));
fakeBrowser.bookmarks = bookmarksApi;

let finishPermissionCheck;
fakeBrowser.permissions.contains = () =>
  new Promise((resolve) => {
    finishPermissionCheck = resolve;
  });
assert.doesNotThrow(() => backgroundSetup());
assert.equal(bookmarkCreated.hasListeners(), true);
assert.equal(bookmarkMoved.hasListeners(), true);
finishPermissionCheck(false);
await new Promise((resolve) => setTimeout(resolve, 0));
unregisterBookmarkDefaultFolderListeners();

fakeBrowser.permissions.contains = async () => bookmarksPermissionGranted;
assert.equal(await recoverDefaultBookmarkFolderMarkers(), false);
assert.equal(bookmarkCreated.hasListeners(), false);
assert.equal(bookmarkMoved.hasListeners(), false);

bookmarksPermissionGranted = true;
assert.equal(registerBookmarkDefaultFolderListeners(), true);
assert.equal(bookmarkCreated.hasListeners(), true);
assert.equal(bookmarkMoved.hasListeners(), true);

fakeBrowser.bookmarks.getSubTree = async () => [
  {
    id: '1',
    title: 'Bookmarks Bar',
    children: [
      {
        id: '6',
        title: 'Projects',
        children: [],
      },
      {
        id: '7',
        title: 'Old default',
        children: [
          {
            id: 'marker-old-folder',
            title: 'Bok Inbox marker',
            url: 'chrome-extension://bok/bookmark-manager.html#bok-inbox-default-folder-marker',
          },
        ],
      },
    ],
  },
];
createdDetails = undefined;
removedIds.length = 0;
assert.equal(await recoverDefaultBookmarkFolderMarkers(), true);
assert.equal(createdDetails?.parentId, '6');
assert.deepEqual(removedIds, ['marker-old-folder', 'marker-new']);

fakeBrowser.bookmarks.getSubTree = async () => [
  {
    id: '1',
    title: 'Bookmarks Bar',
    children: [
      { id: '5', title: 'Inbox', children: [] },
      {
        id: '6',
        title: 'Projects',
        children: [{ id: '7', title: 'Bok', children: [] }],
      },
    ],
  },
];

createdDetails = undefined;
removedIds.length = 0;
bookmarkCreated.emit('created-bookmark', {
  id: 'created-bookmark',
  title: 'Created bookmark',
  url: 'https://created.example',
});
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(createdDetails?.parentId, '6');
assert.deepEqual(removedIds, ['marker-new']);

createdDetails = undefined;
removedIds.length = 0;
bookmarkMoved.emit('moved-bookmark');
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(createdDetails?.parentId, '6');
assert.deepEqual(removedIds, ['marker-new']);

createdDetails = undefined;
removedIds.length = 0;
unregisterBookmarkDefaultFolderListeners();
bookmarkCreated.emit('ignored-bookmark', {
  id: 'ignored-bookmark',
  title: 'Ignored bookmark',
  url: 'https://ignored.example',
});
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(createdDetails, undefined);
assert.deepEqual(removedIds, []);

console.log('bookmark default folder checks passed');
