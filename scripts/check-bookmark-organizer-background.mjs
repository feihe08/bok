import assert from 'node:assert/strict';
import { fakeBrowser } from 'wxt/testing';

fakeBrowser.reset();
globalThis.browser = fakeBrowser;
globalThis.chrome = fakeBrowser;
fakeBrowser.runtime.getURL = (path) => `chrome-extension://bok${path}`;

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListeners() {
      return listeners.size > 0;
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

let bookmarksBar = {
  id: '1',
  title: 'Bookmarks Bar',
  folderType: 'bookmarks-bar',
  children: [
    {
      id: 'inbox',
      title: 'Inbox',
      parentId: '1',
      children: [
        {
          id: 'existing',
          title: 'Existing before baseline',
          url: 'https://existing.example',
          parentId: 'inbox',
        },
      ],
    },
  ],
};

function findNode(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return undefined;
}

let nextReadStarted;
let waitForRead;

function holdNextSubtreeRead() {
  let markStarted;
  let release;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  nextReadStarted = markStarted;
  waitForRead = ready;
  return { started, release };
}

fakeBrowser.bookmarks.getChildren = async (id) =>
  id === '0' ? [clone(bookmarksBar)] : clone(findNode(bookmarksBar, id)?.children ?? []);
fakeBrowser.bookmarks.getSubTree = async (id) => {
  const current = findNode(bookmarksBar, id);
  const snapshot = current ? clone(current) : undefined;
  if (nextReadStarted) {
    nextReadStarted();
    nextReadStarted = undefined;
    await waitForRead;
  }
  return snapshot ? [snapshot] : [];
};

const bookmarkCreated = createEvent();
fakeBrowser.bookmarks.onCreated = bookmarkCreated;
fakeBrowser.bookmarks.onChanged = createEvent();
fakeBrowser.bookmarks.onMoved = createEvent();
fakeBrowser.bookmarks.onRemoved = createEvent();
let resolvePermissionCheck;
fakeBrowser.permissions.contains = () => new Promise((resolve) => {
  resolvePermissionCheck = resolve;
});
globalThis.defineBackground = (setup) => ({ main: setup });

const {
  initializeBookmarkOrganizerTracking,
  recoverBookmarkOrganizerTracking,
} = await import('../entrypoints/background.ts');
const {
  createBookmarkOrganizerStore,
  readBookmarkOrganizerStore,
  writeBookmarkOrganizerStore,
} = await import('../libs/bookmarks/organizer-storage.ts');

function addBookmark(id, title) {
  bookmarksBar.children[0].children.push({
    id,
    title,
    url: `https://${id}.example`,
    parentId: 'inbox',
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const initialGate = holdNextSubtreeRead();
const initializing = initializeBookmarkOrganizerTracking();
assert.equal(bookmarkCreated.hasListeners(), true);
addBookmark('created-during-permission-check', 'Created during permission check');
bookmarkCreated.emit(
  'created-during-permission-check',
  findNode(bookmarksBar, 'created-during-permission-check'),
);
resolvePermissionCheck(true);
await initialGate.started;
assert.equal(bookmarkCreated.hasListeners(), true);
addBookmark('created-during-initialize', 'Created during initialize');
bookmarkCreated.emit('created-during-initialize', findNode(bookmarksBar, 'created-during-initialize'));
initialGate.release();
assert.equal(await initializing, true);
await settle();

let store = await readBookmarkOrganizerStore();
assert.equal(store.candidates.existing, undefined);
assert.equal(
  store.candidates['created-during-permission-check'].title,
  'Created during permission check',
);
assert.equal(
  store.candidates['created-during-initialize'].title,
  'Created during initialize',
);

const gapStore = createBookmarkOrganizerStore('1', 2_000);
gapStore.tracking = {
  ...gapStore.tracking,
  status: 'permission-gap',
  gap: { startedAt: 2_001 },
};
await writeBookmarkOrganizerStore(gapStore);

const recoveryGate = holdNextSubtreeRead();
fakeBrowser.permissions.contains = async () => true;
const recovering = recoverBookmarkOrganizerTracking();
await recoveryGate.started;
addBookmark('created-during-recovery', 'Created during recovery');
bookmarkCreated.emit('created-during-recovery', findNode(bookmarksBar, 'created-during-recovery'));
recoveryGate.release();
assert.equal(await recovering, true);
await settle();

store = await readBookmarkOrganizerStore();
assert.equal(store.candidates.existing, undefined);
assert.equal(store.candidates['created-during-initialize'], undefined);
assert.equal(
  store.candidates['created-during-recovery'].title,
  'Created during recovery',
);

console.log('bookmark organizer background checks passed');
